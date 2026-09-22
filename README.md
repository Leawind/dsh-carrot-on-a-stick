# dsh-ops-mcp

> Operate [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) over MCP: run an MCP server inside the dsh process and expose session execution, task queues, and workspace management to any MCP client.

[![npm version](https://img.shields.io/npm/v/dsh-ops-mcp)](https://www.npmjs.com/package/dsh-ops-mcp)
[![license](https://img.shields.io/npm/l/dsh-ops-mcp)](./LICENSE)

> 📖 English (this page) · [中文](./README.zh-CN.md)

## What it does

dsh ships a complete agent runtime — model routing, tool sandbox, presets, persistent sessions — but it is a Cordis application that external programs cannot call directly. dsh-ops-mcp turns it inside out: the plugin starts an MCP server (StreamableHTTP) inside the dsh process and bridges the live harness through `ctx.agents` / `ctx.agentPresets` / `ctx.tools`.

**Your MCP client is the commander; dsh is the executor.** Works with Claude Code, Codex CLI, Cursor, another dsh instance (via the official `dsh-mcp-client`), or any automation script.

```
MCP client (Claude Code / Codex / another dsh / …)
   │  agent_run / task_inbox / task_result (HTTP + Bearer)
   ▼
dsh-ops-mcp (MCP server, 127.0.0.1:8090)
   │  ctx.agents.create → mount preset
   ▼
dsh agent — full toolset: bash, fs, todo, web…
```

## Tools

| Tool | Purpose |
|---|---|
| `echo` | connectivity check |
| `dsh_list_tools` | list tool names registered in dsh |
| `agent_run` | run a task synchronously, structured result; pass `sessionId` to continue a session |
| `task_inbox` | push a structured task (task + context + cwd) into the async queue, returns `taskId` |
| `task_result` | fetch the structured result of a queued task |
| `attach_session` | attach a session to the workspace of its cwd |
| `rename_session` | rename an existing session |

Every result is structured: `sessionId / assistantText / toolCalls / toolResults / changes / verification / leftovers` — ready to be persisted by the caller.

Sessions are reused per cwd (LRU, default 8) to avoid reloading project context on every call.

## Install & run

```bash
git clone https://github.com/Leawind/dsh-ops-mcp.git
cd dsh-ops-mcp
npm install

export DEEPSEEK_API_KEY=...
dsh web --patch ./cordis.yml
```

The MCP server listens on `127.0.0.1:8090` (StreamableHTTP). Point any MCP client at `http://127.0.0.1:8090/mcp`.

### Client configuration

Generic (any streamable-http capable MCP client):

```json
{
  "mcpServers": {
    "dsh": {
      "url": "http://127.0.0.1:8090/mcp",
      "headers": { "Authorization": "Bearer <your-secret-token>" }
    }
  }
}
```

Let **another dsh** operate this one (add to the peer profile's `cordis.patch.yml`, using the official `dsh-mcp-client`):

```yaml
- id: mcp-dsh-ops
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: dsh
    transport: streamable-http
    url: http://127.0.0.1:8090/mcp
    headers:
      Authorization: 'Bearer <your-secret-token>'
```

## cordis.yml (patch format)

```yaml
- insert:
    - id: dsh-ops-mcp
      name: 'dsh-ops-mcp'
      config:
        http: true
        port: 8090
        host: 127.0.0.1        # localhost only by default; add auth before exposing
        # authToken: 'your-secret-token'   # Bearer token auth
        # workspaceRoots: ['/workspace']   # cwd whitelist
        # preset: 'standard'               # agent preset to mount
        # model: ''                        # empty = follow dsh user/default settings
```

| Field | Default | Meaning |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8090` | MCP server bind address |
| `authToken` | — | Bearer token; enforced on every request when set |
| `workspaceRoots` | — | cwd whitelist |
| `provider` / `model` / `preset` | `deepseek-official` / follow user settings / `standard` | spawned-agent configuration |
| `maxQueue` / `taskTtlMs` / `maxAgents` | `100` / 10 min / `8` | queue capacity, result TTL, session-pool LRU limit |

## Security

⚠️ This plugin exposes **local execution capability** (equivalent to RCE). It binds `127.0.0.1` only by default. When enabling:

1. Set `authToken` — against other local processes and DNS-rebinding attacks;
2. Set `workspaceRoots` — constrain where agents may work;
3. Never bind `0.0.0.0` or expose to LAN/WAN without a reverse proxy + TLS + auth.

## Provenance

The initial source of this project was **copied from** [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server) (MIT, thanks @chushixixin) and then evolved as an independent project — no git fork relationship, no upstream contributions planned. Key changes:

- drops the Hermes-specific framing — targets any MCP client;
- tracks current dsh releases (see Roadmap);
- independent name and repository: `dsh-ops-mcp`.

## Roadmap / known issues (against dsh 0.1.5-rc.2)

- [ ] `@deepseek-ai/dsh-*` deps still pinned to the 0.1.0-rc.x era: when mixed with 0.1.5-rc.2, the module-private `Symbol()` inside `scopeOf` mismatches and preset mounting gets skipped (tool-less agents). Remove the scope pre-check (let `mount` validate) or detect from the host side.
- [ ] `ctx.tools.keys()` no longer exists in 0.1.5 → `dsh_list_tools` returns `[]`; switch to `ctx.tools.schemas()`.
- [ ] `sessionPersistence.list()` now returns `SessionPersistenceSnapshot[]` (header under `.header`).
- [ ] `workspaceRegistry`'s `attachSession` surface needs re-verification.
- [ ] On Windows, `workspaceRoots` subdirectory matching breaks on path separators (`startsWith(root + '/')` vs backslashes).
- [ ] `apply()` does not await `listen`; a port conflict fails silently.

## Development

```bash
npm install
npm run smoke    # minimal smoke test on port 8099 (fake ctx + real MCP protocol round-trips)
```

Building the full artifacts currently requires the deepseek-harness repo tree (inherited `tsconfig.json` relative references); standalone build is planned.

## License

MIT — see [LICENSE](./LICENSE) (upstream copyright notice retained).
