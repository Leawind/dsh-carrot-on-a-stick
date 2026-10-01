// Dev-only smoke test (not shipped): drives apply() with a minimal fake ctx and verifies
// the current feature set against the real MCP protocol round-trips:
//   1. 任意会话续接: live 接管 / 持久化 resume / 明确报错(三级)
//   2. realpath 规范化: create 的 meta.cwd 为 realpath 值; 目录不存在时回退 resolve 不阻断
//   3. attach_session 工具 + 启动存量捞回(workspaceRegistry/sessions/sessionPersistence 三服务路径,
//      持久化侧兼容 0.1.5+ 快照(.header) 与旧版裸 header 两种形状)
//   4. dsh_list_tools 走 ctx.tools.schemas()(0.1.5+), 不再依赖已移除的 keys()
//   5. preset mount 无 scope 预检, 直接调用(混装副本不再导致静默跳过)
//   6. 事件读取走公开 API snapshotEvents()(私有 log 字段仅作旧宿主回退)
//   7. 安全: Bearer 认证 401 / Host 白名单 403(防 DNS rebinding) / workspaceRoots 跨平台子目录匹配
//   8. 模型选择: model_list(sessionController 官方目录 / llm 回退 / provider 过滤 / 投影省上下文)、
//      agent_run+task_inbox 的 provider/model/reasoningEffort 覆盖、池按 cwd+模型分组、
//      select_model 走官方 selectModel 并 re-key、allowModelOverride:false 门禁
//   9. 协议严格性: 工具错误结果带 isError(MCP 规范 SHOULD)、成功结果省略空 error/taskId、
//      工具带 title+annotations(2025-06-18 字段)、401 带 WWW-Authenticate、
//      Origin 白名单(跨域/null 拒, 同源放行)、404 体不再挪用 -32601、会话空闲 TTL GC
//  10. 取消与可观测: agent_run 经 notifications/cancelled 取消(官方 agent.cancel)、
//      task_cancel 排队即终态/执行中 cancelling→收敛后 cancelled、task_list 队列观测、
//      session_list/session_history 查询面
//  11. LRU 淘汰跳过活跃会话、并发压力、GUI 控制面路由(status/stop/start 同源门禁)
//  12. workspaceRoots 覆盖会话面: sessionId 三级接管越界拒绝(池/live/resume)、
//      session_list 只列白名单内(total=过滤后计数, cwd 参数越界拒绝)、session_history 越界不可读、
//      agent_steer 越界不可转向、resources 面同边界、元数据操作仍可达、未配白名单时零行为变化
//  13. 队列持久化加密(queuePersistKey): 密文落盘(非明文)/同 key 重启可恢复/错 key 损坏容忍/legacy 明文迁移
//  14. agent_steer 实时干预: 运行中转向(step 边界)/空闲拒绝/inject 挂起/持久化-only 报错/
//      sessionId/taskId 二选一/执行中任务按 taskId 转向/排队中拒绝
//  15. per-call preset: 新建会话挂载指定 preset/池按 preset 分组/未知 preset 报错/接管忽略 preset/
//      resume 恢复会话原 preset(非部署默认)/allowPresetOverride 门禁/task_inbox 的 preset
//  16. MCP resources 面: resources/list + resources/read(status/queue/sessions/history 模板/guide)
//  17. agent 认知面: dsh_get_started 的 section 参数(只取一节) + dsh://guide 资源 + initialize instructions
//  18. 执行桥接语义: 统一 cwd 锁(按目录/按会话入口同锁串行)+接管显式 cwd 一致性校验、
//      队列 turn 失败任务终态标 error(状态轮询可见)、task_inbox 幂等键去重(含并发同键:
//      查重+入队同步临界区, followup 计数为证)、初始化窗口取消(create 闸门复现 getAgent
//      窗口: 投递前复查, 零 followup)、取消窗口期 cancelRequested 在工具面可见、
//      取消监听生命周期(getEventListeners: 执行中恰 1 个/getAgent 抛错后不残留)
// 假宿主桩(桩服务/桩 agent/可观测记录)与 RPC 小工具在 ./smoke-harness.ts; 本文件只保留各 Phase 的行为断言。
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { getEventListeners } from 'node:events'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { apply } from '../lib/index.js'
import { basicStatusSnapshot } from '../lib/tools.js'
import { isWithin } from '../lib/paths.js'
import { parseSummary } from '../lib/projection.js'
import { state as pluginState } from '../lib/state.js'
import {
  attachedIds,
  BASE,
  checks,
  created,
  disposed,
  disposers,
  fakeLlm,
  fakeSessionController,
  fakeSessionTitle,
  flushed,
  followups,
  FAKE_CWD,
  innerOf,
  makeCtx,
  mounted,
  openSse,
  parsePayload,
  PORT,
  rawRequest,
  resumed,
  rpc,
  selectModelCalls,
  slowAgents,
  slowLiveAgent,
  steered,
  injected,
  waitFor,
} from './smoke-harness.ts'

const ctx = makeCtx({ sessionController: fakeSessionController, llm: fakeLlm, sessionTitle: fakeSessionTitle })

try {
  // ── Phase B(主流程): 无认证、无白名单, 端口 8099; 存量捞回显式开启 ──
  await apply(ctx, { port: PORT, host: '127.0.0.1', reattachOrphans: true, progressIntervalMs: 300 })
  await new Promise((r) => setTimeout(r, 400))

  const init = await rpc(undefined, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } },
  })
  checks['initialize 拿到 sessionId'] = Boolean(init.sid)
  // server instructions: agent 在 initialize 时就能拿到整体工作流引导(含 dsh_get_started 指路)
  const initResult = init.status === 200 ? parsePayload(init.text).result : undefined
  checks['initialize 携带 instructions(含 dsh_get_started 指路)'] = typeof initResult?.instructions === 'string'
    && initResult.instructions.includes('dsh_get_started')
  await rpc(init.sid, { jsonrpc: '2.0', method: 'notifications/initialized' })

  const echo = await rpc(init.sid, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'ping-8099' } } })
  checks['echo 通'] = echo.status === 200 && echo.text.includes('ping-8099')

  const toolsList = await rpc(init.sid, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
  const toolsArr: any[] = parsePayload(toolsList.text).result?.tools ?? []
  const toolNames = toolsArr.map((t) => t.name)
  checks['tools/list: 精确 17 个工具(无多余注册)'] = toolNames.length === 17
  // 结构化输出面: list 类工具带 outputSchema(tools/list 下发), 强类型客户端免二次解析
  checks['tools/list: model_list/task_list/session_list 带 outputSchema'] = ['model_list', 'task_list', 'session_list']
    .every((n) => { const s = toolsArr.find((t) => t.name === n)?.outputSchema; return Boolean(s && typeof s === 'object' && Object.keys(s).length > 0) })

  // 协议版本协商: 旧版(2025-03-26 主流程已验) + 新版(2025-06-18 / 2025-11-25)均可接入
  for (const [pv, pid] of [['2025-06-18', 93], ['2025-11-25', 94]]) {
    const r = await rpc(undefined, { jsonrpc: '2.0', id: pid, method: 'initialize', params: { protocolVersion: pv, capabilities: {}, clientInfo: { name: 'smoke-pv', version: '1.0' } } })
    const negotiated = r.status === 200 ? parsePayload(r.text).result?.protocolVersion : undefined
    checks[`协议版本协商 ${pv}`] = negotiated === pv
    await rpc(r.sid, { jsonrpc: '2.0', method: 'notifications/initialized' })
  }
  checks['attach_session 在工具清单里'] = toolNames.includes('attach_session')
  checks['model_list / select_model 在工具清单里'] = toolNames.includes('model_list') && toolNames.includes('select_model')
  const echoTool = parsePayload(toolsList.text).result?.tools?.find((t) => t.name === 'echo')
  checks['工具带 title + annotations(2025-06-18 协议字段)'] = echoTool?.title === 'Echo' && echoTool?.annotations?.readOnlyHint === true

  // ── dsh_list_tools 走 schemas() ──
  const listTools = await rpc(init.sid, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dsh_list_tools', arguments: {} } })
  const listToolsInner = listTools.status === 200 ? innerOf(listTools) : { error: 'bad' }
  checks['dsh_list_tools 经 schemas() 返回 name+description(带盲区自述)'] = listToolsInner?.source === 'global-registry'
    && typeof listToolsInner.note === 'string' && listToolsInner.note.includes('toolCalls')
    && Array.isArray(listToolsInner.tools)
    && listToolsInner.tools.some((t) => t.name === 'bash' && t.description === 'run a shell command')

  // ── attach_session 工具(正面归组 / 幂等 / 持久化快照 / 旧版裸 header / 未知 四态) ──
  const attachErr = await rpc(init.sid, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-err' } } })
  checks['attach_session live 会话(sess-err 正面归组)'] = attachErr.status === 200 && innerOf(attachErr).attached === true

  const attachMissing = await rpc(init.sid, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-nope' } } })
  checks['attach_session 未知会话报错'] = attachMissing.status === 200 && typeof innerOf(attachMissing).error === 'string'

  // 存量捞回在启动时已把 sess-persisted / sess-legacy / sess-live 挂到工作区, 重复挂应幂等返回
  const attachPersisted = await rpc(init.sid, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-persisted' } } })
  checks['attach_session 持久化会话(.header 快照)'] = attachPersisted.status === 200 && innerOf(attachPersisted).attached === false
    && String(innerOf(attachPersisted).note ?? '').includes('already attached')

  const attachLegacy = await rpc(init.sid, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-legacy' } } })
  checks['attach_session 旧版裸 header 形状'] = attachLegacy.status === 200 && innerOf(attachLegacy).attached === false
    && String(innerOf(attachLegacy).note ?? '').includes('already attached')

  // ── 任意会话续接三级 ──
  const runLive = await rpc(init.sid, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-live' } } })
  const runLiveInner = runLive.status === 200 ? innerOf(runLive) : { error: 'bad' }
  checks['agent_run 接管 live 会话(不 resume 不 dispose)'] = runLiveInner.sessionId === 'sess-live' && resumed.length === 0 && disposed.length === 0
  // 默认 summary 投影: 不泄漏 toolCalls/toolResults 原文, 只给尾部文本 + 工具名
  checks['默认 summary 形状(省上下文)'] = runLiveInner.toolCalls === undefined && runLiveInner.toolResults === undefined
    && Array.isArray(runLiveInner.toolCallNames) && runLiveInner.toolCallNames[0] === 'bash'
    && typeof runLiveInner.assistantTail === 'string' && runLiveInner.assistantTail.includes('c1')
  // 结果观测增强: 墙钟时长恒有; token 用量机会式聚合(fake assistant/message 带 TokenUsage)
  checks['结果带 durationMs 与聚合 usage'] = typeof runLiveInner.durationMs === 'number' && runLiveInner.durationMs >= 0
    && runLiveInner.usage?.inputTokens === 120 && runLiveInner.usage?.outputTokens === 45 && runLiveInner.usage?.totalTokens === 165
    && runLiveInner.detail === 'summary'
  // 成功结果: 不带 isError, 空 error/taskId 字段直接省略
  checks['成功结果不带 isError'] = parsePayload(runLive.text).result?.isError === undefined
  checks['成功结果省略空 error/taskId 字段'] = runLiveInner.error === undefined && runLiveInner.taskId === undefined

  const runPersisted = await rpc(init.sid, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-persisted', detail: 'full' } } })
  const runPersistedInner = runPersisted.status === 200 ? innerOf(runPersisted) : { error: 'bad' }
  checks['agent_run 持久化会话 resume + flush + dispose'] = runPersistedInner.sessionId === 'sess-persisted'
    && resumed.some((r) => r.id === 'sess-persisted') && flushed.includes('sess-persisted') && disposed.includes('sess-persisted')
  checks['resume 也带完整模型选择(agentDefaultModel 补全)'] = resumed.find((r) => r.id === 'sess-persisted')?.agentOptions?.provider === 'p1'
    && resumed.find((r) => r.id === 'sess-persisted')?.agentOptions?.model === 'm1'
  // resume 恢复会话原 preset(header.agentPreset = reviewer), 而不是把部署默认(standard)盖上去
  checks['resume 恢复会话原 preset(非部署默认)'] = runPersistedInner.preset === 'reviewer' && mounted.includes('reviewer')
  // full 档保留原文(排查用)
  checks['detail=full 保留 toolCalls 原文'] = Array.isArray(runPersistedInner.toolCalls) && runPersistedInner.toolCalls[0]?.name === 'bash'

  const runUnknown = await rpc(init.sid, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-unknown' } } })
  checks['agent_run 未知会话明确报错'] = runUnknown.status === 200 && String(innerOf(runUnknown).error ?? '').includes('session not found for resume')

  // 接管一致性: 显式 cwd 与会话实际目录不一致 → 拒(防"以为在 A 树、实际在 B 树执行"; 缺省 cwd 则沿用会话目录)
  const mismatchDir = resolve(FAKE_CWD, 'nonexistent-mismatch')
  const runMismatch = await rpc(init.sid, { jsonrpc: '2.0', id: 148, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'x', cwd: mismatchDir, sessionId: 'sess-live' } } })
  checks['agent_run 接管: 显式 cwd 与会话目录不一致被拒'] = String(innerOf(runMismatch).error ?? '').includes('lives in')
    && String(innerOf(runMismatch).error ?? '').includes('sess-live')

  // 失败透出: turn/end error 进 result.error(E2E 发现的静默空结果缺陷), 且整个结果带 isError 标记
  const runErr = await rpc(init.sid, { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'boom', sessionId: 'sess-err' } } })
  const runErrInner = runErr.status === 200 ? innerOf(runErr) : { error: 'bad' }
  checks['agent_run 失败透出(turn/end error)'] = String(runErrInner.error ?? '').includes('AUTH') && String(runErrInner.error ?? '').includes('invalid api key')
  checks['agent_run 失败结果带 isError 标记'] = parsePayload(runErr.text).result?.isError === true

  // ── 异步队列: status 轮询不注入 payload, 完成后默认 summary ──
  const inbox = await rpc(init.sid, { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'queued job' } } })
  const inboxInner = inbox.status === 200 ? innerOf(inbox) : { error: 'bad' }
  const queuedId = inboxInner.taskId
  checks['task_inbox 返回 taskId'] = typeof queuedId === 'string' && queuedId.length > 0
  let stPollInner: any = {}
  for (let i = 0; i < 50 && stPollInner.status !== 'done'; i++) {
    const stPoll = await rpc(init.sid, { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: queuedId, detail: 'status' } } })
    stPollInner = stPoll.status === 200 ? innerOf(stPoll) : { error: 'bad' }
    if (stPollInner.status !== 'done') await new Promise((r) => setTimeout(r, 100))
  }
  checks['task_result status 轮询: 不注入结果 payload'] = stPollInner.status === 'done' && stPollInner.changes === undefined && stPollInner.toolCallNames === undefined && stPollInner.assistantTail === undefined
  const smFetch = await rpc(init.sid, { jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: queuedId } } })
  const smFetchInner = smFetch.status === 200 ? innerOf(smFetch) : { error: 'bad' }
  checks['task_result 默认 summary 投影'] = smFetchInner.changes === 'c1' && smFetchInner.toolCallNames?.[0] === 'bash' && smFetchInner.toolResults === undefined

  // 未知 taskId: 错误结果带 isError 标记(MCP 规范: 工具执行错误在 result 里表达, 不走协议级错误)
  const missingTask = await rpc(init.sid, { jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: 'nope' } } })
  checks['错误结果带 isError 标记(task_result 未知 taskId)'] = parsePayload(missingTask.text).result?.isError === true

  // 队列失败透出: turn 失败(result.error)的任务终态标 error(而非 done)——只轮询 status 的调用方也看得到失败
  // (error 态的状态轮询走 isError, innerOf 返回原始 JSON 文本, 断言按文本匹配)
  const inboxErr = await rpc(init.sid, { jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'boom queued', sessionId: 'sess-err' } } })
  const inboxErrId = innerOf(inboxErr).taskId
  let inboxErrStatus: any = {}
  for (let i = 0; i < 50 && !String(inboxErrStatus.error ?? '').includes('"status":"error"'); i++) {
    const er = await rpc(init.sid, { jsonrpc: '2.0', id: 190 + i, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: inboxErrId, detail: 'status' } } })
    inboxErrStatus = er.status === 200 ? innerOf(er) : {}
    if (!String(inboxErrStatus.error ?? '').includes('"status":"error"')) await new Promise((r) => setTimeout(r, 100))
  }
  checks['队列失败透出: turn 失败的任务终态标 error(状态轮询可见)'] = String(inboxErrStatus.error ?? '').includes('"status":"error"')
    && String(inboxErrStatus.error ?? '').includes('AUTH')

  // 幂等键: 相同 idempotencyKey 的重复提交返回原任务(响应丢失重试不重复执行)
  // 探针用独立 cwd(独占池 key), "只新建一个会话"才能作为"只执行一次"的确定性证据
  const dedupeCwd = resolve(FAKE_CWD, 'nonexistent-dedupe')
  const createdBeforeDedupe = created.length
  const dedupeA = innerOf(await rpc(init.sid, { jsonrpc: '2.0', id: 195, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'dedupe probe', cwd: dedupeCwd, idempotencyKey: 'smoke-dedupe-1' } } }))
  const dedupeB = innerOf(await rpc(init.sid, { jsonrpc: '2.0', id: 196, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'dedupe probe retry', cwd: dedupeCwd, idempotencyKey: 'smoke-dedupe-1' } } }))
  checks['task_inbox 幂等键: 重复提交返回原任务'] = dedupeB.taskId === dedupeA.taskId && dedupeB.deduplicated === true
  let dedupeDone: any = {}
  for (let i = 0; i < 50 && dedupeDone.status !== 'done'; i++) {
    const dd = await rpc(init.sid, { jsonrpc: '2.0', id: 1970 + i, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: dedupeA.taskId, detail: 'status' } } })
    dedupeDone = dd.status === 200 ? innerOf(dd) : {}
    if (dedupeDone.status !== 'done') await new Promise((r) => setTimeout(r, 100))
  }
  const dedupeC = innerOf(await rpc(init.sid, { jsonrpc: '2.0', id: 198, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'dedupe probe after done', cwd: dedupeCwd, idempotencyKey: 'smoke-dedupe-1' } } }))
  checks['task_inbox 幂等键: 终态任务同样去重并回报状态'] = dedupeC.taskId === dedupeA.taskId && dedupeC.status === 'done' && dedupeC.deduplicated === true
  // 三次提交只执行一次: 仅 dedupeA 新建过一个会话
  checks['task_inbox 幂等键: 重复提交不重复执行(仅一个新会话)'] = created.length === createdBeforeDedupe + 1
  // 并发同键提交: 查重+容量+入队必须是同步临界区——两个请求同时到达也只入队一个。
  // 执行次数以 followup 计数为证(不只看新建会话数)
  const concCwd = resolve(FAKE_CWD, 'nonexistent-conc-dedupe')
  const [conc1, conc2] = await Promise.all([
    rpc(init.sid, { jsonrpc: '2.0', id: 250, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'conc A', cwd: concCwd, idempotencyKey: 'smoke-dedupe-conc' } } }),
    rpc(init.sid, { jsonrpc: '2.0', id: 251, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'conc B', cwd: concCwd, idempotencyKey: 'smoke-dedupe-conc' } } }),
  ])
  const ci1 = innerOf(conc1)
  const ci2 = innerOf(conc2)
  checks['task_inbox 幂等键: 并发同键提交只产生一个任务'] = ci1.taskId === ci2.taskId
    && (ci1.deduplicated === true || ci2.deduplicated === true)
  let concDone: any = {}
  for (let i = 0; i < 50 && concDone.status !== 'done'; i++) {
    const cr = await rpc(init.sid, { jsonrpc: '2.0', id: 2520 + i, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: ci1.taskId, detail: 'status' } } })
    concDone = cr.status === 200 ? innerOf(cr) : {}
    if (concDone.status !== 'done') await new Promise((r) => setTimeout(r, 100))
  }
  // 只入队一个 → 只建一个会话、只执行一次(followup 计数为证; 在执行收敛后断言消除入队/建会话的时序差)
  const concSessions = created.filter((c) => c.cwd === concCwd)
  checks['task_inbox 幂等键: 并发同键只执行一次(单会话, followup 恰 1 次)'] = concDone.status === 'done'
    && concSessions.length === 1
    && followups.filter((f) => f.id === concSessions[0]?.id).length === 1

  // 事件读取走 snapshotEvents + 结构化解析
  checks['结构化解析(toolCalls/changes/verification)'] = runPersistedInner.toolCalls?.length === 1
    && runPersistedInner.toolCalls[0].name === 'bash'
    && runPersistedInner.changes === 'c1' && runPersistedInner.verification === 'v1' && runPersistedInner.leftovers === 'l1'

  // detail=normal: 截断的 toolCalls, 不注入 toolResults/assistantText 原文
  const runNormal = await rpc(init.sid, { jsonrpc: '2.0', id: 78, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-persisted', detail: 'normal' } } })
  const runNormalInner = runNormal.status === 200 ? innerOf(runNormal) : {}
  checks['detail=normal: 截断 toolCalls/toolResults 不注入原文'] = runNormalInner.detail === 'normal'
    && Array.isArray(runNormalInner.toolCalls) && runNormalInner.toolCalls[0]?.name === 'bash'
    && Array.isArray(runNormalInner.toolResults) && runNormalInner.assistantText === undefined

  // ── realpath 规范化 ──
  const runNew = await rpc(init.sid, { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: FAKE_CWD } } })
  const runNewInner = runNew.status === 200 ? innerOf(runNew) : { error: 'bad' }
  checks['agent_run 池新建: meta.cwd 为 realpath 值'] = Boolean(created[0]) && created[0].cwd === FAKE_CWD && runNewInner.sessionId === created[0].id
  checks['池新建带完整模型选择(agentDefaultModel 补全, {{model}} 变量来源)'] = created[0]?.agentOptions?.provider === 'p1' && created[0]?.agentOptions?.model === 'm1'

  const missingDir = resolve(FAKE_CWD, 'nonexistent-xyz')
  const runMissingCwd = await rpc(init.sid, { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: missingDir } } })
  const runMissingInner = runMissingCwd.status === 200 ? innerOf(runMissingCwd) : { error: 'bad' }
  checks['目录不存在: realpath 回退 resolve 且不阻断'] = Boolean(runMissingInner.sessionId)
    && created.some((c) => c.cwd === missingDir)

  // title 命名: 新建池会话时传 title → 走 sessionTitle 服务 rename(此前零覆盖)
  const titledCwd = resolve(FAKE_CWD, 'nonexistent-titled')
  const runTitled = await rpc(init.sid, { jsonrpc: '2.0', id: 395, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: titledCwd, title: 'smoke-titled' } } })
  const titledId = innerOf(runTitled).sessionId
  checks['agent_run title: 新会话经 sessionTitle.rename 命名'] = Boolean(titledId)
    && fakeSessionTitle.renamed.some((r) => r.id === titledId && r.title === 'smoke-titled')

  // ── preset mount: 无 scope 守卫, 直接调用 ──
  // created[0](池新建)与 created[1](missing)各 create 一次, sess-persisted resume 一次 → mount ≥ 3
  checks['preset mount 直接调用(无 scope 预检)'] = mounted.length >= 3

  // ── 启动存量捞回(sessions.list + sessionPersistence.list 两源, 含快照与裸 header) ──
  // reattach 是 fire-and-forget 异步: 断言统一轮询等花名册收齐, 不用固定 sleep
  await waitFor(() => attachedIds.includes('sess-live2')
    && attachedIds.includes('sess-persisted')
    && attachedIds.includes('sess-legacy'), 15000)
  checks['存量捞回: live 列表会话补挂'] = attachedIds.includes('sess-live2')
  checks['存量捞回: 持久化会话补挂(快照形状)'] = attachedIds.includes('sess-persisted')
  checks['存量捞回: 持久化会话补挂(裸 header 形状)'] = attachedIds.includes('sess-legacy')

  // ── 模型选择: model_list / 按调用覆盖 / select_model / 坏输入 ──
  const modelList = await rpc(init.sid, { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'model_list', arguments: {} } })
  const ml = modelList.status === 200 ? innerOf(modelList) : { error: 'bad' }
  checks['model_list 走 sessionController 官方目录'] = ml.source === 'sessionController'
    && ml.default?.provider === 'p1' && ml.default?.model === 'm1'
    && Array.isArray(ml.routableProviders) && ml.routableProviders.length === 2
  checks['model_list 保留推理档、丢掉 description(省上下文)'] = JSON.stringify(ml).includes('reasoningEfforts')
    && JSON.stringify(ml).includes('defaultReasoningEffort')
    && !JSON.stringify(ml).includes('LONG-DESCRIPTION-MUST-NOT-LEAK')
  checks['model_list 带 provider 失败信息与插件模型配置'] = ml.failures?.[0]?.id === 'p3'
    && ml.config?.allowModelOverride === true && ml.config?.provider === null

  const modelListP2 = await rpc(init.sid, { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'model_list', arguments: { provider: 'p2' } } })
  const mlP2 = modelListP2.status === 200 ? innerOf(modelListP2) : { error: 'bad' }
  checks['model_list provider 过滤'] = mlP2.providers?.length === 1 && mlP2.providers[0].id === 'p2'
    && mlP2.routableProviders.length === 1

  // 按调用覆盖模型: create 收到覆盖值, 且与默认模型的会话分开(池按 cwd+模型分组)
  const runOverride = await rpc(init.sid, { jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: FAKE_CWD, provider: 'p2', model: 'm9' } } })
  const runOverrideInner = runOverride.status === 200 ? innerOf(runOverride) : { error: 'bad' }
  const createdOverride = created.find((c) => c.agentOptions?.provider === 'p2')
  checks['agent_run 按调用覆盖模型(create 用覆盖值)'] = Boolean(createdOverride)
    && createdOverride.agentOptions.model === 'm9' && createdOverride.agentOptions.reasoningEffort === undefined
  checks['显式钉住模型时不继承宿主默认推理档(与模型同源)'] = createdOverride?.agentOptions?.reasoningEffort === undefined
    && created.find((c) => c.agentOptions?.provider === 'p1' && c.agentOptions?.model === 'm1')?.agentOptions?.reasoningEffort === 'host-effort'
  checks['结果自报本次用的模型'] = runOverrideInner.model?.provider === 'p2' && runOverrideInner.model?.model === 'm9'
  checks['不同模型各自一个常驻会话(池按模型分组)'] = Boolean(runOverrideInner.sessionId) && runOverrideInner.sessionId !== created[0]?.id

  const createdBefore = created.length
  const runOverrideAgain = await rpc(init.sid, { jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: FAKE_CWD, provider: 'p2', model: 'm9' } } })
  checks['同模型再调用命中池(不新建会话)'] = created.length === createdBefore
    && innerOf(runOverrideAgain).sessionId === runOverrideInner.sessionId

  // 只给 provider: 用宿主默认选择补 model(与 0.3.1 的补全语义一致)
  const partialCwd = resolve(FAKE_CWD, 'nonexistent-partial-model')
  await rpc(init.sid, { jsonrpc: '2.0', id: 34, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: partialCwd, provider: 'p3' } } })
  checks['只给 provider 时用宿主默认补 model'] = created.find((c) => c.agentOptions?.provider === 'p3')?.agentOptions?.model === 'm1'

  // reasoningEffort 透传(选项在 create 的 agentOptions 里, 不是被丢掉)
  const effortCwd = resolve(FAKE_CWD, 'nonexistent-effort')
  await rpc(init.sid, { jsonrpc: '2.0', id: 35, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: effortCwd, provider: 'p1', model: 'm1', reasoningEffort: 'high' } } })
  checks['reasoningEffort 透传到 agentOptions'] = created.find((c) => c.agentOptions?.reasoningEffort === 'high')?.agentOptions?.provider === 'p1'

  // 接管 live 会话时回报它自己的模型(读 agent.options)
  checks['接管 live 会话回报其原有模型'] = runLiveInner.model?.provider === 'live-p' && runLiveInner.model?.model === 'live-m'

  // select_model: 走官方 selectModel + 池 key 跟随新模型(re-key)
  const selModel = await rpc(init.sid, { jsonrpc: '2.0', id: 36, method: 'tools/call', params: { name: 'select_model', arguments: { sessionId: runOverrideInner.sessionId, provider: 'p2', model: 'm10', reasoningEffort: 'high' } } })
  const selInner = selModel.status === 200 ? innerOf(selModel) : { error: 'bad' }
  checks['select_model 走官方 selectModel 并回报归一化选择'] = selInner.ok === true
    && selectModelCalls.at(-1)?.sessionId === runOverrideInner.sessionId
    && selectModelCalls.at(-1)?.model === 'm10' && selectModelCalls.at(-1)?.reasoningEffort === 'high'
    && selInner.selected?.model === 'm10' && selInner.selected?.reasoningEffort === 'high'

  const createdBeforeRekey = created.length
  const runAfterRekey = await rpc(init.sid, { jsonrpc: '2.0', id: 37, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: FAKE_CWD, provider: 'p2', model: 'm10', reasoningEffort: 'high' } } })
  checks['select_model 后池 key 跟随新模型(re-key, 不误开新会话)'] = created.length === createdBeforeRekey
    && innerOf(runAfterRekey).sessionId === runOverrideInner.sessionId

  // 队列侧也带模型覆盖
  const inboxModel = await rpc(init.sid, { jsonrpc: '2.0', id: 38, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'queued with model', cwd: FAKE_CWD, provider: 'p2', model: 'm9' } } })
  const inboxModelId = innerOf(inboxModel).taskId
  let inboxModelInner: any = {}
  for (let i = 0; i < 50 && inboxModelInner.model?.model !== 'm9'; i++) {
    const imr = await rpc(init.sid, { jsonrpc: '2.0', id: 390 + i, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: inboxModelId } } })
    inboxModelInner = imr.status === 200 ? innerOf(imr) : {}
    if (inboxModelInner.model?.model !== 'm9') await new Promise((r) => setTimeout(r, 100))
  }
  checks['task_inbox 的模型覆盖生效(结果自报模型)'] = inboxModelInner.model?.model === 'm9'

  // ── per-call preset: 新建会话选人格(池按 preset 分组), 接管沿用原 preset ──
  const createdBeforePreset = created.length
  const runPreset = await rpc(init.sid, { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'review please', cwd: FAKE_CWD, preset: 'reviewer' } } })
  const runPresetInner = runPreset.status === 200 ? innerOf(runPreset) : { error: 'bad' }
  checks['per-call preset: 新建会话挂载指定 preset(meta+mount+结果回报)'] = Boolean(runPresetInner.sessionId)
    && runPresetInner.preset === 'reviewer'
    && created.length === createdBeforePreset + 1 && created.at(-1)?.preset === 'reviewer'
    && mounted.includes('reviewer')
  const runPresetAgain = innerOf(await rpc(init.sid, { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'review again', cwd: FAKE_CWD, preset: 'reviewer' } } }))
  checks['per-call preset: 池按 preset 分组(同 preset 复用同一会话)'] = runPresetAgain.sessionId === runPresetInner.sessionId
    && created.length === createdBeforePreset + 1
  const runPresetUnknown = await rpc(init.sid, { jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'x', cwd: FAKE_CWD, preset: 'nope' } } })
  checks['per-call preset: 未知 preset 报错并带可用清单'] = parsePayload(runPresetUnknown.text).result?.isError === true
    && String(innerOf(runPresetUnknown).error ?? '').includes('unknown preset "nope"')
    && String(innerOf(runPresetUnknown).error ?? '').includes('standard')
  const takeoverPreset = innerOf(await rpc(init.sid, { jsonrpc: '2.0', id: 44, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'x', sessionId: 'sess-live', preset: 'reviewer' } } }))
  checks['per-call preset: 接管已有会话忽略 preset(沿用原 preset)'] = takeoverPreset.sessionId === 'sess-live' && !takeoverPreset.error
    && takeoverPreset.preset === undefined // live 接管无从得知原 preset → 省略字段
  const inboxPreset = await rpc(init.sid, { jsonrpc: '2.0', id: 45, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'queued with preset', cwd: FAKE_CWD, preset: 'reviewer' } } })
  const inboxPresetId = innerOf(inboxPreset).taskId
  let inboxPresetInner: any = {}
  for (let i = 0; i < 50 && inboxPresetInner.preset !== 'reviewer'; i++) {
    const ipr = await rpc(init.sid, { jsonrpc: '2.0', id: 460 + i, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: inboxPresetId } } })
    inboxPresetInner = ipr.status === 200 ? innerOf(ipr) : {}
    if (inboxPresetInner.preset !== 'reviewer') await new Promise((r) => setTimeout(r, 100))
  }
  checks['task_inbox 的 preset 覆盖生效(结果自报 preset)'] = inboxPresetInner.preset === 'reviewer'

  // task_list 完成任务回报实际执行的 sessionId(重启/轮询后仍可续接)
  const tlDone = await rpc(init.sid, { jsonrpc: '2.0', id: 87, method: 'tools/call', params: { name: 'task_list', arguments: { status: 'done' } } })
  const tlDoneArr: any[] = tlDone.status === 200 ? (innerOf(tlDone).tasks ?? []) : []
  const doneItem = tlDoneArr.find((t) => t.taskId === queuedId)
  checks['task_list: 完成任务回报 sessionId(可续接)'] = Boolean(doneItem?.sessionId)

  // ── dsh_status / workspace_list: 部署状态与工作区清单(只读, headless 场景不开 Web 面板也能看) ──
  const statusTool = await rpc(init.sid, { jsonrpc: '2.0', id: 80, method: 'tools/call', params: { name: 'dsh_status', arguments: {} } })
  const statusInner = statusTool.status === 200 ? innerOf(statusTool) : {}
  checks['dsh_status: 完整快照(版本/配置摘要/队列计数/常驻会话数)'] = statusInner.version === '0.1.0'
    && typeof statusInner.uptimeMs === 'number' && statusInner.config?.preset === 'standard'
    && typeof statusInner.stats?.queue?.active === 'number' && typeof statusInner.stats?.liveAgents === 'number'
  const wsList = await rpc(init.sid, { jsonrpc: '2.0', id: 81, method: 'tools/call', params: { name: 'workspace_list', arguments: {} } })
  const wsListInner = wsList.status === 200 ? innerOf(wsList) : {}
  checks['workspace_list: 花名册(id/路径/会话归属)'] = wsListInner.total >= 1
    && wsListInner.workspaces?.some((w) => w.id === 'ws-fake' && w.path === FAKE_CWD && w.sessionCount >= 1 && Array.isArray(w.sessionIds))
  // 无 apply 闭包时的退路: state 级基础快照(无监听/连接字段, 但配置摘要与队列计数可用)
  const basicSnap: any = basicStatusSnapshot()
  checks['dsh_status: 基础快照退路(state 级, 无监听/连接字段)'] = basicSnap.version === '0.1.0'
    && typeof basicSnap.stats?.liveAgents === 'number'
    && basicSnap.uptimeMs === undefined && basicSnap.connections === undefined

  // ── MCP resources 面: resources/list + resources/read(与工具同数据同边界) ──
  const resList = await rpc(init.sid, { jsonrpc: '2.0', id: 96, method: 'resources/list', params: {} })
  const resUris = resList.status === 200 ? (parsePayload(resList.text).result?.resources ?? []).map((r) => r.uri) : []
  checks['resources/list: 静态资源(status/queue/sessions)'] = resList.status === 200
    && resUris.includes('dsh://status') && resUris.includes('dsh://queue') && resUris.includes('dsh://sessions')
  const resStatus = await rpc(init.sid, { jsonrpc: '2.0', id: 97, method: 'resources/read', params: { uri: 'dsh://status' } })
  const resStatusInner = resStatus.status === 200 ? JSON.parse(parsePayload(resStatus.text).result.contents[0].text) : {}
  checks['resources/read: dsh://status'] = resStatusInner.version === '0.1.0' && typeof resStatusInner.uptimeMs === 'number'
  const resQueue = await rpc(init.sid, { jsonrpc: '2.0', id: 98, method: 'resources/read', params: { uri: 'dsh://queue' } })
  const resQueueInner = resQueue.status === 200 ? JSON.parse(parsePayload(resQueue.text).result.contents[0].text) : null
  checks['resources/read: dsh://queue(task_list 同数据)'] = Array.isArray(resQueueInner?.tasks) && resQueueInner.tasks.some((t: any) => t.taskId && t.status)
  const resSessions = await rpc(init.sid, { jsonrpc: '2.0', id: 99, method: 'resources/read', params: { uri: 'dsh://sessions' } })
  const resSessionsInner = resSessions.status === 200 ? JSON.parse(parsePayload(resSessions.text).result.contents[0].text) : { sessions: [] }
  checks['resources/read: dsh://sessions(session_list 同数据)'] = resSessionsInner.total >= 1
    && resSessionsInner.sessions?.some((s) => s.sessionId === 'sess-live')
  const resHist = await rpc(init.sid, { jsonrpc: '2.0', id: 100, method: 'resources/read', params: { uri: 'dsh://sessions/sess-live/history' } })
  const resHistInner = resHist.status === 200 ? JSON.parse(parsePayload(resHist.text).result.contents[0].text) : {}
  checks['resources/read: 模板资源会话纪要(session_history 同数据)'] = resHistInner.sessionId === 'sess-live'
    && Array.isArray(resHistInner.turns) && resHistInner.turns.length > 0
  const resHistMissing = await rpc(init.sid, { jsonrpc: '2.0', id: 101, method: 'resources/read', params: { uri: 'dsh://sessions/sess-nope/history' } })
  checks['resources/read: 不存在的会话报错'] = resHistMissing.status === 200
    && (parsePayload(resHistMissing.text).error?.message ?? '').includes('session not live')

  // ── agent 认知面: dsh_get_started 的 section 参数(只取一节) + dsh://guide 资源 ──
  const guideFull = await rpc(init.sid, { jsonrpc: '2.0', id: 102, method: 'tools/call', params: { name: 'dsh_get_started', arguments: {} } })
  const guideFullText = guideFull.status === 200 ? String(parsePayload(guideFull.text).result?.content?.[0]?.text ?? '') : ''
  const guideErrors = await rpc(init.sid, { jsonrpc: '2.0', id: 103, method: 'tools/call', params: { name: 'dsh_get_started', arguments: { section: 'errors' } } })
  const guideErrorsText = guideErrors.status === 200 ? String(parsePayload(guideErrors.text).result?.content?.[0]?.text ?? '') : ''
  checks['dsh_get_started: section=errors 只返回对照表一节'] = guideErrorsText.includes('Error → alternative path')
    && !guideErrorsText.includes('## Concepts') && guideErrorsText.length < guideFullText.length
  const resGuide = await rpc(init.sid, { jsonrpc: '2.0', id: 104, method: 'resources/read', params: { uri: 'dsh://guide' } })
  const resGuideInner = resGuide.status === 200 ? parsePayload(resGuide.text).result?.contents?.[0] : undefined
  checks['resources/read: dsh://guide(整份帮助文档)'] = resGuideInner?.mimeType === 'text/markdown'
    && String(resGuideInner?.text ?? '').includes('## Concepts') && String(resGuideInner?.text ?? '').includes('## Workflow recipes')

  // ── Phase R: 资源面 v2 —— 全量 URI/读语义/annotations/completion/订阅推送 ──
  const readRes = async (id: number, uri: string): Promise<{ error?: string; json?: any; mime?: string }> => {
    const r = await rpc(init.sid, { jsonrpc: '2.0', id, method: 'resources/read', params: { uri } })
    if (r.status !== 200) return { error: 'http ' + r.status }
    const payload = parsePayload(r.text)
    if (payload.error) return { error: String(payload.error.message ?? '') }
    const c = payload.result?.contents?.[0]
    return { mime: c?.mimeType, json: c?.text !== undefined ? JSON.parse(c.text) : undefined }
  }
  checks['initialize 声明 resources.listChanged+subscribe'] = initResult?.capabilities?.resources?.listChanged === true
    && initResult?.capabilities?.resources?.subscribe === true
  checks['resources/list: 静态资源全集(guide 分节/tools/models/presets/workspaces/agents/status 细分)'] = [
    'dsh://guide/concepts', 'dsh://guide/workflows', 'dsh://guide/errors', 'dsh://guide/results', 'dsh://guide/limits',
    'dsh://tools', 'dsh://models', 'dsh://presets', 'dsh://workspaces', 'dsh://agents',
    'dsh://status/config', 'dsh://status/stats', 'dsh://status/connections',
  ].every((u) => resUris.includes(u))
  // 新数据能力: presets 花名册(agent_run 的 preset 参数此前无从查证)/常驻池明细
  const rPresets = await readRes(300, 'dsh://presets')
  checks['resources/read: dsh://presets(花名册投影 id/name/description)'] = rPresets.json?.total === 2
    && rPresets.json?.presets?.[0]?.id === 'standard' && rPresets.json?.presets?.[0]?.name === 'Standard'
    && rPresets.json?.presets?.[1]?.id === 'reviewer' && rPresets.json?.presets?.[1]?.name === undefined
  const rAgents = await readRes(301, 'dsh://agents')
  checks['resources/read: dsh://agents(池明细 sessionId/cwd/preset/model/activeTurn)'] = rAgents.json?.total >= 1
    && rAgents.json?.agents?.some((a: any) => a.sessionId === created[0]?.id && a.cwd === FAKE_CWD
      && a.preset === 'standard' && a.model?.provider === 'p1' && a.activeTurn === false)
  const rModels = await readRes(302, 'dsh://models')
  checks['resources/read: dsh://models(官方目录口径)'] = rModels.json?.source === 'sessionController' && rModels.json?.routableProviders?.length === 2
  const rTools = await readRes(303, 'dsh://tools')
  checks['resources/read: dsh://tools(宿主全局注册表 + 盲区自述)'] = rTools.json?.source === 'global-registry'
    && rTools.json?.tools?.some((t: any) => t.name === 'bash')
  const rCfg = await readRes(304, 'dsh://status/config')
  const rStats = await readRes(305, 'dsh://status/stats')
  const rConns = await readRes(306, 'dsh://status/connections')
  checks['resources/read: dsh://status 三细分(config/stats/connections)'] = rCfg.json?.version === '0.1.0'
    && rCfg.json?.config?.maxAgents === 8 && rStats.json?.listening === true && typeof rStats.json?.uptimeMs === 'number'
    && Array.isArray(rConns.json?.connections) && rConns.json.connections.length >= 1
  // guide/errors 是 markdown 文本资源(不走 JSON)
  {
    const raw = await rpc(init.sid, { jsonrpc: '2.0', id: 308, method: 'resources/read', params: { uri: 'dsh://guide/errors' } })
    const txt = raw.status === 200 ? String(parsePayload(raw.text).result?.contents?.[0]?.text ?? '') : ''
    checks['resources/read: dsh://guide/errors(分节 markdown)'] = txt.includes('Error → alternative path') && !txt.includes('## Concepts')
  }
  // 读语义: sessions/{id} 元数据 persisted-only 可读 + historyReadable 指路; history 只对 live 可读
  const rMetaLive = await readRes(309, 'dsh://sessions/sess-live')
  const rMetaPersisted = await readRes(310, 'dsh://sessions/sess-persisted')
  checks['resources/read: dsh://sessions/{id}(元数据, persisted-only 也可读+historyReadable 指路)'] = rMetaLive.json?.sessionId === 'sess-live'
    && rMetaLive.json?.historyReadable === true && rMetaPersisted.json?.sessionId === 'sess-persisted'
    && rMetaPersisted.json?.historyReadable === false
  const rHistPersisted = await readRes(311, 'dsh://sessions/sess-persisted/history')
  checks['resources/read: persisted-only 的 history → -32602 且指路 agent_run'] = String(rHistPersisted.error ?? '').includes('not live')
    && String(rHistPersisted.error ?? '').includes('agent_run')
  // 事件流(JSONL)与游标续读(after=1 → 返回下标 >1 的事件, 共 total-2 条)
  const rEvents = await readRes(312, 'dsh://sessions/sess-live/events')
  const rEvents2 = await readRes(313, 'dsh://sessions/sess-live/events/1')
  checks['resources/read: dsh://sessions/{id}/events(JSONL + after 游标)'] = Array.isArray(rEvents.json?.lines)
    && rEvents.json.lines.length === rEvents.json.total && rEvents.json.total >= 1
    && JSON.parse(rEvents.json.lines[0]).type === 'user/message'
    && rEvents2.json?.after === 1 && rEvents2.json?.returned === rEvents.json.total - 2 && rEvents2.json?.truncated === false
  // 活动窗口(订阅推送的数据本体; assistantTail 取最后一条 assistant 文本)
  const rActivity = await readRes(314, 'dsh://sessions/sess-live/activity')
  checks['resources/read: dsh://sessions/{id}/activity(空闲态快照)'] = rActivity.json?.sessionId === 'sess-live'
    && rActivity.json?.active === false && rActivity.json?.turns >= 1 && rActivity.json?.lastTool === 'bash'
    && String(rActivity.json?.assistantTail ?? '').includes('extra')
  // 纪要翻页: before=0 → 空(第 0 条之前无事件)
  const rHistPage = await readRes(315, 'dsh://sessions/sess-live/history/0')
  checks['resources/read: history/{before} 翻页游标(before=0 → 空页)'] = rHistPage.json?.sessionId === 'sess-live'
    && Array.isArray(rHistPage.json?.turns) && rHistPage.json.turns.length === 0
  // 单任务资源: 完成 → 全量结果; 未知 → -32602 且提及 TTL/订阅
  const rTask = await readRes(316, `dsh://queue/${queuedId}`)
  checks['resources/read: dsh://queue/{taskId}(完成含 full 投影结果)'] = rTask.json?.status === 'done'
    && rTask.json?.result?.detail === 'full' && rTask.json?.result?.changes === 'c1' && rTask.json?.taskId === queuedId
  const rTaskNope = await readRes(317, 'dsh://queue/no-such-task')
  checks['resources/read: 未知任务 → -32602(带 TTL/订阅指路)'] = String(rTaskNope.error ?? '').includes('task not found')
    && String(rTaskNope.error ?? '').includes('taskTtlMs')
  const rNope = await readRes(318, 'dsh://no-such-resource')
  checks['resources/read: 未知资源 → -32602 not found'] = String(rNope.error ?? '').includes('not found')
  // 模板清单 + completion
  const tmplList = await rpc(init.sid, { jsonrpc: '2.0', id: 319, method: 'resources/templates/list', params: {} })
  const tmplUris: string[] = tmplList.status === 200 ? (parsePayload(tmplList.text).result?.resourceTemplates ?? []).map((t: any) => t.uriTemplate) : []
  checks['resources/templates/list: 模板全集(含翻页游标变体)'] = ['dsh://queue/{taskId}', 'dsh://sessions/{sessionId}',
    'dsh://sessions/{sessionId}/history', 'dsh://sessions/{sessionId}/history/{before}',
    'dsh://sessions/{sessionId}/events/{after}', 'dsh://sessions/{sessionId}/activity', 'dsh://models/{provider}']
    .every((u) => tmplUris.includes(u))
  const completeOf = async (id: number, uri: string, name: string, value: string): Promise<string[]> => {
    const r = await rpc(init.sid, {
      jsonrpc: '2.0', id, method: 'completion/complete',
      params: { ref: { type: 'ref/resource', uri }, argument: { name, value } },
    })
    return r.status === 200 ? (parsePayload(r.text).result?.completion?.values ?? []) : []
  }
  checks['completion: sessionId 补全(history 模板只给 live, 元数据模板含 persisted)'] =
    (await completeOf(320, 'dsh://sessions/{sessionId}/history', 'sessionId', 'sess')).includes('sess-live')
    && !(await completeOf(321, 'dsh://sessions/{sessionId}/history', 'sessionId', 'sess-p')).includes('sess-persisted')
    && (await completeOf(322, 'dsh://sessions/{sessionId}', 'sessionId', 'sess-p')).includes('sess-persisted')
  checks['completion: provider 补全(模型目录)'] = JSON.stringify(await completeOf(323, 'dsh://models/{provider}', 'provider', 'p')) === JSON.stringify(['p1', 'p2'])
  checks['completion: taskId 补全(队列现存)'] = (await completeOf(324, 'dsh://queue/{taskId}', 'taskId', queuedId.slice(0, 8))).includes(queuedId)
  // HATEOAS 引用: agent_run/task_inbox 结果带资源 URI
  checks['HATEOAS: agent_run 结果带会话纪要资源引用'] = runLiveInner.resource === 'dsh://sessions/sess-live/history'
  checks['HATEOAS: task_inbox 结果带任务资源引用'] = inboxInner.resource === `dsh://queue/${queuedId}`
  // ── 订阅推送: GET SSE 流上收 notifications/resources/{updated,list_changed} ──
  // 推送是"先订阅后触发"才可确定(快任务可能在订阅落地前已完成——那正是轮询不再需要的场景:
  // 直接读资源即得终态); 慢任务用 slow-cwd, 与后续取消链路块的 slow-cwd 隔离(不同池 key)
  {
    const sse = openSse(init.sid)
    await sse.ready
    const updatedFor = (uri: string) => sse.events.filter((e) => e.method === 'notifications/resources/updated' && e.params?.uri === uri).length
    const hasListChanged = () => sse.events.some((e) => e.method === 'notifications/resources/list_changed')
    let reqId = 400
    const subscribe = async (uri: string): Promise<string> => {
      const r = await rpc(init.sid, { jsonrpc: '2.0', id: ++reqId, method: 'resources/subscribe', params: { uri } })
      const p = parsePayload(r.text)
      return p.error ? String(p.error.message ?? '') : ''
    }
    const unsubscribe = async (uri: string) => {
      await rpc(init.sid, { jsonrpc: '2.0', id: ++reqId, method: 'resources/unsubscribe', params: { uri } })
    }
    // 订阅校验: 未知任务 / persisted-only 历史 / 未知 URI → -32602
    checks['resources/subscribe: 不可读目标拒绝(-32602)'] = (await subscribe('dsh://queue/no-such-task')).includes('task not found')
      && (await subscribe('dsh://sessions/sess-persisted/history')).includes('not live')
      && (await subscribe('dsh://nope')).includes('unknown resource')
    // turn 完成推送: 先订阅 sess-live 的纪要资源, 再跑 agent_run(确定性顺序)
    const historyUri = 'dsh://sessions/sess-live/history'
    checks['resources/subscribe: 可读目标受理'] = (await subscribe(historyUri)) === ''
    const pushRun = await rpc(init.sid, { jsonrpc: '2.0', id: 401, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'push probe', sessionId: 'sess-live' } } })
    checks['订阅: turn 收敛 → history 资源 updated 推送'] = pushRun.status === 200
      && await waitFor(() => updatedFor(historyUri) >= 1, 5000, 50)
    // 慢任务终态推送: 入队(触发 list_changed) → running → 订阅 activity+queue → cancel → 双推送
    const slowCwdR = resolve(FAKE_CWD, 'slow-cwd-resources')
    const inboxSlow = await rpc(init.sid, { jsonrpc: '2.0', id: 402, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'slow push', cwd: slowCwdR } } })
    const slowId = innerOf(inboxSlow).taskId
    let slowSid = ''
    for (let i = 0; i < 50 && !slowSid; i++) {
      const tl = await rpc(init.sid, { jsonrpc: '2.0', id: 4030 + i, method: 'tools/call', params: { name: 'task_list', arguments: {} } })
      slowSid = String((tl.status === 200 ? (innerOf(tl).tasks ?? []) : []).find((t: any) => t.taskId === slowId)?.sessionId ?? '')
      if (!slowSid) await new Promise((r) => setTimeout(r, 100))
    }
    checks['resources/subscribe: 慢任务活动窗口与队列资源受理'] = (await subscribe(`dsh://sessions/${slowSid}/activity`)) === ''
      && (await subscribe(`dsh://queue/${slowId}`)) === ''
    const gotActivity = await waitFor(() => updatedFor(`dsh://sessions/${slowSid}/activity`) >= 1, 5000, 50)
    const cancelSlow = await rpc(init.sid, { jsonrpc: '2.0', id: 404, method: 'tools/call', params: { name: 'task_cancel', arguments: { taskId: slowId } } })
    // 执行中取消: cancelling=true(取消已送达), 终态等 agent 收敛后再推送(queue 资源 updated)
    checks['订阅: 取消任务 → 队列资源终态推送'] = innerOf(cancelSlow).cancelling === true
      && await waitFor(() => updatedFor(`dsh://queue/${slowId}`) >= 1, 5000, 50)
    checks['订阅: 活动窗口推送(turn 运行期)'] = gotActivity
    checks['订阅: list_changed 广播(入队/会话事件)'] = hasListChanged()
    // 订阅观测进状态快照
    const statusSub = await rpc(init.sid, { jsonrpc: '2.0', id: 405, method: 'tools/call', params: { name: 'dsh_status', arguments: {} } })
    checks['dsh_status: stats.subscriptions 订阅观测'] = (statusSub.status === 200 ? innerOf(statusSub).stats?.subscriptions?.subscriptions : 0) >= 3
    // 退订: 之后 history 不再推送(再跑一轮 agent_run, 计数不增长)
    await unsubscribe(historyUri)
    const beforeCount = updatedFor(historyUri)
    const postRun = await rpc(init.sid, { jsonrpc: '2.0', id: 406, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'after unsub', sessionId: 'sess-live' } } })
    checks['resources/unsubscribe: 退订后停止推送'] = postRun.status === 200 && updatedFor(historyUri) === beforeCount
    sse.close()
  }


  // ── 取消链路: agent_run 经 MCP notifications/cancelled → 官方 agent.cancel({kind:'user'}) ──
  // 注意: 规范要求服务端对已取消请求 SHOULD NOT 回响应, 所以这里不 await 响应体,
  // 断言服务端效果(cancel 被调用一次), 最后主动断开连接。
  {
    const ac = new AbortController()
    const slowRunId = 60
    const slowRunFetch = fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': init.sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: slowRunId, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'long job', sessionId: 'sess-slow' } } }),
      signal: ac.signal,
    }).then((res) => res.text()).catch(() => 'aborted')
    // 确定性等待: slow agent 已收到 followup——此刻 turn 必在 whenIdle 上挂起, 取消必然命中 agent.cancel
    await waitFor(() => slowLiveAgent.session.snapshotEvents().length > 0, 5000)
    // agent_steer: turn 运行中投递转向(不经取消链路, turn 照常推进)
    const steerRun = await rpc(init.sid, { jsonrpc: '2.0', id: 67, method: 'tools/call', params: { name: 'agent_steer', arguments: { sessionId: 'sess-slow', message: 'STEER-MARKER-1' } } })
    const steerRunInner = steerRun.status === 200 ? innerOf(steerRun) : { error: 'bad' }
    checks['agent_steer: 运行中转向(运行态确认+到达桩 agent)'] = steerRunInner.ok === true && steerRunInner.mode === 'steer'
      && steerRunInner.agentStatus === 'running' && steerRunInner.sessionId === 'sess-slow'
      && steered.some((s) => s.id === 'sess-slow' && String(s.message?.content?.[0]?.text ?? '').includes('STEER-MARKER-1'))
    await rpc(init.sid, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: slowRunId } })
    await waitFor(() => slowLiveAgent.cancelCalls.length >= 1, 5000) // 让 cancel 链路收敛
    checks['agent_run 可取消(cancelled 通知 → 官方 agent.cancel 一次)'] = slowLiveAgent.cancelCalls.length === 1
      && slowLiveAgent.cancelCalls[0]?.kind === 'user'
    ac.abort() // 服务端不会回响应(规范 SHOULD NOT); 主动断开, 避免 fetch 悬挂
    await slowRunFetch
  }

  // ── agent_steer: 空闲拒绝 / inject 挂起 / 持久化-only / 参数校验 ──
  // 等 cancel 收敛后的收尾微任务(activeTurnSessions 清除)落定, 避免 steer 命中清表前的窗口
  await new Promise((r) => setTimeout(r, 200))
  const steerIdle = await rpc(init.sid, { jsonrpc: '2.0', id: 74, method: 'tools/call', params: { name: 'agent_steer', arguments: { sessionId: 'sess-slow', message: 'x' } } })
  checks['agent_steer: 空闲会话拒绝并提示 agent_run'] = parsePayload(steerIdle.text).result?.isError === true
    && String(innerOf(steerIdle).error ?? '').includes('agent_run')
  const injectIdle = await rpc(init.sid, { jsonrpc: '2.0', id: 75, method: 'tools/call', params: { name: 'agent_steer', arguments: { sessionId: 'sess-live', message: 'CONTEXT-MARKER-1', mode: 'inject' } } })
  const injectIdleInner = injectIdle.status === 200 ? innerOf(injectIdle) : { error: 'bad' }
  checks['agent_steer: inject 空闲允许(挂起到下次唤醒)'] = injectIdleInner.ok === true && injectIdleInner.mode === 'inject'
    && String(injectIdleInner.note ?? '').includes('parked')
    && injected.some((i) => i.id === 'sess-live' && String(i.message?.content?.[0]?.text ?? '').includes('CONTEXT-MARKER-1'))
  const steerPersisted = await rpc(init.sid, { jsonrpc: '2.0', id: 76, method: 'tools/call', params: { name: 'agent_steer', arguments: { sessionId: 'sess-persisted', message: 'x' } } })
  checks['agent_steer: 持久化-only 会话报错(无活 agent)'] = parsePayload(steerPersisted.text).result?.isError === true
    && String(innerOf(steerPersisted).error ?? '').includes('agent_run')
  const steerBoth = await rpc(init.sid, { jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'agent_steer', arguments: { message: 'x', sessionId: 'sess-live', taskId: 'nope' } } })
  const steerNone = await rpc(init.sid, { jsonrpc: '2.0', id: 78, method: 'tools/call', params: { name: 'agent_steer', arguments: { message: 'x' } } })
  checks['agent_steer: sessionId/taskId 二选一(双给/都不给报错)'] = parsePayload(steerBoth.text).result?.isError === true
    && parsePayload(steerNone.text).result?.isError === true
  const steerBadTask = await rpc(init.sid, { jsonrpc: '2.0', id: 79, method: 'tools/call', params: { name: 'agent_steer', arguments: { message: 'x', taskId: 'no-such-task' } } })
  checks['agent_steer: 未知 taskId 报错'] = parsePayload(steerBadTask.text).result?.isError === true
    && String(innerOf(steerBadTask).error ?? '').includes('not found')

  // ── task_cancel / task_list: 排队(锁内)与执行中两条取消路 ──
  const slowCwd = resolve(FAKE_CWD, 'slow-cwd')
  const inboxA = await rpc(init.sid, { jsonrpc: '2.0', id: 62, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'slow A', cwd: slowCwd } } })
  const idA = innerOf(inboxA).taskId
  const inboxB = await rpc(init.sid, { jsonrpc: '2.0', id: 63, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'slow B', cwd: slowCwd } } })
  const idB = innerOf(inboxB).taskId
  // 确定性等待: A 真正进入执行中(拿到 cwd 锁并触发官方 cancel 才有意义), 而非固定 sleep
  let aRunning = false
  for (let i = 0; i < 50 && !aRunning; i++) {
    const tl0 = await rpc(init.sid, { jsonrpc: '2.0', id: 620 + i, method: 'tools/call', params: { name: 'task_list', arguments: {} } })
    const l0: any[] = tl0.status === 200 ? (innerOf(tl0).tasks ?? []) : []
    aRunning = l0.find((t) => t.taskId === idA)?.status === 'running'
    if (!aRunning) await new Promise((r) => setTimeout(r, 100))
  }
  // agent_steer: 执行中任务按 taskId 转向(item.sessionId 经 onSession 即时回填) + 排队中任务拒绝
  const steerTask = await rpc(init.sid, { jsonrpc: '2.0', id: 680, method: 'tools/call', params: { name: 'agent_steer', arguments: { taskId: idA, message: 'TASK-STEER-MARKER-1' } } })
  const steerTaskInner = steerTask.status === 200 ? innerOf(steerTask) : { error: 'bad' }
  checks['agent_steer: 执行中任务按 taskId 转向'] = steerTaskInner.ok === true && Boolean(steerTaskInner.sessionId)
    && steered.some((s) => String(s.message?.content?.[0]?.text ?? '').includes('TASK-STEER-MARKER-1'))
  const steerQueued = await rpc(init.sid, { jsonrpc: '2.0', id: 681, method: 'tools/call', params: { name: 'agent_steer', arguments: { taskId: idB, message: 'x' } } })
  checks['agent_steer: 排队中任务不可干预'] = parsePayload(steerQueued.text).result?.isError === true
    && String(innerOf(steerQueued).error ?? '').includes('not running')
  const cancelB = await rpc(init.sid, { jsonrpc: '2.0', id: 64, method: 'tools/call', params: { name: 'task_cancel', arguments: { taskId: idB } } })
  checks['task_cancel: 排队中任务直接取消'] = innerOf(cancelB).cancelled === true
  const taskList1 = await rpc(init.sid, { jsonrpc: '2.0', id: 65, method: 'tools/call', params: { name: 'task_list', arguments: {} } })
  const listArr: any[] = taskList1.status === 200 ? (innerOf(taskList1).tasks ?? []) : []
  checks['task_list: 状态快照(A running / B cancelled)'] = aRunning && Array.isArray(listArr)
    && listArr.find((t) => t.taskId === idA)?.status === 'running'
    && listArr.find((t) => t.taskId === idB)?.status === 'cancelled'
  const cancelA = await rpc(init.sid, { jsonrpc: '2.0', id: 66, method: 'tools/call', params: { name: 'task_cancel', arguments: { taskId: idA } } })
  // 执行中取消: cancelling=true 表示 abort 已送达(官方 agent.cancel), 状态保持 running 直到真正收敛
  checks['task_cancel: 执行中任务接受取消(cancelling, 未过早标 cancelled)'] = innerOf(cancelA).cancelling === true
    && innerOf(cancelA).status === 'running'
  // 等 runner 经官方 cancel 收敛(轮询)
  let resA: any = {}
  for (let i = 0; i < 50 && resA.status !== 'cancelled'; i++) {
    const ra = await rpc(init.sid, { jsonrpc: '2.0', id: 640 + i, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: idA, detail: 'status' } } })
    resA = ra.status === 200 ? innerOf(ra) : {}
    if (resA.status !== 'cancelled') await new Promise((r) => setTimeout(r, 100))
  }
  const resB = await rpc(init.sid, { jsonrpc: '2.0', id: 68, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: idB, detail: 'status' } } })
  checks['task_result: 两个取消任务均为 cancelled'] = resA.status === 'cancelled' && innerOf(resB).status === 'cancelled'
  let resAFull: any = {}
  for (let i = 0; i < 50 && !String(resAFull.error ?? '').includes('canceled'); i++) {
    const rf = await rpc(init.sid, { jsonrpc: '2.0', id: 660 + i, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: idA } } })
    resAFull = rf.status === 200 ? innerOf(rf) : {}
    if (!String(resAFull.error ?? '').includes('canceled')) await new Promise((r) => setTimeout(r, 100))
  }
  checks['取消结果失败透出(error 含 canceled)'] = String(resAFull.error ?? '').includes('canceled')
  const slowPoolAgent = slowAgents.find((a) => a.session.header.cwd === slowCwd)
  checks['执行中取消触发官方 agent.cancel(池会话一次)'] = slowPoolAgent?.cancelCalls.length === 1

  // ── session_list: live + 持久化合并(live 优先) ──
  const sessList = await rpc(init.sid, { jsonrpc: '2.0', id: 69, method: 'tools/call', params: { name: 'session_list', arguments: {} } })
  const sl = sessList.status === 200 ? innerOf(sessList) : { total: 0, sessions: [] }
  checks['session_list: live+持久化合并(快照/裸 header)'] = sl.total >= 3
    && sl.sessions.some((s) => s.sessionId === 'sess-live2')
    && sl.sessions.some((s) => s.sessionId === 'sess-persisted')
    && sl.sessions.some((s) => s.sessionId === 'sess-legacy')
    && sl.sessions.find((s) => s.sessionId === 'sess-live2')?.title === 'Live Two'
  // 结构化输出: structuredContent 与 text 镜像同源(innerOf 已优先取前者, 这里再验两者一致)
  const slRaw = sessList.status === 200 ? parsePayload(sessList.text).result : undefined
  checks['session_list: structuredContent 与 text 同源'] = typeof slRaw?.structuredContent?.total === 'number'
    && JSON.parse(slRaw.content[0].text).total === slRaw.structuredContent.total
  checks['session_list: 回报已知会话的当前模型'] = sl.sessions.some((s) => s.sessionId === 'sess-live'
    && s.model?.provider === 'live-p' && s.model?.model === 'live-m')
    && !sl.sessions.some((s) => s.sessionId === 'sess-persisted' && s.model)
  const sessListLim = await rpc(init.sid, { jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'session_list', arguments: { limit: 2 } } })
  const slLim = sessListLim.status === 200 ? innerOf(sessListLim) : { total: 0, sessions: [] }
  checks['session_list: limit 截断且 total 不变'] = slLim.sessions.length === 2 && slLim.total === sl.total

  const slFiltered = await rpc(init.sid, { jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'session_list', arguments: { cwd: resolve(FAKE_CWD, 'no-such-dir') } } })
  const slF = slFiltered.status === 200 ? innerOf(slFiltered) : { sessions: [] }
  checks['session_list: cwd 过滤(total 为匹配计数, 无匹配为 0)'] = slF.total === 0 && Array.isArray(slF.sessions) && slF.sessions.length === 0
  const slAll = await rpc(init.sid, { jsonrpc: '2.0', id: 92, method: 'tools/call', params: { name: 'session_list', arguments: { cwd: FAKE_CWD } } })
  checks['session_list: cwd 过滤(根目录全中)'] = slAll.status === 200 && innerOf(slAll).sessions.length === sl.total

  // ── session_history: live 会话纪要(从最新往回取, 时间正序返回) ──
  const histLive = await rpc(init.sid, { jsonrpc: '2.0', id: 72, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-live' } } })
  const hl = histLive.status === 200 ? innerOf(histLive) : { turns: [] }
  checks['session_history: live 会话纪要(assistant+tool_call)'] = Array.isArray(hl.turns) && hl.turns.length >= 3
    && hl.turns.some((t) => t.role === 'assistant' && String(t.text).includes('done'))
    && hl.turns.some((t) => t.role === 'tool_call' && t.name === 'bash')
  const histLim = await rpc(init.sid, { jsonrpc: '2.0', id: 73, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-live', limit: 2 } } })
  const hlim = histLim.status === 200 ? innerOf(histLim) : { turns: [] }
  checks['session_history: limit 截断且时间正序'] = hlim.turns?.length === 2 && hlim.turns[0].index < hlim.turns[1].index

  // roles 过滤: 只取指定类型的轮次, limit 按过滤后的条数计数; 缺省 = 全部类型
  const histRoles = await rpc(init.sid, { jsonrpc: '2.0', id: 93, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-live', roles: ['assistant'] } } })
  const hRoles = histRoles.status === 200 ? innerOf(histRoles) : { turns: [] }
  checks['session_history: roles 只取 assistant(无工具噪声)'] = Array.isArray(hRoles.turns) && hRoles.turns.length > 0
    && hRoles.turns.every((t) => t.role === 'assistant')
  const histRolesLim = await rpc(init.sid, { jsonrpc: '2.0', id: 94, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-live', roles: ['assistant'], limit: 2 } } })
  const hRolesLim = histRolesLim.status === 200 ? innerOf(histRolesLim) : { turns: [] }
  checks['session_history: roles 过滤下 limit 按过滤后计数'] = hRolesLim.turns?.length === 2 && hRolesLim.turns.every((t) => t.role === 'assistant')
  const histRolesPage = await rpc(init.sid, { jsonrpc: '2.0', id: 95, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-live', roles: ['user'], limit: 5 } } })
  const hRolesPage = histRolesPage.status === 200 ? innerOf(histRolesPage) : { turns: [] }
  checks['session_history: roles 过滤 + beforeIndex 翻页仍可用'] = Array.isArray(hRolesPage.turns) && hRolesPage.turns.every((t) => t.role === 'user')

  // beforeIndex 翻页: 从上次最早 index 之前继续往回取
  const histPage1 = await rpc(init.sid, { jsonrpc: '2.0', id: 89, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-live', limit: 2 } } })
  const page1 = histPage1.status === 200 ? innerOf(histPage1) : { turns: [] }
  const page2 = await rpc(init.sid, { jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-live', limit: 2, beforeIndex: page1.turns?.[0]?.index } } })
  const page2Inner = page2.status === 200 ? innerOf(page2) : { turns: [] }
  checks['session_history: beforeIndex 向更早翻页'] = Array.isArray(page2Inner.turns) && page2Inner.turns.length > 0
    && page2Inner.turns.every((t) => t.index < page1.turns[0].index)
  const histPersisted = await rpc(init.sid, { jsonrpc: '2.0', id: 74, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-persisted' } } })
  checks['session_history: 持久化-only 会话明确报不可读'] = parsePayload(histPersisted.text).result?.isError === true
    && String(innerOf(histPersisted).error ?? '').includes('not live')

  // 池新建会话(runNew 的 sessionId)也在 sessions 服务里 → 纪要可读
  const histNew = await rpc(init.sid, { jsonrpc: '2.0', id: 88, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: created[0].id, limit: 5 } } })
  const hNew = histNew.status === 200 ? innerOf(histNew) : { turns: [] }
  checks['session_history: 池新建会话纪要(user+assistant)'] = Array.isArray(hNew.turns) && hNew.turns.length >= 2
    && hNew.turns.some((t) => t.role === 'user') && hNew.turns.some((t) => t.role === 'assistant')

  // ── rename_session: 成功(走 sessionTitle 服务)与未知会话 ──
  const renameOk = await rpc(init.sid, { jsonrpc: '2.0', id: 75, method: 'tools/call', params: { name: 'rename_session', arguments: { sessionId: 'sess-live', title: 'renamed-live' } } })
  const renameOkInner = renameOk.status === 200 ? innerOf(renameOk) : {}
  checks['rename_session: 成功改名(走 sessionTitle 服务)'] = renameOkInner.ok === true && renameOkInner.title === 'renamed-live'
    && fakeSessionTitle.renamed.at(-1)?.id === 'sess-live'
  const renameMissing = await rpc(init.sid, { jsonrpc: '2.0', id: 76, method: 'tools/call', params: { name: 'rename_session', arguments: { sessionId: 'sess-nope' } } })
  checks['rename_session: 未知会话带 isError'] = parsePayload(renameMissing.text).result?.isError === true

  // select_model 切换失败(宿主 selectModel 抛错) → isError 且透出宿主原因
  const selFail = await rpc(init.sid, { jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'select_model', arguments: { sessionId: 'sess-live', provider: 'p2', model: 'boom' } } })
  checks['select_model: 宿主切换失败透出原因(isError)'] = parsePayload(selFail.text).result?.isError === true
    && String(innerOf(selFail).error ?? '').includes('boom is not routable')

  // ── 传输层路由: GET 独立 SSE 流 + DELETE 会话终止(用一次性会话) ──
  const init2 = await rpc(undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-sse', version: '1.0' } } })
  await rpc(init2.sid, { jsonrpc: '2.0', method: 'notifications/initialized' })
  const getSse = await fetch(BASE, { method: 'GET', headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': init2.sid } })
  checks['GET /mcp: 独立 SSE 流(200 + event-stream)'] = getSse.status === 200
    && String(getSse.headers.get('content-type') ?? '').includes('text/event-stream')
  getSse.body?.cancel()
  const delRes = await fetch(BASE, { method: 'DELETE', headers: { 'Mcp-Session-Id': init2.sid } })
  checks['DELETE /mcp: 会话终止'] = delRes.status === 200 || delRes.status === 204
  await delRes.text().catch(() => '')
  const postDel = await rpc(init2.sid, { jsonrpc: '2.0', id: 90, method: 'tools/list', params: {} })
  checks['DELETE 后旧会话 404'] = postDel.status === 404

  // 卸载 Phase B(清空池/队列/server), 再起 Phase A
  for (const d of disposers.splice(0)) {
    if (typeof d === 'function') d()
    else if (d && typeof d.next === 'function') { /* generator disposer: 尽力跑完 */ }
  }
  await new Promise((r) => setTimeout(r, 200))

  // ── Phase A(安全): authToken + workspaceRoots + Host 白名单, 端口 8098 ──
  const PORT_A = 8098
  const BASE_A = `http://127.0.0.1:${PORT_A}/mcp`
  await apply(ctx, { port: PORT_A, host: '127.0.0.1', authToken: 'sekrit-token', workspaceRoots: [FAKE_CWD] })
  await new Promise((r) => setTimeout(r, 200))

  const unauth = await fetch(BASE_A, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } } }),
  })
  checks['authToken: 无 Bearer 被 401'] = unauth.status === 401
  checks['401 带 WWW-Authenticate: Bearer 挑战'] = String(unauth.headers.get('www-authenticate') ?? '').startsWith('Bearer')
  await unauth.text()

  const authOk = await fetch(BASE_A, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer sekrit-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } } }),
  })
  checks['authToken: 正确 Bearer 通过'] = authOk.status === 200
  const sidA = authOk.headers.get('mcp-session-id') ?? undefined
  await authOk.text()

  const evilHost = await rawRequest(PORT_A, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekrit-token', Host: 'evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {}, ...(sidA ? { 'Mcp-Session-Id': sidA } : {}) }),
  })
  checks['Host 白名单: 非 allowlist 主机名被 403'] = evilHost.status === 403

  // Origin 校验(MCP 规范: 本地 HTTP 服务校验 Origin 防 DNS rebinding): 不带 Origin 的 MCP 客户端不受影响
  const evilOrigin = await rawRequest(PORT_A, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekrit-token', Host: '127.0.0.1', Origin: 'http://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {}, ...(sidA ? { 'Mcp-Session-Id': sidA } : {}) }),
  })
  checks['Origin 白名单: 跨域 Origin 被 403'] = evilOrigin.status === 403

  const nullOrigin = await rawRequest(PORT_A, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekrit-token', Host: '127.0.0.1', Origin: 'null' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {}, ...(sidA ? { 'Mcp-Session-Id': sidA } : {}) }),
  })
  checks['Origin: null 被拒(无法证明同源)'] = nullOrigin.status === 403

  const sameOriginReq = await fetch(BASE_A, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer sekrit-token', Origin: `http://127.0.0.1:${PORT_A}`,
      ...(sidA ? { 'Mcp-Session-Id': sidA } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} }),
  })
  checks['Origin 同源主机放行(端口不参与比对)'] = sameOriginReq.status === 200
  await sameOriginReq.text()

  // 超大载荷: content-length 声明超限的 POST 直接 413, 不进入传输层
  const bigBody = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x'.repeat(10 * 1024 * 1024 + 1) } } })
  const bigPost = await rawRequest(PORT_A, { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekrit-token', Host: '127.0.0.1' }, body: bigBody })
  checks['请求体上限: 超大 POST 被 413'] = bigPost.status === 413

  const strayPath = await rawRequest(PORT_A, { path: '/other', headers: { Authorization: 'Bearer sekrit-token', Host: '127.0.0.1' } })
  checks['路径门禁: 非 /mcp 路径 404'] = strayPath.status === 404
  checks['404 体为普通错误对象(不挪用 -32601)'] = (() => {
    try {
      const body = JSON.parse(strayPath.text)
      return body.error === 'Not found: /other' && !strayPath.text.includes('-32601')
    } catch { return false }
  })()

  async function rpcA(sessionId, body) {
    const res = await fetch(BASE_A, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer sekrit-token',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify(body),
    })
    const sid = res.headers.get('mcp-session-id') ?? sessionId
    const text = await res.text()
    return { sid, status: res.status, text }
  }
  await rpcA(sidA, { jsonrpc: '2.0', method: 'notifications/initialized' })

  const insideDir = resolve(FAKE_CWD, 'sub', 'deeper')
  const runInside = await rpcA(sidA, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: insideDir } } })
  const runInsideInner = runInside.status === 200 ? innerOf(runInside) : { error: 'bad' }
  checks['workspaceRoots: 根下子目录放行(跨平台分隔符)'] = Boolean(runInsideInner.sessionId) && !runInsideInner.error

  const outsideDir = resolve(FAKE_CWD, '..', 'somewhere-else')
  const runOutside = await rpcA(sidA, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: outsideDir } } })
  const runOutsideInner = runOutside.status === 200 ? innerOf(runOutside) : { error: String(runOutside) }
  checks['workspaceRoots: 白名单外目录拒绝'] = String(runOutsideInner.error ?? '').includes('not allowed')

  // 队列侧同样受限, 且在提交时即拒(不入队, 调用方无需轮询才发现)
  const outsideInbox = await rpcA(sidA, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'x', cwd: outsideDir } } })
  checks['task_inbox: 越界 cwd 提交时即拒(不入队)'] = parsePayload(outsideInbox.text).result?.isError === true
    && String(innerOf(outsideInbox).error ?? '').includes('not allowed')

  // 卸载 Phase A, 再起模型回退/门禁两个 phase(每个 phase 独立端口 + 独立假 ctx)
  for (const d of disposers.splice(0)) if (typeof d === 'function') d()
  await new Promise((r) => setTimeout(r, 200))

  /** 起一个独立 phase: 返回调用器(自带 initialize) */
  async function startPhase(port2, ctx2, config) {
    await apply(ctx2, { port: port2, host: '127.0.0.1', ...config })
    await new Promise((r) => setTimeout(r, 200))
    const base = `http://127.0.0.1:${port2}/mcp`
    const post = async (sessionId, body) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
        body: JSON.stringify(body),
      })
      return { sid: res.headers.get('mcp-session-id') ?? sessionId, status: res.status, text: await res.text() }
    }
    const init2 = await post(undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-phase', version: '1.0' } } })
    await post(init2.sid, { jsonrpc: '2.0', method: 'notifications/initialized' })
    let n = 100
    return { sid: init2.sid, call: (toolName, args) => post(init2.sid, { jsonrpc: '2.0', id: n++, method: 'tools/call', params: { name: toolName, arguments: args } }), post: (method, params) => post(init2.sid, { jsonrpc: '2.0', id: n++, method, params }) }
  }

  // ── Phase C: 没有 sessionController(headless 类部署)——目录回退 llm, 覆盖仍可用, select_model 明确报不可用 ──
  const phaseC = await startPhase(8096, makeCtx({ llm: fakeLlm }), {})
  const mlC = innerOf(await phaseC.call('model_list', {}))
  checks['model_list 回退 llm.listProviders/listModels'] = mlC.source === 'llm'
    && mlC.providers?.length === 2 && mlC.providers.find((p) => p.id === 'p1')?.models?.[0]?.id === 'm1'
  checks['model_list 回退口径: 单 provider 失败被隔离'] = mlC.failures?.some((f) => f.id === 'p2')
    && mlC.providers.find((p) => p.id === 'p2')?.models.length === 0
  checks['model_list 回退口径仍报缺省选择'] = mlC.default?.provider === 'p1' && mlC.default?.model === 'm1'

  const overrideNoSc = await phaseC.call('agent_run', { task: 'say ok', cwd: FAKE_CWD, provider: 'p2', model: 'm9' })
  checks['无 sessionController 时按调用覆盖模型仍可用'] = innerOf(overrideNoSc).model?.model === 'm9'

  const selNoSc = innerOf(await phaseC.call('select_model', { sessionId: 'sess-live', provider: 'p2', model: 'm9' }))
  checks['无 sessionController 时 select_model 明确报不可用'] = String(selNoSc.error ?? '').includes('sessionController service unavailable')

  // Phase C 的假 ctx 没有 sessionTitle 服务: rename_session 明确报不可用
  const renameNoSc = innerOf(await phaseC.call('rename_session', { sessionId: 'sess-live', title: 'x' }))
  checks['无 sessionTitle 时 rename_session 明确报不可用'] = String(renameNoSc.error ?? '').includes('sessionTitle service unavailable')

  for (const d of disposers.splice(0)) if (typeof d === 'function') d()
  await new Promise((r) => setTimeout(r, 200))

  // ── Phase D: allowModelOverride:false —— 部署锁死模型, 覆盖被明确拒绝, 不覆盖仍可用 ──
  const phaseD = await startPhase(8095, makeCtx({ sessionController: fakeSessionController, llm: fakeLlm }), { allowModelOverride: false, allowPresetOverride: false })
  const mlD = innerOf(await phaseD.call('model_list', {}))
  checks['allowModelOverride:false 在 model_list 里可见'] = mlD.config?.allowModelOverride === false

  const deniedRun = innerOf(await phaseD.call('agent_run', { task: 'say ok', cwd: FAKE_CWD, provider: 'p2', model: 'm9' }))
  checks['allowModelOverride:false 时按调用选模型被拒'] = String(deniedRun.error ?? '').includes('allowModelOverride')

  const deniedSelResp = await phaseD.call('select_model', { sessionId: 'sess-live', provider: 'p2', model: 'm9' })
  const deniedSel = innerOf(deniedSelResp)
  checks['allowModelOverride:false 时 select_model 被拒'] = String(deniedSel.error ?? '').includes('allowModelOverride')
  checks['被拒结果带 isError 标记(select_model)'] = parsePayload(deniedSelResp.text).result?.isError === true

  const allowedRun = innerOf(await phaseD.call('agent_run', { task: 'say ok', cwd: FAKE_CWD }))
  checks['allowModelOverride:false 不影响不带覆盖的调用'] = Boolean(allowedRun.sessionId) && !allowedRun.error
    && allowedRun.error === undefined // 空 error 字段直接省略(不再是空串)

  // preset 门禁与模型门禁相互独立: 锁 preset 不锁模型, 反之亦然
  const presetGate = await phaseD.call('agent_run', { task: 'x', cwd: FAKE_CWD, preset: 'reviewer' })
  checks['allowPresetOverride:false 门禁(preset 覆盖被拒)'] = parsePayload(presetGate.text).result?.isError === true
    && String(innerOf(presetGate).error ?? '').includes('allowPresetOverride')
  checks['allowPresetOverride:false 不带 preset 仍可用'] = !innerOf(await phaseD.call('agent_run', { task: 'x', cwd: FAKE_CWD })).error

  // ── Phase E: 会话空闲 TTL GC —— 超时无活动的会话被服务端关闭, 旧 sid 得 404, 重新 initialize 即可恢复 ──
  const phaseE = await startPhase(8094, makeCtx({ llm: fakeLlm }), { sessionTtlMs: 400 })
  const inTtl = await phaseE.call('model_list', {})
  checks['TTL: 会话在 TTL 内可用'] = inTtl.status === 200
  // sweeper 间隔 = min(60s, ttl/2) = 200ms; 等 1.3s 确保 400ms 空闲的会话被清扫
  await new Promise((r) => setTimeout(r, 1300))
  const stale = await phaseE.call('echo', { text: 'after-ttl' })
  checks['TTL: 空闲超时会话被关闭(旧 sid 404)'] = stale.status === 404
  const reInit = await fetch('http://127.0.0.1:8094/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-ttl', version: '1.0' } } }),
  })
  checks['TTL: 客户端可重新 initialize 建新会话'] = reInit.status === 200 && Boolean(reInit.headers.get('mcp-session-id'))
  await reInit.text()

  // ── Phase F: taskTimeoutMs 自动超时 —— turn 超时以 hook 原因走官方 cancel, error 注明 timed out ──
  const phaseF = await startPhase(8093, makeCtx({ llm: fakeLlm }), { taskTimeoutMs: 300 })
  const timeoutRun = innerOf(await phaseF.call('agent_run', { task: 'long job', sessionId: 'sess-slow' }))
  checks['taskTimeoutMs: 超时结果 error 注明 timed out'] = String(timeoutRun.error ?? '').includes('timed out after 300ms')
  checks['taskTimeoutMs: 以 hook 原因触发官方 agent.cancel'] = slowLiveAgent.cancelCalls.at(-1)?.kind === 'hook'
    && String(slowLiveAgent.cancelCalls.at(-1)?.reason ?? '').includes('task timeout')
  // 不带超时的正常 agent_run 不受影响(phaseF 默认任务走快 agent)
  const normalRun = innerOf(await phaseF.call('agent_run', { task: 'quick job' }))
  checks['taskTimeoutMs: 不影响正常完成的任务'] = Boolean(normalRun.sessionId) && !normalRun.error

  // ── Phase G: 队列持久化(queuePersistPath) —— 重启后 done 结果仍可取回 / running 标记被打断 / queued 重新执行 ──
  {
    const persistPath = resolve(FAKE_CWD, '.smoke-queue.json')
    try { unlinkSync(persistPath) } catch { /* 首次不存在 */ }
    const ctxG = makeCtx({ llm: fakeLlm })
    const phaseG = await startPhase(8092, ctxG, { queuePersistPath: persistPath })
    const gA = innerOf(await phaseG.call('task_inbox', { task: 'slow A', cwd: slowCwd }))
    const gB = innerOf(await phaseG.call('task_inbox', { task: 'slow B', cwd: slowCwd }))
    const gC = innerOf(await phaseG.call('task_inbox', { task: 'quick', cwd: FAKE_CWD }))
    // 等持久化快照达到目标状态(A running / B queued / C done)——轮询而非固定 sleep;
    // 收敛与否本身也是断言(快照未收敛就重启, 后面的恢复断言会集体失真)
    const snapshotSettled = await waitFor(() => {
      try {
        const items = JSON.parse(readFileSync(persistPath, 'utf8'))
        const byId = new Map<string, any>(items.map((i: any) => [i.id, i] as [string, any]))
        return byId.get(gA.taskId)?.status === 'running'
          && byId.get(gB.taskId)?.status === 'queued'
          && byId.get(gC.taskId)?.status === 'done'
      } catch { return false }
    }, 15000)
    checks['队列持久化: 重启前快照达到目标状态(A/B/C)'] = snapshotSettled
    // 重启: 卸载(关 server + 清内存队列) → 同配置重新 apply(恢复快照)
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 300))
    const phaseG2 = await startPhase(8092, ctxG, { queuePersistPath: persistPath })
    // 恢复与重执行都是异步链, 断言统一轮询(高频 CI/低配机器下, 一次性请求会偶发失真)
    let resC: any = {}
    for (let i = 0; i < 50 && resC.changes !== 'c1'; i++) {
      resC = innerOf(await phaseG2.call('task_result', { taskId: gC.taskId }))
      if (resC.changes !== 'c1') await new Promise((r) => setTimeout(r, 100))
    }
    checks['队列持久化: done 结果重启后仍可取回'] = resC.taskId === gC.taskId && resC.changes === 'c1'
    let resA: any = {}
    for (let i = 0; i < 50 && !String(resA.error ?? '').includes('interrupted'); i++) {
      resA = innerOf(await phaseG2.call('task_result', { taskId: gA.taskId }))
      if (!String(resA.error ?? '').includes('interrupted')) await new Promise((r) => setTimeout(r, 100))
    }
    checks['队列持久化: running 重启后如实标记 interrupted'] = String(resA.error ?? '').includes('"status":"error"')
      && String(resA.error ?? '').includes('interrupted')
    let gBItem
    for (let i = 0; i < 50 && gBItem?.status !== 'running'; i++) {
      const gList: any[] = innerOf(await phaseG2.call('task_list', { status: 'running' }))?.tasks ?? []
      gBItem = gList.find((t) => t.taskId === gB.taskId)
      if (gBItem?.status !== 'running') await new Promise((r) => setTimeout(r, 100))
    }
    checks['队列持久化: queued 重启后重新执行'] = gBItem?.status === 'running'
    const gCancel = innerOf(await phaseG2.call('task_cancel', { taskId: gB.taskId }))
    checks['队列持久化: 重启后的任务可取消'] = gCancel.cancelling === true
    // 原子写的本意是 ".tmp 是瞬态的": 轮询等它消失(写入链在负载下可能慢于任何固定 sleep)
    checks['队列持久化: 无 .tmp 残留(原子写)'] = await waitFor(() => !existsSync(`${persistPath}.tmp`), 5000)
    try { unlinkSync(persistPath) } catch { /* 已清理 */ }
  }

  // ── Phase H: 进度通知 —— agent_run 带 _meta.progressToken 时, SSE 流上应先收到 notifications/progress 心跳 ──
  {
    const ctxH = makeCtx({ llm: fakeLlm })
    const PORT_H = 8091
    await apply(ctxH, { port: PORT_H, host: '127.0.0.1', progressIntervalMs: 300 })
    await new Promise((r) => setTimeout(r, 200))
    const baseH = `http://127.0.0.1:${PORT_H}/mcp`
    const postH = async (sessionId, body) => {
      const res = await fetch(baseH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
        body: JSON.stringify(body),
      })
      return { sid: res.headers.get('mcp-session-id') ?? sessionId, res }
    }
    const initH = await postH(undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-progress', version: '1.0' } } })
    await initH.res.text()
    const sidH = initH.sid
    await postH(sidH, { jsonrpc: '2.0', method: 'notifications/initialized' })

    // 长任务 + progressToken: for-await 增量读 SSE 流, 收集响应前到达的心跳
    const ac = new AbortController()
    const runId = 200
    const res = await fetch(baseH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sidH },
      body: JSON.stringify({ jsonrpc: '2.0', id: runId, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'long job', sessionId: 'sess-slow' }, _meta: { progressToken: 'tok-progress' } } }),
      signal: ac.signal,
    })
    let buf = ''
    const decoderH = new TextDecoder()
    const deadline = Date.now() + 3000
    try {
      for await (const chunk of res.body) {
        buf += decoderH.decode(chunk, { stream: true })
        if (Date.now() > deadline) break
      }
    } catch { /* 下方 abort 导致的流中断 */ }
    await postH(sidH, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: runId } })
    ac.abort()
    const msgs = buf.split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => { try { return JSON.parse(l.slice(6)) } catch { return null } })
      .filter(Boolean)
    const progresses = msgs.filter((m) => m.method === 'notifications/progress' && m.params?.progressToken === 'tok-progress')
    checks['进度通知: turn 期间在 SSE 流上收到 progress 心跳'] = progresses.length >= 2
    checks['进度通知: progress 单调递增且带 message'] = progresses.every((p, i) => i === 0 || p.params.progress > progresses[i - 1].params.progress)
      && progresses.every((p) => typeof p.params.message === 'string' && p.params.message.includes('new events'))
    checks['进度通知: 首个通知即回报已启动(progress=1, 0 事件 turn 0)'] = progresses[0]?.params?.progress === 1
      && String(progresses[0]?.params?.message ?? '').includes('0 new events')
      && String(progresses[0]?.params?.message ?? '').includes('turn 0')
    // 心跳增强: turn 启动后到达的心跳带轮数与最近工具名(而非只有事件数)
    checks['进度通知: 心跳带 turn 轮数'] = progresses.some((p) => String(p.params?.message ?? '').includes('turn 1'))
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Phase I: 并发压力 —— 不同 cwd 并行执行 / 同 cwd 串行复用同一会话 ──
  {
    const ctxI = makeCtx({ llm: fakeLlm })
    const phaseI = await startPhase(8089, ctxI, {})
    const concCwds = [1, 2, 3, 4, 5, 6].map((n) => resolve(FAKE_CWD, `conc-${n}`))
    const concRuns = await Promise.all(concCwds.map((c, i) => phaseI.call('agent_run', { task: `t${i}`, cwd: c })))
    checks['并发: 6 个不同 cwd 的任务全部成功'] = concRuns.every((r) => Boolean(innerOf(r).sessionId))
    const sameCwd = resolve(FAKE_CWD, 'conc-same')
    const sameRuns = await Promise.all([1, 2, 3].map((i) => phaseI.call('agent_run', { task: `s${i}`, cwd: sameCwd })))
    const sameIds = new Set(sameRuns.map((r) => innerOf(r).sessionId))
    checks['并发: 同 cwd 三任务串行复用同一会话'] = sameIds.size === 1 && Boolean([...sameIds][0])
    const listDuring = await phaseI.call('task_list', {})
    checks['并发: 混合查询不受影响'] = listDuring.status === 200
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Phase N: 官方 SDK Client 对接 —— 用参考客户端实现验证握手/工具调用/进度/超时取消全链路 ──
  {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const ctxN = makeCtx({ llm: fakeLlm })
    const PORT_N = 8084
    await apply(ctxN, { port: PORT_N, host: '127.0.0.1', progressIntervalMs: 300 })
    await new Promise((r) => setTimeout(r, 200))
    const client = new Client({ name: 'smoke-sdk-client', version: '1.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT_N}/mcp`))
    await client.connect(transport)

    const { tools } = await client.listTools()
    checks['SDK Client: listTools 返回 17 工具'] = tools.length === 17
    const echoRes = await client.callTool({ name: 'echo', arguments: { text: 'sdk-ping' } })
    checks['SDK Client: echo 往返'] = String(echoRes.content?.[0]?.text ?? '').includes('sdk-ping')

    // 长任务 + onprogress(官方进度回调) + timeout(客户端超时自动发 cancelled → 服务端官方 cancel)
    const progressEvents = []
    const cancelCallsBeforeN = slowLiveAgent.cancelCalls.length
    try {
      await client.callTool(
        { name: 'agent_run', arguments: { task: 'long job', sessionId: 'sess-slow' } },
        undefined,
        { timeout: 3000, onprogress: (p) => progressEvents.push(p) },
      )
    } catch {
      // 客户端超时: SDK 自动发 cancelled 并在本地 reject
    }
    checks['SDK Client: onprogress 收到进度心跳'] = progressEvents.length >= 2
      && progressEvents.every((p) => typeof p.progress === 'number')
    await waitFor(() => slowLiveAgent.cancelCalls.length > cancelCallsBeforeN, 5000) // 等服务端收敛
    checks['SDK Client: 超时触发服务端官方 agent.cancel'] = slowLiveAgent.cancelCalls.length > cancelCallsBeforeN
    await client.close()
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Phase M: 持久化文件损坏 —— 启动必须存活, 队列从空开始 ──
  {
    const badPath = resolve(tmpdir(), 'dsh-carrot-smoke-queue-bad.json')
    writeFileSync(badPath, '{corrupted json', 'utf8')
    const phaseM = await startPhase(8085, makeCtx({ llm: fakeLlm }), { queuePersistPath: badPath })
    const tlM = innerOf(await phaseM.call('task_list', {}))
    checks['持久化文件损坏: 启动存活且队列为空'] = Array.isArray(tlM?.tasks) && tlM.tasks.length === 0
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    try { unlinkSync(badPath) } catch { /* 已清理 */ }
  }

  // ── Phase K: LRU 淘汰跳过活跃会话 —— maxAgents:1 时, 忙会话不被淘汰 dispose, 空闲会话才被逐出 ──
  {
    const ctxK = makeCtx({ llm: fakeLlm })
    const PORT_K = 8087
    await apply(ctxK, { port: PORT_K, host: '127.0.0.1', maxAgents: 1 })
    await new Promise((r) => setTimeout(r, 200))
    const baseK = `http://127.0.0.1:${PORT_K}/mcp`
    const postK = async (sessionId, body) => {
      const res = await fetch(baseK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
        body: JSON.stringify(body),
      })
      return { sid: res.headers.get('mcp-session-id') ?? sessionId, res }
    }
    const initK = await postK(undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-lru', version: '1.0' } } })
    await initK.res.text()
    const sidK = initK.sid
    await postK(sidK, { jsonrpc: '2.0', method: 'notifications/initialized' })

    const cwdA = resolve(FAKE_CWD, 'slow-cwd-evict-A')
    const cwdB = resolve(FAKE_CWD, 'slow-cwd-evict-B')
    const acA = new AbortController()
    const acB = new AbortController()
    const acC = new AbortController()
    const callNoWait = (id, name, args, ac) => {
      const p = fetch(baseK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sidK },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
        signal: ac.signal,
      }).then((r) => r.text()).catch(() => 'aborted')
      return p
    }

    const runA = callNoWait(80, 'agent_run', { task: 'hold A', cwd: cwdA }, acA)
    // 确定性等待: A 的 slow agent 已收到 followup——此刻 A 必已带活跃标记, 淘汰一定跳过它
    await waitFor(() => {
      const a = slowAgents.find((x) => x.session.header.cwd === cwdA)
      return Boolean(a && a.session.snapshotEvents().length > 0)
    }, 5000)
    const runB = callNoWait(81, 'agent_run', { task: 'hold B', cwd: cwdB }, acB) // 触发淘汰: A 忙 → 跳过, 池超限建 B
    await waitFor(() => created.some((c) => c.cwd === cwdB), 5000)
    const idA = created.find((c) => c.cwd === cwdA)?.id
    const idB = created.find((c) => c.cwd === cwdB)?.id
    checks['LRU: 满池时跳过活跃会话(新建不 dispose A)'] = Boolean(idA && idB) && !disposed.includes(idA)

    // 取消 A → 收敛; C 到来时 A 空闲 → 被 LRU 正常淘汰 dispose
    await postK(sidK, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 80 } })
    await waitFor(() => slowAgents.find((x) => x.session.header.cwd === cwdA)?.cancelCalls.length === 1, 5000)
    const runC = callNoWait(82, 'agent_run', { task: 'quick C', cwd: resolve(FAKE_CWD, 'evict-C') }, acC)
    await waitFor(() => disposed.includes(idA), 5000)
    checks['LRU: 空闲会话被正常淘汰 dispose'] = disposed.includes(idA)
    acA.abort()
    acB.abort()
    acC.abort()
    await Promise.allSettled([runA, runB, runC])
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Phase L: 旧宿主 keys() 回退 —— dsh_list_tools 无 schemas() 时退回 keys() ──
  {
    const legacyCtx = makeCtx({ llm: fakeLlm, tools: { keys: () => ['bash', 'read'] } })
    const phaseL = await startPhase(8086, legacyCtx, {})
    const ltLegacy = innerOf(await phaseL.call('dsh_list_tools', {}))
    checks['dsh_list_tools: 旧宿主 keys() 回退'] = Array.isArray(ltLegacy?.tools) && ltLegacy.tools.some((t) => t.name === 'bash' && t.description === '')
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Phase W: workspaceRoots 覆盖会话面 —— 接管/列表/历史按白名单裁剪, 元数据操作仍可达 ──
  {
    const outsideDir = resolve(FAKE_CWD, '..', 'smoke-outside-w')
    const ctxW = makeCtx({
      llm: fakeLlm,
      sessionTitle: fakeSessionTitle,
      extraSessions: [{ id: 'sess-outside', cwd: outsideDir }],
      extraPersisted: [{ id: 'sess-persisted-outside', cwd: outsideDir }],
    })
    const phaseW = await startPhase(8083, ctxW, { workspaceRoots: [FAKE_CWD] })

    // 执行面: cwd 参数给白名单内目录, 但 sessionId 指向白名单外会话 → 拒(live 接管层)
    const runLiveOutside = innerOf(await phaseW.call('agent_run', { task: 'x', cwd: FAKE_CWD, sessionId: 'sess-outside' }))
    checks['白名单: live 接管白名单外会话被拒'] = String(runLiveOutside.error ?? '').includes('not allowed')
      && String(runLiveOutside.error ?? '').includes('sess-outside')
    // resume 层: 拒绝发生在重建 agent 之前(resumed 无记录)
    const runResOutside = innerOf(await phaseW.call('agent_run', { task: 'x', cwd: FAKE_CWD, sessionId: 'sess-persisted-outside' }))
    checks['白名单: resume 白名单外会话被拒(不重建 agent)'] = String(runResOutside.error ?? '').includes('not allowed')
      && !resumed.some((r) => r.id === 'sess-persisted-outside')
    // 白名单内会话接管不受影响(不回归)
    const runInside = innerOf(await phaseW.call('agent_run', { task: 'x', cwd: FAKE_CWD, sessionId: 'sess-live' }))
    checks['白名单: 白名单内会话接管不受影响'] = runInside.sessionId === 'sess-live' && !runInside.error

    // 观测面: session_list 只列白名单内会话
    const slW = innerOf(await phaseW.call('session_list', {}))
    checks['白名单: session_list 只列白名单内会话'] = slW.sessions.some((s) => s.sessionId === 'sess-live')
      && !slW.sessions.some((s) => s.sessionId === 'sess-outside')
      && !slW.sessions.some((s) => s.sessionId === 'sess-persisted-outside')
    const slWOutside = await phaseW.call('session_list', { cwd: outsideDir })
    checks['白名单: session_list 的 cwd 参数越界被拒'] = parsePayload(slWOutside.text).result?.isError === true
      && String(innerOf(slWOutside).error ?? '').includes('not allowed')
    // 内容面: session_history 越界会话不可读, 白名单内照常
    const histWOutside = await phaseW.call('session_history', { sessionId: 'sess-outside' })
    checks['白名单: session_history 越界会话被拒'] = parsePayload(histWOutside.text).result?.isError === true
      && String(innerOf(histWOutside).error ?? '').includes('not allowed')
    // 实时干预面: agent_steer 同一边界(越界会话不可转向)
    const steerWOutside = await phaseW.call('agent_steer', { sessionId: 'sess-outside', message: 'x' })
    checks['白名单: agent_steer 越界会话被拒'] = parsePayload(steerWOutside.text).result?.isError === true
      && String(innerOf(steerWOutside).error ?? '').includes('not allowed')
    // resources 面: 会话清单与纪要同一边界(越界会话不在 list 里, 直接读也报错)
    const resListW = parsePayload((await phaseW.post('resources/list', {})).text).result?.resources ?? []
    const histUrisW = resListW.filter((r) => String(r.uri).startsWith('dsh://sessions/')).map((r) => r.uri)
    checks['白名单: 资源 list 只含白名单内会话的纪要'] = histUrisW.some((u) => u.includes('sess-live'))
      && !histUrisW.some((u) => u.includes('sess-outside'))
    const resHistW = await phaseW.post('resources/read', { uri: 'dsh://sessions/sess-outside/history' })
    checks['白名单: 越界会话纪要 resources/read 被拒'] = String(parsePayload(resHistW.text).error?.message ?? '').includes('not allowed')
    const histWInside = innerOf(await phaseW.call('session_history', { sessionId: 'sess-live' }))
    checks['白名单: session_history 白名单内不受影响'] = Array.isArray(histWInside.turns) && histWInside.turns.length > 0
    // 元数据操作仍可达(边界: 只裁执行与内容读取)
    const renameW = innerOf(await phaseW.call('rename_session', { sessionId: 'sess-outside', title: 'w' }))
    checks['白名单: 元数据操作(rename_session)仍可达'] = renameW.ok === true
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Phase X: 队列持久化加密(queuePersistKey) —— 密文落盘/同 key 恢复/错 key 容忍/legacy 明文迁移 ──
  {
    const encPath = resolve(FAKE_CWD, '.smoke-queue-enc.bin')
    try { unlinkSync(encPath) } catch { /* 首次不存在 */ }
    const ctxX = makeCtx({ llm: fakeLlm })
    const phaseX = await startPhase(8082, ctxX, { queuePersistPath: encPath, queuePersistKey: 'smoke-secret' })
    const xTask = innerOf(await phaseX.call('task_inbox', { task: 'secret payload', cwd: FAKE_CWD }))
    // 等任务完成(密文不可读内容, 以 status 轮询为准), 再等落盘链静默
    for (let i = 0; i < 50; i++) {
      const st = innerOf(await phaseX.call('task_result', { taskId: xTask.taskId, detail: 'status' }))
      if (st.status === 'done') break
      await new Promise((r) => setTimeout(r, 100))
    }
    await new Promise((r) => setTimeout(r, 300))
    const rawX = readFileSync(encPath)
    checks['持久化加密: 落盘为 DSHQ1 密文(不含明文载荷)'] = rawX.subarray(0, 5).toString('utf8') === 'DSHQ1'
      && !rawX.toString('latin1').includes('secret payload')
    // 同 key 重启: 结果连密文一起恢复
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 300))
    const phaseX2 = await startPhase(8082, ctxX, { queuePersistPath: encPath, queuePersistKey: 'smoke-secret' })
    const xRes = innerOf(await phaseX2.call('task_result', { taskId: xTask.taskId }))
    checks['持久化加密: 同 key 重启后结果可取回'] = xRes.taskId === xTask.taskId && xRes.changes === 'c1'
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 300))
    // 错 key: GCM auth 失败按损坏容忍——启动存活, 队列从空开始
    const phaseX3 = await startPhase(8082, ctxX, { queuePersistPath: encPath, queuePersistKey: 'wrong-key' })
    const tlX = innerOf(await phaseX3.call('task_list', {}))
    checks['持久化加密: 错 key 按损坏容忍(启动存活, 队列空)'] = Array.isArray(tlX?.tasks) && tlX.tasks.length === 0
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
    try { unlinkSync(encPath) } catch { /* 已清理 */ }

    // legacy 明文迁移: 配 key 后旧明文文件仍可读, 下次落盘迁移为密文
    const legacyPath = resolve(FAKE_CWD, '.smoke-queue-legacy.json')
    writeFileSync(legacyPath, JSON.stringify([{
      id: 'legacy-task', task: 'legacy job', context: '', cwd: FAKE_CWD, status: 'done',
      createdAt: 1, finishedAt: Date.now(),
      result: { taskId: 'legacy-task', sessionId: 'sess-legacy-run', model: { provider: 'p1', model: 'm1' }, assistantText: '', toolCalls: [], toolResults: [], changes: 'c', verification: 'v', leftovers: 'l', error: '' },
    }]), 'utf8')
    const phaseX4 = await startPhase(8082, ctxX, { queuePersistPath: legacyPath, queuePersistKey: 'smoke-secret' })
    const legacyRes = innerOf(await phaseX4.call('task_result', { taskId: 'legacy-task' }))
    checks['持久化加密: legacy 明文文件配 key 后仍可读'] = legacyRes.taskId === 'legacy-task' && legacyRes.changes === 'c'
    await phaseX4.call('task_list', {}) // 触发一次落盘 → 迁移为密文
    await waitFor(() => { try { return readFileSync(legacyPath).subarray(0, 5).toString('utf8') === 'DSHQ1' } catch { return false } })
    checks['持久化加密: 旧明文文件下次落盘迁移为密文'] = readFileSync(legacyPath).subarray(0, 5).toString('utf8') === 'DSHQ1'
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
    try { unlinkSync(legacyPath) } catch { /* 已清理 */ }
  }

  // ── Phase Y: 初始化窗口取消 + 取消窗口的工具面可见性 —— create 停在闸门上拉长 getAgent 窗口 ──
  {
    const ctxY = makeCtx({ llm: fakeLlm })
    let releaseCreate: () => void = () => {}
    const gate = new Promise<void>((r) => { releaseCreate = r })
    const origCreate = ctxY.agents.create
    ctxY.agents.create = async (args: any) => { await gate; return origCreate(args) }
    const phaseY = await startPhase(8081, ctxY, {})
    const gateCwd = resolve(FAKE_CWD, 'nonexistent-gate')
    const yInbox = innerOf(await phaseY.call('task_inbox', { task: 'cancel during init', cwd: gateCwd }))
    // 等 running(onStart 与 getAgent 同处投递链: 观察到 running 即已进入 getAgent 窗口, 停在闸门上)
    let yRunning = false
    for (let i = 0; i < 50 && !yRunning; i++) {
      const tlY: any[] = innerOf(await phaseY.call('task_list', { status: 'running' }))?.tasks ?? []
      yRunning = tlY.some((t) => t.taskId === yInbox.taskId)
      if (!yRunning) await new Promise((r) => setTimeout(r, 100))
    }
    // 取消监听生命周期: 注册确有发生(执行中挂在调用方 signal 上; 须在取消前查——abort 触发后由 once:true 自摘)
    const yItem = pluginState.taskQueue.get(yInbox.taskId)
    checks['取消监听: 任务执行中挂在调用方 signal 上'] = yItem?.controller !== undefined
      && getEventListeners(yItem.controller.signal, 'abort').length === 1
    // 初始化窗口内取消: cancelling=true、状态保持 running(未过早终态)
    const yCancel = innerOf(await phaseY.call('task_cancel', { taskId: yInbox.taskId }))
    checks['task_cancel: 初始化窗口取消返回 cancelling(未过早终态)'] = yCancel.cancelling === true && yCancel.status === 'running'
    // 取消窗口期内标记必须在工具面可见(task_list 的 outputSchema 不剥字段; 轻量轮询也带)
    const yListW = innerOf(await phaseY.call('task_list', {}))
    checks['task_list: 取消窗口期带 cancelRequested(outputSchema 未过滤)'] = (yListW.tasks ?? []).some((t: any) => t.taskId === yInbox.taskId && t.cancelRequested === true)
    const yStatusW = innerOf(await phaseY.call('task_result', { taskId: yInbox.taskId, detail: 'status' }))
    checks['task_result status: 取消窗口期带 cancelRequested'] = yStatusW.status === 'running' && yStatusW.cancelRequested === true
    // 放行 create: executeTask 在投递前复查取消 → 不投递、零 followup, 终态 cancelled
    releaseCreate()
    let yFinal: any = {}
    for (let i = 0; i < 50 && yFinal.status !== 'cancelled'; i++) {
      const yr = await phaseY.call('task_result', { taskId: yInbox.taskId, detail: 'status' })
      yFinal = yr.status === 200 ? innerOf(yr) : {}
      if (yFinal.status !== 'cancelled') await new Promise((r) => setTimeout(r, 100))
    }
    const createdY = created.filter((c) => c.cwd === gateCwd)
    checks['初始化窗口取消: 会话已建但不投递(零 followup)且终态 cancelled'] = yFinal.status === 'cancelled'
      && createdY.length === 1
      && followups.filter((f) => f.id === createdY[0]?.id).length === 0
    // 收敛后窗口关闭: cancelRequested 标记消失
    const yListF = innerOf(await phaseY.call('task_list', {}))
    checks['task_list: 收敛后 cancelRequested 标记消失'] = (yListF.tasks ?? []).every((t: any) => t.taskId !== yInbox.taskId || t.cancelRequested === undefined)
    // 监听清理(getAgent 抛错路径): 未知 sessionId 的任务初始化失败(无 abort 触发, once 自摘不适用),
    // executeTask 上抛前必须显式摘除监听, 否则残留在队列条目的 controller.signal 上
    const leakInbox = innerOf(await phaseY.call('task_inbox', { task: 'leak probe', sessionId: 'sess-unknown' }))
    let leakStatus: any = {}
    for (let i = 0; i < 50 && !String(leakStatus.error ?? '').includes('"status":"error"'); i++) {
      const lr = await phaseY.call('task_result', { taskId: leakInbox.taskId, detail: 'status' })
      leakStatus = lr.status === 200 ? innerOf(lr) : {}
      if (!String(leakStatus.error ?? '').includes('"status":"error"')) await new Promise((r) => setTimeout(r, 100))
    }
    const leakItem = pluginState.taskQueue.get(leakInbox.taskId)
    checks['取消监听: 初始化失败(getAgent 抛错)后不残留'] = String(leakStatus.error ?? '').includes('session not found for resume')
      && leakItem?.controller !== undefined
      && getEventListeners(leakItem.controller.signal, 'abort').length === 0
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Phase J: GUI 控制面路由 —— status 快照 / stop-start 同源门禁 / 软停启循环 ──
  {
    const { EventEmitter } = await import('node:events')
    const ctxJ = makeCtx({ llm: fakeLlm })
    const gui = ctxJ.__webHandlers
    await apply(ctxJ, { port: 8088, host: '127.0.0.1' })
    const handler = gui.get('gui')
    const callGui = (route, { httpMethod = 'GET', headers = {} } = {}) => {
      const req = new EventEmitter()
      Object.assign(req, { method: httpMethod, url: `/_dsh/dsh-carrot-on-a-stick/${route}`, headers })
      const res = {
        status: 0, headers: {}, body: '',
        writeHead(code, h) { this.status = code; Object.assign(this.headers, h || {}) },
        end(b) { this.body = String(b ?? '') },
      }
      const done = handler(req, res)
      setImmediate(() => req.emit('end')) // 消费 POST body 流(GET 无监听者, no-op)
      return done.then(() => res)
    }
    const st = await callGui('status')
    const stBody = st.status === 200 ? JSON.parse(st.body) : {}
    checks['GUI 路由: status 快照(版本/监听/配置)'] = st.status === 200 && typeof stBody.version === 'string'
      && typeof stBody.listening === 'boolean' && typeof stBody.config?.sessionTtlMs === 'number'
      && stBody.stats?.connections === 0 && Array.isArray(stBody.connections)
    const stopCross = await callGui('stop', { httpMethod: 'POST' })
    checks['GUI 路由: 无同源标识的 stop 被 403(CSRF 门禁)'] = stopCross.status === 403
    const stopOk = await callGui('stop', { httpMethod: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })
    checks['GUI 路由: 同源 stop 成功'] = stopOk.status === 200 && JSON.parse(stopOk.body).stopped === true
    const st2 = await callGui('status')
    checks['GUI 路由: stop 后 listening=false'] = JSON.parse(st2.body).listening === false
    const startOk = await callGui('start', { httpMethod: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })
    checks['GUI 路由: 同源 start 重新监听'] = startOk.status === 200 && JSON.parse(startOk.body).started === true
    const st3 = await callGui('status')
    checks['GUI 路由: start 后 listening=true'] = JSON.parse(st3.body).listening === true
    // 闭环: 重启后的服务必须能真实完成一次 MCP 握手(而不只是标志位翻真)
    const afterStart = await fetch('http://127.0.0.1:8088/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-restart', version: '1.0' } } }),
    })
    checks['GUI start 后真实 HTTP 握手可达'] = afterStart.status === 200 && Boolean(afterStart.headers.get('mcp-session-id'))
    await afterStart.text()
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Phase RF: resourceFirst 部署形态(独立端口独立 ctx)——只读工具下线, 数据走资源面 ──
  // 注意: state 是模块级单例, 本 phase 在所有主流程 phase 之后执行(覆盖 state.config/hooks 不影响前文断言)
  {
    const ctxRF = makeCtx({ sessionController: fakeSessionController, llm: fakeLlm, sessionTitle: fakeSessionTitle })
    await apply(ctxRF, { port: 8096, host: '127.0.0.1', resourceFirst: true })
    await new Promise((r) => setTimeout(r, 200))
    // 此前主流程 phase 已 dispose 掉 8099 的 server, RF 阶段统一打 8096
    const RF_BASE = 'http://127.0.0.1:8096/mcp'
    const initRF = await rpc(undefined, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-rf', version: '1.0' } },
    }, {}, RF_BASE)
    const rfSid = initRF.sid
    const rfInitResult = initRF.status === 200 ? parsePayload(initRF.text).result : undefined
    await rpc(rfSid, { jsonrpc: '2.0', method: 'notifications/initialized' }, {}, RF_BASE)
    const rpcRF = (id: number, body: any) => rpc(rfSid, { jsonrpc: '2.0', id, ...body }, {}, RF_BASE)
    checks['resourceFirst: instructions 指路资源面'] = String(rfInitResult?.instructions ?? '').includes('resource-first')
      && String(rfInitResult?.instructions ?? '').includes('dsh://')
    const rfTools = await rpcRF(2, { method: 'tools/list', params: {} })
    const rfNames: string[] = rfTools.status === 200 ? (parsePayload(rfTools.text).result?.tools ?? []).map((t: any) => t.name) : []
    checks['resourceFirst: 只读工具 9 个下线(剩 7 个动作工具)'] = rfNames.length === 7
      && ['echo', 'agent_run', 'agent_steer', 'task_inbox', 'select_model', 'rename_session', 'attach_session'].every((n) => rfNames.includes(n))
      && !rfNames.includes('task_list') && !rfNames.includes('session_list') && !rfNames.includes('session_history')
      && !rfNames.includes('model_list') && !rfNames.includes('task_result') && !rfNames.includes('dsh_status')
    const rfList = await rpcRF(3, { method: 'resources/list', params: {} })
    const rfUris: string[] = rfList.status === 200 ? (parsePayload(rfList.text).result?.resources ?? []).map((r: any) => r.uri) : []
    checks['resourceFirst: 资源面齐备(数据本体)'] = ['dsh://status', 'dsh://models', 'dsh://presets', 'dsh://sessions', 'dsh://queue', 'dsh://agents', 'dsh://tools']
      .every((u) => rfUris.includes(u))
    // agent_run 默认 detail=uri: 只回引用, 数据经 resource 读取
    const rfRun = await rpcRF(4, { method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-live' } } })
    const rfRunInner = rfRun.status === 200 ? innerOf(rfRun) : { error: 'bad' }
    checks['resourceFirst: agent_run 默认 uri 档(引用 + note, 不注入 payload)'] = rfRunInner.detail === 'uri'
      && rfRunInner.sessionId === 'sess-live' && rfRunInner.resource === 'dsh://sessions/sess-live/history'
      && rfRunInner.changes === undefined && rfRunInner.assistantTail === undefined
      && String(rfRunInner.note ?? '').includes('resource')
    // 显式 detail 仍可拿到内联投影(逃生门)
    const rfRunFull = await rpcRF(5, { method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-live', detail: 'summary' } } })
    checks['resourceFirst: detail=summary 逃生门(内联投影)'] = rfRunFull.status === 200 && innerOf(rfRunFull).changes === 'c1'
    // 数据经资源面: history 资源可读(替代 session_history 工具)
    const rfHist = await rpcRF(6, { method: 'resources/read', params: { uri: 'dsh://sessions/sess-live/history' } })
    const rfHistInner = rfHist.status === 200 ? JSON.parse(parsePayload(rfHist.text).result.contents[0].text) : {}
    checks['resourceFirst: 资源面承接 session_history'] = rfHistInner.sessionId === 'sess-live' && rfHistInner.turns?.length > 0
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Phase P: 纯函数边界(白名单 isWithin / 结构化解析 parseSummary)——安全与解析内核的回归钉 ──
  {
    const root = FAKE_CWD
    const rootChild = resolve(root, 'sub')
    checks['isWithin: 根等于自身'] = isWithin(root, root) === true
    checks['isWithin: 子目录在内'] = isWithin(root, rootChild) === true
    checks['isWithin: 根带尾分隔符仍匹配'] = isWithin(`${root}/`, rootChild) === true
    checks['isWithin: 父目录为根时子目录在内'] = isWithin(resolve(root, '..'), root) === true
    // 前缀陷阱: 根 'ab' 与目录 'a/c' —— startsWith('ab') 会误判, 路径段比对必须为 false
    checks['isWithin: 兄弟前缀陷阱(a/c 不在 ab 内)'] = isWithin(resolve(root, 'ab'), resolve(root, 'a', 'c')) === false
    checks['isWithin: 目录是根的父级 → 不在内'] = isWithin(rootChild, root) === false

    checks['parseSummary: 正常一行 JSON'] = (() => {
      const s = parseSummary('前置说明 {"changes":"c","verification":"v","leftovers":"l"} 结尾')
      return s.changes === 'c' && s.verification === 'v' && s.leftovers === 'l'
    })()
    checks['parseSummary: 多候选取最后一次出现的合法 summary'] = (() => {
      const s = parseSummary('{"changes":"旧","verification":"x","leftovers":"y"} 中间 {"changes":"新","verification":"v2","leftovers":"l2"}')
      return s.changes === '新' && s.verification === 'v2'
    })()
    checks['parseSummary: 中文别名字段可解析'] = (() => {
      const s = parseSummary('{"改动":"改","验证":"验","遗留":"遗"}')
      return s.changes === '改' && s.verification === '验' && s.leftovers === '遗'
    })()
    checks['parseSummary: 无 summary/非 JSON → 空串兜底'] = (() => {
      const s = parseSummary('没有任何 JSON 的普通回答')
      return s.changes === '' && s.verification === '' && s.leftovers === ''
    })()
  }

  const total = Object.keys(checks).length
  const failed = Object.entries(checks).filter(([, ok]) => !ok)
  for (const [checkName, ok] of Object.entries(checks)) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${checkName}`)
  console.log('attach_session 路径记录:', JSON.stringify(attachedIds))
  console.log('mount 记录:', JSON.stringify(mounted))
  console.log(failed.length === 0 ? `SMOKE PASS (${total} 项)` : `SMOKE FAIL (${failed.length}/${total} 项)`)
  for (const d of disposers.splice(0)) if (typeof d === 'function') d()
  await new Promise((r) => setTimeout(r, 100))
  process.exit(failed.length === 0 ? 0 : 1)
} catch (e) {
  console.error('SMOKE ERROR:', e)
  process.exit(1)
}
