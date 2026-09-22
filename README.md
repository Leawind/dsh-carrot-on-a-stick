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
| `dsh_list_tools` | list tools registered in dsh (name + description) |
| `agent_run` | run a task synchronously, structured result; pass `sessionId` to continue a session |
| `task_inbox` | push a structured task (task + context + cwd) into the async queue, returns `taskId` |
| `task_result` | fetch the structured result of a queued task |
| `attach_session` | attach a session to the workspace of its cwd |
| `rename_session` | rename an existing session |

Every result is structured: `sessionId / assistantText / toolCalls / toolResults / changes / verification / leftovers` — ready to be persisted by the caller.

Sessions are reused per cwd (LRU, default 8) to avoid reloading project context on every call.

## Install & run

The plugin must be installed into a dsh **profile directory** (the loader resolves plugin names from there; `--patch` alone from a repo checkout will not find the local package — see finding 1 in the [E2E report](./docs/e2e-0.1.5-rc.2.zh.md)):

```bash
git clone https://github.com/Leawind/dsh-ops-mcp.git
cd dsh-ops-mcp
npm install && npm run build
npm pack                                        # produces dsh-ops-mcp-<ver>.tgz

# install into the profile (Windows note: use the tarball; pnpm mangles file:D:/... specifiers)
pnpm -C ~/.dsh/profiles/<profile> add -w <path-to-tarball>

export DEEPSEEK_API_KEY=...                     # model credentials (or use what ~/.dsh already stores)
dsh --profile <profile> --patch ./cordis.yml --no-open --port 3081
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
        # authToken: 'your-secret-token'   # Bearer token auth (constant-time compare)
        # workspaceRoots: ['/workspace']   # cwd whitelist (separator/case-safe cross-platform)
        # allowedHosts: ['my-box.lan']     # extra allowed Host header values (DNS-rebinding guard)
        # preset: 'standard'               # agent preset to mount
        # model: ''                        # empty = follow dsh user/default settings
```

| Field | Default | Meaning |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8090` | MCP server bind address; a listen failure (port in use, …) fails plugin startup loudly |
| `authToken` | — | Bearer token; enforced on every request when set (constant-time compare) |
| `workspaceRoots` | — | cwd whitelist; agents may only work inside the listed directories (subdirs included) |
| `allowedHosts` | — | extra allowed Host-header values; the bind host and loopback aliases are always allowed, everything else gets 403 |
| `provider` / `model` | follow host user settings (`agentDefaultModel`) | spawned-agent model selection; **configure as a pair** — a partial setting is completed from the host default |
| `preset` | `standard` | agent preset to mount |
| `reattachOrphans` | `false` | bulk-attach ungrouped sessions to workspaces at startup (writes user data; the `attach_session` tool remains available anytime) |
| `maxQueue` / `taskTtlMs` / `maxAgents` | `100` / 10 min / `8` | queue capacity, result TTL, session-pool LRU limit |

Every result is structured: `sessionId / assistantText / toolCalls / toolResults / changes / verification / leftovers / error` — `error` carries non-normal turn endings (model failure / cancel / blocked), so a silent empty "success" can no longer happen.

## Zero host copies

The plugin has **zero runtime dependencies on `@deepseek-ai/*`**: every dsh capability is reached
through injected host services (`ctx.agents` / `ctx.tools` / `ctx.agentPresets` …), types only
augment the compiler via `import type` (erased at build), and `@deepseek-ai/*` packages are
devDependencies. A plugin therefore can never drag a mismatched copy of a host package into the
process — the root cause behind the upstream-era `scopeOf` symbol mismatch that silently left
agents tool-less. Event reads go through the public `session.snapshotEvents()` API and message
construction uses a local, field-for-field equivalent of the host's `createUserMessage`.

## Security

⚠️ This plugin exposes **local execution capability** (equivalent to RCE). It binds `127.0.0.1` only by default. When enabling:

1. Set `authToken` — against other local processes and DNS-rebinding attacks (constant-time compare);
2. Set `workspaceRoots` — constrain where agents may work;
3. Never bind `0.0.0.0` or expose to LAN/WAN without a reverse proxy + TLS + auth.

Built-in guards: a Host-header allowlist (bind host + loopback aliases by default, guarding against
DNS rebinding; a missing Host header gets 400) and a `/mcp`-only HTTP surface (everything else 404).

## Provenance

The initial source of this project was **copied from** [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server) (MIT, thanks @chushixixin) and then evolved as an independent project — no git fork relationship, no upstream contributions planned. Key changes:

- drops the Hermes-specific framing — targets any MCP client;
- tracks current dsh releases (see Roadmap);
- independent name and repository: `dsh-ops-mcp`.

## Roadmap / known limitations (against dsh 0.1.5-rc.2)

The 0.2.0 compatibility issues were fixed in 0.3.0; **0.3.1 completed live-host E2E verification** (all green — see [docs/e2e-0.1.5-rc.2.zh.md](./docs/e2e-0.1.5-rc.2.zh.md)) and fixed what it uncovered: the `{{model}}` prompt variable (model selection now completed via `agentDefaultModel`), turn-failure surfacing, pool-session flush, startup reattach off by default, and corrected install docs.

What remains:

- [ ] The task queue lives in process memory; a restart loses it (persistence is future work).
- [ ] No server-side timeout or cancellation for `agent_run` / `task_inbox` — a hung agent holds its cwd's serial lock and later same-directory tasks queue behind it; callers should bring their own MCP-level timeout.
- [ ] Tool calls inside spawned sessions go through the host approval policy (sensitive operations under `ask` may pop a dialog or fail closed; the read-only E2E operation was unaffected).
- [ ] `dsh_list_tools` only lists the host-global registry; listing an agent's actually-visible tools needs a host-side API (the ScopeKey is a private symbol, unreachable under the zero-copy principle).
- [ ] When dsh releases new versions, the `@deepseek-ai/*` devDependencies need syncing (compile-time only; the zero-runtime-dependency design is unaffected).

## Development

```bash
npm install
npm run build    # standalone build (plain tsc) -> lib/
npm run smoke    # fake-ctx smoke on ports 8099/8098 (27 checks, real MCP protocol round-trips)
                 # + a port-conflict case (apply must fail loudly)
```

Live-host E2E (needs a local dsh with model credentials; costs a few tokens): boot a dedicated
profile as described in [docs/e2e-0.1.5-rc.2.zh.md](./docs/e2e-0.1.5-rc.2.zh.md), then run
`E2E_WITH_AGENT=1 node e2e.mjs`.

## License

MIT — see [LICENSE](./LICENSE) (upstream copyright notice retained).
