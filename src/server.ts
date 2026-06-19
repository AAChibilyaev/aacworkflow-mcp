/**
 * buildServer — constructs an McpServer bound to one AACWorkflow identity.
 *
 * The same factory powers both transports:
 *  - stdio (src/index.ts): one process, token from env.
 *  - HTTP  (src/http.ts):  one hosted endpoint, token taken per-request from
 *    the Authorization header — so every connecting user drives their own
 *    workspaces (companies) with their own token. No shared credentials.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Cfg = { serverUrl: string; token: string; defaultWorkspace?: string };

export function buildServer(cfg: Cfg): McpServer {
  const SERVER_URL = cfg.serverUrl.replace(/\/+$/, "");
  const TOKEN = cfg.token;
  const DEFAULT_WORKSPACE = cfg.defaultWorkspace ?? "";

  type ApiOpts = { query?: Record<string, string | undefined>; body?: unknown; workspaceId?: string; scoped?: boolean };

  async function api(method: string, path: string, opts: ApiOpts = {}): Promise<unknown> {
    const url = new URL(SERVER_URL + path);
    if (opts.scoped !== false && opts.workspaceId) url.searchParams.set("workspace_id", opts.workspaceId);
    if (opts.query) for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}: ${text.slice(0, 500)}`);
    try { return text ? JSON.parse(text) : null; } catch { return text; }
  }

  let wsCache: Array<{ id: string; name: string; slug?: string }> | null = null;
  async function listWorkspacesRaw() {
    if (wsCache) return wsCache;
    const data = (await api("GET", "/api/workspaces", { scoped: false })) as any;
    const arr = Array.isArray(data) ? data : data?.workspaces ?? data?.data ?? [];
    wsCache = arr.map((w: any) => ({ id: w.id, name: w.name, slug: w.slug }));
    return wsCache!;
  }
  async function resolveWorkspace(arg?: string): Promise<string> {
    if (arg) return arg;
    if (DEFAULT_WORKSPACE) return DEFAULT_WORKSPACE;
    const list = await listWorkspacesRaw();
    if (list.length === 1) return list[0].id;
    throw new Error(
      list.length === 0
        ? "This token has no workspaces. Create/join one at " + SERVER_URL
        : "You belong to multiple workspaces — pass workspace_id. Available: " + list.map((w) => `${w.name} (${w.id})`).join("; "),
    );
  }

  const server = new McpServer({ name: "aacworkflow-mcp", version: "0.3.0" });
  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  const oops = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: String(e instanceof Error ? e.message : e) }] });
  const wsArg = { workspace_id: z.string().optional().describe("Workspace/company id. Omit to use the default or your only workspace.") };

  const scoped = (name: string, desc: string, shape: any, run: (ws: string, args: any) => Promise<unknown>) =>
    server.tool(name, desc, { ...shape, ...wsArg }, async (args: any) => {
      try { return ok(await run(await resolveWorkspace(args.workspace_id), args)); } catch (e) { return oops(e); }
    });
  const global_ = (name: string, desc: string, shape: any, run: (args: any) => Promise<unknown>) =>
    server.tool(name, desc, shape, async (args: any) => {
      try { return ok(await run(args)); } catch (e) { return oops(e); }
    });

  // Account / workspaces
  global_("whoami", "Get the authenticated user/account for the current token.", {}, () => api("GET", "/api/me", { scoped: false }));
  global_("list_workspaces", "List the workspaces (companies) this token can access.", {}, async () => { wsCache = null; return listWorkspacesRaw(); });
  scoped("list_members", "List members of a workspace.", {}, (ws) => api("GET", `/api/workspaces/${ws}/members`, { scoped: false }));
  scoped("list_runtimes", "List agent runtimes (machines) in the workspace.", {}, (ws) => api("GET", "/api/runtimes", { workspaceId: ws }));

  // Agents
  scoped("list_agents", "List agents in the workspace.", {}, (ws) => api("GET", "/api/agents", { workspaceId: ws }));
  scoped("get_agent", "Get full details of one agent.", { id: z.string() }, (ws, a) => api("GET", `/api/agents/${a.id}`, { workspaceId: ws }));
  scoped("create_agent", "Create an agent on a runtime. Use visibility 'workspace' so all members can use it.", {
    name: z.string(), runtime_id: z.string().describe("from list_runtimes"), description: z.string().optional(),
    instructions: z.string().optional(), model: z.string().optional(), visibility: z.enum(["private", "workspace"]).optional(),
    max_concurrent_tasks: z.number().int().optional(),
  }, (ws, { workspace_id, ...body }) => api("POST", "/api/agents", { workspaceId: ws, body }));
  scoped("update_agent", "Update an agent.", { id: z.string(), patch: z.record(z.any()) }, (ws, a) => api("PUT", `/api/agents/${a.id}`, { workspaceId: ws, body: a.patch }));
  scoped("list_agent_templates", "List built-in agent template slugs.", {}, (ws) => api("GET", "/api/agent-templates", { workspaceId: ws }));
  scoped("create_agent_from_template", "Create an agent from a template slug.", {
    slug: z.string(), runtime_id: z.string(), name: z.string().optional(), visibility: z.enum(["private", "workspace"]).optional(),
  }, (ws, { workspace_id, slug, ...rest }) => api("POST", "/api/agents/from-template", { workspaceId: ws, body: { template_slug: slug, slug, ...rest } }));
  scoped("list_agent_tasks", "List tasks an agent has worked on.", { id: z.string() }, (ws, a) => api("GET", `/api/agents/${a.id}/tasks`, { workspaceId: ws }));

  // Issues (tasks)
  scoped("list_issues", "List issues (tasks). Filter by status / assignee / project.", {
    status: z.string().optional(), assignee_type: z.string().optional(), assignee_id: z.string().optional(), project_id: z.string().optional(),
  }, (ws, { workspace_id, ...q }) => api("GET", "/api/issues", { workspaceId: ws, query: q }));
  scoped("get_issue", "Get one issue (task) with full detail.", { id: z.string() }, (ws, a) => api("GET", `/api/issues/${a.id}`, { workspaceId: ws }));
  scoped("create_issue", "Create a task. Dispatch to an agent with assignee_type='agent' + assignee_id.", {
    title: z.string(), description: z.string().optional(),
    priority: z.enum(["urgent", "high", "medium", "low", "no_priority"]).optional(), status: z.string().optional(),
    project_id: z.string().optional(), parent_issue_id: z.string().optional(),
    assignee_type: z.enum(["agent", "user"]).optional(), assignee_id: z.string().optional(),
    due_date: z.string().optional().describe("ISO YYYY-MM-DD"),
  }, (ws, { workspace_id, ...body }) => api("POST", "/api/issues", { workspaceId: ws, body }));
  scoped("update_issue", "Update an issue.", { id: z.string(), patch: z.record(z.any()) }, (ws, a) => api("PUT", `/api/issues/${a.id}`, { workspaceId: ws, body: a.patch }));
  scoped("assign_issue_to_agent", "Assign an existing issue to an agent (dispatches the task).", { id: z.string(), agent_id: z.string() }, (ws, a) => api("PUT", `/api/issues/${a.id}`, { workspaceId: ws, body: { assignee_type: "agent", assignee_id: a.agent_id } }));
  scoped("rerun_issue", "Re-run an issue's agent task.", { id: z.string() }, (ws, a) => api("POST", `/api/issues/${a.id}/rerun`, { workspaceId: ws, body: {} }));
  scoped("comment_issue", "Add a comment to an issue.", { id: z.string(), body: z.string() }, (ws, a) => api("POST", `/api/issues/${a.id}/comments`, { workspaceId: ws, body: { body: a.body } }));
  scoped("list_comments", "List comments on an issue.", { id: z.string() }, (ws, a) => api("GET", `/api/issues/${a.id}/comments`, { workspaceId: ws }));
  scoped("search_issues", "Full-text search issues.", { q: z.string() }, (ws, a) => api("GET", "/api/issues/search", { workspaceId: ws, query: { q: a.q } }));

  // Projects / labels
  scoped("list_projects", "List projects in the workspace.", {}, (ws) => api("GET", "/api/projects", { workspaceId: ws }));
  scoped("create_project", "Create a project.", { name: z.string(), description: z.string().optional() }, (ws, { workspace_id, ...body }) => api("POST", "/api/projects", { workspaceId: ws, body }));
  scoped("list_labels", "List issue labels.", {}, (ws) => api("GET", "/api/labels", { workspaceId: ws }));
  scoped("create_label", "Create an issue label.", { name: z.string(), color: z.string().optional() }, (ws, { workspace_id, ...body }) => api("POST", "/api/labels", { workspaceId: ws, body }));

  // Squads
  scoped("list_squads", "List squads (teams).", {}, (ws) => api("GET", "/api/squads", { workspaceId: ws }));
  scoped("get_squad", "Get one squad with its members.", { id: z.string() }, (ws, a) => api("GET", `/api/squads/${a.id}`, { workspaceId: ws }));
  scoped("create_squad", "Create a squad.", { name: z.string(), description: z.string().optional() }, (ws, { workspace_id, ...body }) => api("POST", "/api/squads", { workspaceId: ws, body }));

  // Autopilots
  scoped("list_autopilots", "List autopilots (scheduled/triggered automations).", {}, (ws) => api("GET", "/api/autopilots", { workspaceId: ws }));
  scoped("get_autopilot", "Get one autopilot.", { id: z.string() }, (ws, a) => api("GET", `/api/autopilots/${a.id}`, { workspaceId: ws }));
  scoped("trigger_autopilot", "Manually trigger an autopilot run.", { id: z.string() }, (ws, a) => api("POST", `/api/autopilots/${a.id}/trigger`, { workspaceId: ws, body: {} }));
  scoped("list_autopilot_runs", "List runs of an autopilot.", { id: z.string() }, (ws, a) => api("GET", `/api/autopilots/${a.id}/runs`, { workspaceId: ws }));

  // Dashboard analytics
  scoped("dashboard_usage_daily", "Daily credit/token usage.", {}, (ws) => api("GET", "/api/dashboard/usage/daily", { workspaceId: ws }));
  scoped("dashboard_usage_by_agent", "Usage by agent.", {}, (ws) => api("GET", "/api/dashboard/usage/by-agent", { workspaceId: ws }));
  scoped("dashboard_agent_runtime", "Agent run-time totals.", {}, (ws) => api("GET", "/api/dashboard/agent-runtime", { workspaceId: ws }));

  return server;
}
