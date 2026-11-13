import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import pkceChallenge from "pkce-challenge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";

const realFetch = globalThis.fetch;

// buildApp() bakes publicUrl into OAuth issuer/redirect metadata at construction
// time, so the real listening port must be known before calling it.
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

describe("hosted HTTP app", () => {
  let server: Server;
  let baseUrl: string;
  let cleanup: () => void;

  beforeEach(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const built = buildApp({ serverUrl: "https://aac.example", publicUrl: baseUrl });
    cleanup = built.cleanup;
    await new Promise<void>((resolve) => {
      server = built.app.listen(port, "127.0.0.1", resolve);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    cleanup();
    await new Promise((resolve) => server.close(resolve));
  });

  async function oauthCredentials(aacToken = "mul_e2e_token") {
    // The server verifies the pasted token against SERVER_URL/api/me ("https://aac.example",
    // unroutable). Intercept only that upstream call; let everything else (incl. requests
    // this test makes to its own local baseUrl) hit the real network/local server.
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(url).startsWith("https://aac.example/")) return new Response(null, { status: 200 });
      return realFetch(url as any, init);
    });

    const pkce = await pkceChallenge();

    const regRes = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:1/cb"], token_endpoint_auth_method: "none", client_name: "Test Client" }),
    });
    expect(regRes.status).toBe(201);
    const client = await regRes.json();

    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", "http://127.0.0.1:1/cb");
    authorizeUrl.searchParams.set("code_challenge", pkce.code_challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "xyz");
    const authorizeRes = await fetch(authorizeUrl);
    expect(authorizeRes.status).toBe(200);
    const html = await authorizeRes.text();
    const txn = /name="txn" value="([^"]+)"/.exec(html)?.[1];
    expect(txn).toBeTruthy();

    // The consent page posts here; this exercises the exact route-ordering bug where
    // mcpAuthRouter's prefix-mounted "/authorize" handler used to swallow the request
    // body before it reached this handler. Redirect must not be auto-followed so we can
    // assert on the 302 + Location instead of whatever the (unreachable) callback returns.
    const verifyRes = await fetch(`${baseUrl}/authorize/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ txn: txn!, token: aacToken }),
      redirect: "manual",
    });
    expect(verifyRes.status).toBe(302);
    const location = new URL(verifyRes.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("http://127.0.0.1:1/cb");
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code")!;
    expect(code).toBeTruthy();

    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: pkce.code_verifier, client_id: client.client_id, redirect_uri: "http://127.0.0.1:1/cb" }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.access_token).toMatch(/^aacmcp_at_/);

    return { client, tokens };
  }

  it("reports health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "aacworkflow-mcp" });
  });

  it("publishes OAuth authorization server metadata", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = await res.json();
    expect(meta.authorization_endpoint).toBe(`${baseUrl}/authorize`);
    expect(meta.token_endpoint).toBe(`${baseUrl}/token`);
    expect(meta.registration_endpoint).toBe(`${baseUrl}/register`);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("publishes protected resource metadata pointing at the MCP endpoint", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const meta = await res.json();
    expect(meta.resource).toBe(`${baseUrl}/mcp`);
    expect(meta.authorization_servers).toEqual([`${baseUrl}/`]);
  });

  it("rejects unauthenticated /mcp requests with a 401 and WWW-Authenticate hint", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/resource_metadata/);
  });

  it("accepts a legacy raw mul_ bearer token and serves the full tool list over a real session", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer mul_test_token" } },
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.length).toBe(71);

    await client.close();
  });

  it("rejects a garbage bearer token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer garbage", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
    });
    expect(res.status).toBe(401);
  });

  it("runs the token-paste OAuth authorize page end to end", async () => {
    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "does-not-exist");
    const res = await fetch(authorizeUrl);
    // Unregistered client_id must be rejected before any redirect happens.
    expect(res.status).toBe(400);
  });

  it("completes a full OAuth round trip: register, authorize, verify, exchange, use the access token", async () => {
    const { tokens } = await oauthCredentials();

    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    const oauthClient = new Client({ name: "oauth-test-client", version: "0.0.0" });
    await oauthClient.connect(transport);
    const { tools } = await oauthClient.listTools();
    expect(tools.length).toBe(71);
    await oauthClient.close();
  });

  it("prevents another authenticated AACWorkflow identity from using, streaming, or deleting a session", async () => {
    const ownerTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer mul_owner_token" } },
    });
    const otherTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer mul_other_token" } },
    });
    const ownerClient = new Client({ name: "owner", version: "1" });
    const otherClient = new Client({ name: "other", version: "1" });
    await ownerClient.connect(ownerTransport);
    await otherClient.connect(otherTransport);
    try {
      expect((await otherClient.listTools()).tools).toHaveLength(71);
      for (const method of ["POST", "GET", "DELETE"]) {
        const response = await fetch(`${baseUrl}/mcp`, {
          method,
          headers: {
            Authorization: "Bearer mul_other_token",
            "Mcp-Session-Id": ownerTransport.sessionId!,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
          },
          body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }) : undefined,
        });
        expect(response.status, method).toBe(403);
        expect((await response.json()).error.message).toMatch(/authentication does not match/);
      }
      // A denied DELETE must leave the actual owner's session usable.
      expect((await ownerClient.listTools()).tools).toHaveLength(71);
    } finally {
      await ownerClient.close();
      await otherClient.close();
    }
  });

  it("binds an OAuth session to its client as well as the underlying AACWorkflow token", async () => {
    const owner = await oauthCredentials("mul_shared_upstream_token");
    const other = await oauthCredentials("mul_shared_upstream_token");
    expect(other.client.client_id).not.toBe(owner.client.client_id);
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${owner.tokens.access_token}` } },
    });
    const client = new Client({ name: "owner", version: "1" });
    await client.connect(transport);
    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${other.tokens.access_token}`,
          "Mcp-Session-Id": transport.sessionId!,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
      });
      expect(response.status).toBe(403);
      await response.json();
      expect((await client.listTools()).tools).toHaveLength(71);
    } finally {
      await client.close();
    }
  });

  it("keeps the same authenticated session usable after OAuth access-token rotation", async () => {
    const { client: registration, tokens } = await oauthCredentials();
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    const client = new Client({ name: "refresh-owner", version: "1" });
    await client.connect(transport);
    try {
      const refresh = await fetch(`${baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: registration.client_id }),
      });
      expect(refresh.status).toBe(200);
      const rotated = await refresh.json();
      expect(rotated.access_token).not.toBe(tokens.access_token);
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rotated.access_token}`,
          "Mcp-Session-Id": transport.sessionId!,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? text;
      expect(JSON.parse(data).result.tools).toHaveLength(71);
    } finally {
      await client.close();
    }
  });
});
