import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkceChallenge from "pkce-challenge";
import { createOAuthProvider, type OAuthProvider } from "../src/oauth.js";
import { InvalidGrantError, InvalidScopeError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthStateFile, type OAuthStateConfig } from "../src/oauth-state.js";

function fakeRes() {
  const state = { statusCode: 200, body: "", redirectedTo: undefined as string | undefined };
  const res: any = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    type() {
      return res;
    },
    send(body: string) {
      state.body = body;
      return res;
    },
    redirect(code: number, url: string) {
      state.statusCode = code;
      state.redirectedTo = url;
      return res;
    },
  };
  return { res, state };
}

const CLIENT: OAuthClientInformationFull = {
  client_id: "client-1",
  redirect_uris: ["https://client.example/callback"],
  client_name: "Test Client",
};

describe("OAuth 2.1 provider", () => {
  let provider: OAuthProvider;
  let fetchMock: ReturnType<typeof vi.fn>;
  const temporaryDirs: string[] = [];

  beforeEach(() => {
    provider = createOAuthProvider({ serverUrl: "https://aac.example" });
    provider.clientsStore.registerClient!(CLIENT);
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    provider.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function stateConfig(): OAuthStateConfig {
    const dir = mkdtempSync(join(tmpdir(), "aacworkflow-oauth-test-"));
    temporaryDirs.push(dir);
    return { file: join(dir, "oauth-state.enc"), key: "11".repeat(32) };
  }

  function restart(state: OAuthStateConfig) {
    provider.stop();
    provider = createOAuthProvider({ serverUrl: "https://aac.example", state });
  }

  async function runFullFlow(aacToken: string, scopes = ["aacworkflow"]) {
    const pkce = await pkceChallenge();
    const { res: authRes, state: authState } = fakeRes();
    await provider.authorize(CLIENT, { state: "xyz", scopes, redirectUri: CLIENT.redirect_uris[0]!, codeChallenge: pkce.code_challenge }, authRes);
    const txn = /name="txn" value="([^"]+)"/.exec(authState.body)?.[1];
    expect(txn).toBeTruthy();

    fetchMock.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const ok = headers.Authorization === `Bearer ${aacToken}`;
      return new Response(null, { status: ok ? 200 : 401 });
    });

    const { res: verifyRes, state: verifyState } = fakeRes();
    await provider.completeAuthorization(txn!, aacToken, verifyRes);
    return { verifyState, pkce };
  }

  it("completes authorize -> verify -> code exchange -> access token", async () => {
    const { verifyState, pkce } = await runFullFlow("mul_good_token");
    expect(verifyState.redirectedTo).toMatch(/^https:\/\/client\.example\/callback\?code=/);
    const redirectUrl = new URL(verifyState.redirectedTo!);
    expect(redirectUrl.searchParams.get("state")).toBe("xyz");
    const code = redirectUrl.searchParams.get("code")!;

    const challenge = await provider.challengeForAuthorizationCode(CLIENT, code);
    expect(challenge).toBe(pkce.code_challenge);

    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0]);
    expect(tokens.access_token).toMatch(/^aacmcp_at_/);
    expect(tokens.refresh_token).toMatch(/^aacmcp_rt_/);

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.extra?.aacToken).toBe("mul_good_token");
    expect(info.clientId).toBe(CLIENT.client_id);

    // Codes are single-use.
    await expect(provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0])).rejects.toThrow(InvalidGrantError);
  });

  it("re-renders the consent page with an error when the pasted token is rejected", async () => {
    const pkce = await pkceChallenge();
    const { res: authRes, state: authState } = fakeRes();
    await provider.authorize(CLIENT, { redirectUri: CLIENT.redirect_uris[0]!, codeChallenge: pkce.code_challenge }, authRes);
    const txn = /name="txn" value="([^"]+)"/.exec(authState.body)?.[1]!;

    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 401 }));
    const { res: verifyRes, state: verifyState } = fakeRes();
    await provider.completeAuthorization(txn, "mul_bad_token", verifyRes);

    expect(verifyState.redirectedTo).toBeUndefined();
    expect(verifyState.body).toMatch(/rejected/);
  });

  it("rejects a submission for an unknown/expired transaction", async () => {
    const { res, state } = fakeRes();
    await provider.completeAuthorization("does-not-exist", "mul_x", res);
    expect(state.statusCode).toBe(400);
    expect(state.body).toMatch(/expired/);
  });

  it("legacy pass-through accepts a raw mul_ bearer token directly", async () => {
    const info = await provider.verifyAccessToken("mul_some_raw_token");
    expect(info.extra?.aacToken).toBe("mul_some_raw_token");
    expect(info.clientId).toBe("legacy-direct-token");
  });

  it("rejects unknown, non-mul_ tokens", async () => {
    await expect(provider.verifyAccessToken("garbage")).rejects.toThrow(InvalidTokenError);
  });

  it("revokeToken makes an access token invalid", async () => {
    const { verifyState, pkce } = await runFullFlow("mul_good_token");
    const code = new URL(verifyState.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0]);

    await provider.revokeToken!(CLIENT, { token: tokens.access_token! });
    await expect(provider.verifyAccessToken(tokens.access_token!)).rejects.toThrow(InvalidTokenError);
  });

  it("exchangeRefreshToken issues a new access token and rotates the refresh token", async () => {
    const { verifyState, pkce } = await runFullFlow("mul_good_token");
    const code = new URL(verifyState.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0]);

    const refreshed = await provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    const info = await provider.verifyAccessToken(refreshed.access_token);
    expect(info.extra?.aacToken).toBe("mul_good_token");

    await expect(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!)).rejects.toThrow(InvalidGrantError);
  });

  it("rejects refresh scope expansion without consuming the original refresh token", async () => {
    const { verifyState, pkce } = await runFullFlow("mul_good_token");
    const code = new URL(verifyState.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0]);

    await expect(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!, ["aacworkflow", "offline_access"])).rejects.toThrow(InvalidScopeError);
    const valid = await provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!, ["aacworkflow"]);
    expect(valid.scope).toBe("aacworkflow");
  });

  it("allows narrower refresh scopes and prevents a later refresh from expanding them again", async () => {
    const { verifyState, pkce } = await runFullFlow("mul_good_token", ["aacworkflow", "offline_access"]);
    const code = new URL(verifyState.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0]);
    const narrowed = await provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!, ["aacworkflow"]);
    expect((await provider.verifyAccessToken(narrowed.access_token)).scopes).toEqual(["aacworkflow"]);
    await expect(provider.exchangeRefreshToken(CLIENT, narrowed.refresh_token!, ["aacworkflow", "offline_access"])).rejects.toThrow(InvalidScopeError);
  });

  it("retains registered clients and encrypted access/refresh tokens across restarts", async () => {
    const state = stateConfig();
    restart(state);
    await provider.clientsStore.registerClient!(CLIENT);
    const { verifyState, pkce } = await runFullFlow("mul_persistent_token");
    const code = new URL(verifyState.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0]);

    expect(statSync(state.file).mode & 0o777).toBe(0o600);
    const encrypted = readFileSync(state.file).toString("utf8");
    expect(encrypted).not.toContain("mul_persistent_token");
    expect(encrypted).not.toContain(tokens.access_token);
    expect(encrypted).not.toContain(tokens.refresh_token);

    restart(state);
    expect(await provider.clientsStore.getClient(CLIENT.client_id)).toEqual(CLIENT);
    expect((await provider.verifyAccessToken(tokens.access_token)).extra?.aacToken).toBe("mul_persistent_token");
    const refreshed = await provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!);
    restart(state);
    await expect(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!)).rejects.toThrow(InvalidGrantError);
    expect((await provider.verifyAccessToken(refreshed.access_token)).clientId).toBe(CLIENT.client_id);
    await expect(provider.exchangeRefreshToken(CLIENT, refreshed.refresh_token!)).resolves.toHaveProperty("access_token");
  });

  it("keeps revoked tokens revoked after restart", async () => {
    const state = stateConfig();
    restart(state);
    await provider.clientsStore.registerClient!(CLIENT);
    const { verifyState, pkce } = await runFullFlow("mul_persistent_token");
    const code = new URL(verifyState.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0]);
    await provider.revokeToken!(CLIENT, { token: tokens.access_token });
    await provider.revokeToken!(CLIENT, { token: tokens.refresh_token! });

    restart(state);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(InvalidTokenError);
    await expect(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!)).rejects.toThrow(InvalidGrantError);
  });

  it("expires and removes saved access tokens without invalidating renewable refresh tokens", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = stateConfig();
    restart(state);
    await provider.clientsStore.registerClient!(CLIENT);
    const { verifyState, pkce } = await runFullFlow("mul_persistent_token");
    const code = new URL(verifyState.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0]);
    vi.setSystemTime(Date.now() + 3_601_000);

    restart(state);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(InvalidTokenError);
    expect(new OAuthStateFile(state).load()).toMatchObject({ accessTokens: [] });
    await expect(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!)).resolves.toHaveProperty("access_token");
  });

  it("fails closed on a wrong key or tampered ciphertext and preserves the existing file", () => {
    const state = stateConfig();
    restart(state);
    const original = readFileSync(state.file);
    expect(() => createOAuthProvider({ serverUrl: "https://aac.example", state: { ...state, key: "22".repeat(32) } })).toThrow(/Cannot decrypt OAuth state/);
    expect(readFileSync(state.file)).toEqual(original);

    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    writeFileSync(state.file, tampered);
    expect(() => createOAuthProvider({ serverUrl: "https://aac.example", state })).toThrow(/Cannot decrypt OAuth state/);
    expect(readFileSync(state.file)).toEqual(tampered);
  });

  it("rejects an invalid saved state rather than starting with empty OAuth maps", () => {
    const state = stateConfig();
    new OAuthStateFile(state).save({ version: 99, clients: [], accessTokens: [], refreshTokens: [] });
    expect(() => createOAuthProvider({ serverUrl: "https://aac.example", state })).toThrow(/Invalid encrypted OAuth state schema/);
    expect(() => new OAuthStateFile({ ...state, key: "not-a-key" })).toThrow(/encryption key/);
  });

  it("disables authorization after a durable write fails instead of accepting unsaved state", async () => {
    const state = stateConfig();
    state.file = join(temporaryDirs[temporaryDirs.length - 1]!, "active", "oauth-state.enc");
    restart(state);
    const active = join(temporaryDirs[temporaryDirs.length - 1]!, "active");
    renameSync(active, `${active}.offline`);
    writeFileSync(active, "blocked storage directory");

    expect(() => provider.clientsStore.registerClient!(CLIENT)).toThrow(/Cannot persist encrypted OAuth state/);
    expect(provider.isHealthy()).toBe(false);
    await expect(provider.verifyAccessToken("mul_legacy_token")).rejects.toThrow(/storage is unavailable/);
    expect(() => provider.clientsStore.getClient(CLIENT.client_id)).toThrow(/storage is unavailable/);
  });

  it("handles an expiry-sweep write failure by disabling authorization without an uncaught timer error", async () => {
    provider.stop();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const state = stateConfig();
    const active = join(temporaryDirs[temporaryDirs.length - 1]!, "active");
    state.file = join(active, "oauth-state.enc");
    restart(state);
    await provider.clientsStore.registerClient!(CLIENT);
    const { verifyState, pkce } = await runFullFlow("mul_persistent_token");
    const code = new URL(verifyState.redirectedTo!).searchParams.get("code")!;
    await provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0]);
    renameSync(active, `${active}.offline`);
    writeFileSync(active, "blocked storage directory");

    expect(() => vi.advanceTimersByTime(3_900_001)).not.toThrow();
    expect(provider.isHealthy()).toBe(false);
    await expect(provider.verifyAccessToken("mul_legacy_token")).rejects.toThrow(/storage is unavailable/);
  });

  it("serializes concurrent issuance and rotation without losing durable state", async () => {
    const state = stateConfig();
    restart(state);
    await provider.clientsStore.registerClient!(CLIENT);
    const issued = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
      const { verifyState, pkce } = await runFullFlow(`mul_parallel_token_${i}`);
      const code = new URL(verifyState.redirectedTo!).searchParams.get("code")!;
      return provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0]);
    }));
    const refreshed = await Promise.all(issued.map((token) => provider.exchangeRefreshToken(CLIENT, token.refresh_token!)));

    restart(state);
    for (const token of issued) await expect(provider.exchangeRefreshToken(CLIENT, token.refresh_token!)).rejects.toThrow(InvalidGrantError);
    for (const token of refreshed) expect((await provider.verifyAccessToken(token.access_token)).clientId).toBe(CLIENT.client_id);
  });
});
