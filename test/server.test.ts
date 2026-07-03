import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";

type FetchCall = { url: string; init: RequestInit | undefined };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function connectedClient(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, cfg?: Partial<Parameters<typeof buildServer>[0]>) {
  const server = buildServer({ serverUrl: "https://aac.example", token: "mul_test_token", ...cfg });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function toolResult(res: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = (res as { content: Array<{ type: string; text: string }> }).content;
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]!.text);
}

describe("buildServer tools", () => {
  let calls: FetchCall[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls = [];
    fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the bearer token and JSON headers on every call", async () => {
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    await client.callTool({ name: "whoami", arguments: {} });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://aac.example/api/me");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mul_test_token");
    expect(headers.Accept).toBe("application/json");
  });

  it("scopes requests with the default workspace when one is configured", async () => {
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    await client.callTool({ name: "list_agents", arguments: {} });

    expect(calls[0]!.url).toBe("https://aac.example/api/agents?workspace_id=ws1");
  });

  it("auto-resolves the workspace when the token only has one", async () => {
    fetchMock.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ workspaces: [{ id: "only-ws", name: "Only" }] });
    });
    const client = await connectedClient(fetchMock);
    const result = await client.callTool({ name: "list_projects", arguments: {} });

    expect(calls[0]!.url).toBe("https://aac.example/api/workspaces");
    expect(calls[1]!.url).toBe("https://aac.example/api/projects?workspace_id=only-ws");
    expect(toolResult(result)).toEqual({ ok: true });
  });

  it("returns an actionable error when the token spans multiple workspaces and none was specified", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ workspaces: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }));
    const client = await connectedClient(fetchMock);
    const result = (await client.callTool({ name: "list_projects", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/multiple workspaces/);
  });

  it("surfaces upstream HTTP errors as tool errors instead of throwing", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("nope", { status: 403 }));
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    const result = (await client.callTool({ name: "list_agents", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/HTTP 403/);
  });

  it("builds nested resource paths and merges patch bodies for updates", async () => {
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    await client.callTool({ name: "update_issue", arguments: { id: "iss_1", patch: { status: "done" } } });

    expect(calls[0]!.url).toBe("https://aac.example/api/issues/iss_1?workspace_id=ws1");
    expect(calls[0]!.init?.method).toBe("PUT");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ status: "done" });
  });

  it("dispatches assign_issue_to_agent to the right shape", async () => {
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    await client.callTool({ name: "assign_issue_to_agent", arguments: { id: "iss_1", agent_id: "ag_1" } });

    expect(calls[0]!.url).toBe("https://aac.example/api/issues/iss_1?workspace_id=ws1");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ assignee_type: "agent", assignee_id: "ag_1" });
  });

  it("registers exactly the 69 documented tools", async () => {
    const client = await connectedClient(fetchMock);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(69);
    const names = tools.map((t) => t.name);
    expect(names).toContain("create_issue");
    expect(names).toContain("list_skills");
    expect(names).toContain("update_squad");
  });

  it("builds nested paths for the new skills/squad-member/workspace endpoints", async () => {
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });

    await client.callTool({ name: "delete_skill", arguments: { id: "sk_1" } });
    expect(calls[0]!.url).toBe("https://aac.example/api/skills/sk_1?workspace_id=ws1");
    expect(calls[0]!.init?.method).toBe("DELETE");

    await client.callTool({ name: "add_squad_member", arguments: { id: "sq_1", agent_id: "ag_1" } });
    expect(calls[1]!.url).toBe("https://aac.example/api/squads/sq_1/members?workspace_id=ws1");
    expect(JSON.parse(calls[1]!.init?.body as string)).toEqual({ member_type: "agent", member_id: "ag_1" });

    await client.callTool({ name: "update_workspace", arguments: { id: "ws1", patch: { name: "New Name" } } });
    expect(calls[2]!.url).toBe("https://aac.example/api/workspaces/ws1");
    expect(calls[2]!.init?.method).toBe("PUT");
    expect(JSON.parse(calls[2]!.init?.body as string)).toEqual({ name: "New Name" });
  });

  // Regression coverage for methods/paths confirmed against the live API — see commit history.
  it("uses PATCH (not PUT) for runtime and autopilot updates", async () => {
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });

    await client.callTool({ name: "update_runtime", arguments: { id: "rt_1", patch: { name: "x" } } });
    expect(calls[0]!.url).toBe("https://aac.example/api/runtimes/rt_1?workspace_id=ws1");
    expect(calls[0]!.init?.method).toBe("PATCH");

    await client.callTool({ name: "update_autopilot", arguments: { id: "ap_1", patch: { title: "x" } } });
    expect(calls[1]!.url).toBe("https://aac.example/api/autopilots/ap_1?workspace_id=ws1");
    expect(calls[1]!.init?.method).toBe("PATCH");
  });

  it("removes a squad member via DELETE with a member_id body, not a nested path", async () => {
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    await client.callTool({ name: "remove_squad_member", arguments: { id: "sq_1", agent_id: "ag_1" } });

    expect(calls[0]!.url).toBe("https://aac.example/api/squads/sq_1/members?workspace_id=ws1");
    expect(calls[0]!.init?.method).toBe("DELETE");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ member_id: "ag_1" });
  });

  it("attach/detach skill does a read-modify-write PUT over the full skill list", async () => {
    fetchMock.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse([{ id: "sk_existing" }]);
    });
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    await client.callTool({ name: "attach_skill_to_agent", arguments: { id: "ag_1", skill_id: "sk_new" } });

    expect(calls[0]!.url).toBe("https://aac.example/api/agents/ag_1/skills?workspace_id=ws1");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[1]!.init?.method).toBe("PUT");
    expect(JSON.parse(calls[1]!.init?.body as string)).toEqual({ skill_ids: ["sk_existing", "sk_new"] });
  });
});
