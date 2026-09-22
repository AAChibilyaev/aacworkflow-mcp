/**
 * buildServer — constructs an McpServer bound to one AACWorkflow identity.
 *
 * The same factory powers both transports:
 *  - stdio (src/index.ts): one process, token from env.
 *  - HTTP  (src/http.ts):  one hosted endpoint, token taken per-request from
 *    the Authorization header — so every connecting user drives their own
 *    workspaces (companies) with their own token. No shared credentials.
 *
 * Design notes for agentic clients (ChatGPT / Claude):
 *  - Every tool carries ToolAnnotations (readOnlyHint/destructiveHint/
 *    idempotentHint/openWorldHint) so a client can reason about risk before
 *    calling, per the MCP + OpenAI Apps SDK guidance.
 *  - Every tool has a real outputSchema + returns structuredContent, not
 *    just JSON serialized into a text blob — so a client can chain
 *    create_issue -> issue.id -> assign_issue_to_agent without parsing text.
 *  - `patch: any` is gone. Every update_* tool has a field-level schema
 *    matching the real `aacworkflow <resource> update --help` flags this
 *    project verified against the live CLI/API.
 *  - workspace_id is REQUIRED on every write tool (optional only on reads,
 *    where "use my one workspace / default" is a safe guess).
 *  - NOT included on purpose: per-tool OAuth scopes, and a first-class Run
 *    API (list_runs/pause_run/...). AACWorkflow's own API has no token-scope
 *    system and no run-level pause/resume/retry endpoints today — declaring
 *    either here would be decorative, not enforced. Issue-scoped run data
 *    (list_agent_tasks) is exposed as-is; nothing more is promised.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type Cfg = { serverUrl: string; token: string; defaultWorkspace?: string };

// ── Shared enums (verified against live CLI --help / API responses, not guessed) ──

/** `aacworkflow issue status <id> <value>` valid values (CLI_AND_DAEMON.md). */
const ISSUE_STATUS = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const;
/** Matches real issue data (e.g. AAC-5 returns "none", not the old "no_priority"). */
const ISSUE_PRIORITY = ["urgent", "high", "medium", "low", "none"] as const;
/** Issues are polymorphic: agent | member | squad (never "user" — see aacworkflow-squads skill). */
const ASSIGNEE_TYPE = ["agent", "member", "squad"] as const;
/** `aacworkflow project status <id> <value>` valid values. */
const PROJECT_STATUS = ["planned", "in_progress", "paused", "completed", "cancelled"] as const;
const AGENT_VISIBILITY = ["private", "workspace"] as const;
const AGENT_PERMISSION_MODE = ["private", "public_to"] as const;
/** DB check constraint `agent_status_check`. Informational — the daemon sets this, tools don't. */
const AGENT_STATUS = ["idle", "working", "blocked", "error", "offline"] as const;
const RUNTIME_MODE = ["local", "cloud"] as const;
/** `create_issue.mode` / autopilot skill: only create_issue is CLI-exposed; run_only exists in the
 * data model but the daemon task path doesn't resolve a workspace for it yet. */
const AUTOPILOT_EXECUTION_MODE = ["create_issue", "run_only"] as const;
const AUTOPILOT_STATUS = ["active", "paused"] as const;
const MEMBER_ROLE = ["owner", "admin", "member"] as const;
const SQUAD_MEMBER_TYPE = ["agent", "member"] as const;

// ── Structured error taxonomy ──────────────────────────────────────────────

const ERROR_CODES = [
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID_ARGUMENT",
  "CONFLICT",
  "RATE_LIMITED",
  "TIMEOUT",
  "INTERNAL_ERROR",
] as const;
type ErrorCode = (typeof ERROR_CODES)[number];

class ApiError extends Error {
  code: ErrorCode;
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
  constructor(opts: { code: ErrorCode; message: string; status?: number; retryable: boolean; retryAfterMs?: number }) {
    super(opts.message);
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

function codeForStatus(status: number): ErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status === 400 || status === 422) return "INVALID_ARGUMENT";
  if (status >= 500) return "INTERNAL_ERROR";
  return "INTERNAL_ERROR";
}

export function buildServer(cfg: Cfg): McpServer {
  const SERVER_URL = cfg.serverUrl.replace(/\/+$/, "");
  const TOKEN = cfg.token;
  const DEFAULT_WORKSPACE = cfg.defaultWorkspace ?? "";

  type ApiOpts = { query?: Record<string, string | number | undefined>; body?: unknown; workspaceId?: string; scoped?: boolean };

  async function api(method: string, path: string, opts: ApiOpts = {}): Promise<unknown> {
    const url = new URL(SERVER_URL + path);
    if (opts.scoped !== false && opts.workspaceId) url.searchParams.set("workspace_id", opts.workspaceId);
    if (opts.query) for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      throw new ApiError({ code: "TIMEOUT", message: timedOut ? `Request timed out: ${method} ${path}` : `Network error: ${method} ${path}: ${String(e)}`, retryable: true });
    }
    const text = await res.text();
    if (!res.ok) {
      const retryAfterHeader = res.headers.get("retry-after");
      throw new ApiError({
        code: codeForStatus(res.status),
        message: `HTTP ${res.status} ${method} ${path}: ${text.slice(0, 500)}`,
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        retryAfterMs: retryAfterHeader ? Number(retryAfterHeader) * 1000 : res.status === 429 ? 2000 : undefined,
      });
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
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
    throw new ApiError({
      code: "INVALID_ARGUMENT",
      retryable: false,
      message:
        list.length === 0
          ? "This token has no workspaces. Create/join one at " + SERVER_URL
          : "You belong to multiple workspaces — pass workspace_id. Available: " + list.map((w) => `${w.name} (${w.id})`).join("; "),
    });
  }

  const server = new McpServer(
    { name: "aacworkflow-mcp", version: "0.4.0" },
    {
      instructions: [
        "AACWorkflow is an AI software-work orchestration system.",
        "Hierarchy: Workspace -> Project -> Squad -> Agent -> Issue.",
        "An Issue is the canonical unit of work; list_agent_tasks shows what an agent has executed against issues.",
        "Skills hold durable, reusable context bound to an agent — not one-off task instructions (those belong in an Issue description or Agent instructions).",
        "Use read tools (list_/get_/search_) before write tools whenever an id or the current state is unknown or unconfirmed.",
        "Never guess a workspace_id, project_id, agent_id, runtime_id, or issue_id — call the matching list_* tool first.",
        "Search for an existing issue (search_issues) before creating one, to avoid duplicates.",
        "Destructive tools (destructiveHint: true) require explicit user intent; use dry_run: true first when unsure what will be affected.",
        "This server does not implement per-tool OAuth scopes or a standalone Run API — AACWorkflow tokens are all-or-nothing and there is no run-level pause/resume/retry endpoint. Don't assume either exists.",
      ].join("\n"),
    },
  );

  // ── response helpers ───────────────────────────────────────────────────

  function okStructured(data: Record<string, unknown>) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
  function errorShape(e: unknown): { code: ErrorCode; message: string; retryable: boolean; retry_after_ms?: number } {
    if (e instanceof ApiError) return { code: e.code, message: e.message, retryable: e.retryable, retry_after_ms: e.retryAfterMs };
    return { code: "INTERNAL_ERROR", message: String(e instanceof Error ? e.message : e), retryable: false };
  }
  function oops(e: unknown) {
    const shape = errorShape(e);
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(shape) }], structuredContent: shape as any };
  }

  const ERROR_OUTPUT_NOTE =
    "On failure, structuredContent (and the JSON in content) is {code, message, retryable, retry_after_ms?} with code one of " +
    ERROR_CODES.join("|") +
    ".";

  const wsArgOptional = { workspace_id: z.string().optional().describe("Workspace/company id. Omit to use the default or your only workspace.") };
  const wsArgRequired = { workspace_id: z.string().describe("Workspace/company id — REQUIRED for write operations. Call list_workspaces first if unknown; never guess it.") };
  const pageArgs = {
    limit: z.number().int().positive().max(200).optional().describe("Max items to return, if the endpoint supports it."),
    cursor: z.string().optional().describe("Opaque pagination cursor from a previous call's next_cursor, if the endpoint supports it."),
  };

  type Shape = Record<string, z.ZodTypeAny>;

  /** Read-only tool: no workspace_id required, GET-shaped. */
  function readTool(name: string, desc: string, shape: Shape, outputShape: Shape, run: (ws: string, args: any) => Promise<unknown>, ann: Partial<ToolAnnotations> = {}) {
    server.registerTool(
      name,
      {
        description: desc,
        inputSchema: { ...shape, ...wsArgOptional },
        outputSchema: outputShape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, ...ann },
      },
      async (args: any) => {
        try {
          return okStructured((await run(await resolveWorkspace(args.workspace_id), args)) as Record<string, unknown>);
        } catch (e) {
          return oops(e);
        }
      },
    );
  }

  /** Write tool scoped to a workspace: workspace_id is required. */
  function writeTool(
    name: string,
    desc: string,
    shape: Shape,
    outputShape: Shape,
    run: (ws: string, args: any) => Promise<unknown>,
    ann: Partial<ToolAnnotations>,
  ) {
    server.registerTool(
      name,
      {
        description: `${desc} ${ERROR_OUTPUT_NOTE}`,
        inputSchema: { ...shape, ...wsArgRequired },
        outputSchema: outputShape,
        annotations: { readOnlyHint: false, ...ann },
      },
      async (args: any) => {
        try {
          return okStructured((await run(args.workspace_id, args)) as Record<string, unknown>);
        } catch (e) {
          return oops(e);
        }
      },
    );
  }

  /** Global (not workspace-scoped) read tool — whoami, list_workspaces, get_workspace. */
  function globalRead(name: string, desc: string, shape: Shape, outputShape: Shape, run: (args: any) => Promise<unknown>) {
    server.registerTool(
      name,
      { description: desc, inputSchema: shape, outputSchema: outputShape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      async (args: any) => {
        try {
          return okStructured((await run(args)) as Record<string, unknown>);
        } catch (e) {
          return oops(e);
        }
      },
    );
  }

  // ── Account / workspace ────────────────────────────────────────────────

  globalRead(
    "whoami",
    "Authenticated-user profile tool. Returns a stable opaque id that persists across reconnects/token refresh — use it to attribute actions, not for display beyond name.",
    {},
    { profile: z.record(z.string(), z.unknown()).describe("id, name, email of the authenticated AACWorkflow user.") },
    async () => ({ profile: await api("GET", "/api/me", { scoped: false }) }),
  );

  globalRead("list_workspaces", "List the workspaces (companies) this token can access.", {}, { workspaces: z.array(z.record(z.string(), z.unknown())) }, async () => {
    wsCache = null;
    return { workspaces: await listWorkspacesRaw() };
  });

  globalRead("get_workspace", "Get one workspace's details.", { id: z.string().describe("workspace id or slug") }, { workspace: z.record(z.string(), z.unknown()) }, async (a) => ({
    workspace: await api("GET", `/api/workspaces/${a.id}`, { scoped: false }),
  }));

  server.registerTool(
    "update_workspace",
    {
      description: `Update a workspace's name, description, context, or issue prefix. ${ERROR_OUTPUT_NOTE}`,
      inputSchema: {
        id: z.string().describe("workspace id"),
        name: z.string().optional(),
        description: z.string().optional(),
        context: z.string().optional().describe("Free-text workspace context injected into agent briefs."),
        issue_prefix: z.string().optional().describe("Short issue key prefix, e.g. AAC."),
      },
      outputSchema: { workspace: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a: any) => {
      try {
        const { id, ...patch } = a;
        return okStructured({ workspace: await api("PUT", `/api/workspaces/${id}`, { scoped: false, body: patch }) });
      } catch (e) {
        return oops(e);
      }
    },
  );

  readTool("list_members", "List members of a workspace.", {}, { members: z.array(z.object({ id: z.string().optional(), user_id: z.string().optional(), role: z.enum(MEMBER_ROLE).optional() }).catchall(z.unknown())) }, (ws) =>
    api("GET", `/api/workspaces/${ws}/members`, { scoped: false }).then((d) => ({ members: d })),
  );

  // ── Runtimes ────────────────────────────────────────────────────────────

  readTool(
    "list_runtimes",
    "List agent runtimes (machines/daemons) in the workspace — the execution targets behind agents.",
    {},
    { runtimes: z.array(z.object({ id: z.string(), name: z.string(), provider: z.string(), status: z.string(), runtime_mode: z.enum(RUNTIME_MODE).optional() }).catchall(z.unknown())) },
    (ws) => api("GET", "/api/runtimes", { workspaceId: ws }).then((d) => ({ runtimes: d })),
  );

  writeTool(
    "update_runtime",
    "Update a runtime's configuration (its own custom display name and/or visibility only — not the daemon's own settings).",
    {
      id: z.string(),
      custom_name: z.string().nullable().optional().describe("Override display name; null clears it."),
      visibility: z.enum(AGENT_VISIBILITY).optional(),
    },
    { runtime: z.record(z.string(), z.unknown()) },
    (ws, { id, workspace_id, ...patch }) => api("PATCH", `/api/runtimes/${id}`, { workspaceId: ws, body: patch }).then((d) => ({ runtime: d })),
    { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  readTool("get_runtime_usage", "Resource consumption metrics for one runtime.", { id: z.string() }, { usage: z.record(z.string(), z.unknown()) }, (ws, a) =>
    api("GET", `/api/runtimes/${a.id}/usage`, { workspaceId: ws }).then((d) => ({ usage: d })),
  );
  readTool("get_runtime_activity", "Activity log for one runtime.", { id: z.string() }, { activity: z.record(z.string(), z.unknown()) }, (ws, a) =>
    api("GET", `/api/runtimes/${a.id}/activity`, { workspaceId: ws }).then((d) => ({ activity: d })),
  );

  // ── Agents ──────────────────────────────────────────────────────────────

  const AgentOut = {
    agent: z
      .object({
        id: z.string(),
        name: z.string(),
        status: z.enum(AGENT_STATUS).optional(),
        visibility: z.enum(AGENT_VISIBILITY).optional(),
        runtime_id: z.string().optional(),
        model: z.string().nullable().optional(),
      })
      .catchall(z.unknown()),
  };

  readTool("list_agents", "List agents in the workspace.", { ...pageArgs }, { agents: z.array(AgentOut.agent) }, (ws, { workspace_id, ...q }) =>
    api("GET", "/api/agents", { workspaceId: ws, query: q }).then((d) => ({ agents: d })),
  );
  readTool("get_agent", "Get full details of one agent.", { id: z.string() }, AgentOut, (ws, a) => api("GET", `/api/agents/${a.id}`, { workspaceId: ws }).then((d) => ({ agent: d })));

  writeTool(
    "create_agent",
    "Create an agent on a runtime. Use visibility 'workspace' so all members can use it; 'private' (default) restricts it to its owner.",
    {
      name: z.string(),
      runtime_id: z.string().describe("from list_runtimes"),
      description: z.string().max(255).optional().describe("Catalog summary only — NOT sent to the agent's runtime prompt."),
      instructions: z.string().optional().describe("The actual runtime behavior contract the daemon sends to the provider. Persona/responsibilities/boundaries go here, not in description."),
      model: z.string().optional(),
      visibility: z.enum(AGENT_VISIBILITY).optional(),
      max_concurrent_tasks: z.number().int().positive().optional(),
    },
    AgentOut,
    (ws, { workspace_id, ...body }) => api("POST", "/api/agents", { workspaceId: ws, body }).then((d) => ({ agent: d })),
    { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );

  writeTool(
    "update_agent",
    "Update an agent. Note: instructions (not description) is what the daemon actually sends the provider at claim time.",
    {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().max(255).optional(),
      instructions: z.string().optional(),
      model: z.string().optional(),
      thinking_level: z.string().optional().describe("Runtime/model-specific (e.g. Claude: low|medium|high|xhigh|max). Empty string clears to runtime default."),
      visibility: z.enum(AGENT_VISIBILITY).optional(),
      permission_mode: z.enum(AGENT_PERMISSION_MODE).optional(),
      public_to_member_ids: z.array(z.string()).optional().describe("Used when permission_mode is public_to."),
      max_concurrent_tasks: z.number().int().positive().optional(),
      runtime_id: z.string().optional(),
    },
    AgentOut,
    (ws, { id, workspace_id, ...patch }) => api("PUT", `/api/agents/${id}`, { workspaceId: ws, body: patch }).then((d) => ({ agent: d })),
    { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  writeTool(
    "archive_agent",
    "Archive an agent (soft-delete; it stops picking up new work). Reversible via restore_agent.",
    { id: z.string() },
    AgentOut,
    (ws, a) => api("POST", `/api/agents/${a.id}/archive`, { workspaceId: ws, body: {} }).then((d) => ({ agent: d })),
    { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  );
  writeTool(
    "restore_agent",
    "Restore a previously archived agent.",
    { id: z.string() },
    AgentOut,
    (ws, a) => api("POST", `/api/agents/${a.id}/restore`, { workspaceId: ws, body: {} }).then((d) => ({ agent: d })),
    { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  readTool("list_agent_templates", "List built-in agent template slugs.", {}, { templates: z.array(z.record(z.string(), z.unknown())) }, (ws) =>
    api("GET", "/api/agent-templates", { workspaceId: ws }).then((d) => ({ templates: d })),
  );
  writeTool(
    "create_agent_from_template",
    "Create an agent from a template slug (see list_agent_templates).",
    { slug: z.string(), runtime_id: z.string(), name: z.string().optional(), visibility: z.enum(AGENT_VISIBILITY).optional() },
    AgentOut,
    (ws, { workspace_id, slug, ...rest }) => api("POST", "/api/agents/from-template", { workspaceId: ws, body: { template_slug: slug, slug, ...rest } }).then((d) => ({ agent: d })),
    { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );

  readTool(
    "list_agent_tasks",
    "List tasks (issue-execution attempts) an agent has worked on. This is the closest thing to a 'run' list this API exposes — there is no standalone run entity.",
    { id: z.string() },
    { tasks: z.array(z.record(z.string(), z.unknown())) },
    (ws, a) => api("GET", `/api/agents/${a.id}/tasks`, { workspaceId: ws }).then((d) => ({ tasks: d })),
  );

  readTool("list_agent_skills", "List skills attached to an agent.", { id: z.string() }, { skills: z.array(z.object({ id: z.string(), name: z.string().optional() }).catchall(z.unknown())) }, (ws, a) =>
    api("GET", `/api/agents/${a.id}/skills`, { workspaceId: ws }).then((d) => ({ skills: d })),
  );
  writeTool(
    "attach_skill_to_agent",
    "Attach a skill to an agent (additive — read-modify-write over the full skill list; other skills stay attached).",
    { id: z.string(), skill_id: z.string() },
    { skills: z.array(z.record(z.string(), z.unknown())) },
    async (ws, a) => {
      const current = (await api("GET", `/api/agents/${a.id}/skills`, { workspaceId: ws })) as Array<{ id: string }>;
      const ids = Array.from(new Set([...current.map((s) => s.id), a.skill_id]));
      return { skills: await api("PUT", `/api/agents/${a.id}/skills`, { workspaceId: ws, body: { skill_ids: ids } }) };
    },
    { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );
  writeTool(
    "detach_skill_from_agent",
    "Detach a skill from an agent (read-modify-write over the full skill list; other skills stay attached).",
    { id: z.string(), skill_id: z.string() },
    { skills: z.array(z.record(z.string(), z.unknown())) },
    async (ws, a) => {
      const current = (await api("GET", `/api/agents/${a.id}/skills`, { workspaceId: ws })) as Array<{ id: string }>;
      const ids = current.map((s) => s.id).filter((id) => id !== a.skill_id);
      return { skills: await api("PUT", `/api/agents/${a.id}/skills`, { workspaceId: ws, body: { skill_ids: ids } }) };
    },
    { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  );

  // ── Skills ──────────────────────────────────────────────────────────────

  const SkillOut = { skill: z.object({ id: z.string(), name: z.string() }).catchall(z.unknown()) };

  readTool("list_skills", "List skills available in the workspace.", { ...pageArgs }, { skills: z.array(SkillOut.skill) }, (ws, { workspace_id, ...q }) =>
    api("GET", "/api/skills", { workspaceId: ws, query: q }).then((d) => ({ skills: d })),
  );
  readTool("get_skill", "Get one skill's details, including its content.", { id: z.string() }, SkillOut, (ws, a) => api("GET", `/api/skills/${a.id}`, { workspaceId: ws }).then((d) => ({ skill: d })));
  writeTool(
    "create_skill",
    "Create a skill directly (raw content, not imported from a URL — use import_skill for that).",
    { name: z.string(), description: z.string().optional(), content: z.string().optional().describe("SKILL.md body.") },
    SkillOut,
    (ws, { workspace_id, ...body }) => api("POST", "/api/skills", { workspaceId: ws, body }).then((d) => ({ skill: d })),
    { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );
  writeTool(
    "update_skill",
    "Update a skill's metadata or content.",
    { id: z.string(), name: z.string().optional(), description: z.string().optional(), content: z.string().optional() },
    SkillOut,
    (ws, { id, workspace_id, ...patch }) => api("PUT", `/api/skills/${id}`, { workspaceId: ws, body: patch }).then((d) => ({ skill: d })),
    { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );
  writeTool(
    "delete_skill",
    "Delete a skill. Set dry_run: true to see what would be deleted without deleting it.",
    { id: z.string(), dry_run: z.boolean().optional().describe("If true, fetch and return the skill instead of deleting it.") },
    { deleted: z.boolean(), skill: z.record(z.string(), z.unknown()).optional() },
    async (ws, a) => {
      if (a.dry_run) return { deleted: false, skill: await api("GET", `/api/skills/${a.id}`, { workspaceId: ws }) };
      await api("DELETE", `/api/skills/${a.id}`, { workspaceId: ws });
      return { deleted: true };
    },
    { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  );
  writeTool(
    "import_skill",
    "Import a skill from an external source URL (GitHub, ClawHub, skills.sh). Fetches from a domain outside AACWorkflow.",
    { source: z.string().describe("source URL, e.g. a GitHub repo, or a ClawHub/skills.sh slug") },
    SkillOut,
    (ws, { workspace_id, ...body }) => api("POST", "/api/skills/import", { workspaceId: ws, body }).then((d) => ({ skill: d })),
    { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  );

  // ── Issues (tasks) ──────────────────────────────────────────────────────

  const IssueOut = {
    issue: z
      .object({
        id: z.string(),
        identifier: z.string().optional().describe("Routable key, e.g. AAC-42."),
        title: z.string(),
        status: z.enum(ISSUE_STATUS).optional(),
        priority: z.enum(ISSUE_PRIORITY).optional(),
        assignee_type: z.enum(ASSIGNEE_TYPE).nullable().optional(),
        assignee_id: z.string().nullable().optional(),
      })
      .catchall(z.unknown()),
  };
  const IssueListOut = { items: z.array(IssueOut.issue), total: z.number().optional(), next_cursor: z.string().optional() };

  readTool(
    "list_issues",
    "List issues (tasks). Filter by status / assignee / project.",
    { status: z.enum(ISSUE_STATUS).optional(), assignee_type: z.enum(ASSIGNEE_TYPE).optional(), assignee_id: z.string().optional(), project_id: z.string().optional(), ...pageArgs },
    IssueListOut,
    async (ws, { workspace_id, ...q }) => {
      const d = (await api("GET", "/api/issues", { workspaceId: ws, query: q })) as any;
      const items = Array.isArray(d) ? d : d?.items ?? d?.issues ?? [];
      return { items, total: d?.total, next_cursor: d?.next_cursor };
    },
  );
  readTool("get_issue", "Get one issue (task) with full detail.", { id: z.string() }, IssueOut, (ws, a) => api("GET", `/api/issues/${a.id}`, { workspaceId: ws }).then((d) => ({ issue: d })));

  writeTool(
    "create_issue",
    "Create a task. To dispatch it to an agent immediately, set assignee_type:'agent' + assignee_id (this enqueues a run on that agent's runtime). Search with search_issues first to avoid duplicates.",
    {
      title: z.string(),
      description: z.string().optional(),
      priority: z.enum(ISSUE_PRIORITY).optional(),
      status: z.enum(ISSUE_STATUS).optional(),
      project_id: z.string().optional(),
      parent_issue_id: z.string().optional(),
      assignee_type: z.enum(ASSIGNEE_TYPE).optional(),
      assignee_id: z.string().optional().describe("Required if assignee_type is set. Look up via list_agents / list_members / list_squads — never guess."),
      due_date: z.string().optional().describe("ISO YYYY-MM-DD"),
    },
    { issue: IssueOut.issue, dispatched: z.boolean().describe("True if assignee_type/assignee_id were set, meaning a run was enqueued.") },
    (ws, { workspace_id, ...body }) =>
      api("POST", "/api/issues", { workspaceId: ws, body }).then((issue: any) => ({ issue, dispatched: Boolean(body.assignee_type && body.assignee_id) })),
    { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );

  writeTool(
    "update_issue",
    "Update an issue's fields. Changing status or assignee has server-side side effects (may enqueue or cancel agent work) — this is not a passive metadata edit.",
    {
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(ISSUE_STATUS).optional(),
      priority: z.enum(ISSUE_PRIORITY).optional(),
      project_id: z.string().nullable().optional(),
      parent_issue_id: z.string().nullable().optional(),
      assignee_type: z.enum(ASSIGNEE_TYPE).nullable().optional(),
      assignee_id: z.string().nullable().optional(),
      due_date: z.string().nullable().optional().describe("ISO YYYY-MM-DD, or null to clear."),
    },
    IssueOut,
    (ws, { id, workspace_id, ...patch }) => api("PUT", `/api/issues/${id}`, { workspaceId: ws, body: patch }).then((d) => ({ issue: d })),
    { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  );

  writeTool(
    "delete_issue",
    "Delete an issue. Immediately clears its comments, reactions, and attachments — cannot be undone. Set dry_run: true to preview first.",
    { id: z.string(), dry_run: z.boolean().optional() },
    { deleted: z.boolean(), issue: z.record(z.string(), z.unknown()).optional() },
    async (ws, a) => {
      if (a.dry_run) return { deleted: false, issue: await api("GET", `/api/issues/${a.id}`, { workspaceId: ws }) };
      await api("DELETE", `/api/issues/${a.id}`, { workspaceId: ws });
      return { deleted: true };
    },
    { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  );

  writeTool(
    "assign_issue_to_agent",
    "Assign an existing issue to an agent. Dispatches a task — the agent's runtime daemon will pick it up and run it, which may push to GitHub, call external services, etc. Cancels any existing in-flight task for the issue first.",
    { id: z.string(), agent_id: z.string() },
    IssueOut,
    (ws, a) => api("PUT", `/api/issues/${a.id}`, { workspaceId: ws, body: { assignee_type: "agent", assignee_id: a.agent_id } }).then((d) => ({ issue: d })),
    { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  );
  writeTool(
    "rerun_issue",
    "Re-run an issue's agent task from scratch. Enqueues a fresh run — same real-world effects as any agent run (may push to GitHub, call external services).",
    { id: z.string() },
    { started: z.boolean() },
    (ws, a) => api("POST", `/api/issues/${a.id}/rerun`, { workspaceId: ws, body: {} }).then(() => ({ started: true })),
    { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  );

  writeTool(
    "comment_issue",
    "Add a comment to an issue. Depending on the issue's assignee and any @mentions in the body, this can wake an agent (see AACWorkflow's mention contract: [@Name](mention://agent/<uuid>) enqueues a run).",
    { id: z.string(), body: z.string() },
    { comment: z.record(z.string(), z.unknown()) },
    (ws, a) => api("POST", `/api/issues/${a.id}/comments`, { workspaceId: ws, body: { body: a.body } }).then((d) => ({ comment: d })),
    { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  );
  readTool("list_comments", "List comments on an issue.", { id: z.string() }, { comments: z.array(z.record(z.string(), z.unknown())) }, (ws, a) =>
    api("GET", `/api/issues/${a.id}/comments`, { workspaceId: ws }).then((d) => ({ comments: d })),
  );
  readTool("search_issues", "Full-text search issues. Use this before create_issue to avoid duplicates.", { q: z.string(), ...pageArgs }, IssueListOut, async (ws, a) => {
    const d = (await api("GET", "/api/issues/search", { workspaceId: ws, query: { q: a.q, limit: a.limit, cursor: a.cursor } })) as any;
    const items = Array.isArray(d) ? d : d?.items ?? d?.issues ?? [];
    return { items, total: d?.total, next_cursor: d?.next_cursor };
  });

  readTool("list_issue_subscribers", "List subscribers on an issue.", { id: z.string() }, { subscribers: z.array(z.record(z.string(), z.unknown())) }, (ws, a) =>
    api("GET", `/api/issues/${a.id}/subscribers`, { workspaceId: ws }).then((d) => ({ subscribers: d })),
  );
  writeTool(
    "subscribe_to_issue",
    "Subscribe (yourself, by token identity) to an issue's notifications.",
    { id: z.string() },
    { subscribed: z.literal(true) },
    (ws, a) => api("POST", `/api/issues/${a.id}/subscribe`, { workspaceId: ws, body: { subscribed: true } }).then(() => ({ subscribed: true as const })),
    { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );
  writeTool(
    "unsubscribe_from_issue",
    "Unsubscribe (yourself, by token identity) from an issue's notifications.",
    { id: z.string() },
    { subscribed: z.literal(false) },
    (ws, a) => api("POST", `/api/issues/${a.id}/subscribe`, { workspaceId: ws, body: { subscribed: false } }).then(() => ({ subscribed: false as const })),
    { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  readTool("list_issue_attachments", "List attachments on an issue.", { id: z.string() }, { attachments: z.array(z.record(z.string(), z.unknown())) }, (ws, a) =>
    api("GET", `/api/issues/${a.id}/attachments`, { workspaceId: ws }).then((d) => ({ attachments: d })),
  );
  readTool("get_attachment", "Get an attachment's metadata (including its download URL).", { id: z.string() }, { attachment: z.record(z.string(), z.unknown()) }, (ws, a) =>
    api("GET", `/api/attachments/${a.id}`, { workspaceId: ws }).then((d) => ({ attachment: d })),
  );
  writeTool(
    "delete_attachment",
    "Delete an attachment. Set dry_run: true to preview first.",
    { id: z.string(), dry_run: z.boolean().optional() },
    { deleted: z.boolean(), attachment: z.record(z.string(), z.unknown()).optional() },
    async (ws, a) => {
      if (a.dry_run) return { deleted: false, attachment: await api("GET", `/api/attachments/${a.id}`, { workspaceId: ws }) };
      await api("DELETE", `/api/attachments/${a.id}`, { workspaceId: ws });
      return { deleted: true };
    },
    { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  );

  // ── Projects / labels ──────────────────────────────────────────────────

  const ProjectOut = { project: z.object({ id: z.string(), title: z.string(), status: z.enum(PROJECT_STATUS).optional() }).catchall(z.unknown()) };

  readTool("list_projects", "List projects in the workspace.", { status: z.enum(PROJECT_STATUS).optional(), ...pageArgs }, { projects: z.array(ProjectOut.project) }, (ws, { workspace_id, ...q }) =>
    api("GET", "/api/projects", { workspaceId: ws, query: q }).then((d) => ({ projects: d })),
  );
  writeTool(
    "create_project",
    "Create a project. Its description (if set) becomes durable context injected into every future task bound to it.",
    { title: z.string(), description: z.string().optional(), icon: z.string().optional(), lead_id: z.string().optional(), status: z.enum(PROJECT_STATUS).optional() },
    ProjectOut,
    (ws, { workspace_id, ...body }) => api("POST", "/api/projects", { workspaceId: ws, body }).then((d) => ({ project: d })),
    { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );
  writeTool(
    "update_project",
    "Update a project.",
    {
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(PROJECT_STATUS).optional(),
      icon: z.string().optional(),
      lead_id: z.string().nullable().optional(),
      start_date: z.string().nullable().optional().describe("ISO YYYY-MM-DD, or null/empty string to clear."),
      due_date: z.string().nullable().optional(),
    },
    ProjectOut,
    (ws, { id, workspace_id, ...patch }) => api("PUT", `/api/projects/${id}`, { workspaceId: ws, body: patch }).then((d) => ({ project: d })),
    { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );
  writeTool(
    "delete_project",
    "Delete a project. Set dry_run: true to preview first.",
    { id: z.string(), dry_run: z.boolean().optional() },
    { deleted: z.boolean(), project: z.record(z.string(), z.unknown()).optional() },
    async (ws, a) => {
      if (a.dry_run) return { deleted: false, project: await api("GET", `/api/projects/${a.id}`, { workspaceId: ws }) };
      await api("DELETE", `/api/projects/${a.id}`, { workspaceId: ws });
      return { deleted: true };
    },
    { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  );

  readTool("list_labels", "List issue labels.", {}, { labels: z.array(z.object({ id: z.string(), name: z.string() }).catchall(z.unknown())) }, (ws) =>
    api("GET", "/api/labels", { workspaceId: ws }).then((d) => ({ labels: d })),
  );
  writeTool(
    "create_label",
    "Create an issue label.",
    { name: z.string(), color: z.string().optional().describe("Hex color, e.g. #7C3AED.") },
    { label: z.record(z.string(), z.unknown()) },
    (ws, { workspace_id, ...body }) => api("POST", "/api/labels", { workspaceId: ws, body }).then((d) => ({ label: d })),
    { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );
  writeTool(
    "update_label",
    "Update an issue label.",
    { id: z.string(), name: z.string().optional(), color: z.string().optional() },
    { label: z.record(z.string(), z.unknown()) },
    (ws, { id, workspace_id, ...patch }) => api("PUT", `/api/labels/${id}`, { workspaceId: ws, body: patch }).then((d) => ({ label: d })),
    { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );
  writeTool(
    "delete_label",
    "Delete an issue label.",
    { id: z.string() },
    { deleted: z.boolean() },
    (ws, a) => api("DELETE", `/api/labels/${a.id}`, { workspaceId: ws }).then(() => ({ deleted: true })),
    { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  );

  // ── Squads ──────────────────────────────────────────────────────────────

  const SquadOut = { squad: z.object({ id: z.string(), name: z.string(), leader_id: z.string().optional() }).catchall(z.unknown()) };

  readTool("list_squads", "List squads (teams). A squad is not an agent — work routed to it always goes to squad.leader_id, never fanned out to every member.", {}, { squads: z.array(SquadOut.squad) }, (ws) =>
    api("GET", "/api/squads", { workspaceId: ws }).then((d) => ({ squads: d })),
  );
  readTool("get_squad", "Get one squad with its members.", { id: z.string() }, SquadOut, (ws, a) => api("GET", `/api/squads/${a.id}`, { workspaceId: ws }).then((d) => ({ squad: d })));
  writeTool(
    "create_squad",
    "Create a squad. leader_id must be an existing agent — it becomes the sole executor for all squad-routed work.",
    { name: z.string(), leader_id: z.string().describe("agent id leading the squad"), description: z.string().optional() },
    SquadOut,
    (ws, { workspace_id, ...body }) => api("POST", "/api/squads", { workspaceId: ws, body }).then((d) => ({ squad: d })),
    { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );
  writeTool(
    "update_squad",
    "Update a squad's properties. `instructions` is leader-briefing content (appended to the leader's own instructions for squad-routed tasks) — it is not broadcast to members.",
    { id: z.string(), name: z.string().optional(), description: z.string().optional(), instructions: z.string().optional(), leader_id: z.string().optional(), avatar_url: z.string().optional() },
    SquadOut,
    (ws, { id, workspace_id, ...patch }) => api("PUT", `/api/squads/${id}`, { workspaceId: ws, body: patch }).then((d) => ({ squad: d })),
    { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );
  writeTool(
    "delete_squad",
    "Archive (soft-delete) a squad; its assigned issues transfer to the (former) leader agent.",
    { id: z.string() },
    { deleted: z.boolean() },
    (ws, a) => api("DELETE", `/api/squads/${a.id}`, { workspaceId: ws }).then(() => ({ deleted: true })),
    { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  );
  readTool("list_squad_members", "List a squad's members (roster, not necessarily who does the work — see get_squad).", { id: z.string() }, { members: z.array(z.record(z.string(), z.unknown())) }, (ws, a) =>
    api("GET", `/api/squads/${a.id}/members`, { workspaceId: ws }).then((d) => ({ members: d })),
  );
  writeTool(
    "add_squad_member",
    "Add an agent to a squad's roster. Does not by itself route any work to them — routing always targets the leader.",
    { id: z.string(), agent_id: z.string() },
    { members: z.array(z.record(z.string(), z.unknown())) },
    (ws, a) => api("POST", `/api/squads/${a.id}/members`, { workspaceId: ws, body: { member_type: "agent", member_id: a.agent_id } }).then((d) => ({ members: d })),
    { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );
  writeTool(
    "remove_squad_member",
    "Remove a member from a squad.",
    { id: z.string(), member_id: z.string(), member_type: z.enum(SQUAD_MEMBER_TYPE).default("agent") },
    { removed: z.boolean() },
    (ws, a) => api("DELETE", `/api/squads/${a.id}/members`, { workspaceId: ws, body: { member_id: a.member_id, member_type: a.member_type } }).then(() => ({ removed: true })),
    { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  );

  // ── Autopilots ──────────────────────────────────────────────────────────

  const AutopilotOut = { autopilot: z.object({ id: z.string(), title: z.string(), status: z.enum(AUTOPILOT_STATUS).optional() }).catchall(z.unknown()) };

  readTool("list_autopilots", "List autopilots (scheduled/triggered automations).", {}, { autopilots: z.array(AutopilotOut.autopilot) }, (ws) =>
    api("GET", "/api/autopilots", { workspaceId: ws }).then((d) => ({ autopilots: d })),
  );
  readTool("get_autopilot", "Get one autopilot, including its triggers.", { id: z.string() }, AutopilotOut, (ws, a) => api("GET", `/api/autopilots/${a.id}`, { workspaceId: ws }).then((d) => ({ autopilot: d })));
  writeTool(
    "create_autopilot",
    "Create an autopilot — a recurring/triggered automation that files an issue for an agent (or squad). 'run_only' mode is defined in the data model but not resolvable by the daemon yet — use 'create_issue'.",
    {
      title: z.string(),
      description: z.string().optional().describe("The prompt/task description used on every run."),
      assignee_type: z.enum(["agent", "squad"]),
      assignee_id: z.string().describe("agent or squad id that receives the generated issue"),
      execution_mode: z.enum(AUTOPILOT_EXECUTION_MODE),
      project_id: z.string().optional(),
      issue_title_template: z.string().optional().describe('Only the literal "{{date}}" placeholder is supported — no other variables exist.'),
    },
    AutopilotOut,
    (ws, { workspace_id, ...body }) => api("POST", "/api/autopilots", { workspaceId: ws, body }).then((d) => ({ autopilot: d })),
    { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );
  writeTool(
    "update_autopilot",
    "Update an autopilot.",
    { id: z.string(), title: z.string().optional(), description: z.string().optional(), status: z.enum(AUTOPILOT_STATUS).optional(), assignee_id: z.string().optional() },
    AutopilotOut,
    (ws, { id, workspace_id, ...patch }) => api("PATCH", `/api/autopilots/${id}`, { workspaceId: ws, body: patch }).then((d) => ({ autopilot: d })),
    { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );
  writeTool(
    "delete_autopilot",
    "Delete an autopilot.",
    { id: z.string() },
    { deleted: z.boolean() },
    (ws, a) => api("DELETE", `/api/autopilots/${a.id}`, { workspaceId: ws }).then(() => ({ deleted: true })),
    { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  );
  writeTool(
    "trigger_autopilot",
    "Manually fire an autopilot once. This dispatches real agent work exactly like a real trigger would (creates an issue and enqueues a run) — not a dry run.",
    { id: z.string() },
    { run: z.record(z.string(), z.unknown()) },
    (ws, a) => api("POST", `/api/autopilots/${a.id}/trigger`, { workspaceId: ws, body: {} }).then((d) => ({ run: d })),
    { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  );
  readTool("list_autopilot_runs", "List runs of an autopilot.", { id: z.string(), ...pageArgs }, { runs: z.array(z.record(z.string(), z.unknown())) }, (ws, a) =>
    api("GET", `/api/autopilots/${a.id}/runs`, { workspaceId: ws, query: { limit: a.limit, cursor: a.cursor } }).then((d) => ({ runs: d })),
  );

  // ── Dashboard analytics ─────────────────────────────────────────────────

  readTool("dashboard_usage_daily", "Daily credit/token usage for the workspace.", {}, { usage: z.record(z.string(), z.unknown()) }, (ws) =>
    api("GET", "/api/dashboard/usage/daily", { workspaceId: ws }).then((d) => ({ usage: d })),
  );
  readTool("dashboard_usage_by_agent", "Usage broken down by agent.", {}, { usage: z.record(z.string(), z.unknown()) }, (ws) =>
    api("GET", "/api/dashboard/usage/by-agent", { workspaceId: ws }).then((d) => ({ usage: d })),
  );
  readTool("dashboard_agent_runtime", "Agent run-time totals.", {}, { runtime: z.record(z.string(), z.unknown()) }, (ws) =>
    api("GET", "/api/dashboard/agent-runtime", { workspaceId: ws }).then((d) => ({ runtime: d })),
  );

  // ── Discovery: capabilities / metadata ─────────────────────────────────
  // Both are answered from constants verified in this codebase's own tool
  // definitions above (CLI --help / live API responses), NOT invented, and
  // NOT a proxy to a real /api/capabilities endpoint — AACWorkflow doesn't
  // have one. If the enums drift from the live server, these drift with them
  // only when this file is redeployed, same as every other tool's schema.

  server.registerTool(
    "get_capabilities",
    {
      description: "Static description of this MCP server's feature surface, so a client doesn't have to infer it from 71 tool names.",
      inputSchema: {},
      outputSchema: {
        server_version: z.string(),
        mcp_server: z.string(),
        features: z.record(z.string(), z.boolean()),
        excluded_by_design: z.array(z.string()).describe("Capabilities this server deliberately does not implement, and why — see get_metadata for none of these."),
        server_time: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      try {
        return okStructured({
          server_version: "0.4.0",
          mcp_server: "aacworkflow-mcp",
          features: {
            workspaces: true,
            projects: true,
            issues: true,
            agents: true,
            skills: true,
            squads: true,
            autopilots: true,
            attachments: true,
            labels: true,
            dashboard_analytics: true,
            github_pr_linking: true,
            per_tool_oauth_scopes: false,
            run_pause_resume_retry: false,
            audit_log_api: false,
          },
          excluded_by_design: [
            "per_tool_oauth_scopes — AACWorkflow tokens have no scope system server-side; declaring scopes here would not be enforced",
            "run_pause_resume_retry — AACWorkflow has no standalone Run entity or pause/resume/retry endpoints, only issue-scoped tasks (list_agent_tasks) and rerun_issue",
            "audit_log_api — AACWorkflow has no audit-log REST endpoint to proxy",
          ],
          server_time: new Date().toISOString(),
        });
      } catch (e) {
        return oops(e);
      }
    },
  );

  server.registerTool(
    "get_metadata",
    {
      description: "Enumerates every enum/constant this server's tool schemas use (statuses, priorities, execution modes, etc.) — call this instead of guessing an allowed value.",
      inputSchema: {},
      outputSchema: {
        issue_statuses: z.array(z.string()),
        issue_priorities: z.array(z.string()),
        assignee_types: z.array(z.string()),
        project_statuses: z.array(z.string()),
        agent_visibility: z.array(z.string()),
        agent_permission_modes: z.array(z.string()),
        agent_statuses: z.array(z.string()),
        runtime_modes: z.array(z.string()),
        autopilot_execution_modes: z.array(z.string()),
        autopilot_statuses: z.array(z.string()),
        member_roles: z.array(z.string()),
        squad_member_types: z.array(z.string()),
        error_codes: z.array(z.string()),
        runtime_providers: z.array(z.string()).describe("CLIs the daemon can detect (CLI_AND_DAEMON.md); a given runtime's actual provider/model list comes from list_runtimes / get_runtime_activity, not from this static list."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      try {
        return okStructured({
          issue_statuses: [...ISSUE_STATUS],
          issue_priorities: [...ISSUE_PRIORITY],
          assignee_types: [...ASSIGNEE_TYPE],
          project_statuses: [...PROJECT_STATUS],
          agent_visibility: [...AGENT_VISIBILITY],
          agent_permission_modes: [...AGENT_PERMISSION_MODE],
          agent_statuses: [...AGENT_STATUS],
          runtime_modes: [...RUNTIME_MODE],
          autopilot_execution_modes: [...AUTOPILOT_EXECUTION_MODE],
          autopilot_statuses: [...AUTOPILOT_STATUS],
          member_roles: [...MEMBER_ROLE],
          squad_member_types: [...SQUAD_MEMBER_TYPE],
          error_codes: [...ERROR_CODES],
          runtime_providers: ["claude", "codex", "copilot", "opencode", "openclaw", "hermes", "gemini", "pi", "cursor-agent", "kimi", "kiro-cli"],
        });
      } catch (e) {
        return oops(e);
      }
    },
  );

  return server;
}
