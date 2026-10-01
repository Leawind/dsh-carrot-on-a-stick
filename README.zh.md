| 中文 | [English](./README.md) |
| ---- | ---------------------- |

# DSH Carrot on a Stick

一个 [DSH](https://github.com/deepseek-ai/deepseek-harness) 插件，通过 MCP 协议为其他应用提供操作 DSH 的能力。

## MCP 功能

### 工具

| 工具              | 用途                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh_get_started` | 给 agent 的 dsh 入门课——概念、典型工作流、错误应对。初次使用先调用它                                                                   |
| `echo`            | 验证连通性                                                                                                                             |
| `dsh_status`      | 插件状态：版本、监听、uptime、队列计数、已连接客户端                                                                                   |
| `dsh_list_tools`  | 列出宿主全局工具注册表                                                                                                                 |
| `workspace_list`  | 已注册的工作区及其会话                                                                                                                 |
| `model_list`      | 可路由的 provider / 模型 / 推理档，以及当前缺省选择                                                                                    |
| `agent_run`       | 同步执行任务，返回结构化结果；`sessionId` 续接会话；按调用指定 `provider` / `model` / `reasoningEffort` / `preset`；可取消，带进度心跳 |
| `agent_steer`     | 对运行中的 agent 实时下达指令——`steer` 在下个 step 边界生效，`inject` 只注入上下文                                                     |
| `task_inbox`      | 后台任务入队，返回 `taskId`；`idempotencyKey` 幂等去重                                                                                 |
| `task_result`     | 取回队列任务结果（`detail: "status"` 轻量轮询）                                                                                        |
| `task_list`       | 队列一览：排队 / 执行中 / 已结束                                                                                                       |
| `task_cancel`     | 取消排队中（立即生效）或执行中的任务（`cancelling` → `cancelled`）                                                                     |
| `session_list`    | 已知会话（live + 持久化），按时间倒序                                                                                                  |
| `session_history` | 读会话最近轮次；`roles` 过滤（如 `["assistant"]` 只看回答）                                                                            |
| `select_model`    | 切换已有会话的模型，历史保留                                                                                                           |
| `attach_session`  | 把会话归组到其 cwd 对应的工作区                                                                                                        |
| `rename_session`  | 给会话改名                                                                                                                             |

### 资源

支持 resources 的客户端可以零 token 读取同样的数据，并用订阅替代轮询：

| URI                                           | 内容                          |
| --------------------------------------------- | ----------------------------- |
| `dsh://status[/config\|/stats\|/connections]` | 部署状态                      |
| `dsh://guide[/{section}]`                     | dsh 使用指南（markdown）      |
| `dsh://tools`                                 | 宿主全局工具注册表            |
| `dsh://models[/{provider}]`                   | 模型目录                      |
| `dsh://presets`                               | `preset` 合法取值             |
| `dsh://workspaces[/{id}]`                     | 工作区花名册                  |
| `dsh://sessions[/{id}]`                       | 会话清单 / 元数据             |
| `dsh://sessions/{id}/history[/{before}]`      | 对话纪要（可翻页）            |
| `dsh://sessions/{id}/events[/{after}]`        | 原始事件流（JSONL，可翻页）   |
| `dsh://sessions/{id}/activity`                | 当前 turn 活动窗口            |
| `dsh://queue[/{taskId}]`                      | 队列 / 任务明细（含全量结果） |
| `dsh://agents`                                | 常驻会话池                    |

`resources/subscribe` 可订阅任务状态迁移、turn 收敛刷新、实时活动，沿 SSE 推送——无需轮询。配置 `resourceFirst: true` 后九个只读工具下线、结果以资源引用返回（面向确认支持 MCP resources 的客户端；默认 `false`，工具与资源并存）。

## 常用模式

**一次性任务**——同步执行，返回结构化总结；之后用 `sessionId` 续接（`context` 只发增量）：

```json
{ "name": "agent_run", "arguments": { "task": "修复 src/auth 里挂掉的测试", "cwd": "/workspace/app" } }
```

**异步队列**——提交、轻量轮询、完成后取一次：

```json
{ "name": "task_inbox",   "arguments": { "task": "…", "cwd": "/workspace/app" } }
{ "name": "task_result",  "arguments": { "taskId": "…", "detail": "status" } }
{ "name": "task_cancel",  "arguments": { "taskId": "…" } }
{ "name": "task_result",  "arguments": { "taskId": "…" } }
```

**会话**——`session_list` 找会话，`session_history` 回看，`select_model` 换模型，`agent_steer` 中途纠偏。

**模型与 preset**

-   优先级：**单次调用参数 > 插件 config > 宿主默认**。只配一边会用低优先级来源补全；补不齐会明确报错。
-   三条改模型的路径：按调用传 `provider`+`model` · 会话中途 `select_model` · config 配死并设 `allowModelOverride: false`。preset（`preset` 参数，对新建会话生效）同理，受 `allowPresetOverride` 门禁。
-   会话池按 `cwd + 模型 + preset` 分组：同一目录、不同模型/preset → 不同的会话。接管已有会话沿用其模型与 preset。
-   按 `sessionId` 续接时在会话自己的目录执行；显式传入的 `cwd` 必须与之一致。

**结果体积**——`detail` 控制 token 开销：`summary`（默认，数百 token）/ `normal`（~2k）/ `full`（排查用）；`task_result` 另有 `status` 档供轮询。结果是结构化的（`sessionId`、`model`、`changes`、`verification`、`leftovers`…）；失败以 `isError: true` 返回。

## 配置（cordis.yml）

```yaml
- insert:
      - id: dsh-carrot-on-a-stick
        name: 'dsh-carrot-on-a-stick'
        config:
            http: true
            port: 8090
            host: 127.0.0.1 # 默认仅本机; 暴露前必须加认证
            # authToken: 'your-secret-token'
            # workspaceRoots: ['/workspace']   # cwd 白名单（同时约束会话面）
            # allowedHosts: ['my-box.lan']     # Host 头白名单追加项
            # preset: 'standard'               # 挂载的 agent preset
            # model: ''                        # 与 provider 成对; 空 = 跟随宿主默认
            # provider: ''
            # reasoningEffort: ''              # 空 = 适配器默认
            # allowModelOverride: true         # false = 锁死模型
            # allowPresetOverride: true        # false = 锁死 preset
            # queuePersistPath: '.dsh/queue.json'
            # queuePersistKey: 'passphrase'    # 持久化文件加密口令
            # sessionTtlMs: 86400000
```

| 字段                                   | 默认值                | 含义                                                                                 |
| -------------------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `host` / `port`                        | `127.0.0.1` / `8090`  | MCP server 监听地址；监听失败会让插件启动显式失败                                    |
| `authToken`                            | —                     | Bearer token；设置后所有请求强制校验                                                 |
| `workspaceRoots`                       | —                     | cwd 白名单——agent 只能在列出的目录（含子目录）下干活；同时限制可接管、可读的会话范围 |
| `allowedHosts`                         | —                     | Host 头白名单追加项（绑定地址与 loopback 始终放行）                                  |
| `provider` / `model`                   | 跟随宿主设置          | spawn agent 的默认模型；需成对配置                                                   |
| `reasoningEffort`                      | 适配器默认            | 默认推理强度（取值见 `model_list`）                                                  |
| `allowModelOverride`                   | `true`                | 是否允许调用方按调用覆盖模型                                                         |
| `allowPresetOverride`                  | `true`                | 是否允许调用方为新建会话选 preset                                                    |
| `preset`                               | `standard`            | 挂载的 agent preset（按调用 `preset` 只对新建会话生效）                              |
| `defaultDetail`                        | `summary`             | `agent_run` / `task_result` 的默认详略级别                                           |
| `resourceFirst`                        | `false`               | 资源优先形态：只读工具下线，结果以资源引用返回                                       |
| `reattachOrphans`                      | `false`               | 启动时把未分组会话批量补挂到工作区                                                   |
| `maxQueue` / `taskTtlMs` / `maxAgents` | `100` / 24 小时 / `8` | 队列容量、结果保留时长、会话池上限                                                   |
| `taskTimeoutMs`                        | `0`（关闭）           | agent turn 超时自动取消                                                              |
| `progressIntervalMs`                   | `5000`（最小 250）    | 进度心跳间隔                                                                         |
| `queuePersistPath`                     | —（关闭）             | 队列持久化文件；重启后已完成结果可取回、排队任务重新执行、执行中的如实标记被打断     |
| `queuePersistKey`                      | —（明文 + 启动告警）  | 持久化文件加密口令；口令错误 / 文件损坏则队列从空开始                                |
| `sessionTtlMs`                         | `86400000`            | 空闲 MCP 传输会话超过该时长被回收（`0` = 永不）                                      |

## 安全

⚠️ 这个插件暴露的是**本机代码执行能力**（等价于 RCE）。默认只监听 `127.0.0.1`。启用时务必：

1. 配置 `authToken`——防本机其他进程与 DNS rebinding；
2. 配置 `workspaceRoots`——不配就没有任何目录边界；配置后执行与会话读取（列举 / 历史 / 干预 / 接管）同时受限；
3. 不要绑定 `0.0.0.0` 或暴露到局域网/公网，除非前面有反代 + TLS + 认证。

内置防护：Host / Origin 头白名单（防 DNS rebinding）、HTTP 入口只服务 `/mcp`、401 带 Bearer 挑战、空闲传输会话按 `sessionTtlMs` 自动回收。注意 spawn 出的会话遵循宿主 / preset 的**审批策略**——本插件无人值守运行，`ask` 类策略下敏感操作可能弹窗等待或直接失败；部署前请按实际 preset 验证。启用 `queuePersistPath` 后任务载荷会写入该文件（不设 `queuePersistKey` 为明文）——请放在文件系统权限合适的路径。

## Web 设置面板

bundle 会向 dsh Web UI 注入 **设置 → dsh-carrot-on-a-stick** 区：实时状态徽章、MCP 端点（点击复制）、停止 / 启动按钮、已连接客户端列表、队列计数。

## 已知限制

-   spawn 出的会话遵循宿主 / preset 审批策略——无人值守场景下 `ask` 类策略可能弹窗或失败关闭。
-   `select_model` 依赖 web profile 的 `sessionController`；headless 部署回退为模型目录 + 按调用覆盖。
-   `dsh_list_tools` 只列宿主全局注册表；按 agent 实际可见范围列出需要宿主侧 API。
-   不配置 `queuePersistPath` 时队列为进程内存，重启即失。

## 感谢

初始源码复制自 [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT，感谢 @chushixixin），现为独立项目。
