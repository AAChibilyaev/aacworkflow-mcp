# aacworkflow-mcp

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

## Tools (34)

- **Account/workspace:** `whoami`, `list_workspaces`, `list_members`, `list_runtimes`
- **Agents:** `list_agents`, `get_agent`, `create_agent`, `update_agent`, `list_agent_templates`, `create_agent_from_template`, `list_agent_tasks`
- **Tasks (issues):** `list_issues`, `get_issue`, `create_issue`, `update_issue`, `assign_issue_to_agent`, `rerun_issue`, `comment_issue`, `list_comments`, `search_issues`
- **Projects / labels:** `list_projects`, `create_project`, `list_labels`, `create_label`
- **Squads:** `list_squads`, `get_squad`, `create_squad`
- **Autopilots:** `list_autopilots`, `get_autopilot`, `trigger_autopilot`, `list_autopilot_runs`
- **Analytics:** `dashboard_usage_daily`, `dashboard_usage_by_agent`, `dashboard_agent_runtime`

> **Dispatch work to an agent:** `create_issue` with `assignee_type:"agent"` + `assignee_id`, or `assign_issue_to_agent` on an existing issue — the agent's runtime daemon picks it up and runs it.

## Config

| Env | Default | |
|-----|---------|---|
| `AACWORKFLOW_TOKEN` | — | **required** (`mul_…`) |
| `AACWORKFLOW_SERVER_URL` | `https://aacworkflow.com` | self-hosted? point here |
| `AACWORKFLOW_WORKSPACE_ID` | — | optional default workspace |

## Security

Your token is read only from the environment you pass at install time and sent
only to your `AACWORKFLOW_SERVER_URL` over HTTPS. It is never written to the
repo, logged, or shared. Revoke it anytime in Settings → Tokens.

MIT licensed.
