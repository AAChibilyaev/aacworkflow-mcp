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
    // Default mock returns an empty array — safe for both list_* (array outputSchema)
    // and single-resource tools that just merge it into a named field.
    fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the bearer token and JSON headers on every call", async () => {
    fetchMock.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ id: "u1", name: "Test", email: "t@example.com" });
    });
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

  it("auto-resolves the workspace when the token only has one (read tools only — writes require an explicit workspace_id)", async () => {
    fetchMock.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ workspaces: [{ id: "only-ws", name: "Only" }] });
    });
    const client = await connectedClient(fetchMock);
    const result = await client.callTool({ name: "list_projects", arguments: {} });

    expect(calls[0]!.url).toBe("https://aac.example/api/workspaces");
    expect(calls[1]!.url).toBe("https://aac.example/api/projects?workspace_id=only-ws");
    expect(toolResult(result)).toEqual({ projects: [] });
  });

  it("returns an actionable structured error when the token spans multiple workspaces and none was specified", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ workspaces: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }));
    const client = await connectedClient(fetchMock);
    const result = (await client.callTool({ name: "list_projects", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.code).toBe("INVALID_ARGUMENT");
    expect(body.message).toMatch(/multiple workspaces/);
    expect(body.retryable).toBe(false);
  });

  it("surfaces upstream HTTP errors as structured tool errors instead of throwing", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("nope", { status: 403 }));
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    const result = (await client.callTool({ name: "list_agents", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.code).toBe("FORBIDDEN");
    expect(body.message).toMatch(/HTTP 403/);
    expect(body.retryable).toBe(false);
  });

  it("maps a 429 to a retryable RATE_LIMITED error with retry_after_ms", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("slow down", { status: 429, headers: { "Retry-After": "3" } }));
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    const result = (await client.callTool({ name: "list_agents", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };

    const body = JSON.parse(result.content[0]!.text);
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retryable).toBe(true);
    expect(body.retry_after_ms).toBe(3000);
  });

  it("sends flat patch fields (no patch: wrapper) and requires workspace_id on write tools", async () => {
    fetchMock.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ id: "iss_1", title: "x", status: "done" });
    });
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    await client.callTool({ name: "update_issue", arguments: { id: "iss_1", status: "done", workspace_id: "ws1" } });

    expect(calls[0]!.url).toBe("https://aac.example/api/issues/iss_1?workspace_id=ws1");
    expect(calls[0]!.init?.method).toBe("PUT");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ status: "done" });
  });

  it("rejects a write tool call that omits the now-required workspace_id", async () => {
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    const result = (await client.callTool({ name: "update_issue", arguments: { id: "iss_1", status: "done" } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/workspace_id/);
    expect(calls).toHaveLength(0);
  });

  it("dispatches assign_issue_to_agent to the right shape", async () => {
    fetchMock.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ id: "iss_1" });
    });
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    await client.callTool({ name: "assign_issue_to_agent", arguments: { id: "iss_1", agent_id: "ag_1", workspace_id: "ws1" } });

    expect(calls[0]!.url).toBe("https://aac.example/api/issues/iss_1?workspace_id=ws1");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ assignee_type: "agent", assignee_id: "ag_1" });
  });

  it("registers exactly the 71 documented tools, including the discovery tools", async () => {
    const client = await connectedClient(fetchMock);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(71);
    const names = tools.map((t) => t.name);
    expect(names).toContain("create_issue");
    expect(names).toContain("list_skills");
    expect(names).toContain("update_squad");
    expect(names).toContain("get_capabilities");
    expect(names).toContain("get_metadata");
  });

  it("every tool declares ToolAnnotations, and every write tool is not readOnly", async () => {
    const client = await connectedClient(fetchMock);
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.annotations, `${t.name} is missing annotations`).toBeDefined();
    }
    const deleteIssue = tools.find((t) => t.name === "delete_issue")!;
    expect(deleteIssue.annotations?.readOnlyHint).toBe(false);
    expect(deleteIssue.annotations?.destructiveHint).toBe(true);
    const listIssues = tools.find((t) => t.name === "list_issues")!;
    expect(listIssues.annotations?.readOnlyHint).toBe(true);
    expect(listIssues.annotations?.destructiveHint).toBe(false);
    const importSkill = tools.find((t) => t.name === "import_skill")!;
    expect(importSkill.annotations?.openWorldHint).toBe(true);
  });

  it("get_capabilities reports scopes and Run API as not implemented, by design", async () => {
    const client = await connectedClient(fetchMock);
    const result = await client.callTool({ name: "get_capabilities", arguments: {} });
    const body = toolResult(result) as any;
    expect(body.features.per_tool_oauth_scopes).toBe(false);
    expect(body.features.run_pause_resume_retry).toBe(false);
    expect(body.excluded_by_design.length).toBeGreaterThanOrEqual(2);
  });

  it("get_metadata enumerates the real enums used by the tool schemas", async () => {
    const client = await connectedClient(fetchMock);
    const result = await client.callTool({ name: "get_metadata", arguments: {} });
    const body = toolResult(result) as any;
    expect(body.issue_statuses).toEqual(["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"]);
    expect(body.issue_priorities).toContain("none");
    expect(body.issue_priorities).not.toContain("no_priority");
    expect(body.assignee_types).toEqual(["agent", "member", "squad"]);
  });

  it("builds nested paths for skills/squad-member/workspace endpoints", async () => {
    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ id: "x" });
    });
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });

    await client.callTool({ name: "delete_skill", arguments: { id: "sk_1", workspace_id: "ws1" } });
    expect(calls[0]!.url).toBe("https://aac.example/api/skills/sk_1?workspace_id=ws1");
    expect(calls[0]!.init?.method).toBe("DELETE");

    await client.callTool({ name: "add_squad_member", arguments: { id: "sq_1", agent_id: "ag_1", workspace_id: "ws1" } });
    expect(calls[1]!.url).toBe("https://aac.example/api/squads/sq_1/members?workspace_id=ws1");
    expect(JSON.parse(calls[1]!.init?.body as string)).toEqual({ member_type: "agent", member_id: "ag_1" });

    await client.callTool({ name: "update_workspace", arguments: { id: "ws1", name: "New Name" } });
    expect(calls[2]!.url).toBe("https://aac.example/api/workspaces/ws1");
    expect(calls[2]!.init?.method).toBe("PUT");
    expect(JSON.parse(calls[2]!.init?.body as string)).toEqual({ name: "New Name" });
  });

  // Regression coverage for methods/paths confirmed against the live API — see commit history.
  it("uses PATCH (not PUT) for runtime and autopilot updates", async () => {
    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ id: "x" });
    });
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });

    await client.callTool({ name: "update_runtime", arguments: { id: "rt_1", custom_name: "x", workspace_id: "ws1" } });
    expect(calls[0]!.url).toBe("https://aac.example/api/runtimes/rt_1?workspace_id=ws1");
    expect(calls[0]!.init?.method).toBe("PATCH");

    await client.callTool({ name: "update_autopilot", arguments: { id: "ap_1", title: "x", workspace_id: "ws1" } });
    expect(calls[1]!.url).toBe("https://aac.example/api/autopilots/ap_1?workspace_id=ws1");
    expect(calls[1]!.init?.method).toBe("PATCH");
  });

  it("removes a squad member via DELETE with a member_id/member_type body, not a nested path", async () => {
    fetchMock.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ id: "x" });
    });
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    await client.callTool({ name: "remove_squad_member", arguments: { id: "sq_1", member_id: "ag_1", workspace_id: "ws1" } });

    expect(calls[0]!.url).toBe("https://aac.example/api/squads/sq_1/members?workspace_id=ws1");
    expect(calls[0]!.init?.method).toBe("DELETE");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ member_id: "ag_1", member_type: "agent" });
  });

  it("attach/detach skill does a read-modify-write PUT over the full skill list", async () => {
    fetchMock.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse([{ id: "sk_existing" }]);
    });
    fetchMock.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse([{ id: "sk_existing" }, { id: "sk_new" }]);
    });
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    await client.callTool({ name: "attach_skill_to_agent", arguments: { id: "ag_1", skill_id: "sk_new", workspace_id: "ws1" } });

    expect(calls[0]!.url).toBe("https://aac.example/api/agents/ag_1/skills?workspace_id=ws1");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[1]!.init?.method).toBe("PUT");
    expect(JSON.parse(calls[1]!.init?.body as string)).toEqual({ skill_ids: ["sk_existing", "sk_new"] });
  });

  it("delete_issue with dry_run:true fetches the issue instead of deleting it", async () => {
    fetchMock.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ id: "iss_1", title: "Would be deleted" });
    });
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    const result = await client.callTool({ name: "delete_issue", arguments: { id: "iss_1", dry_run: true, workspace_id: "ws1" } });

    expect(calls[0]!.init?.method).toBe("GET");
    expect(toolResult(result)).toEqual({ deleted: false, issue: { id: "iss_1", title: "Would be deleted" } });
  });

  it("create_issue reports dispatched:true only when an assignee was set", async () => {
    fetchMock.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ id: "iss_1", title: "x" });
    });
    const client = await connectedClient(fetchMock, { defaultWorkspace: "ws1" });
    const result = await client.callTool({
      name: "create_issue",
      arguments: { title: "x", assignee_type: "agent", assignee_id: "ag_1", workspace_id: "ws1" },
    });

    expect(toolResult(result)).toEqual({ issue: { id: "iss_1", title: "x" }, dispatched: true });
  });
});
