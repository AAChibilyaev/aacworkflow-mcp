# aacworkflow-mcp

[![CI](https://github.com/AAChibilyaev/aacworkflow-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AAChibilyaev/aacworkflow-mcp/actions/workflows/ci.yml)

MCP server that lets **Claude** and **Claude Code** drive [AACWorkflow](https://aacworkflow.com): tasks (issues), agents, projects, squads, autopilots and analytics.

**Bring your own token.** Every user runs their own copy with their own AACWorkflow token — there is no shared server and no central credential store. Your token scopes you to the workspaces (companies) you belong to, and you can drive several from one install.

## Quick start (any AACWorkflow user)

1. **Create a token:** aacworkflow.com → your workspace → **Settings → Tokens** → create. Copy the `mul_…` value.
2. **Connect it to Claude Code** (no clone needed — runs straight from GitHub):

   ```bash
   claude mcp add aacworkflow --scope user \
     -e AACWORKFLOW_TOKEN=mul_your_token \
     -- npx -y github:AAChibilyaev/aacworkflow-mcp
   ```

3. Start a new Claude Code session and ask: *"list my aacworkflow agents"*, *"create a task and assign it to the Маркетолог agent"*, *"show this week's usage"*.

### Multiple companies / workspaces

If your token belongs to **one** workspace it is used automatically. If you belong to **several**, either:

- set a default: add `-e AACWORKFLOW_WORKSPACE_ID=<id>`, or
- pass `workspace_id` per call — run `list_workspaces` first to see the ids.

## Remote / hosted — work from anywhere (Claude Code, claude.ai, ChatGPT)

The same code also runs as a **hosted, multi-tenant HTTP endpoint**. Host it once; any registered AACWorkflow user connects with **their own token** and drives **their own** workspaces (companies). No shared credentials.

Two ways to authenticate against the hosted endpoint — pick whichever your client supports:

- **Direct bearer token** — put `Authorization: Bearer mul_your_token` on the request. No handshake, works with any HTTP MCP client (Claude Code, curl, Claude Desktop's remote config).
- **OAuth 2.1** — the server is a full authorization server (dynamic client registration, `authorization_code` + PKCE, refresh tokens, revocation, RFC 8414 / RFC 9728 metadata). Required by clients that only support OAuth discovery, like claude.ai and ChatGPT connectors. There's no separate AACWorkflow login page to redirect to, so `/authorize` renders a small page asking you to paste your `mul_…` token once; it's verified against `AACWORKFLOW_SERVER_URL` and exchanged for an opaque, short-lived, revocable access token — the raw token itself is never handed to the connecting app.

### Run the server

```bash
# from source
npm install && npm run build
PORT=8787 AACWORKFLOW_MCP_PUBLIC_URL=https://mcp.example.com npm run start:http
# or Docker
docker build -t aacworkflow-mcp . && docker run -p 8787:8787 \
  -e AACWORKFLOW_MCP_PUBLIC_URL=https://mcp.example.com aacworkflow-mcp
```

Put it behind HTTPS (any reverse proxy / Coolify / Cloudflare) → e.g. `https://mcp.example.com/mcp`. Set `AACWORKFLOW_MCP_PUBLIC_URL` to that exact public origin — OAuth issuer/redirect URLs are derived from it and must match what clients actually reach (OAuth requires HTTPS in production; `http://localhost` / `http://127.0.0.1` are allowed for local testing).

Endpoints: `POST/GET/DELETE /mcp` (MCP Streamable HTTP), `GET /health`, plus the OAuth set below.

### Connect from Claude Code (remote)

```bash
claude mcp add aacworkflow --transport http https://mcp.example.com/mcp \
  --header "Authorization: Bearer mul_your_token"
```

### Connect from claude.ai / ChatGPT (OAuth connector)

Settings → Connectors → **Add custom connector** → MCP server URL `https://mcp.example.com/mcp`. Leave auth as OAuth (default) — the client discovers `/.well-known/oauth-protected-resource/mcp`, registers itself, and opens `/authorize` in a browser tab where you paste your AACWorkflow token once. From then on the connector holds its own rotating access/refresh tokens.

If your connector only supports static bearer tokens, you can still skip OAuth entirely and use `Authorization: Bearer mul_your_token` directly, same as the Claude Code example above.

### OAuth endpoints

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata (issuer, `/authorize`, `/token`, `/register`, `/revoke`) |
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 9728 metadata pointing MCP clients at the authorization server |
| `GET/POST /authorize` | Starts the flow; renders the token-paste consent page |
| `POST /authorize/verify` | Consent page submits here; verifies the token against AACWorkflow and redirects back with a code |
| `POST /token` | Exchanges an authorization code (+ PKCE verifier) or refresh token for an access token |
| `POST /register` | RFC 7591 dynamic client registration |
| `POST /revoke` | RFC 7009 token revocation |

Tokens are in-memory only (opaque `aacmcp_at_…` / `aacmcp_rt_…`, 1h access / rotating refresh) — restarting the process ends all OAuth sessions; clients re-run the flow automatically. This is intentional for a single-instance deployment; there is no cross-instance token store.

### Marketplace / directory listing

The hosted endpoint now satisfies the **OAuth 2.1** requirement for the Anthropic Connectors directory / OpenAI Apps. Actually publishing still requires a vendor review submitted from your own org account — that's a business step, not a code change.

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aacworkflow": {
      "command": "npx",
      "args": ["-y", "github:AAChibilyaev/aacworkflow-mcp"],
      "env": { "AACWORKFLOW_TOKEN": "mul_your_token" }
    }
  }
}
```

Restart Claude Desktop.

## Local install (development)

```bash
git clone https://github.com/AAChibilyaev/aacworkflow-mcp
cd aacworkflow-mcp && npm install && npm run build
claude mcp add aacworkflow -e AACWORKFLOW_TOKEN=mul_xxx -- node "$PWD/dist/index.js"
```

## Tools (65)

- **Account/workspace:** `whoami`, `list_workspaces`, `get_workspace`, `update_workspace`, `list_members`
- **Runtimes:** `list_runtimes`, `update_runtime`, `runtime_usage`, `runtime_activity`
- **Agents:** `list_agents`, `get_agent`, `create_agent`, `update_agent`, `archive_agent`, `restore_agent`, `list_agent_templates`, `create_agent_from_template`, `list_agent_tasks`, `list_agent_skills`, `attach_skill_to_agent`, `detach_skill_from_agent`
- **Skills:** `list_skills`, `get_skill`, `create_skill`, `update_skill`, `delete_skill`, `import_skill`
- **Tasks (issues):** `list_issues`, `get_issue`, `create_issue`, `update_issue`, `assign_issue_to_agent`, `rerun_issue`, `comment_issue`, `list_comments`, `search_issues`, `list_issue_runs`, `list_issue_subscribers`, `add_issue_subscriber`, `remove_issue_subscriber`, `get_attachment`
- **Projects / labels:** `list_projects`, `create_project`, `update_project`, `delete_project`, `list_labels`, `create_label`
- **Squads:** `list_squads`, `get_squad`, `create_squad`, `update_squad`, `delete_squad`, `list_squad_members`, `add_squad_member`, `remove_squad_member`
- **Autopilots:** `list_autopilots`, `get_autopilot`, `create_autopilot`, `update_autopilot`, `delete_autopilot`, `trigger_autopilot`, `list_autopilot_runs`
- **Analytics:** `dashboard_usage_daily`, `dashboard_usage_by_agent`, `dashboard_agent_runtime`

> **Dispatch work to an agent:** `create_issue` with `assignee_type:"agent"` + `assignee_id`, or `assign_issue_to_agent` on an existing issue — the agent's runtime daemon picks it up and runs it.

> **Endpoint provenance:** AACWorkflow doesn't publish an OpenAPI/Swagger spec. The original 34 tools were verified against the live API; the rest were added by mapping [`aacworkflow` CLI commands](https://aacworkflow.com/docs/cli) to REST calls by analogy with the existing ones (e.g. `squad member add` → `POST /api/squads/:id/members`). If one of the newer tools 404s against your instance, that's why — open an issue with the correct path and it'll get fixed.

## Config

**stdio (local, `src/index.ts`)**

| Env | Default | |
|-----|---------|---|
| `AACWORKFLOW_TOKEN` | — | **required** (`mul_…`) |
| `AACWORKFLOW_SERVER_URL` | `https://aacworkflow.com` | self-hosted? point here |
| `AACWORKFLOW_WORKSPACE_ID` | — | optional default workspace |

**HTTP (hosted, `src/http.ts`)**

| Env | Default | |
|-----|---------|---|
| `PORT` | `8787` | listen port |
| `AACWORKFLOW_SERVER_URL` | `https://aacworkflow.com` | upstream AACWorkflow API |
| `AACWORKFLOW_MCP_PUBLIC_URL` | `http://127.0.0.1:$PORT` | **set this in production** — the public origin clients reach you at; OAuth issuer/redirect/metadata URLs are derived from it |

## Operations

- **Rate limiting:** `/mcp` is capped at 120 req/min per IP; the OAuth endpoints (`/authorize`, `/token`, `/register`, `/revoke`) have their own stricter limits built into the SDK's auth router.
- **Logging:** one structured JSON line per request to stdout (method, path, status, latency, session id) — no tokens are ever logged; OAuth token log lines carry only an 8-char prefix for correlation.
- **Session lifecycle:** idle MCP sessions (no request for 30 minutes) are reaped every 5 minutes to bound memory; `SIGTERM`/`SIGINT` drain in-flight sessions and OAuth state before exiting.
- **Scaling:** session and OAuth-token state is in-process memory, sized for a single instance (which is what a Coolify/Cloudflare deployment of this project is). Running multiple replicas needs sticky sessions in front — there's no shared session/token store.

## Development

```bash
npm install
npm run build     # tsc
npm test          # vitest — server tools, OAuth provider, HTTP app smoke tests
npm run test:watch
```

CI (`.github/workflows/ci.yml`) runs build + test + a Docker build on every push/PR to `main`.

## Security

Your token is read only from the environment you pass at install time (stdio) or
from the `Authorization` header per-request (HTTP), and sent only to your
`AACWORKFLOW_SERVER_URL` over HTTPS. It is never written to the repo, logged, or
shared. Revoke it anytime in Settings → Tokens.

For the hosted HTTP transport, OAuth access/refresh tokens are opaque, scoped to
the client that requested them, expire in an hour (access) or are revoked
individually (refresh, rotated on every use) — they carry no information about
your underlying AACWorkflow token beyond an in-memory mapping on this server.

MIT licensed.
