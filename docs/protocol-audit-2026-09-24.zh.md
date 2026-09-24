# MCP 协议一致性审查报告（2026-09-24）

对 dsh-carrot-on-a-stick 0.5.0 的完整协议审查，以及由此驱动的修复与补齐（全部合并为**待发布批次**，
开发期间版本号保持 0.1.0，发布版本号发布时再定）。
> 下文「修复版本」列中的 0.6.0/0.7.0/…/0.11.9 为**开发内部批次号**，不是独立发布版本。
对照规范：MCP specification 2025-03-26 / 2025-06-18（SDK 1.30.0 另支持 2025-11-25 协商）、
JSON-RPC 2.0（RFC 无版本规范本体）。

## 审查方法

- 逐行核对 `src/index.ts` 的 HTTP 层、会话管理、工具注册与错误路径；
- 核对 `@modelcontextprotocol/sdk` 1.30.0 传输层与协议层的实际行为（协议一致性的大头
  由官方 SDK 内建：生命周期状态机、版本协商、Accept/Content-Type 协商、404/400 语义等）；
- 真实 HTTP 往返验证（冒烟测试即真实 initialize → notifications/initialized → tools/call
  流程，非 mock 传输层）。

## 审查结论

**核心严格合规**（生命周期、JSON-RPC 语义、传输层校验、会话管理、工具定义），存在
两处规范字面偏差与若干可以更严格的细节，全部已在本批次（未发布）修复。

### 合规项（0.5.0 时已满足）

| 项目 | 规范依据 |
|---|---|
| initialize / notifications/initialized 状态机、版本协商 | Lifecycle |
| `Mcp-Session-Id` 随机 UUID、请求回传、DELETE 终止、无效会话 404 | Transports |
| 无会话非 initialize 请求 400、重复 initialize 拒绝、-32700/-32600 标准码 | JSON-RPC 2.0 |
| Accept / Content-Type 协商（406/415） | Transports |
| 自定义错误码 -32001 落在实现保留区间（-32000..-32099） | JSON-RPC 2.0 |
| 工具名 `^[a-zA-Z0-9_-]{1,64}$`、zod 生成的 inputSchema、text content 结果 | Tools |
| 抛错路径经 SDK 包装为 `isError: true` 的 CallToolResult | Tools |
| Bearer 常数时间比较、Host 白名单防 DNS rebinding、仅绑 127.0.0.1 | Security |

### 发现的偏差与修复

| # | 问题 | 严重度 | 修复版本 |
|---|---|---|---|
| 1 | 多个工具把业务错误（未知 taskId、覆盖被禁、服务不可用、cwd 越界、归组失败等）当成功结果返回，未设 `isError: true` | SHOULD 级 | 0.6.0 |
| 2 | 未校验 `Origin` 头（规范对本地 HTTP 服务要求校验以防 DNS rebinding；此前仅 Host 白名单，属等效缓解但非规范字面） | MUST（字面） | 0.6.0 |
| 3 | 401 未带 `WWW-Authenticate: Bearer` 挑战 | 惯例 / MAY | 0.6.0 |
| 4 | 非 `/mcp` 路径的 404 挪用 `-32601`（method not found）语义 | 语义洁癖 | 0.6.0 |
| 5 | 成功结果带 `"error": ""` / `"taskId": ""` 空串噪音 | 载荷卫生 | 0.6.0 |
| 6 | 客户端异常退出不发 DELETE，transport/McpServer 无限累积 | 健壮性 | 0.6.0（`sessionTtlMs`） |
| 7 | 工具无 `title` / `annotations`（2025-06-18 协议新增字段） | 能力缺口 | 0.6.0 |
| 8 | 软停止不等 `server.close()` 完成，停止→启动可能撞未释放端口 | 健壮性 | 0.6.0 |
| 9 | `agent_run` 不可取消、队列不可列举/取消、会话不可发现 | 能力缺口 | 0.7.0（`notifications/cancelled` → 官方 `agent.cancel`；`task_cancel`/`task_list`/`session_list`） |
| 10 | 无服务端自动超时 | 能力缺口 | 0.8.0（`taskTimeoutMs`，hook 原因 cancel） |
| 11 | 队列重启丢失；`running` 状态在锁内等待时即被标记，语义失真 | 能力缺口/语义 | 0.9.0（`queuePersistPath`；`running` 改为真正开始执行才标记） |
| 12 | 长任务无进度反馈；live 会话历史不可读 | 能力缺口 | 0.10.0（`notifications/progress` 心跳；`session_history`） |

### 有意的非合规选择（记录在案）

- **Origin 校验按主机名而非完整 origin 比对**：DNS rebinding 攻击的特征是"陌生主机名解析到
  本机"，主机名白名单是充分缓解；MCP 客户端不是浏览器、通常不发 Origin，强校验完整 origin
  反而破坏兼容。端口不参与比对（同主机不同端口不构成 rebinding）。
- **服务端不校验客户端的 `MCP-Protocol-Version` 回传头**（规范允许 MAY 拒绝）：协商结果由
  SDK 状态机持有，实测各大客户端行为一致，拒绝反而增加误伤面。
- **404/403 的 JSON-RPC 错误体**：HTTP 状态码是客户端判断依据，错误体仅作人读诊断。

## 验证

- 冒烟测试 57 → 126 项（真实 HTTP + 官方 SDK 传输层往返）：生命周期/会话/取消/超时/持久化/
  进度心跳/错误语义/安全门禁（Bearer/Host/Origin/体上限）/并发与锁清理/GUI 控制面路由全覆盖；
- 真机 E2E（`e2e.mjs`）：零 token 相 13 工具接线探针 + agent 相全链路；真机 progress 心跳与
  session_history 轮次读取的探针已就位，待下次真机会话一并验证（本轮未连真实宿主）。

## 已知剩余限制

- 仅持久化的会话无法读取完整历史（宿主未暴露整日志加载 API，`session_history` 只覆盖 live）；
- 持久化为单文件 JSON，适合单机部署，无并发多写者保护；
- `notifications/progress` 在 `_enableJsonResponse` 模式（非 SSE 响应）下不可用——本插件
  默认 SSE 模式，不受影响；
- 协议原生 task augmentation（2025-11-25 草案，SDK 接口标注 experimental）有意缓做：
  自定义 `task_inbox` / `task_result` / `task_cancel` 已覆盖同一工作流，等规范稳定再评估。
