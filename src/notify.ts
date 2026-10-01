/**
 * 资源订阅枢纽(notifications/resources/updated + list_changed 的发射端)。
 *
 * 架构事实: 本插件每个 MCP 传输会话各有一个 McpServer 实例(index.ts), 所以"订阅者按连接隔离"
 * 天然成立——订阅登记挂在连接自己的 McpServer 上, 推送只发往登记过的实例。
 * SDK 1.30 只提供 sendResourceUpdated/sendResourceListChanged, 不做订阅者登记, 这里补齐:
 *   updated(uri)          → 立即推给所有订阅了该 URI 的连接(任务完成等状态迁移)
 *   updatedThrottled(uri) → 尾沿节流(活动窗口等高频面; 间隔 = progressIntervalMs)
 *   listChanged()         → 尾沿合并(~100ms)广播给全部连接(清单成员变化)
 * 通知发送失败(连接已关/客户端未开 GET SSE 流)一律静默——推送是尽力而为, 不反压业务路径。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** 订阅枢纽(每次 apply 一个; 生命周期与 HTTP server 一致, dispose 清定时器) */
export interface NotifyHub {
  /** 连接建立(initialize 完成)后登记; 未登记的连接不收任何通知 */
  bind(mcp: McpServer): void
  /** 连接关闭时解除登记(顺带清它的订阅) */
  unbind(mcp: McpServer): void
  /** 该连接订阅了某个资源 URI */
  subscribe(mcp: McpServer, uri: string): void
  unsubscribe(mcp: McpServer, uri: string): void
  /** 立即推送资源更新(状态迁移类: 任务完成/历史翻新) */
  updated(uri: string): void
  /** 尾沿节流推送(高频类: 活动/进度窗口; 间隔取构造参数) */
  updatedThrottled(uri: string): void
  /** 合并广播资源清单变化(任何清单语义变化都汇到这里) */
  listChanged(): void
  /** 观测: 绑定连接数 / 全部连接的订阅总数(GUI 面板与 status 用) */
  stats(): { connections: number; subscriptions: number }
  /** 清空定时器与登记(apply 卸载) */
  dispose(): void
}

/** 沿某连接的 McpServer 发通知(尽力而为: 未连接/已关闭的传输静默失败) */
async function send(mcp: McpServer, method: 'notifications/resources/updated' | 'notifications/resources/list_changed', params?: unknown): Promise<void> {
  try {
    const server = mcp.server
    if (method === 'notifications/resources/updated') {
      await server.sendResourceUpdated(params as { uri: string })
    } else {
      await server.sendResourceListChanged()
    }
  } catch {
    /* 客户端没开 GET SSE 流 / 传输已关: 通知丢弃是 StreamableHTTP 语义内的正常态 */
  }
}

export function createNotifyHub(opts: { activityThrottleMs: number; listChangedCoalesceMs?: number }): NotifyHub {
  const bound = new Set<McpServer>()
  const subs = new Map<McpServer, Set<string>>()
  const activityTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let listChangedTimer: ReturnType<typeof setTimeout> | undefined
  const coalesceMs = Math.max(10, opts.listChangedCoalesceMs ?? 100)
  const throttleMs = Math.max(100, opts.activityThrottleMs)

  const hub: NotifyHub = {
    bind(mcp) {
      bound.add(mcp)
      if (!subs.has(mcp)) subs.set(mcp, new Set())
    },
    unbind(mcp) {
      bound.delete(mcp)
      subs.delete(mcp)
    },
    subscribe(mcp, uri) {
      let set = subs.get(mcp)
      if (!set) {
        set = new Set()
        subs.set(mcp, set)
      }
      set.add(uri)
    },
    unsubscribe(mcp, uri) {
      subs.get(mcp)?.delete(uri)
    },
    updated(uri) {
      for (const [mcp, set] of subs) {
        if (set.has(uri)) void send(mcp, 'notifications/resources/updated', { uri })
      }
    },
    updatedThrottled(uri) {
      // 无人订阅时零开销(no-op), 活动窗口的频繁触发不会积累定时器
      let anySubscribed = false
      for (const set of subs.values()) if (set.has(uri)) { anySubscribed = true; break }
      if (!anySubscribed) return
      // 尾沿节流: 悬空期间多次触发合并为悬空结束后的一次
      if (activityTimers.has(uri)) return
      const timer = setTimeout(() => {
        activityTimers.delete(uri)
        hub.updated(uri)
      }, throttleMs)
      timer.unref?.()
      activityTimers.set(uri, timer)
    },
    listChanged() {
      if (listChangedTimer !== undefined) return
      listChangedTimer = setTimeout(() => {
        listChangedTimer = undefined
        for (const mcp of bound) void send(mcp, 'notifications/resources/list_changed')
      }, coalesceMs)
      listChangedTimer.unref?.()
    },
    stats() {
      let total = 0
      for (const set of subs.values()) total += set.size
      return { connections: bound.size, subscriptions: total }
    },
    dispose() {
      for (const t of activityTimers.values()) clearTimeout(t)
      activityTimers.clear()
      if (listChangedTimer !== undefined) clearTimeout(listChangedTimer)
      listChangedTimer = undefined
      bound.clear()
      subs.clear()
    },
  }
  return hub
}
