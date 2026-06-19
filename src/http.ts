#!/usr/bin/env node
/**
 * HTTP entry — one hosted endpoint, MULTI-TENANT, remote-MCP compatible.
 *
 * Works as a remote connector for Claude Code, claude.ai and ChatGPT from
 * anywhere. Each user authenticates with their OWN AACWorkflow token in the
 * Authorization header at session start; the server binds that token to the
 * session and uses only it — so every user drives their own workspaces
 * (companies). No shared credentials.
 *
 * Endpoints (MCP Streamable HTTP):
 *   POST /mcp    initialize (Authorization: Bearer <mul_ token>) + JSON-RPC
 *   GET  /mcp    server→client SSE stream (uses Mcp-Session-Id)
 *   DELETE /mcp  terminate session
 *   GET  /health
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8787);
const SERVER_URL = process.env.AACWORKFLOW_SERVER_URL ?? "https://aacworkflow.com";

const app = express();
app.use(express.json({ limit: "4mb" }));

// CORS so browser-based MCP clients (claude.ai / ChatGPT) can reach it.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.header("origin") ?? "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, X-Workspace-Id");
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "aacworkflow-mcp", upstream: SERVER_URL }));

const transports: Record<string, StreamableHTTPServerTransport> = {};
const bearer = (req: Request): string => {
  const m = (req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? (typeof req.query.token === "string" ? req.query.token : "");
};

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const sid = req.header("mcp-session-id");
    let transport = sid ? transports[sid] : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      const token = bearer(req);
      if (!token) {
        res.status(401).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Missing 'Authorization: Bearer <aacworkflow token>'" } });
        return;
      }
      const workspace = req.header("x-workspace-id") || (typeof req.query.workspace_id === "string" ? req.query.workspace_id : undefined);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports[id] = transport!; },
      });
      transport.onclose = () => { if (transport!.sessionId) delete transports[transport!.sessionId]; };
      const server = buildServer({ serverUrl: SERVER_URL, token, defaultWorkspace: workspace });
      await server.connect(transport);
    }

    if (!transport) {
      res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "No valid session — send an initialize request with an Authorization header first." } });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(e instanceof Error ? e.message : e) } });
  }
});

const sessionStream = async (req: Request, res: Response) => {
  const sid = req.header("mcp-session-id");
  const transport = sid ? transports[sid] : undefined;
  if (!transport) { res.status(400).send("Unknown or missing Mcp-Session-Id"); return; }
  await transport.handleRequest(req, res);
};
app.get("/mcp", sessionStream);
app.delete("/mcp", sessionStream);

app.listen(PORT, () => console.error(`[aacworkflow-mcp] remote MCP on :${PORT} → ${SERVER_URL}`));
