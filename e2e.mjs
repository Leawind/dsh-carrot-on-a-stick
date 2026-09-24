// E2E verification against a REAL dsh host (not shipped; dev-only).
// Zero-token phase: initialize / tools/list / echo / dsh_list_tools / model_list /
// task_list / task_cancel wiring probe / session_list / select_model wiring probe.
// Agent phase (E2E_WITH_AGENT=1): one minimal tool-using agent_run — verifies preset
// mounting (toolCalls non-empty), local userMessage() acceptance, snapshotEvents
// extraction, and the summary contract on a live agent-loop.
//
// Usage: E2E_MCP_URL=http://127.0.0.1:8090/mcp [E2E_WITH_AGENT=1] node e2e.mjs
// E2E_MODEL_LIST=0 skips the read-only model_list leg (it asks the host's model
// adapters for their catalogs, so it can be slow on a cold adapter).
const BASE = process.env.E2E_MCP_URL ?? 'http://127.0.0.1:8090/mcp'
const WITH_AGENT = process.env.E2E_WITH_AGENT === '1'
const CWD = process.env.E2E_CWD ?? process.cwd()
const AGENT_TIMEOUT_MS = Number(process.env.E2E_AGENT_TIMEOUT_MS ?? 180_000)

async function rpc(sessionId, body) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  })
  const sid = res.headers.get('mcp-session-id') ?? sessionId
  const text = await res.text()
  return { sid, status: res.status, text }
}

function parsePayload(text) {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('data: ')) return JSON.parse(t.slice(6))
  }
  return JSON.parse(text)
}

function innerOf(resp) {
  const payload = parsePayload(resp.text)
  if (payload.error) return { error: payload.error.message, raw: payload }
  const r = payload.result
  if (r.isError) return { error: r.content?.[0]?.text ?? 'isError', raw: payload }
  const text = r.content?.[0]?.text
  try { return JSON.parse(text) } catch { return { error: `non-JSON result: ${String(text).slice(0, 200)}`, raw: payload } }
}

const findings = []
function report(name, ok, detail = '') {
  findings.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
function finish() {
  const failed = findings.filter((f) => !f.ok)
  console.log(failed.length === 0 ? (WITH_AGENT ? '\nE2E PASS' : '\nE2E PASS (zero-token phase)') : `\nE2E FAIL (${failed.length} 项)`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

try {
  const init = await rpc(undefined, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0' } },
  })
  report('initialize(MCP 握手)', init.status === 200 && Boolean(init.sid), `server=${parsePayload(init.text).result?.serverInfo?.name ?? '?'}`)
  const sid = init.sid
  await rpc(sid, { jsonrpc: '2.0', method: 'notifications/initialized' })

  const toolsList = await rpc(sid, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const names = parsePayload(toolsList.text).result?.tools?.map((t) => t.name) ?? []
  const expected = ['echo', 'dsh_list_tools', 'model_list', 'agent_run', 'task_inbox', 'task_result', 'task_list', 'task_cancel', 'session_list', 'session_history', 'select_model', 'attach_session', 'rename_session']
  report('tools/list 十三工具齐(含 model_list/select_model/task_*/session_*)', expected.every((n) => names.includes(n)), names.join(','))

  const echo = await rpc(sid, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'e2e-ping' } } })
  report('echo 往返', echo.status === 200 && echo.text.includes('e2e-ping'))

  const listTools = await rpc(sid, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dsh_list_tools', arguments: {} } })
  const lt = innerOf(listTools)
  report('dsh_list_tools 返回数组', Array.isArray(lt), Array.isArray(lt) ? `${lt.length} 个全局工具: ${lt.slice(0, 8).map((t) => t.name).join(',')}${lt.length > 8 ? '…' : ''}` : String(lt.error).slice(0, 120))

  // ── model_list(只读): 真机模型目录 ──
  if (process.env.E2E_MODEL_LIST !== '0') {
    const mlT0 = Date.now()
    const modelList = await rpc(sid, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'model_list', arguments: {} } })
    const ml = innerOf(modelList)
    const secs = ((Date.now() - mlT0) / 1000).toFixed(1)
    const modelCount = (ml.providers ?? []).reduce((n, p) => n + (p.models?.length ?? 0), 0)
    report('model_list 返回目录', !ml.error && Array.isArray(ml.providers), ml.error
      ? String(ml.error).slice(0, 160)
      : `${secs}s source=${ml.source} providers=${ml.providers.length} models=${modelCount} default=${JSON.stringify(ml.default)}`)
    report('model_list 报出可用模型 id', modelCount > 0 || (ml.failures?.length ?? 0) > 0,
      modelCount > 0
        ? (ml.providers.flatMap((p) => (p.models ?? []).map((m) => `${p.id}/${m.id}`)).slice(0, 6).join(', '))
        : `failures=${JSON.stringify(ml.failures ?? []).slice(0, 160)}`)
    report('model_list 报出插件模型配置与覆盖开关', typeof ml.config?.allowModelOverride === 'boolean',
      `config=${JSON.stringify(ml.config ?? null)}`)
  }

  // ── select_model 接线(只读式探针): 用一个不存在的会话 id, 期望宿主拒绝而不是"服务不可用" ──
  const probe = await rpc(sid, {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'select_model', arguments: { sessionId: 'e2e-nonexistent-session', provider: 'x', model: 'y' } },
  })
  const probeInner = innerOf(probe)
  const probeErr = String(probeInner.error ?? '')
  report('select_model 已接上官方 sessionController(不存在会话被拒)', probeInner.ok !== true && probeErr !== ''
    && !probeErr.includes('sessionController service unavailable'),
  probeErr.slice(0, 160))

  // ── 队列/会话查询面(只读) + task_cancel 接线探针 ──
  const taskList = await rpc(sid, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'task_list', arguments: {} } })
  const tl = innerOf(taskList)
  report('task_list 返回数组', Array.isArray(tl), Array.isArray(tl) ? `${tl.length} 个任务` : String(tl.error).slice(0, 120))

  const cancelProbe = await rpc(sid, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'task_cancel', arguments: { taskId: 'e2e-nonexistent-task' } } })
  const cancelPayload = parsePayload(cancelProbe.text).result
  const cancelInner = innerOf(cancelProbe)
  report('task_cancel 未知 taskId 以 isError 拒绝', cancelPayload?.isError === true && String(cancelInner.error ?? '').includes('task not found'),
    String(cancelInner.error ?? '').slice(0, 120))

  const sessionList = await rpc(sid, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'session_list', arguments: { limit: 5 } } })
  const sl = innerOf(sessionList)
  report('session_list 返回清单', !sl.error && Number.isInteger(sl.total) && Array.isArray(sl.sessions),
    sl.error ? String(sl.error).slice(0, 120) : `total=${sl.total} 最新: ${sl.sessions.slice(0, 3).map((s) => String(s.sessionId).slice(0, 8)).join(',')}`)

  const histProbe = await rpc(sid, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'e2e-nonexistent-session' } } })
  const histPayload = parsePayload(histProbe.text).result
  report('session_history 不存在会话以 isError 拒绝', histPayload?.isError === true,
    String(innerOf(histProbe).error ?? '').slice(0, 120))

  if (!WITH_AGENT) {
    console.log('\n(zero-token phase done; set E2E_WITH_AGENT=1 for the live agent_run leg)')
    finish()
  } else {

  // ── agent 阶段: 一次最小的真实任务(一条列目录命令 + 行内 JSON 总结), 带 progressToken 验证心跳 ──
  console.log(`\nagent_run: cwd=${CWD} (timeout ${AGENT_TIMEOUT_MS}ms, progressToken=pt-e2e)`)
  const t0 = Date.now()
  const runPromise = rpc(sid, {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: {
      name: 'agent_run',
      arguments: {
        task: '用一条命令列出当前目录下的文件名(只要文件名, 不要内容), 然后输出总结。',
        cwd: CWD,
        title: 'dsh-carrot-on-a-stick e2e',
      },
      _meta: { progressToken: 'pt-e2e' },
    },
  })
  // agent_run 可能跑几十秒: rpc() 返回的 text 是完整 SSE 体, 进度心跳行就在其中, 最后统一解析
  const timer = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), AGENT_TIMEOUT_MS))
  const run = await Promise.race([runPromise, timer])
  if (run.timeout) {
    report('agent_run 在限时内返回', false, `TIMEOUT after ${AGENT_TIMEOUT_MS}ms(可能卡在审批或模型路由)`)
    finish()
  } else {
  const inner = run.status === 200 ? innerOf(run) : { error: `HTTP ${run.status}` }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  report('agent_run 返回无错误', !inner.error, inner.error ? String(inner.error).slice(0, 200) : `${secs}s`)
  const progressMsgs = run.text.split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => { try { return JSON.parse(l.slice(6)) } catch { return null } })
    .filter((m) => m?.method === 'notifications/progress' && m.params?.progressToken === 'pt-e2e')
  report('progress 心跳在真实任务期间到达', progressMsgs.length >= 1,
    `${progressMsgs.length} 次: ${progressMsgs.slice(-1)[0]?.params?.message ?? '(无)'}`)
  if (!inner.error) {
    report('sessionId 存在', typeof inner.sessionId === 'string' && inner.sessionId.length > 0, String(inner.sessionId).slice(0, 40))
    report('toolCalls 非空(preset 挂载成功)', Array.isArray(inner.toolCalls) && inner.toolCalls.length > 0,
      `calls=${inner.toolCalls?.map((c) => c.name).join(',')}`)
    report('toolResults 非空(事件提取成功)', Array.isArray(inner.toolResults) && inner.toolResults.length > 0)
    report('assistantText 非空', typeof inner.assistantText === 'string' && inner.assistantText.trim().length > 0,
      String(inner.assistantText).slice(0, 100).replace(/\n/g, ' '))
    report('summary 解析(changes/verification)', Boolean(inner.changes || inner.verification),
      `changes="${String(inner.changes).slice(0, 80)}"`)
    const slAfter = innerOf(await rpc(sid, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'session_list', arguments: {} } }))
    report('session_list 包含刚执行的会话(live 归并)', !slAfter.error
      && slAfter.sessions?.some((s) => s.sessionId === inner.sessionId),
      slAfter.error ? String(slAfter.error).slice(0, 120) : `total=${slAfter.total}`)
    const histAfter = innerOf(await rpc(sid, { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: inner.sessionId, limit: 6 } } }))
    report('session_history 读到刚执行的轮次', !histAfter.error
      && Array.isArray(histAfter.turns) && histAfter.turns.length > 0,
      histAfter.error ? String(histAfter.error).slice(0, 120)
        : `turns=${histAfter.turns.length} roles=${histAfter.turns.map((t) => t.role).join(',')}`)
  }
  finish()
  }
  }
} catch (e) {
  console.error('E2E ERROR:', e)
  process.exitCode = 1
}
