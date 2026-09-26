/**
 * 结果投影: token 预算。
 * 本插件的存在意义是省 operator(调用方)的上下文: 内部 TaskResult 始终全量(队列与 sessionId 续接
 * 不丢信息), 只在返回前按 detail 级别投影。各级字段上限的总和控制在预算内:
 *   summary(默认) ≤ ~3k 字符 ≈ 数百 token: 三行总结 + 回答尾部 + 工具名列表 + 错误
 *   normal       ≤ ~9k 字符: 上述 + 截断的工具调用参数与结果
 *   full         旧版行为(assistantText 8k / 50×2k / 20×2k), 仅排查时用
 */
import type { DetailLevel, ModelSelectionOverride, TaskResult } from './types.js'

/** 从 agent 最终回答里解析 changes/verification/leftovers(从后往前找候选, 更可靠) */
export function parseSummary(assistantText: string): { changes: string; verification: string; leftovers: string } {
  const empty = { changes: '', verification: '', leftovers: '' }
  // 收集所有 {...} 候选(agent 被要求输出一行 summary JSON)
  const candidates: string[] = []
  const re = /\{[\s\S]*?\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(assistantText)) !== null) {
    candidates.push(m[0])
  }
  // 从后往前: 最后出现的候选最可能是最终 summary, 逐个尝试解析
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i] as string) as Record<string, unknown>
      const s = (v: unknown) => (typeof v === 'string' ? v : '')
      const changes = s(obj.changes) || s(obj.改动)
      const verification = s(obj.verification) || s(obj.验证)
      const leftovers = s(obj.leftovers) || s(obj.遗留) || s(obj.leftover)
      // 只要含任一 summary 字段就采纳, 否则继续尝试更早的候选
      if (changes || verification || leftovers) {
        return { changes, verification, leftovers }
      }
    } catch {
      // 非合法 JSON, 继续尝试下一个候选
    }
  }
  return empty
}

/** 各级别字段上限(字符) */
const DETAIL_CAPS: Record<DetailLevel, {
  summaryField: number
  error: number
  assistantTail: number
  toolCalls: number
  toolCallArgs: number
  toolResults: number
  toolResultChars: number
  assistantText: number
}> = {
  summary: { summaryField: 300, error: 300, assistantTail: 1200, toolCalls: 0, toolCallArgs: 0, toolResults: 0, toolResultChars: 0, assistantText: 0 },
  normal: { summaryField: 400, error: 600, assistantTail: 1200, toolCalls: 15, toolCallArgs: 250, toolResults: 6, toolResultChars: 400, assistantText: 0 },
  full: { summaryField: 2000, error: 2000, assistantTail: 0, toolCalls: 50, toolCallArgs: 2000, toolResults: 20, toolResultChars: 2000, assistantText: 8000 },
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

export const DETAIL_ARG = {
  summary: 'summary(默认): 三行总结 + 回答尾部 + 工具名列表, ~数百 token',
  normal: 'normal: 加上截断的工具调用参数与结果(~2k token)',
  full: 'full: 完整原文(最坏数万 token, 仅排查用)',
} as const

/** 结果里的模型回报: 只保留有值的字段(接管别人建的会话、读不到 options 时为空对象) */
export function projectModel(selection: ModelSelectionOverride | undefined): Record<string, string> {
  const o: Record<string, string> = {}
  if (selection?.provider) o.provider = selection.provider
  if (selection?.model) o.model = selection.model
  if (selection?.reasoningEffort) o.reasoningEffort = selection.reasoningEffort
  return o
}

/** 读时投影: 把全量 TaskResult 渲染成对应 detail 级别的返回载荷(空 error/taskId 直接省略字段) */
export function renderResult(result: TaskResult, detail: DetailLevel): Record<string, unknown> {
  const caps = DETAIL_CAPS[detail]
  const base = {
    detail,
    ...(result.taskId ? { taskId: result.taskId } : {}),
    sessionId: result.sessionId,
    model: projectModel(result.model),
    ...(result.preset ? { preset: result.preset } : {}),
    durationMs: result.durationMs,
    ...(result.usage ? { usage: result.usage } : {}),
    toolCallCount: result.toolCalls.length,
    toolResultCount: result.toolResults.length,
    ...(result.error ? { error: clip(result.error, caps.error) } : {}),
    changes: clip(result.changes, caps.summaryField),
    verification: clip(result.verification, caps.summaryField),
    leftovers: clip(result.leftovers, caps.summaryField),
  }
  if (detail === 'summary') {
    // 总结 JSON 在回答末尾, 尾部最有信息量; 工具只报名字不报参数
    return {
      ...base,
      assistantTail: result.assistantText.slice(-caps.assistantTail),
      toolCallNames: result.toolCalls.map((c) => c.name),
    }
  }
  if (detail === 'normal') {
    return {
      ...base,
      assistantTail: result.assistantText.slice(-caps.assistantTail),
      toolCalls: result.toolCalls.slice(0, caps.toolCalls).map((c) => ({ name: c.name, args: clip(c.args, caps.toolCallArgs) })),
      toolResults: result.toolResults.slice(0, caps.toolResults).map((r) => clip(r, caps.toolResultChars)),
    }
  }
  return {
    ...base,
    assistantText: result.assistantText.slice(0, caps.assistantText),
    toolCalls: result.toolCalls.slice(0, caps.toolCalls).map((c) => ({ name: c.name, args: clip(c.args, caps.toolCallArgs) })),
    toolResults: result.toolResults.slice(0, caps.toolResults).map((r) => clip(r, caps.toolResultChars)),
  }
}

/** 递归收集事件数据里的文本(text/content 字段; 数组与嵌套对象都走)。acc 为累积缓冲(缺省新建) */
export function extractTexts(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) { value.forEach((x) => extractTexts(x, acc)); return acc }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (typeof rec.text === 'string' && rec.text.trim()) acc.push(rec.text)
    if (typeof rec.content === 'string' && rec.content.trim()) acc.push(rec.content)
    for (const v of Object.values(rec)) extractTexts(v, acc)
  }
  return acc
}

export type HistoryRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'turn_end'

/**
 * 会话事件 → 轮次纪要(从 newest 往回取 limit 条, 返回时按时间正序排列)。
 * beforeIndex: 只考虑序号小于该值的事件——配合上次结果的最早 index 实现向更早翻页。
 * roles: 只保留命中类型的轮次, limit 按过滤后的条数计数; 缺省 = 全部类型。
 * 事件形状与 executeTask 的解析一致: assistant/message, user/message, tool/call, tool/result, turn/end。
 * 长文本按角色截断, 防止整段历史灌穿调用方上下文。
 */
export function historyTurnsOf(events: readonly unknown[], limit: number, beforeIndex?: number, roles?: readonly HistoryRole[]): Record<string, unknown>[] {
  const want = roles ? new Set<string>(roles) : undefined
  const turns: Record<string, unknown>[] = []
  const start = Math.min(beforeIndex ?? events.length, events.length)
  for (let i = start - 1; i >= 0 && turns.length < limit; i--) {
    const ev = events[i] as { type?: string; data?: unknown } | undefined
    if (ev?.type === 'assistant/message') {
      if (want && !want.has('assistant')) continue
      const d = ev.data as { message?: { content?: { type?: string; text?: string }[] } } | undefined
      const text = (d?.message?.content ?? []).filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n')
      if (text.trim()) turns.unshift({ index: i, role: 'assistant', text: clip(text, 600) })
    } else if (ev?.type === 'user/message') {
      if (want && !want.has('user')) continue
      turns.unshift({ index: i, role: 'user', text: clip(extractTexts(ev.data).join('\n'), 200) })
    } else if (ev?.type === 'tool/call') {
      if (want && !want.has('tool_call')) continue
      const d = ev.data as { name?: string; arguments?: string; input?: unknown } | undefined
      turns.unshift({ index: i, role: 'tool_call', name: d?.name ?? '?', args: clip(String(d?.arguments ?? JSON.stringify(d?.input ?? null) ?? ''), 200) })
    } else if (ev?.type === 'tool/result') {
      if (want && !want.has('tool_result')) continue
      const texts = extractTexts(ev.data ?? ev).join('\n')
      if (texts.trim()) turns.unshift({ index: i, role: 'tool_result', text: clip(texts, 300) })
    } else if (ev?.type === 'turn/end') {
      if (want && !want.has('turn_end')) continue
      const d = ev.data as { turn?: number; reason?: { kind?: string } } | undefined
      turns.unshift({ index: i, role: 'turn_end', kind: d?.reason?.kind ?? '?' })
    }
  }
  return turns
}
