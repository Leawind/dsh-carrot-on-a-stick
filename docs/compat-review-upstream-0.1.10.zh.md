> 本报告写于项目 fork/改名之前，审查对象是上游 `@chushixixin/dsh-harness-mcp-server@0.1.10`（与本仓库初始源码一致，diff 为 0）。
> 对照环境：`@deepseek-ai/dsh@0.1.5-rc.2`。README 中 Roadmap 的每一项都对应本报告的具体条目。
# @chushixixin/dsh-harness-mcp-server 审查报告

- 审查对象：`@chushixixin/dsh-harness-mcp-server@0.1.10`（npm，MIT，作者 chushixixin）
- 对照环境：本机 `@deepseek-ai/dsh@0.1.5-rc.2`（全部子包同版本，cordis 4.0.2）
- 审查方式：源码通读（包内自带 `src/index.ts` 774 行）+ 编译产物比对 + 对当前运行 harness 的 Inspect 服务目录逐项核对

---

## 一、总结论

**代码本身干净、无恶意行为、架构合理；但它是在 DSH 0.1.0-rc.6 时代写的，直接装到 0.1.5-rc.2 上，核心执行链路大概率能跑，但有一个很可能让 agent 变成"无工具裸模型"的隐患（scopeOf 副本不匹配），另有三处已确认的功能降级和一个 Windows 下的白名单失效 bug。** 建议：当架构参考 / 打补丁后使用；或按它的思路用当前版本的动态 Cordis 插件重写一个贴版本的实现。

---

## 二、包的架构（一句话）

在 DSH 进程内部起一个 MCP StreamableHTTP server（默认 `127.0.0.1:8090/mcp`），通过 `ctx.agents / ctx.agentPresets / ctx.tools` 桥接 harness：外部 MCP 客户端（README 场景是 Hermes）调 `agent_run`（同步）或 `task_inbox`/`task_result`（异步队列），插件按 cwd 复用常驻 agent 会话（LRU，默认 8 个），执行完把 `assistant/message`、`tool/call`、`tool/result` 事件折叠成结构化 JSON（changes/verification/leftovers）返回。

## 三、供应链检查 —— 通过

- `lib/index.js`（653 行，实际运行的文件）与 `src/index.ts` 结构一致；全文扫描无 `child_process`、`eval`、外联 URL、telemetry、混淆代码。唯一 `exec(` 命中是正则 `re.exec()`。
- 无 postinstall 脚本；`cordis.yml` patch 只注册插件自身。
- 作者在 npm 与 GitHub 同名仓库公开源码，迭代记录（0.1.0→0.1.10，两天内 11 版）与其 README 的自述吻合。

## 四、兼容性核对（对照当前 0.1.5-rc.2 实测的 Inspect 目录与 .d.ts）

| 包的用法 | 当前版本现状 | 判定 |
|---|---|---|
| `inject: ['tools','llm','agents','agentPresets','workspaceRegistry','sessionPersistence','sessions']` | 7 个服务全部存在 | ✅ |
| `ctx.agents.create/resume/get`（CreateAgentOptions 带 sessionId/meta/agentOptions/setup） | 签名一致；`AgentHandle {agent, dispose()}` 存在 | ✅ |
| `ctx.agentPresets.mount(agentCtx, id)` | `mount(agentCtx, id?)` 存在 | ✅ |
| `agent.followup(UserMessage)` / `agent.whenIdle()` | dsh-agent runtime-types 中仍存在 | ✅ |
| `ctx.sessions.get/list/flush(session)` | 存在，`flush(session): Promise<boolean>` | ✅ |
| `ctx.get('sessionTitle').rename(session, title)` | 存在，签名一致 | ✅ |
| `createUserMessage`（dsh-llm 值导入） | 导出仍在；但包钉的是 `0.0.1-rc.1` 老副本，见第五节风险 2 | ⚠️ |
| `ctx.tools.keys()` 列工具名 | **已不存在**（现在是 register/get/schemas/execute） | ❌ 降级：`harness_list_tools` 永远返回 `[]`（有 guard，不崩） |
| `sessionPersistence.list()` 当 `SessionHeader[]` 用 | **返回类型已改为 `SessionPersistenceSnapshot[]`**（header 在 `.header` 字段） | ❌ 降级：持久化会话的 header 查找失效 → 对非 live 会话 `attach_session` 报 "not found"、"存量捞回" 只剩 live 部分（有 guard，不崩） |
| `workspace.attachSession(sid)` | 当前服务目录中**零命中** | ❌ 降级：会话归组到工作区静默 no-op（纯 UI 功能，不影响执行） |

## 五、两个真正的风险

### 风险 1（高）：scopeOf 模块副本不匹配 → agent 大概率没有工具

- 该包在 setup 里先 `scopeOf(agentCtx)` 检测，**检测不到 scope 就跳过 `agentPresets.mount`**（这是它为 rc.6 的旧 bug 打的补丁）。
- `scopeOf` 的实现用的是**模块私有 Symbol**（`dsh-scope/lib/index.js:100`：`const key = Symbol()`）。
- 包把 `@deepseek-ai/dsh-agent` 钉在 `^0.1.0-rc.6`（semver 上**不含** 0.1.5-rc.2 预发布版），profile 里 pnpm 会装进**老版本副本**；`scopeOf` 又是从**未声明依赖**的 `@deepseek-ai/dsh-scope` 导入（靠 pnpm 提升 hoisting 才能解析到，而且解析到的多半是老副本）。
- 结果：老副本的 `Symbol() ≠` host 副本的 `Symbol()`，`scopeOf(agentCtx)` 恒为 `undefined` → **每次都走"跳过挂载"分支** → `agent_run` 返回的是无 bash/fs/web 工具的裸模型回答，并刷 `agent ctx unscoped (dsh rc.6 bug)` 警告。
- 修复方向（如要继续用这个包）：删掉这个 guard 直接调 `mount`（mount 是 host 服务，自己会校验 scope）；或把 `scopeOf` 的判断改为从 host 侧注入。顺带把 `@deepseek-ai/dsh-scope` 补进 dependencies。

### 风险 2（中）：老副本值导入的形状漂移

`createUserMessage`、`SessionId`、`scopeOf` 都从包自带的老副本导入，喂给 0.1.5-rc.2 的 agent-loop。`SessionId` 是品牌转换（无害）；`createUserMessage` 若消息结构在 rc 期间变过，会产生形状不合的消息。与风险 1 同根：**别让插件带老版 `@deepseek-ai/*` 副本进进程**。

## 六、安全评估

| 项 | 现状 | 评价 |
|---|---|---|
| 默认监听 | `127.0.0.1:8090`，README 明确警告勿暴露 | ✅ 默认稳妥 |
| 鉴权 | **默认无**；可选 `authToken`（Bearer，全请求校验） | ⚠️ 本机任何进程可直接驱动；未校验 Origin/Host 头，存在 DNS rebinding 让恶意网页间接打进来的经典面（MCP 官方都建议校验 Origin）。**启用时务必配 `authToken`** |
| cwd 白名单 `workspaceRoots` | 有，但检查写的是 `workdir.startsWith(r + '/')` | ❌ **Windows bug**：`path.resolve` 在 Windows 产反斜杠路径，`C:\foo\bar` 永远不匹配 `C:\foo/` → 白名单只允许"精确等于根目录"，子目录全被拒（fail-closed，烦人但不危险）。Linux/macOS 正常 |
| 未配白名单时 | 调用方可指定**任意** cwd，agent 可在全盘任意目录干活 | ⚠️ 按"本机受信客户端"设计；对外/多用户场景不可接受 |
| 审批策略交互 | 未知 | ⚠️ spawn 出的会话里工具调用会走 approval 服务；当前部署是 ask 策略——要么 GUI 弹窗、要么无 answerer fail-closed。**首次实测务必用无害任务**，并确认审批弹窗行为 |
| 细节 | Bearer 比较非常数时间；明文 HTTP；`apply` 不 await `listen`（端口被占时插件"成功"但 server 静默不存在） | 均为可接受/可修的小问题 |

## 七、工程质量

- 生命周期：`ctx.effect` 注册清理（关 server、清全部 Map）✅；per-cwd 串行锁防并发 followup ✅；LRU 淘汰 ✅；结果分字段限长保证返回合法 JSON ✅；所有可选依赖都有 `?.` guard，降级不崩 ✅。
- 坏味道：`runtimeConfig` 是模块级全局可变态；`apply` 不等待端口就绪；大量 `as unknown as` 视图类型（为兼容多版本，可理解）。

## 八、建议

1. **想最快用起来**：装它（`dsh plugin --profile web add @chushixixin/dsh-harness-mcp-server` + patch 行），**必须**配 `authToken`；首次用 `agent_run` 跑一个无害任务（如"列出当前目录文件"），看它返回里 `toolCalls` 是否为空、日志是否刷 `unscoped` 警告——若中招，按第五节风险 1 打补丁（删 guard），并修 `workspaceRoots` 的分隔符 bug 后再配白名单。
2. **想要干净的当前版本实现**：把它的架构当蓝本（HTTP MCP + ctx.agents 桥接 + cwd 会话池 + 结构化结果），用本会话的动态 Cordis 插件机制重写——服务全部来自注入的 0.1.5-rc.2 副本，不存在混装问题；MCP 协议部分是纯 JSON-RPC over HTTP，可手写，无需引入 `@modelcontextprotocol/sdk` 依赖。
3. 无论哪条路：MCP server 暴露的是本机执行能力，保持 `127.0.0.1`、配 token、配白名单，三者缺一不可。

---
审查人：DSH 会话代理（glm-5.3-flash）· 依据：包源码 v0.1.10、本机 DSH 0.1.5-rc.2 安装、运行时 Inspect 服务目录
