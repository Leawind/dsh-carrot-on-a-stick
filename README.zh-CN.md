# dsh-ops-mcp

> 通过 MCP 操作 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）：在 dsh 进程内启动一个 MCP server，把会话执行、任务队列、工作区管理能力暴露出来，任何 MCP 客户端都能调用。

[![npm version](https://img.shields.io/npm/v/dsh-ops-mcp)](https://www.npmjs.com/package/dsh-ops-mcp)
[![license](https://img.shields.io/npm/l/dsh-ops-mcp)](./LICENSE)

> 📖 [English](./README.md) · 中文（当前页）

## 它解决什么问题

dsh 自带完整的 agent 运行时——模型路由、工具沙箱、预设、会话持久化——但它是一个 Cordis 应用，外部程序无法直接调用。dsh-ops-mcp 把它「由内向外」翻转：插件在 dsh 进程内启动 MCP server（StreamableHTTP），通过 `ctx.agents` / `ctx.agentPresets` / `ctx.tools` 桥接运行中的 harness。

**你的 MCP 客户端是指挥官，dsh 是执行者。** 适配的客户端包括且不限于：Claude Code、Codex CLI、Cursor、另一个 dsh 实例（经官方 `dsh-mcp-client` 挂接）、任何自动化脚本。

```
MCP 客户端（Claude Code / Codex / 另一个 dsh / …）
   │  agent_run / task_inbox / task_result (HTTP + Bearer)
   ▼
dsh-ops-mcp（MCP server, 127.0.0.1:8090）
   │  ctx.agents.create → 挂载 preset
   ▼
dsh agent —— 完整工具集：bash、fs、todo、web…
```

## 工具

| 工具 | 用途 |
|---|---|
| `echo` | 验证 MCP 连通性 |
| `dsh_list_tools` | 列出 dsh 当前注册的工具名 |
| `agent_run` | 同步执行任务，返回结构化结果；可传 `sessionId` 续接已有会话 |
| `task_inbox` | 把结构化任务（任务+上下文+cwd）推入异步队列，返回 `taskId` |
| `task_result` | 取回队列任务的结构化结果 |
| `attach_session` | 把会话归组到其 cwd 对应的工作区 |
| `rename_session` | 给已有会话改名 |

每个任务结果都是**结构化**的：`sessionId / assistantText / toolCalls / toolResults / changes / verification / leftovers`——调用方可以直接写回自己的记忆系统或工单。

会话按 cwd 复用（LRU，默认 8 个），避免每次调用都重新加载项目上下文。

## 安装与运行

```bash
git clone https://github.com/Leawind/dsh-ops-mcp.git
cd dsh-ops-mcp
npm install

export DEEPSEEK_API_KEY=...
dsh web --patch ./cordis.yml
```

MCP server 监听 `127.0.0.1:8090`（StreamableHTTP）。任意 MCP 客户端指向 `http://127.0.0.1:8090/mcp` 即可。

### 客户端配置示例

通用（任何支持 streamable-http 的 MCP 客户端）：

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

让**另一个 dsh** 操作这个 dsh（对端 profile 的 `cordis.patch.yml`，走官方 `dsh-mcp-client`）：

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

## cordis.yml（patch 格式）

```yaml
- insert:
    - id: dsh-ops-mcp
      name: 'dsh-ops-mcp'
      config:
        http: true
        port: 8090
        host: 127.0.0.1        # 默认仅本机; 暴露前必须加认证
        # authToken: 'your-secret-token'   # Bearer token 认证
        # workspaceRoots: ['/workspace']   # cwd 白名单
        # preset: 'standard'               # 挂载的 agent preset
        # model: ''                        # 空 = 跟随 dsh 用户/默认设置
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8090` | MCP server 监听地址 |
| `authToken` | — | Bearer token；设置后所有请求强制校验 |
| `workspaceRoots` | — | cwd 白名单；agent 只能在列出的目录下干活 |
| `provider` / `model` / `preset` | `deepseek-official` / 跟随用户设置 / `standard` | 生成 agent 的配置 |
| `maxQueue` / `taskTtlMs` / `maxAgents` | `100` / 10 分钟 / `8` | 队列容量、结果保留时长、会话池 LRU 上限 |

## 安全

⚠️ 这个插件暴露的是**本机执行能力**（等价于远程代码执行）。默认只监听 `127.0.0.1`。启用时务必：

1. 配置 `authToken`——防本机其他进程与 DNS rebinding 攻击；
2. 配置 `workspaceRoots`——限定 agent 可操作的目录；
3. 不要绑定 `0.0.0.0` 或暴露到局域网/公网，除非前面有反代 + TLS + 认证。

## 源码来源

本项目的初始源码**复制自** [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT，感谢 @chushixixin），随后作为独立项目演进：不保留 git fork 关系，也不计划向上游贡献。主要改造方向：

- **去 Hermes 化**：面向任意 MCP 客户端（Claude Code / Codex / Cursor / 另一个 dsh / 自动化脚本）；
- **贴合当前版本 dsh**：见下方 Roadmap；
- **独立命名与仓库**：`dsh-ops-mcp`。

## Roadmap / 已知问题（对 dsh 0.1.5-rc.2）

- [ ] `@deepseek-ai/dsh-*` 依赖仍钉在 0.1.0-rc.x 时代：与 0.1.5-rc.2 混装时，`scopeOf` 的模块私有 Symbol 不匹配会让 preset 挂载被跳过（agent 无工具）。需移除 scope 预检（让 `mount` 自行校验）或改用宿主侧判定。
- [ ] `ctx.tools.keys()` 在 0.1.5 已不存在 → `dsh_list_tools` 返回空数组，改用 `ctx.tools.schemas()`。
- [ ] `sessionPersistence.list()` 返回 `SessionPersistenceSnapshot[]`（header 在 `.header` 字段），按旧形状读取会失效。
- [ ] `workspaceRegistry` 侧 `attachSession` 接口需重新核对。
- [ ] Windows 下 `workspaceRoots` 子目录匹配因路径分隔符失效（`startsWith(root + '/')` 遇反斜杠路径）。
- [ ] `apply()` 不等待 `listen`，端口被占用时静默失败。

## 开发

```bash
npm install
npm run smoke    # 端口 8099 上的最小冒烟测试（假 ctx + 真实 MCP 协议往返）
```

构建完整产物需要在 deepseek-harness 仓库树内执行（上游遗留的 `tsconfig.json` 相对引用），后续计划改为独立构建。

## License

MIT —— 见 [LICENSE](./LICENSE)（保留上游版权声明）。
