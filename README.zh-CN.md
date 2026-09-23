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
   │  agent_run / task_inbox / task_result / model_list / select_model (HTTP + Bearer)
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
| `dsh_list_tools` | 列出 dsh 全局工具注册表（name + description；模型工具在 preset 作用域，通常为空） |
| `model_list` | 列出当前可路由的 provider、模型 id、推理档与缺省选择（选模型前先查这里） |
| `agent_run` | 同步执行任务，返回结构化结果；`sessionId` 续接会话；`provider`/`model`/`reasoningEffort` 指定本次模型；`detail` 分级控制返回体积；支持 MCP `notifications/cancelled` 取消（走宿主官方 `agent.cancel`）；调用方传 `_meta.progressToken` 时发 `notifications/progress` 心跳 |
| `task_inbox` | 把结构化任务（任务+上下文+cwd+模型）推入异步队列，返回 `taskId` |
| `task_result` | 取回队列任务结果；`detail=status` 轻量轮询，不重复注入 payload |
| `task_list` | 列出队列中的任务（排队/执行中/已结束；队列可观测） |
| `task_cancel` | 取消排队或执行中的任务（执行中走宿主官方 `agent.cancel`） |
| `session_list` | 列出已知会话元数据（live+持久化合并，按创建时间倒序），供挑选续接的 `sessionId` |
| `session_history` | 读 live 会话的对话纪要（user/assistant/tool 轮次，从最新往回取，文本截断） |
| `select_model` | 切换**已存在会话**使用的模型（官方 `sessionController.selectModel` 路径） |
| `attach_session` | 把会话归组到其 cwd 对应的工作区 |
| `rename_session` | 给已有会话改名 |

## 模型选择

优先级：**单次调用参数 > 插件 config（`provider`+`model`） > 宿主默认选择**（`ctx.agentDefaultModel.currentSelection()`，与 Web UI 建会话同源）。只给一边时用低优先级来源补另一边；补齐不了会明确报错，而不是留个空模型（否则 persona 里的 `{{model}}` 变量无值，整个 turn 在组装期失败）。

**推理强度（`reasoningEffort`）与模型同源**：调用参数 > 插件 config > 宿主默认选择里的档位。但若调用方或插件 config 已**显式钉住 provider+model**，就不再继承宿主那个"为别的模型选的"档位（宿主对不支持的显式 effort 直接拒绝，不做 clamp/别名，继承反而会把本来能跑的部署弄挂）。

三条改模型的路径：

| 想要什么 | 怎么做 |
|---|---|
| 这次任务换个模型跑 | `agent_run` / `task_inbox` 带 `provider`+`model`（可加 `reasoningEffort`） |
| 同一个会话中途换模型、保留历史 | `select_model`（官方 `sessionController.selectModel`：校验 + 写一条持久通知，在下一个 step 生效；历史不丢） |
| 整台部署固定用一个模型 | 插件 config 里成对配 `provider`+`model`，并设 `allowModelOverride: false` 锁死调用方覆盖 |

两个来源语义要分清：

- **常驻会话池按 `cwd + 模型三元组` 分组**。同一目录下用 A 模型跑任务 1、B 模型跑任务 2，是两个独立会话（上下文不串联），这样"哪个会话在用哪个模型"始终可预期；想在一个会话里换模型就用 `select_model`。
- 结果里新增 `model: {provider, model, reasoningEffort?}`，调用方不用猜这次是谁答的。

`model_list` 的 `source` 说明目录口径：`sessionController` = 官方口径（与 Web UI 模型选择器同一数据源，含 `default` / `routableProviders` / 各 provider 的加载失败与推理档）；`llm` = 回退口径（`llm.listProviders()` + 逐个 `listModels()`，用于没有 `sessionController` 的部署，如 headless，不含推理档元数据）。同时回报插件自身的模型配置与 `allowModelOverride`，调用方一眼能看出"我能不能自己选"。

**结果分级（token 预算）**——本插件的存在意义是省调用方（operator）的上下文：dsh 内部执行细节不进调用方上下文，读回按 `detail` 投影：

- `summary`（默认，~数百 token）：`changes/verification/leftovers` 三行总结 + 回答尾部（总结 JSON 在末尾）+ 工具名列表 + `error`
- `normal`（~2k token）：上述 + 截断的工具调用参数与结果
- `full`（最坏数万 token，排查用）：完整原文
- `task_result` 另有 `status` 档：轮询只返回 `{taskId, status, error?}`，完成后再取一次 summary——避免轮询把结果 payload 重复灌进上下文

续接同一 `sessionId` 时，executor 已记得此前内容，`context` 建议**只发增量**。

每个任务结果都是**结构化**的：`sessionId / model / assistantText / toolCalls / toolResults / changes / verification / leftovers`——调用方可以直接写回自己的记忆系统或工单。

会话按 `cwd + 模型` 复用（LRU，默认 8 个），避免每次调用都重新加载项目上下文。

## 安装与运行

插件以包形式装进 dsh 的 **profile 目录**（loader 从那里解析插件名；在仓库根直接 `--patch` 是找不到本地包的——见 [E2E 记录](./docs/e2e-0.1.5-rc.2.zh.md) 发现 1）：

```bash
git clone https://github.com/Leawind/dsh-ops-mcp.git
cd dsh-ops-mcp
npm install && npm run build
npm pack                                        # 产出 dsh-ops-mcp-<ver>.tgz

# 装进 profile(Windows 注意: 用 tarball, pnpm 对 file:D:/... 形式会拼坏路径)
pnpm -C ~/.dsh/profiles/<profile> add -w <tarball 路径>

export DEEPSEEK_API_KEY=...                     # 模型凭证(或用 ~/.dsh 里已保存的)
dsh --profile <profile> --patch ./cordis.yml --no-open --port 3081
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
        # authToken: 'your-secret-token'   # Bearer token 认证(常数时间比较)
        # workspaceRoots: ['/workspace']   # cwd 白名单(跨平台分隔符/大小写安全)
        # allowedHosts: ['my-box.lan']     # Host 头白名单追加项(防 DNS rebinding)
        # preset: 'standard'               # 挂载的 agent preset
        # model: ''                        # 空 = 跟随 dsh 用户/默认设置
        # provider: ''                     # 与 model 成对; 空 = 跟随宿主默认
        # reasoningEffort: ''              # 默认推理强度(空 = 适配器默认)
        # allowModelOverride: true         # false = 锁死模型, 拒绝调用方的覆盖
        # sessionTtlMs: 86400000           # 空闲 MCP 传输会话超过该时长即被回收(0 = 永不)
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8090` | MCP server 监听地址；监听失败（如端口被占）会让插件启动显式失败 |
| `authToken` | — | Bearer token；设置后所有请求强制校验（常数时间比较） |
| `workspaceRoots` | — | cwd 白名单；agent 只能在列出的目录（含子目录）下干活 |
| `allowedHosts` | — | Host 头白名单追加项；默认放行绑定地址与 loopback 别名，其余 403 |
| `provider` / `model` | 跟随宿主用户设置（`agentDefaultModel`） | 生成 agent 的模型选择；**需成对配置**，只配一边会用宿主默认补全另一边 |
| `reasoningEffort` | 适配器默认 | 默认推理强度（适配器定义的 id，见 `model_list` 的 `reasoningEfforts`） |
| `allowModelOverride` | `true` | 是否允许调用方（`agent_run`/`task_inbox`/`select_model`）覆盖模型；`false` = 部署锁死，覆盖请求被明确拒绝 |
| `preset` | `standard` | 挂载的 agent preset |
| `defaultDetail` | `summary` | `agent_run`/`task_result` 的默认详略级别（单次调用可用 `detail` 覆盖） |
| `reattachOrphans` | `false` | 启动时把未分组会话补挂到工作区（批量写用户数据，默认关；`attach_session` 工具随时可用） |
| `maxQueue` / `taskTtlMs` / `maxAgents` | `100` / 10 分钟 / `8` | 队列容量、结果保留时长、会话池 LRU 上限 |
| `taskTimeoutMs` | `0`（关闭） | agent turn 自动超时；到点走官方 `agent.cancel({kind:'hook'})`，结果 `error` 注明超时。长任务部署请调大或保持关闭 |
| `progressIntervalMs` | `5000`（最小 250） | `agent_run` 的 `notifications/progress` 心跳间隔——仅当调用方传 `_meta.progressToken` 时生效 |
| `queuePersistPath` | —（关闭） | 任务队列持久化文件：每次变化即落盘；重启后 done/error/cancelled 连结果取回、queued 重新执行、running 如实标记 `interrupted by restart` |
| `sessionTtlMs` | `86400000`（24 小时） | 空闲超过该时长的 MCP 传输会话被服务端回收；客户端对旧会话 id 得到 404，按规范重新 initialize 即可（`0` = 永不回收） |

每个任务结果都是**结构化**的：`sessionId / model / changes / verification / leftovers / error / toolCallCount …`（按 detail 分级投影）；`error` 承接 turn 的非正常收场（模型调用失败/取消/blocked），不会再出现"成功"的空结果；空的 `error`/`taskId` 字段直接省略（不再是空串）。工具级失败（未知 `taskId`、覆盖被拒、服务不可用、cwd 越界、turn 失败）按 MCP 规范以 **`isError: true`** 的工具结果返回——严格客户端与模型无需解析载荷即可识别为失败。

## 零宿主副本

插件运行时对 `@deepseek-ai/*` **零依赖**：所有 dsh 能力都经注入的宿主服务
（`ctx.agents` / `ctx.tools` / `ctx.agentPresets` …）访问；类型只在编译期做声明合并
（`import type`，构建后擦除），`@deepseek-ai/*` 全部是 devDependencies。
因此插件自带的新旧依赖副本永远不会与宿主进程内的私有 Symbol/类标识错位——
上游 0.1.x 时代 `scopeOf` 副本不匹配导致 agent 静默失去全部工具的根因就此消除。
事件读取走公开 API `session.snapshotEvents()`，消息构造用与宿主 `createUserMessage`
逐字段一致的本地实现。

## 安全

⚠️ 这个插件暴露的是**本机执行能力**（等价于远程代码执行）。默认只监听 `127.0.0.1`。启用时务必：

1. 配置 `authToken`——防本机其他进程与 DNS rebinding 攻击（常数时间比较）；
2. 配置 `workspaceRoots`——限定 agent 可操作的目录；
3. 不要绑定 `0.0.0.0` 或暴露到局域网/公网，除非前面有反代 + TLS + 认证。

内置防护：Host 头白名单（默认绑定地址 + loopback 别名，防 DNS rebinding，缺失 Host 400）；
同一白名单上的 Origin 头校验（带跨域或非法 `Origin`——如 `Origin: null`——一律 403；不发 Origin
的非浏览器 MCP 客户端不受影响）；HTTP 入口只服务 `/mcp`，其余路径 404；401 响应带
`WWW-Authenticate: Bearer` 挑战；空闲传输会话超过 `sessionTtlMs`（默认 24 小时）自动回收。
工具同时携带协议元数据（`title`、`annotations.readOnlyHint` 等，2025-06-18 协议字段），
便于客户端标注与沙箱判断。注意：`queuePersistPath` 会把任务载荷（任务文本、调用方上下文、
结果）以明文写入指定文件——请放在文件系统权限合适的路径。

## 源码来源

本项目的初始源码**复制自** [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT，感谢 @chushixixin），随后作为独立项目演进：不保留 git fork 关系，也不计划向上游贡献。主要改造方向：

- **去 Hermes 化**：面向任意 MCP 客户端（Claude Code / Codex / Cursor / 另一个 dsh / 自动化脚本）；
- **贴合当前版本 dsh**：见下方 Roadmap；
- **独立命名与仓库**：`dsh-ops-mcp`。

## Roadmap / 已知限制（对 dsh 0.1.5-rc.2）

0.2.0 Roadmap 的兼容性问题已在 0.3.0 处理；**0.3.1 完成真机 E2E 验证**（全绿，见 [docs/e2e-0.1.5-rc.2.zh.md](./docs/e2e-0.1.5-rc.2.zh.md)），并修复 E2E 发现的问题：`{{model}}` 提示词变量（模型选择现经 `agentDefaultModel` 补全）、turn 失败透出、池会话 flush、存量捞回默认关闭、安装流程文档修正。
**0.5.0 补齐模型选择面**：`model_list`（官方目录 / `llm` 回退）、`agent_run`+`task_inbox` 的按调用覆盖、`select_model`（会话内换模型）、`reasoningEffort`、`allowModelOverride` 门禁、结果自报 `model`、会话池按 `cwd + 模型` 分组。
**0.6.0 收紧 MCP 协议一致性**：工具错误结果带 `isError: true`、DNS rebinding 防护补上 Origin 头校验、401 带 `WWW-Authenticate` 挑战、工具暴露 `title` + `annotations`、空闲传输会话自动回收（`sessionTtlMs`）、GUI 面板显示会话 TTL。
**0.7.0 补齐取消与可观测面**：`agent_run` 支持 MCP `notifications/cancelled` 取消（接宿主官方 `agent.cancel({kind:'user'})`），新增 `task_cancel` / `task_list` / `session_list`——队列可取消可列举、会话可发现，均为原先的 Roadmap 项。
**0.8.0 收尾**：可选 `taskTimeoutMs` 自动超时（官方 hook 原因 cancel + error 注明）、`session_list` 回报 live 会话标题、GUI 队列统计细分失败/取消。
**0.9.0 可选队列持久化**（`queuePersistPath`）：任务状态跨重启保留——已完成结果仍可取回、排队任务重新执行、被打断的如实上报；`running` 状态改为真正开始执行才标记，`task_list` 的排队/执行中从此精确。
**0.10.0 补齐交互面**：`agent_run` 支持 `notifications/progress` 心跳（规范 `_meta.progressToken`），新增只读 `session_history` 读 live 会话纪要。协议审查报告见 [docs/protocol-audit-2026-09-24.zh.md](./docs/protocol-audit-2026-09-24.zh.md)。
**0.11.0 会话模型可见性**：`session_list` 回报各会话当前模型选择（已知时），续接前即可确认"这个会话在用哪个模型"。

仍然存在的限制：

- [x] ~~任务队列在进程内存中，进程重启丢失~~——0.9.0 加了可选持久化（`queuePersistPath`）；不配置时仍是内存队列。
- [x] ~~无服务端自动超时~~——0.8.0 加了可选的 `taskTimeoutMs`（默认关闭）；调用方仍可主动取消（`agent_run` 用 MCP `notifications/cancelled`，队列任务用 `task_cancel`）。
- [x] ~~队列不能列举/取消~~——0.7.0 已补（`task_list` / `task_cancel`）。
- [x] ~~只读查询面不完整：没有 `session_list`~~——0.7.0 已补（列会话元数据）；0.10.0 再补 `session_history`（live 会话纪要；仅持久化的会话读整日志仍需宿主侧 API）。
- [ ] `preset` 仍是部署级配置（一个 MCP server 实例一种 persona），不能按调用指定。
- [ ] spawn 出的会话里工具调用走宿主 approval 策略（`ask` 下敏感操作可能弹窗或 fail-closed；本次 E2E 的只读操作未受影响）。
- [ ] `dsh_list_tools` 只列宿主全局注册表；按 agent 作用域列出实际可用工具需要宿主侧 API（ScopeKey 私有符号，零副本原则下拿不到）。
- [ ] `select_model` 依赖 web profile 的 `sessionController`；该服务缺席时（如 headless）只有目录回退与按调用覆盖可用，工具会明确报不可用。
- [ ] 协议原生 task augmentation（2025-11-25 草案，SDK 接口标注 experimental）：把 `agent_run` 暴露为规范原生任务，走 `tasks/get` / `tasks/result` 轮询。有意缓做——`task_inbox` / `task_result` / `task_cancel` 已对所有客户端覆盖同一工作流，等规范离开草案再评估。
- [ ] dsh 未来版本升级时，devDeps 里的 `@deepseek-ai/*` 类型版本需同步（仅影响编译期，运行时零依赖不受影响）。

## 开发

```bash
npm install
npm run build    # 独立构建(纯 tsc), 产出 lib/
npm run smoke    # 端口 8099/8098/8096/8095/8094/8093/8092/8091 假 ctx 冒烟(93 项, 真实 MCP 协议往返) + 端口冲突专项
```

真机 E2E（需要本机 dsh 与模型凭证，会花少量 token）：按 [docs/e2e-0.1.5-rc.2.zh.md](./docs/e2e-0.1.5-rc.2.zh.md) 的方式起一个独立 profile，然后 `E2E_WITH_AGENT=1 node e2e.mjs`。

## License

MIT —— 见 [LICENSE](./LICENSE)（保留上游版权声明）。
