/**
 * 进程内可变运行时状态(模块级单例)。
 * 每次 apply 重建 config 并重绑 hooks(不跨次泄漏), 卸载 effect 清空各 Map/Set;
 * 其余模块经同一份 state 对象读写, 避免散落多个模块级可变量。
 */
import { DEFAULTS, type RuntimeConfig } from './config.js'
import type { PooledAgent, TaskItem } from './types.js'

/**
 * apply 绑定的执行/通知钩子(未 apply 前调用 runTaskItem 会得到明确报错; 通知钩子缺省为 no-op,
 * 使数据层/引擎在无 MCP 面的部署形态下零通知开销)。
 * 通知钩子是资源面订阅枢纽(notify.ts)的注入点: 队列/会话/池的变更点在各模块就地调用,
 * hub 未挂载时(no-op)零成本, 挂载后按订阅关系定向推送。
 */
export interface StateHooks {
  /** 队列任务执行器(内部走 engine.executeTask) */
  runTaskItem: (item: TaskItem) => void
  /** 队列持久化钩子(未配置 queuePersistPath 时为 no-op) */
  persistQueue: () => void
  /** 单任务状态/结果变化(dsh://queue/{taskId} 资源更新推送; 任务生命周期各迁移点调用) */
  notifyTaskChanged: (taskId: string) => void
  /** 会话 turn 活动变化(dsh://sessions/{id}/activity; 节流在 hub 侧, 这里直呼即可) */
  notifySessionActivity: (sessionId: string) => void
  /** 会话历史变化(turn 收敛后; dsh://sessions/{id}/history 推送) */
  notifySessionHistory: (sessionId: string) => void
  /** 资源清单变化(sessions/queue/workspaces/agents 的集合或成员语义变化; hub 侧合并后广播) */
  notifyListChanged: () => void
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
    notifyTaskChanged: () => {},
    notifySessionActivity: () => {},
    notifySessionHistory: () => {},
    notifyListChanged: () => {},
  },
}

/**
 * TTL 清理: 删除已完成/失败/已取消且超时的任务, 返回被清掉的 taskId 清单
 * (调用方顺带 notifyListChanged——队列成员变化要广播 list_changed)。
 */
export function sweepExpiredTasks(): string[] {
  const now = Date.now()
  const removed: string[] = []
  for (const [tid, t] of state.taskQueue) {
    if ((t.status === 'done' || t.status === 'error' || t.status === 'cancelled') && t.finishedAt && now - t.finishedAt > state.config.taskTtlMs) {
      state.taskQueue.delete(tid)
      removed.push(tid)
    }
  }
  return removed
}
