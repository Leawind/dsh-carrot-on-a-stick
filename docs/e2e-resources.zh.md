# E2E 验证记录：MCP resources 面全面利用（2026-09-30）

> 批次 25（资源面数据化 + 订阅推送 + completion/annotations + resourceFirst）的真机验证。
> 零 token 相 **20/20 全绿**；agent 相走**完整资源路径**（`task_inbox` → 订阅 → 推送 → 读资源）
> **E2E PASS**（真实 turn 32.8s 收敛）。

## 环境

- 宿主：`@deepseek-ai/dsh@0.2.0-rc.2`（临时前缀安装，非全局）
- **隔离 home**：`DSH_HOME` 指向临时目录，复制入 `.credentials.yaml` / `settings.yaml`（自
  `settings.yaml.imported`）/ `llm-deepseek` / `.agent-presets`；不触碰常驻实例的 `~/.dsh`
- 测试实例：`--profile carrot-e2e --from-default-profile web`，插件 tarball 经 `pnpm remove` +
  `pnpm add -w` 强制重装（同版本号 tarball 更新后 pnpm 会跳过——本轮踩到，先 remove 再 add），
  `--patch e2e-patch.yml` 把 MCP 端口让到 8091（避开常驻实例的 8090）
- 客户端：`e2e.ts`（零 token 相 + agent 相都真开了 GET SSE 流收服务端推送）

## 结果

### 零 token 相：20/20 全绿

initialize（instructions + **`capabilities.resources.{listChanged, subscribe:true}` 宣告**）/
tools/list 十七工具齐 / dsh_get_started(errors 节) / echo / **resources/list 静态资源全集（24 个）** /
**resources/templates/list 模板全集（9 个，含 history·events 游标变体）** / dsh://status/stats /
**dsh://presets（真机 4 个 preset：standard/ptc/minimal/cordis）** / dsh://agents / dsh://sessions /
未知资源 -32602 / **订阅不可读目标 -32602（带 TTL/订阅指路）** / dsh_list_tools / select_model 接线 /
task_list / task_cancel 拒绝 / session_list / session_history 拒绝——全部通过。

### agent 相（资源路径）：E2E PASS

真实任务（列目录 + 总结，Temp 工作目录）经**资源面一枪过**：

| 检查 | 结果 |
|---|---|
| `task_inbox` 返回 taskId + 资源引用（HATEOAS） | ✅ `resource=dsh://queue/<taskId>` |
| `resources/subscribe` 受理 | ✅ |
| 状态迁移推送（免轮询） | ✅ **首次 0.2s**（running） |
| 终态推送 + 资源内容收敛 | ✅ **32.8s status=done** |
| 任务资源读取：full 投影结果 | ✅ `result.detail=full` |
| sessionId 回填 + 会话元数据资源 `historyReadable` | ✅ |
| preset 挂载（任务资源里的 toolCalls） | ✅ `calls=pwsh,pwsh` |
| summary 合同（changes/verification） | ✅ |
| 纪要资源读到真实轮次 | ✅ `turns=8`（user/tool_call/tool_result/assistant/turn_end） |
| `list_changed` 广播到达 | ✅ |

## 资源语义要点（本轮实证）

1. **`updated` 是"重读"信号，不是终态信号**：任务的每次状态迁移（queued→running→认领会话→终态）
   都各推一次 `notifications/resources/updated`。客户端模式 = 收到推送 → 重读资源 → 非终态继续等；
   终态以资源内容为准（首轮 e2e 探针把首次 running 推送当完成，已修正并写进任务资源描述）。
2. **快任务的订阅竞态**：任务可能在订阅落地前已完成——此时没有推送，直接读取即得终态（这也写进了
   资源描述）。确定性验证订阅链路要么"先订阅后触发"（agent_run 前先订 history），要么用慢任务。
3. **GET SSE 流是推送的唯一通道**：不打开 StreamableHTTP 的 GET 流就收不到任何推送（读取永远可用）；
   `list_changed` 因 ~100ms 合并窗口反而比即时 `updated` 更容易在竞态窗口后到达。
4. **subscription 按连接隔离**：每连接一个 McpServer 实例，`resources/subscribe` 的登记挂在连接自己的
   实例上；`dsh_status` 的 `stats.subscriptions` 可观测（连接数/订阅总数）。

## 附注

- 隔离 home 的会话/队列数据全部在临时目录，验证完即删（含 `.credentials.yaml` 副本）；常驻实例数据未触碰。
- `history/{before}` 与 `events/{after}` 游标、`dsh://workspaces/{id}`、`dsh://models/{provider}`、
  `dsh://guide/{section}` 已在 smoke 230 项里覆盖（假宿主桩），真机零 token 相覆盖其存在性与
  `dsh://sessions/{id}` 元数据路径。
- 真机 `completion/complete` 在 E2E_MODEL_LIST=0 时跳过（避免冷启动拉模型目录）；smoke 全量覆盖。
