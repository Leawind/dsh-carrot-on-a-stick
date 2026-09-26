/**
 * 进程内可变运行时状态(模块级单例)。
 * 每次 apply 重建 config 并重绑 hooks(不跨次泄漏), 卸载 effect 清空各 Map/Set;
 * 其余模块经同一份 state 对象读写, 避免散落多个模块级可变量。
 */
import { DEFAULTS, type RuntimeConfig } from './config.js'
import type { PooledAgent, TaskItem } from './types.js'

/** apply 绑定的执行钩子(未 apply 前调用 task_inbox 会得到明确报错) */
export interface StateHooks {
  /** 队列任务执行器(内部走 engine.executeTask) */
  runTaskItem: (item: TaskItem) => void
  /** 队列持久化钩子(未配置 queuePersistPath 时为 no-op) */
  persistQueue: () => void
}

/** 进程内可变运行时状态(每次 apply 重建 config 并重绑 hooks, 卸载 effect 清空集合) */
interface RuntimeState {
  config: RuntimeConfig
  liveAgents: Map<string, PooledAgent>
  sessionToPoolKey: Map<string, string>
  agentLocks: Map<string, Promise<unknown>>
  activeTurnSessions: Set<string>
  taskQueue: Map<string, TaskItem>
  hooks: StateHooks
}

export const state: RuntimeState = {
  config: { ...DEFAULTS },
  liveAgents: new Map(),
  sessionToPoolKey: new Map(),
  agentLocks: new Map(),
  activeTurnSessions: new Set(),
  taskQueue: new Map(),
  hooks: {
    runTaskItem: () => { throw new Error('dsh-carrot-on-a-stick not applied') },
    persistQueue: () => {},
  },
}

/** TTL 清理: 删除已完成/失败/已取消且超时的任务(task_inbox/task_list 入口顺带调用) */
export function sweepExpiredTasks(): void {
  const now = Date.now()
  for (const [tid, t] of state.taskQueue) {
    if ((t.status === 'done' || t.status === 'error' || t.status === 'cancelled') && t.finishedAt && now - t.finishedAt > state.config.taskTtlMs) {
      state.taskQueue.delete(tid)
    }
  }
}
