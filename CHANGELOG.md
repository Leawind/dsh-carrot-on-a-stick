# Changelog

## 0.11.6

**进度与续接体验**：

- `agent_run` 的进度通知现在**立即回报一次"已启动"**（progress=1, events=0），调用方进度 UI
  无需等第一个心跳间隔才知道任务开跑了；此后心跳照常（progress 单调递增）。
- `task_list` 每个任务回报实际执行的 `sessionId`（新建池会话时请求参数里没有，执行完成后
  回填并随持久化保存）——重启或轮询后拿到 taskId 就能找到可续接的会话。
- 冒烟测试 117 → 120 项（含池新建会话纪要读取）。

## 0.11.5

**修复：池 LRU 淘汰不再打断活跃会话**——此前 `maxAgents` 压力下，不同 cwd 的新任务会淘汰
（dispose）一个正在执行 turn 的会话，直接砍掉别人的运行中任务。现在：

- executeTask 执行期间把会话 id 记入 `activeTurnSessions`；
- LRU 淘汰跳过活跃会话（优先逐出空闲的），全部忙碌时允许池暂时超限；
- 冒烟测试 109 → 111 项：`maxAgents:1` 下忙会话不被 dispose、空闲会话正常被逐出。

## 0.11.4

**加固**：MCP POST 请求体上限 10MB——`content-length` 声明超限的请求**先排空请求体再回
413**（不进入传输层读体；排空保证客户端拿到完整响应而非连接被重置）。正常任务/上下文远小于
此上限。冒烟 104 → 105 项。

## 0.11.3

**细节修正**：

- `queuePersistPath` 相对路径按进程 cwd 归一化（此前原样透传，行为依赖启动目录）。
- `executeTask` 读输出异常改为**追加**到已积累的 `assistantText`（原先整体覆盖，中途异常会
  丢掉已解析的文本）。
- README 安全段补充：持久化文件含任务载荷明文，注意文件系统权限。
- **GUI 控制面路由首次纳入测试**（status/stop/start + 同源 CSRF 门禁 + 软停启循环）：
  此前假 ctx 不提供 webServer，这块代码零覆盖；冒烟 98 → 104 项。

## 0.11.2

**锁表清理 + 并发压力覆盖**：

- `withLock` 的锁链落定且无新等待者时清掉 map key——长期运行的服务进程此前会为每个
  出现过的 cwd/session 永久留一个已 settle 的 promise，无限累积；
- 冒烟新增并发相位：6 个不同 cwd 并行 `agent_run` 全部成功、同 cwd 3 个并发任务串行
  复用同一会话、混合 `task_list` 查询不受影响；
- `package-lock.json` 根版本重新同步（此前停在 0.5.0，可能咬到 CI 的 `npm ci`）。

## 0.11.1

**健壮性收尾**：

- `task_inbox` 的 cwd 白名单校验提前到**提交时**：越界任务直接以 `isError` 拒绝并说明原因，
  不再入队后异步失败（此前调用方要轮询 `task_result` 才知道被拒）。
- 数值配置边界钳制：`taskTimeoutMs` / `sessionTtlMs` / `taskTtlMs` 负数一律按 `0`（关闭）
  处理；`maxQueue` / `maxAgents` 下限 1——误配不再产生" sweeper 秒删一切"或"池永不淘汰"类
  行为。
- 冒烟测试 94 → 95 项。

## 0.11.0

**会话模型可见性**——补上"读某会话当前模型"的最后一角：

- `session_list` 每个会话回报 `model: {provider, model, reasoningEffort?}`（已知时）：
  常驻池会话读池记录，其他 live 会话读 `agent.options`；仅持久化的会话 agent 未重建、
  无从得知，字段省略。调用方续接前即可确认"这个会话在用哪个模型"。
- GUI 面板显示队列持久化是否启用。
- README 图示工具清单更新；冒烟测试 93 → 94 项。

## 0.10.0

**进度心跳与会话纪要**——补齐 MCP 交互面最后两块：

- **`agent_run` 支持 `notifications/progress` 心跳**（MCP 规范的进度机制）：调用方在请求
  `_meta.progressToken` 里带上令牌，agent turn 执行期间按 `progressIntervalMs`（新配置，
  默认 5 秒，最小 250）在响应 SSE 流上收到进度通知——`progress` 单调递增，`message` 带
  本次新增的会话事件数。不传令牌的调用方完全不受影响。与取消/超时共用一条 abort 路径，
  心跳定时器在 turn 收敛时清除。
- **新工具 `session_history`**（只读）：读 live 会话的对话纪要——user/assistant/tool_call/
  tool_result/turn_end 轮次，从最新往回取（`limit` 默认 10），文本按角色截断省上下文。
  已持久化但不在内存的会话明确报不可读（宿主未暴露整日志加载 API），不再假装能查。
- **重构**：`executeTask` 的 9 个位置参数收拢为 `ExecuteTaskOptions` 对象；事件文本提取
  提升为模块级 `extractTexts`（与 `session_history` 共用）。
- E2E：工具清单断言更新到 13 个；新增 `session_history` 两条真机探针（不存在会话 isError
  拒绝 / agent 相读刚执行会话的轮次）。
- 冒烟测试 88 → 93 项：SSE 流上实时收到 progress 心跳 / progress 单调递增且带 message /
  history 纪要解析与 limit / 持久化-only 会话不可读。

## 0.9.0

**任务队列持久化（可选）**——Roadmap 上最后一项收尾：

- **新配置 `queuePersistPath`**（默认空 = 不持久化，行为与旧版完全一致）：设置文件路径后，
  每次队列变化即**串行落盘**（最后写入胜出），`apply` 时恢复快照——
  - `done` / `error` / `cancelled` 连结果一起回来，调用方重启后仍可 `task_result` 取回；
  - `queued`（含锁内等待）重新入队自动执行；
  - `running` 无法安全续跑半个 turn，如实标记为 `interrupted by restart`。
- **`running` 语义修正**：原来提交即标记 running（cwd 锁内等待也算"执行中"），现在只有
  真正拿到锁开始执行才翻转（`executeTask` 新增 `onStart` 锁内回调）——`task_list` 的
  排队/执行中从此名副其实，持久化快照也因此不失真。
- GUI 面板状态摘要显示队列是否持久化。
- 冒烟测试 84 → 88 项：真实"卸载→重启"流程验证 done 结果取回 / running 标记 interrupted /
  queued 重新执行并取消。

## 0.8.0

**自动超时 + 细节打磨**——0.7.0 取消面之上的收尾（Roadmap"无服务端自动超时"就此关闭）：

- **新配置 `taskTimeoutMs`**（默认 `0` = 不启用）：agent turn 执行超过该时长自动走官方
  `agent.cancel({kind:'hook', reason:'dsh-ops-mcp: task timeout after Xms'})`——与外部取消
  信号合流到同一条 abort 路径；结果 `error` 注明 `task timed out after Xms (official
  agent.cancel fired)`，且整个结果带 `isError: true`。长任务部署请按需调大或保持关闭。
- `session_list` 机会式读取 live 会话对象的 `title`（sessionTitle 服务维护的字段；没有就
  省略，不报错）——列会话时能直接看到人起的标题。
- GUI 面板队列统计细分：`X 活跃 / Y 完成 / Z 失败 / W 取消`。
- 清理：transport 的 `as never` 强转移除（SDK 1.30 的 `handleRequest` 本就收 Node 原生
  req/res 类型）。
- E2E 扩充：零 token 相新增 `task_list` / `task_cancel`（未知 taskId 以 isError 拒绝的
  接线探针）/ `session_list` 三条腿；agent 相新增"`session_list` 包含刚执行的会话（live
  归并）"；工具清单断言更新到十二个。
- 冒烟测试 81 → 84 项：超时 error 标注 / hook 原因 / 正常任务不受影响；`session_list`
  的 live title 断言并入合并检查。

## 0.7.0

**取消与可观测面**——补上 Roadmap 上最后两个大项：任务可取消、队列/会话可列举。

- **`agent_run` 支持 MCP 级取消**：客户端发 `notifications/cancelled`（MCP 规范的请求取消）→
  SDK abort 信号 → 插件调宿主官方 `agent.cancel({kind:'user'})`（中止当前 turn 并清掉未开工的
  排队输入），随后等 agent 收敛——withLock 的锁持有到收敛为止，取消不会与后续 followup 并发。
  按规范，服务端对已取消请求 SHOULD NOT 回响应；取消本身的结果经 turn/end 事件照常进
  `result.error`（下次续接可见）。宿主缺 `cancel`（旧版本）时退化为不可取消、不报错。
- **新工具 `task_cancel`**：取消排队中的任务（直接出队，不再投递给 agent——`executeTask`
  拿到锁后对已中止信号直接以取消收场）或执行中的任务（同上走官方 cancel）。已结束任务
  原样回报当前状态。
- **新工具 `task_list`**：列出队列任务（taskId/状态/创建时间/cwd/error），可按状态过滤；
  入口顺带做一次 TTL 清理。任务状态新增 `cancelled`（TTL 清理与 GUI 统计同步跟上）。
- **新工具 `session_list`**（只读）：live + 持久化合并（live 优先、快照/裸 header 两种形状
  兼容）、按创建时间倒序，列出 sessionId/createdAt/cwd/agentPreset——挑选要续接/改名/归组
  的会话不再靠猜。
- 冒烟测试 72 → 81 项：`notifications/cancelled` → `agent.cancel({kind:'user'})` 恰一次、
  排队取消直接出队、执行中取消收敛为 `cancelled`、取消结果失败透出（error 含 canceled）、
  `task_list` 状态快照、`session_list` 合并与 limit。

## 0.6.0

**MCP 协议一致性收紧**——对照 MCP 规范逐项审查后的修复与补齐（审查结论：核心生命周期/传输层
经官方 SDK 严格合规，本次补齐剩余的字面偏差）：

- **工具错误结果带 `isError: true`**（规范 SHOULD）：`task_inbox`（队列满）、`task_result`
  （未知 `taskId`、失败任务轮询、失败任务取结果）、`select_model`（覆盖被禁/服务不可用/切换失败）、
  `rename_session`（会话不存在/服务不可用）、`attach_session`（会话不存在/无 cwd/归组失败）
  原先把 `{"error": …}` 当成功结果返回，严格客户端与模型无法识别为失败；现在载荷不变（仍是
  JSON 文本），但整个结果带 `isError` 标记。`agent_run`/`task_result` 投影出的 `error` 非空时
  同样标 `isError`（turn 失败透出对模型可见）。抛错路径（cwd 越界、模型无法解析等）本就经
  SDK 包装为 `isError: true`，不变。
- **Origin 头校验**（规范对本地 HTTP 服务的 MUST）：与 Host 白名单同一份 allowlist——浏览器
  类请求带跨域 `Origin` 或解析失败值（如 `Origin: null`）一律 403；不发 Origin 的非浏览器
  MCP 客户端不受影响。此前只有 Host 校验（等效缓解但非规范字面）。
- **401 带 `WWW-Authenticate: Bearer` 挑战**（RFC 6750 / MCP 授权惯例）。
- **非 `/mcp` 路径的 404 不再挪用 `-32601`**：路径门禁不属于 JSON-RPC 语义，响应体改为普通
  错误对象 `{"error": "Not found: <path>"}`（状态码不变，客户端只看 404）。
- **成功结果省略空 `error`/`taskId` 字段**：`agent_run`（同步，无 taskId）不再返回
  `"error": ""`/`"taskId": ""` 空串噪音。
- **工具元数据**：迁移到 `registerTool`，每个工具带 `title` 与 `annotations`
  （2025-06-18 协议新增字段）——纯查询工具（`echo`/`dsh_list_tools`/`model_list`/`task_result`）
  标 `readOnlyHint: true`，写类工具标 `readOnlyHint: false`，无破坏性的写（改模型/改名/归组）
  加 `destructiveHint: false`。
- **新配置 `sessionTtlMs`**（默认 24 小时，`0` = 永不）：空闲超时的 MCP 传输会话由服务端回收
  （客户端异常退出不发 DELETE，transport/McpServer 此前会无限累积）；客户端对旧会话 id 得到
  404，按规范重新 initialize 即可。GUI 面板同步显示"会话 TTL"。
- **软停止等待 close 完成**：GUI"停止→启动"循环现在可靠（此前 `close()` 未等待，立即重启
  可能撞上未释放的端口）。
- 冒烟测试 57 → 72 项：isError 标记（4 处场景）、成功结果无 isError 且省略空字段、工具带
  `title`+`annotations`、Origin 三态（跨域拒 / `null` 拒 / 同源放行）、401 带
  WWW-Authenticate、404 体、会话 TTL 三连（TTL 内可用 / 超时 404 / 重新 initialize 恢复）。

## 0.5.0

**模型选择面补齐**——原版只能用插件 config 在**部署级**定一个模型，调用方无法按任务/按会话选模型，也看不到有哪些可选。本次把三条路径接上，并保持"零宿主副本"原则：

- 新增 `model_list` 工具：列当前可路由的 provider / 模型 id / 推理档与缺省选择。
  - 优先走官方 `sessionController.modelCatalog()`（与 Web UI 模型选择器同一数据源，含 `default` /
    `routableProviders` / 各 provider 加载失败）；
  - 该服务缺席时（headless 类部署）回退 `llm.listProviders()` + 逐个 `listModels()`，逐 provider
    隔离失败，并如实标注 `source=llm`（回退口径不含推理档元数据）；
  - 投影只保留 `id/name/reasoningEfforts/defaultReasoningEffort`，丢掉 `description` 等长字段省上下文；
  - 同时回报插件自身模型配置与 `allowModelOverride`，调用方一眼看出能不能自己选。
- `agent_run` / `task_inbox` 新增 `provider` / `model` / `reasoningEffort`：**优先级 = 调用参数 >
  插件 config > 宿主默认选择**（`agentDefaultModel`），只给一边时用低优先级来源补另一边，补齐不了
  仍明确报错（`{{model}}` 变量无值的教训保持不变）。`task_inbox` 的覆盖随任务入队保存。
  **推理强度与模型同源**：显式钉住 provider+model 时不继承宿主默认档位——真机实测宿主默认选择里带
  `reasoningEffort: high`，而无条件继承会把"为别的模型选的档位"套到被钉住的模型上（宿主对不支持的
  显式 effort 直接拒绝，不做 clamp），真机验证时发现并改掉了这一版初稿行为。
- 新增 `select_model` 工具：走官方 `sessionController.selectModel` 在**同一会话内**换模型
  （校验 + 写一条持久通知，下一个 step 生效，历史保留）。服务缺席时报明确不可用，并提示改用覆盖参数。
- **常驻会话池改按 `cwd + 模型三元组` 分组**（原来是按 cwd）：同一目录下不同模型各占一个会话，
  "这个会话在用哪个模型"始终可预期；`select_model` 成功后池 key 跟随新模型 re-key，不会误开新会话。
- 结果新增 `model: {provider, model, reasoningEffort?}`（summary/normal/full 三档都有），
  接管 UI 手开会话时读 `agent.options` 如实回报；`task_result` 的 `status` 档仍不带 payload。
- 新配置：`reasoningEffort`（默认推理强度）、`allowModelOverride`（默认 `true`；设 `false` 时部署锁死
  模型，`agent_run`/`task_inbox`/`select_model` 的覆盖与切换被明确拒绝，不带覆盖的调用照常）。
- 冒烟测试 31 → 57 项：官方目录 / 回退目录 / provider 过滤 / 投影不泄漏 description / 按调用覆盖 /
  池按模型分组 / 同模型命中池 / 只给 provider 的补全 / reasoningEffort 透传与"同源不继承" /
  live 会话模型回报 / select_model + re-key / 队列侧覆盖 / 无 sessionController 的降级 /
  `allowModelOverride:false` 门禁。
- E2E 客户端(零 token 相位)扩到 8 项：加 `model_list` 真机目录断言与 `select_model` 接线探针
  （不存在的会话 id，期望宿主拒绝而非"服务不可用"，不改动任何真实会话）。真机结果：9 工具齐、
  `source=sessionController`、7 provider / 21 模型、`select_model` 报 `session not found`。
- 顺带修掉仓库里已有的冒烟断裂：`client/` 那批 GUI 改动引入 `ctx.inject(['webServer'])` 后，
  `smoke.mjs` / `smoke-port.mjs` 的假 ctx 缺 `inject` 桩，`npm run smoke` 在改动前就已失败。
- CI：GitHub Actions——`ci.yml` 在 push main / PR 时跑测试矩阵（ubuntu + windows × node 22/24，
  `npm ci` → `npm test` = 构建 + 全量冒烟）；`publish.yml` 在推 `v*` 标签（或手动 dispatch）时
  构建测试通过后 `npm publish --provenance` 发布 npm，tag 与 `package.json` 版本不一致直接拒绝。

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
