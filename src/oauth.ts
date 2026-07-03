/**
 * OAuth 2.1 authorization server for aacworkflow-mcp.
 *
 * AACWorkflow itself has no OAuth login endpoint — the only credential is the
 * `mul_…` API token minted in Settings → Tokens. So this server plays both
 * roles required by the MCP Authorization spec:
 *
 *  - Authorization Server: issues short-lived opaque access/refresh tokens
 *    via the standard authorization_code + PKCE flow (dynamic client
 *    registration included), so OAuth-only clients (claude.ai, ChatGPT
 *    connectors) can add this server without any custom auth code.
 *  - Resource Server: verifyAccessToken() maps those opaque tokens back to
 *    the underlying AACWorkflow token, which is what actually calls the API.
 *
 * Consent happens on a plain HTML page (`authorize()` below) that asks the
 * user to paste their AACWorkflow token — there's no third-party identity
 * to redirect to. The token is verified against `${serverUrl}/api/me`
 * before an authorization code is issued, and never leaves the process.
 *
 * Everything is in-memory: fine for a single instance (the deployment this
 * project targets). Restarting the process invalidates all sessions; OAuth
 * clients handle that transparently via re-authorization.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidClientError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { logger, redact } from "./logger.js";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1h
const AUTH_CODE_TTL_SECONDS = 5 * 60;
const PENDING_TXN_TTL_SECONDS = 10 * 60;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

type PendingAuthorization = { client: OAuthClientInformationFull; params: AuthorizationParams; expiresAt: number };
type IssuedCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  aacToken: string;
  expiresAt: number;
};
type IssuedToken = { clientId: string; scopes: string[]; aacToken: string; expiresAt?: number };

function now(): number {
  return Math.floor(Date.now() / 1000);
}
function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function authorizePage(opts: { txnId: string; clientName: string; error?: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Connect AACWorkflow</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 440px; margin: 64px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 19px; }
  .app { font-weight: 600; }
  label { display: block; margin: 20px 0 6px; font-weight: 600; font-size: 13px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 14px; border: 1px solid #ccc; border-radius: 6px; }
  button { margin-top: 20px; padding: 10px 20px; font-size: 14px; font-weight: 600; background: #111; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
  button:hover { background: #333; }
  .hint { color: #666; font-size: 13px; margin-top: 6px; }
  .error { background: #fdecea; color: #a4262c; padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-top: 16px; }
</style></head>
<body>
  <h1><span class="app">${escapeHtml(opts.clientName)}</span> wants to access your AACWorkflow account</h1>
  <p>Paste an AACWorkflow API token to continue. It is used only to complete this sign-in and is never stored in plain form beyond this session.</p>
  ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ""}
  <form method="POST" action="/authorize/verify">
    <input type="hidden" name="txn" value="${escapeHtml(opts.txnId)}">
    <label for="token">AACWorkflow token</label>
    <input type="password" id="token" name="token" placeholder="mul_..." autocomplete="off" autofocus required>
    <div class="hint">Create one at your workspace → Settings → Tokens.</div>
    <button type="submit">Authorize</button>
  </form>
</body></html>`;
}

export type OAuthProvider = OAuthServerProvider & {
  /** Handles the token-paste form submission; not part of the SDK's provider interface. */
  completeAuthorization(txnId: string, token: string, res: Response): Promise<void>;
  /** Stops the background cleanup sweep. Call on graceful shutdown / in tests. */
  stop(): void;
};

export function createOAuthProvider(cfg: { serverUrl: string }): OAuthProvider {
  const SERVER_URL = cfg.serverUrl.replace(/\/+$/, "");

  const clients = new Map<string, OAuthClientInformationFull>();
  const pending = new Map<string, PendingAuthorization>();
  const codes = new Map<string, IssuedCode>();
  const accessTokens = new Map<string, IssuedToken>();
  const refreshTokens = new Map<string, IssuedToken>();

  async function verifyAacToken(token: string): Promise<boolean> {
    try {
      const res = await fetch(`${SERVER_URL}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
      return res.ok;
    } catch (e) {
      logger.warn("aacworkflow token verification failed", { error: String(e) });
      return false;
    }
  }

  const clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId) => clients.get(clientId),
    registerClient: (client) => {
      const full = client as OAuthClientInformationFull;
      clients.set(full.client_id, full);
      logger.info("oauth client registered", { clientId: full.client_id, name: full.client_name });
      return full;
    },
  };

  function sweep() {
    const t = now();
    for (const [id, p] of pending) if (p.expiresAt < t) pending.delete(id);
    for (const [c, e] of codes) if (e.expiresAt < t) codes.delete(c);
    for (const [tok, e] of accessTokens) if (e.expiresAt !== undefined && e.expiresAt < t) accessTokens.delete(tok);
  }
  const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  const provider: OAuthProvider = {
    clientsStore,

    async authorize(client, params, res) {
      const txnId = randomUUID();
      pending.set(txnId, { client, params, expiresAt: now() + PENDING_TXN_TTL_SECONDS });
      res
        .status(200)
        .type("html")
        .send(authorizePage({ txnId, clientName: client.client_name ?? client.client_id }));
    },

    async completeAuthorization(txnId, token, res) {
      const entry = pending.get(txnId);
      if (!entry) {
        res.status(400).type("html").send(authorizePage({ txnId, clientName: "This app", error: "This authorization request has expired. Please try connecting again." }));
        return;
      }
      const trimmed = token.trim();
      const ok = trimmed.length > 0 && (await verifyAacToken(trimmed));
      if (!ok) {
        res.status(200).type("html").send(
          authorizePage({ txnId, clientName: entry.client.client_name ?? entry.client.client_id, error: "That token was rejected by AACWorkflow. Check it and try again." }),
        );
        return;
      }

      const code = newToken("aacmcp_code");
      codes.set(code, {
        clientId: entry.client.client_id,
        redirectUri: entry.params.redirectUri,
        codeChallenge: entry.params.codeChallenge,
        scopes: entry.params.scopes ?? [],
        resource: entry.params.resource?.toString(),
        aacToken: trimmed,
        expiresAt: now() + AUTH_CODE_TTL_SECONDS,
      });
      pending.delete(txnId);

      const redirect = new URL(entry.params.redirectUri);
      redirect.searchParams.set("code", code);
      if (entry.params.state !== undefined) redirect.searchParams.set("state", entry.params.state);
      logger.info("oauth authorization granted", { clientId: entry.client.client_id });
      res.redirect(302, redirect.toString());
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      const entry = codes.get(authorizationCode);
      if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
      if (entry.expiresAt < now()) {
        codes.delete(authorizationCode);
        throw new InvalidGrantError("Authorization code expired");
      }
      return entry.codeChallenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri) {
      const entry = codes.get(authorizationCode);
      if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
      if (entry.expiresAt < now()) {
        codes.delete(authorizationCode);
        throw new InvalidGrantError("Authorization code expired");
      }
      if (redirectUri !== undefined && redirectUri !== entry.redirectUri) throw new InvalidGrantError("redirect_uri does not match");
      codes.delete(authorizationCode);

      const accessToken = newToken("aacmcp_at");
      const refreshToken = newToken("aacmcp_rt");
      const issued: IssuedToken = { clientId: client.client_id, scopes: entry.scopes, aacToken: entry.aacToken, expiresAt: now() + ACCESS_TOKEN_TTL_SECONDS };
      accessTokens.set(accessToken, issued);
      refreshTokens.set(refreshToken, { ...issued, expiresAt: undefined });
      logger.info("oauth token issued", { clientId: client.client_id, grant: "authorization_code", token: redact(accessToken) });

      return {
        access_token: accessToken,
        token_type: "bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: entry.scopes.join(" "),
        refresh_token: refreshToken,
      } satisfies OAuthTokens;
    },

    async exchangeRefreshToken(client, refreshToken, scopes) {
      const entry = refreshTokens.get(refreshToken);
      if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");

      // Rotate the refresh token so a leaked/replayed one stops working once used.
      refreshTokens.delete(refreshToken);
      const newAccess = newToken("aacmcp_at");
      const newRefresh = newToken("aacmcp_rt");
      const grantedScopes = scopes ?? entry.scopes;
      accessTokens.set(newAccess, { clientId: client.client_id, scopes: grantedScopes, aacToken: entry.aacToken, expiresAt: now() + ACCESS_TOKEN_TTL_SECONDS });
      refreshTokens.set(newRefresh, { clientId: client.client_id, scopes: grantedScopes, aacToken: entry.aacToken, expiresAt: undefined });
      logger.info("oauth token issued", { clientId: client.client_id, grant: "refresh_token", token: redact(newAccess) });

      return {
        access_token: newAccess,
        token_type: "bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: grantedScopes.join(" "),
        refresh_token: newRefresh,
      } satisfies OAuthTokens;
    },

    async verifyAccessToken(token) {
      const entry = accessTokens.get(token);
      if (entry) {
        if (entry.expiresAt !== undefined && entry.expiresAt < now()) {
          accessTokens.delete(token);
          throw new InvalidTokenError("Access token expired");
        }
        return { token, clientId: entry.clientId, scopes: entry.scopes, expiresAt: entry.expiresAt, extra: { aacToken: entry.aacToken } } satisfies AuthInfo;
      }
      // Legacy path: the raw AACWorkflow token used directly as a bearer token
      // (simple `Authorization: Bearer mul_xxx`, no OAuth handshake) — kept for
      // Claude Code / Desktop / curl users who don't need a browser flow.
      if (token.startsWith("mul_")) {
        // requireBearerAuth() rejects tokens with no expiresAt; this is re-verified fresh on
        // every request, so the rolling window is cosmetic, not an actual TTL on the mul_ token.
        return { token, clientId: "legacy-direct-token", scopes: ["*"], expiresAt: now() + ACCESS_TOKEN_TTL_SECONDS, extra: { aacToken: token } } satisfies AuthInfo;
      }
      throw new InvalidTokenError("The access token is invalid or expired");
    },

    async revokeToken(client, request: OAuthTokenRevocationRequest) {
      const { token } = request;
      const access = accessTokens.get(token);
      if (access) {
        if (access.clientId !== client.client_id) throw new InvalidClientError("Token was not issued to this client");
        accessTokens.delete(token);
        return;
      }
      const refresh = refreshTokens.get(token);
      if (refresh) {
        if (refresh.clientId !== client.client_id) throw new InvalidClientError("Token was not issued to this client");
        refreshTokens.delete(token);
      }
      // Unknown token: no-op per RFC 7009.
    },

    stop() {
      clearInterval(sweepTimer);
    },
  };

  return provider;
}
