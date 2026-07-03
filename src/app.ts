/**
 * Express app for the hosted, multi-tenant HTTP transport — testable in
 * isolation (no listen()/process lifecycle here, see src/http.ts for that).
 *
 * Auth: two ways in, both ending at the same buildServer(token) call —
 *  - legacy: `Authorization: Bearer mul_xxx` straight from the user, no OAuth
 *    handshake (what Claude Code / Desktop / curl use today).
 *  - OAuth 2.1: authorization_code + PKCE via the router installed below,
 *    ending in an opaque `aacmcp_at_…` token that maps back to a mul_ token
 *    (what claude.ai / ChatGPT connectors require). See src/oauth.ts.
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { buildServer } from "./server.js";
import { createOAuthProvider } from "./oauth.js";
import { logger } from "./logger.js";

export type AppCfg = {
  /** AACWorkflow backend, e.g. https://aacworkflow.com */
  serverUrl: string;
  /** Public origin this app is reachable at, e.g. https://mcp.example.com or http://127.0.0.1:8787 for local/dev. */
  publicUrl: string;
};

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_REAP_INTERVAL_MS = 5 * 60 * 1000;

export function buildApp(cfg: AppCfg): { app: express.Express; cleanup: () => void } {
  const SERVER_URL = cfg.serverUrl.replace(/\/+$/, "");
  const PUBLIC_URL = new URL(cfg.publicUrl);
  const MCP_URL = new URL("/mcp", PUBLIC_URL);

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", req.header("origin") ?? "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, X-Workspace-Id");
    res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use((req, res, next) => {
    const start = Date.now();
    // Capture originalUrl now — Express strips the mount-path prefix off req.url/req.path
    // while a request is inside a path-mounted middleware (e.g. app.use("/mcp", ...)) and
    // only restores it on next(), so reading req.path lazily inside 'finish' can see a
    // truncated path if the request was rejected by such middleware.
    const path = req.originalUrl;
    res.on("finish", () => {
      logger.info("http request", {
        method: req.method,
        path,
        status: res.statusCode,
        ms: Date.now() - start,
        sessionId: req.header("mcp-session-id"),
      });
    });
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, service: "aacworkflow-mcp", upstream: SERVER_URL }));

  const oauthProvider = createOAuthProvider({ serverUrl: SERVER_URL });

  // Consent-form submission for the token-paste page rendered by oauthProvider.authorize().
  // Must be registered BEFORE mcpAuthRouter below: that router mounts its authorize handler
  // as a prefix match on "/authorize", so it would otherwise intercept "/authorize/verify"
  // too, drain the request body with its own urlencoded() parser, and 404/500 on the way out.
  app.post("/authorize/verify", express.urlencoded({ extended: false }), async (req, res) => {
    const txn = typeof req.body?.txn === "string" ? req.body.txn : "";
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!txn) {
      res.status(400).send("Missing txn");
      return;
    }
    await oauthProvider.completeAuthorization(txn, token, res);
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: PUBLIC_URL,
      resourceServerUrl: MCP_URL,
      resourceName: "AACWorkflow",
      scopesSupported: ["aacworkflow"],
    }),
  );

  app.use("/mcp", rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
  app.use(
    "/mcp",
    requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(MCP_URL) }),
  );

  type SessionEntry = { transport: StreamableHTTPServerTransport; lastActivity: number };
  const sessions = new Map<string, SessionEntry>();

  const reapTimer = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_TIMEOUT_MS;
    for (const [id, s] of sessions) {
      if (s.lastActivity < cutoff) {
        logger.info("reaping idle mcp session", { sessionId: id });
        sessions.delete(id);
        void s.transport.close();
      }
    }
  }, SESSION_REAP_INTERVAL_MS);
  reapTimer.unref?.();

  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const sid = req.header("mcp-session-id");
      const existing = sid ? sessions.get(sid) : undefined;

      if (!existing && isInitializeRequest(req.body)) {
        const aacToken = req.auth?.extra?.aacToken as string | undefined;
        if (!aacToken) {
          res.status(401).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Missing AACWorkflow token" } });
          return;
        }
        const workspace = req.header("x-workspace-id") || (typeof req.query.workspace_id === "string" ? req.query.workspace_id : undefined);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, lastActivity: Date.now() });
            logger.info("mcp session started", { sessionId: id });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            logger.info("mcp session closed", { sessionId: transport.sessionId });
          }
        };
        const server = buildServer({ serverUrl: SERVER_URL, token: aacToken, defaultWorkspace: workspace });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!existing) {
        res.status(400).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "No valid session — send an initialize request with an Authorization header first." },
        });
        return;
      }
      existing.lastActivity = Date.now();
      await existing.transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(e instanceof Error ? e.message : e) } });
    }
  });

  const sessionStream = async (req: Request, res: Response) => {
    const sid = req.header("mcp-session-id");
    const existing = sid ? sessions.get(sid) : undefined;
    if (!existing) {
      res.status(400).send("Unknown or missing Mcp-Session-Id");
      return;
    }
    existing.lastActivity = Date.now();
    await existing.transport.handleRequest(req, res);
  };
  app.get("/mcp", sessionStream);
  app.delete("/mcp", sessionStream);

  function cleanup() {
    clearInterval(reapTimer);
    oauthProvider.stop();
    for (const s of sessions.values()) void s.transport.close();
    sessions.clear();
  }

  return { app, cleanup };
}
