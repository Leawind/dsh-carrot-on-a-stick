/**
 * 跨模块共享的纯数据类型(无行为、无宿主服务依赖)。
 */
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 一次模型选择: provider+model 必成对; reasoningEffort 可选 */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 调用方单次调用的模型覆盖(三项都可选; 只给一边时由插件 config / 宿主默认补另一边) */
export type ModelSelectionOverride = Partial<ModelSelection>

/** 池中常驻 agent 的记录: 记下 cwd/模型选择/preset, 供 sessionId 续接与"改模型后重新入池"复用 */
export interface PooledAgent {
  sessionId: SessionId
  handle: AgentHandle
  /** realpath 规范化后的 cwd(池 key 的第一段) */
  cwd: string
  /** 建这个会话时用的模型选择(结果回报与 re-key 用) */
  selection: ModelSelection
  /** 建这个会话时挂载的 preset(结果回报与池 key 用; 接管会话沿用创建时的 preset) */
  preset: string
}

/** 结构化任务结果 */
export interface TaskResult {
  taskId: string
  sessionId: string
  /** 本次执行实际用的模型选择(接管会话读不到 options 时字段为空; 让调用方知道是谁答的) */
  model: ModelSelection
  /** 本次实际挂载的 preset(接管 live 会话无从得知时为空, 投影时省略) */
  preset: string
  /** turn 执行墙钟时长 ms(followup 投递 → whenIdle 收敛; 调用方做成本判断用) */
  durationMs: number
  /** token 用量(机会式聚合 assistant/message 事件里的 message.usage; 宿主未提供时省略) */
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number }
  assistantText: string
  toolCalls: { name: string; args: string }[]
  toolResults: string[]
  changes: string
  verification: string
  leftovers: string
  /**
   * 失败透出: turn/end 的非 completed 收场(LlmError / 取消 / blocked / max-tokens 等)。
   * E2E 实测教训: 模型调用失败时没有 assistant 输出, 不透出错误的话调用方只拿到一份"成功"的空结果。
   */
  error: string
}

/** 结果详略级别 */
export type DetailLevel = 'summary' | 'normal' | 'full'

/** 异步任务队列条目(进程内存; 取消用 task_cancel 或 abort controller) */
export interface TaskItem {
  id: string
  task: string
  context: string
  cwd: string
  sessionId?: string
  title?: string
  /** 单次调用的模型覆盖(入队后异步执行时才解析成完整选择) */
  provider?: string
  model?: string
  reasoningEffort?: string
  /** 单次调用的 preset 覆盖(仅对新建会话生效; 接管已有会话沿用其原 preset) */
  preset?: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  /** 取消句柄: task_cancel 触发 abort → executeTask 走官方 agent.cancel */
  controller?: AbortController
  result?: TaskResult
  error?: string
  createdAt: number
  finishedAt?: number
}
