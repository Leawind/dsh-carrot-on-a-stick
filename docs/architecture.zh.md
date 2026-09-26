# 架构说明(模块布局)

> 面向维护者。读完这页,你应该知道"改 X 要动哪个文件"、"为什么这里要这样绕"。
> 配套阅读:README(功能与配置)、[protocol-audit](./protocol-audit-2026-09-24.zh.md)(协议决策台账)、
> [e2e 记录](./e2e-0.1.5-rc.2.zh.md)(真机踩坑)。

## 模块地图

```
src/
├── index.ts      装配层: 插件导出(name/inject/apply)、配置构建、队列持久化接线、
│                 Streamable HTTP 传输层(认证/Host/Origin/体上限/会话路由)、GUI 控制面
├── config.ts     Config 接口(公开 API)+ DEFAULTS + 运行时配置类型
├── types.ts      跨模块纯数据类型(ModelSelection/TaskResult/TaskItem/PooledAgent…)
├── state.ts      进程内可变状态单例(config/会话池/锁/队列/hooks)+ TTL 清扫
├── paths.ts      cwd realpath 规范化、跨平台 isWithin、workspaceRoots 白名单(安全边界)
├── persist.ts    队列持久化静态加密(AES-256-GCM, 纯函数)
├── projection.ts 结果投影(token 预算分级)与会话纪要投影(纯函数)
├── host.ts       零宿主副本桥接: 类型声明合并、本地等价实现、可选服务视图、工作区归组/会话查找
├── engine.ts     执行引擎: 模型选择解析、常驻会话池(LRU)、sessionId 三级接管、
│                 cwd/session 串行锁、取消/进度、executeTask 核心回路
└── tools.ts      17 个 MCP 工具注册(registerTool + title + annotations; model_list/
                  task_list/session_list 带 zod 派生的 outputSchema + structuredContent)
                  与模型目录
```

依赖方向自上而下、无环:

```
index → tools → engine → host → paths → state → config    (主干, 每层只依赖下游)
          │        │                        │
          └──→ projection ──→ types ←───────┘        (engine/tools 也依赖投影与类型)
index → persist                                     (纯函数, 仅装配层使用)
index → onboarding                                  (纯文本, initialize instructions + 帮助文档)
```

实际边(与代码逐一核对): index → {tools,engine,host,paths,state,persist,config,types};
tools → {engine,host,paths,projection,state,types}; engine → {host,paths,projection,state,types};
host → {paths,config}; paths → state; state → {config,types}; projection → types; persist → 无。

纯函数尽量下沉(paths/persist/projection 无状态可独立测试);可变状态集中在 state.ts
一处(ESM live binding 的限制下, 重新赋值只能发生在声明模块, 所以 apply 用
`state.config = …` / `state.hooks.runTaskItem = …` 整体替换, 而不是给导入的绑定赋值)。

## 三条贯穿性设计约束

1. **零宿主副本(host.ts)**:运行时对 `@deepseek-ai/*` 零依赖——类型只在编译期声明合并
   (`import type {}`,构建后擦除),运行时一律经注入的宿主服务(`ctx.agents`/`ctx.tools`/…)访问。
   这是为了避免插件自带的依赖副本与宿主进程内的私有 Symbol 错位(上游 0.1.x `scopeOf` 事故的根因)。
   *推论*:凡"宿主没暴露公开 API 就做不到"的功能(如按 agent 作用域列工具)都是已知限制,
   不要用"顺手加一个 devDependency"来破解。
2. **投影省上下文(projection.ts)**:内部 `TaskResult` 恒为全量(队列与续接不丢信息),
   出口按 `detail` 分级裁剪。新字段想透出给调用方时,先想清楚它进哪一档、占多少预算。
3. **白名单是执行与内容读取的边界(paths.ts)**:`workspaceRoots` 配置后,cwd 参数、sessionId
   三级接管(engine.getAgent)、session_list/session_history 都按它裁剪;元数据操作
   (select_model/rename_session/attach_session)不裁。改会话相关代码时,新路径必须过
   `sessionCwdRefusal`。

## 关键流程速查

- **同步任务**:`agent_run`(tools)→ `executeTask`(engine)→ `canonicalizeAllowedCwd` →
  cwd/session 锁 → `getAgent`(池/live/resume 三级)→ `followup` → 事件解析 → `TaskResult` →
  `renderResult` 投影。
- **异步任务**:`task_inbox`(提交时校验容量与 cwd)→ `state.hooks.runTaskItem`(index 接线)→
  同上 → `task_result` 按 detail 取回;`task_cancel` 经 AbortController 合流到官方 `agent.cancel`。
- **持久化**:队列每次变化 → `persistQueue`(index,**快照取自调用瞬间**——不可改回"写盘执行时
  再取",否则落盘链积压时,卸载清空队列后的迟到写入会把空队列覆盖进文件、重启静默丢整个队列,
  这是冒烟压测抓到过的真实竞态)→ 原子写(tmp+rename,persist.ts 加密可选);apply 时恢复,
  `running` 如实标记 interrupted。
- **传输**:所有 MCP 流量走 `/mcp`(index):Bearer → Host 白名单 → Origin 校验 → 体上限 →
  按 `Mcp-Session-Id` 路由到 SDK transport;空闲会话由 TTL sweeper 回收。
- **热重载**:每次 apply 重建 `state.config` 并重绑 hooks;卸载经 `ctx.effect` 清空
  池/队列/transport。**不要**在模块顶层持有需要跨 apply 的状态。

## 测试布局

- `smoke.ts`:190 项行为断言,按 Phase 组织(协议/安全/白名单/持久化/取消/进度/并发/LRU/GUI/
  agent 认知面/纯函数边界)。
  假宿主(桩 Cordis 服务 + 桩 agent + 可观测记录数组)与真 HTTP 的 RPC 小工具在 `smoke-harness.ts`
  ——Phase 只写行为断言;时序敏感断言一律走 `waitFor`/轮询,不做一次性请求。
- 测试是普通 TypeScript,`node smoke.ts` 直跑(Node 原生 type stripping,开发机需 Node ≥ 23.6;
  发布产物 lib/ 仍支持 Node ≥ 18);`npm run typecheck` 对测试文件做类型检查(不产出,
  tsconfig.test.json,假宿主边界允许 any)。
- `npm test` = 先 build 再跑(smoke + 端口冲突专项 `smoke-port.ts`)
  ——**测试永远验证当前源码,不是 lib/ 里的旧产物**。
- `e2e.ts`:真机 E2E(需 dsh 宿主与凭证),零 token 探针 + 一次真实 agent_run。

改代码的验收线:`npm run build && npm test` 全绿(或直接 `npm test`,它自身先构建);
行为变化必须同步 smoke 断言、README(中英)与 CHANGELOG 批次。
