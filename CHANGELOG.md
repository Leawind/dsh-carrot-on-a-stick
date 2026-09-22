# Changelog

## 0.4.0

**结果分级与 token 预算**——本插件的存在意义是省调用方上下文, 本次把"骨架对、默认浪费"的返回体积问题修掉:

- `agent_run` / `task_result` 新增 `detail: summary | normal | full`(**默认 summary**):
  - `summary`(~数百 token): 三行总结 + 回答尾部(总结 JSON 在末尾) + 工具名列表 + error;
  - `normal`(~2k token): 加截断的工具调用参数与结果;
  - `full`: 旧版全量行为(最坏数万 token, 排查用)。
  旧版默认最坏可返回 ~15 万字符(toolCalls 50×2000 + toolResults 20×2000 + assistantText 8000)——一次调用就能把调用方上下文打穿, 比 computer use 读几张截图还贵。
- `task_result` 新增 `detail: 'status'` 轻量轮询档: 只返回 `{taskId, status, error?}`, 完成后再取一次
  summary——旧版每次轮询都返回完整结果 JSON, 轮询 5 次 = 5 份全量 payload 进上下文。
- 内部 `TaskResult` 始终全量(队列与 sessionId 续接不丢信息), 投影只发生在返回前(`renderResult`, 各级
  字段上限总和 ≤ 级别预算)。
- 新配置 `defaultDetail`(默认 `summary`), 部署级默认、单次调用可覆盖。
- `task_result` 返回从 `{taskId, status, result: {...}}` 改为**扁平**载荷(少一层嵌套, 少几十字节)。
- 使用建议(已写入 README): 续接同一 `sessionId` 时 `context` 只发增量。
- 冒烟测试扩到 31 项(summary 形状不泄漏原文、full 档保留原文、status 轮询不注入 payload、
  队列默认 summary 投影)。

## 0.3.1

真机 E2E 验证（dsh 0.1.5-rc.2 独立 profile + 真实 agent 任务，全绿）驱动的修复，
详见 [docs/e2e-0.1.5-rc.2.zh.md](./docs/e2e-0.1.5-rc.2.zh.md)。

- **`{{model}}` 提示词变量修复（核心）**：agent-loop 把 `{{model}}` 直接读 `agent.options.model`，
  不做默认解析（默认模型解析在 Web 应用层）。v0.3.0 的默认 `provider: 'deepseek-official'` 无
  `model` 让每个 turn 在 persona 组装期失败。现在 `resolveAgentOptions()`：provider+model 成对
  显式配置直接用，部分配置经 `ctx.agentDefaultModel.currentSelection()` 补全，仍不完整则明确
  报错；默认 provider 撤空（跟随宿主用户设置）。
- **turn 失败透出**：`TaskResult.error` 承接 `turn/end` 的非 completed 收场
  （LlmError/取消/blocked/max-tokens），另加"完全无产出"兜底——不再返回"成功"的空结果。
- **池会话 flush**：任务后统一 best-effort flush（官方语义：消费者自读存储需自行 flush），
  否则 durable log 只有 header，重启续接丢历史。
- **存量捞回默认关闭**（`reattachOrphans: true` 显式开启）：真机一次补挂 156 个历史会话
  （批量写用户数据）；0.1.5 的 workspaceRegistry 已按 header.cwd 自动索引，该 rc.6 时代的
  workaround 属过度行为。`attach_session` 工具保留随时手动归组。
- **`dsh_list_tools` 语义澄清**：0.1.5+ 模型工具挂在 preset/agent 作用域，全局注册表通常为空；
  工具描述已说明以 `agent_run` 的 toolCalls 为准。
- **安装文档修正**：loader 从 profile 目录解析插件名——仓库根 `dsh web --patch ./cordis.yml`
  找不到本地包；改为 tarball 装进 profile 再 `--patch`（Windows 下 pnpm 对 `file:D:/...` 会拼坏
  路径，用 tarball）。
- 冒烟测试扩到 27 项（错误透出路径、模型选择补全断言）；新增 `e2e.mjs`（真机 E2E 客户端，
  零 token 阶段 + 环境变量门控的 agent 阶段）。

## 0.3.0

对齐 dsh 0.1.5-rc.2 的兼容性修复 + 安全加固 + 独立构建。详见 [docs/compat-review-upstream-0.1.10.zh.md](./docs/compat-review-upstream-0.1.10.zh.md)（修复依据）。

### 兼容性（对 dsh 0.1.5-rc.2）

- **移除 `scopeOf` 预检，直接调用 `ctx.agentPresets.mount`**：scope 校验交给宿主服务自身。
  旧预检在插件与宿主持有不同 `@deepseek-ai/dsh-scope` 副本时恒为假（模块私有 Symbol 不匹配），
  导致 preset 挂载被静默跳过、agent 变成无工具裸模型——本项目的头号问题。
- **运行时零 `@deepseek-ai/*` 依赖（“零宿主副本”原则）**：`createUserMessage` / `SessionId`
  改为本地等价实现（纯数据、深冻结、逐字段与宿主一致），`@deepseek-ai/*` 全部退为
  devDependencies（仅编译期类型）。插件从此不可能把新旧依赖副本混进宿主进程。
- `dsh_list_tools` 改走 `ctx.tools.schemas()`（0.1.5+），旧版 `keys()` 仅作回退；现在返回
  `name + description`。
- `sessionPersistence.list()` 兼容 0.1.5+ 的 `SessionPersistenceSnapshot[]`（header 在
  `.header` 字段）与旧版裸 header 两种形状——`attach_session` 与启动存量捞回对持久化会话恢复可用。
- 事件读取改走公开 API `session.snapshotEvents()`（私有 `log` 字段仅作旧宿主回退）。
- `workspaceRegistry` 侧核对确认：`resolveByPath ?? create` + `ws.attachSession` 在 0.1.5
  仍是官方姿势（与 `dsh-api-session-controller` 的 session.create 同款）。

### 修复

- **Windows 下 `workspaceRoots` 子目录匹配失效**：`startsWith(root + '/')` 遇反斜杠路径永远
  不匹配。改为跨平台 `isWithin`（双方 resolve、分隔符统一 `/`、win32 大小写折叠）。
- **`apply()` 现在等待 `listen` 完成**：端口被占用等监听失败会显式 reject，插件启动失败可见
  （旧行为是"成功"但 server 不存在）。

### 安全加固

- Bearer token 改为常数时间比较（`timingSafeEqual`，长度不等直接拒）。
- 新增 **Host 头白名单**（防 DNS rebinding）：默认放行绑定地址与 loopback 别名，可用
  `allowedHosts` 扩展；非白名单主机名 403，缺失 Host 400。
- HTTP 入口只服务 `/mcp`，其余路径 404。

### 工程

- **独立构建**：`tsconfig.json` 去掉对 deepseek-harness 仓库树的相对引用，`npm run build`
  （纯 `tsc`）即可产出 `lib/`；不再依赖 tsdown。
- `package.json`：新增 `exports`（支持 Node 自引用解析，`dsh --patch` 在仓库根目录直接可用）；
  运行时依赖只剩 `@modelcontextprotocol/sdk` + `zod`；版本对齐 devDeps（cordis 4.0.2、
  dsh-* 0.1.5-rc.2、typescript 5.9、@types/node）。
- 运行时配置每次 `apply` 重建，不再跨次泄漏。
- 卸载清理补全：transport 逐个 close。
- 冒烟测试扩到 24 项 + 端口冲突专项（`npm run smoke`）。

### 已知限制（未变）

- 任务队列在进程内存中，重启丢失；`agent_run` 无服务端超时/取消（调用方需自带 MCP 层超时）。
- spawn 出的会话里工具调用走宿主 approval 策略。
- 尚未在真实 `dsh web --patch` 环境做端到端验证（当前以接口核对 + 假 ctx 冒烟为准）。

## 0.2.0

初始独立版本（复制自 `chushixixin/dsh-harness-mcp-server` v0.1.10 并更名）。
