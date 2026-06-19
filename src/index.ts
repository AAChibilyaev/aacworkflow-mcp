#!/usr/bin/env node
/**
 * stdio entry — one local process, token from the environment.
 * Each user runs their own copy with their own AACWORKFLOW_TOKEN.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

const token = process.env.AACWORKFLOW_TOKEN ?? "";
if (!token) console.error("[aacworkflow-mcp] AACWORKFLOW_TOKEN is not set — create one at <server>/settings (Tokens).");

const server = buildServer({
  serverUrl: process.env.AACWORKFLOW_SERVER_URL ?? "https://aacworkflow.com",
  token,
  defaultWorkspace: process.env.AACWORKFLOW_WORKSPACE_ID,
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[aacworkflow-mcp] stdio ready");
