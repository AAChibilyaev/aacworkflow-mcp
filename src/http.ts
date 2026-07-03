#!/usr/bin/env node
/**
 * HTTP entry — reads env, starts the app, handles graceful shutdown.
 * App wiring itself lives in src/app.ts (kept separate so it's testable
 * without binding a real port).
 */
import { buildApp } from "./app.js";
import { logger } from "./logger.js";

const PORT = Number(process.env.PORT ?? 8787);
const SERVER_URL = process.env.AACWORKFLOW_SERVER_URL ?? "https://aacworkflow.com";
const PUBLIC_URL = process.env.AACWORKFLOW_MCP_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;

const { app, cleanup } = buildApp({ serverUrl: SERVER_URL, publicUrl: PUBLIC_URL });

const server = app.listen(PORT, () => {
  logger.info("aacworkflow-mcp listening", { port: PORT, upstream: SERVER_URL, publicUrl: PUBLIC_URL });
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  cleanup();
  server.close((err) => {
    if (err) {
      logger.error("error during shutdown", { error: String(err) });
      process.exit(1);
    }
    process.exit(0);
  });
  // Don't hang forever waiting on in-flight SSE streams.
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
