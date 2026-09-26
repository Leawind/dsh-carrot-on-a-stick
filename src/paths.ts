/**
 * cwd 规范化与 workspaceRoots 白名单(跨平台)。
 * 白名单是插件的安全边界: 约束 cwd 参数(agent_run/task_inbox)、sessionId 三级接管、
 * session_list/session_history 内容读取(见 README「安全」)。
 */
import { realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { state } from './state.js'

/**
 * cwd realpath 规范化: 解析符号链接与 .. 段, 使 cwd 能与 workspace.path(存储时为 realpath 规范化值)
 * 精确比对——这是官方 attachSession 强校验通过的前提。目录不存在时回退 resolve 结果, 由调用方告警不阻断。
 */
export async function canonicalCwd(raw: string): Promise<string> {
  try {
    return await realpath(raw)
  } catch {
    return resolve(raw)
  }
}

/**
 * 跨平台目录包含判定: 双方 resolve 后统一分隔符为 '/', win32 再做大小写折叠。
 * 修复旧版 `startsWith(root + '/')` 在 Windows(反斜杠路径)下子目录永远不匹配的 bug。
 */
export function isWithin(root: string, dir: string): boolean {
  const fold = (p: string) => {
    let s = resolve(p)
    if (sep !== '/') s = s.split(sep).join('/')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  const r = fold(root)
  const d = fold(dir)
  return d === r || d.startsWith(`${r}/`)
}

/**
 * 会话面白名单校验: 按 sessionId 接管(agent_run/task_inbox)与读取(session_list/session_history)
 * 会话前, 校验会话自身 cwd 在 workspaceRoots 内——否则"cwd 参数给白名单内目录 + sessionId 指向
 * 白名单外会话"就是一条沙箱绕过路径。白名单未配置时直通(零行为变化);
 * header 无 cwd 时无法验证, 按拒绝处理(fail closed)。
 */
export async function sessionCwdRefusal(sessionId: string, cwd: string | undefined): Promise<string | undefined> {
  if (state.config.workspaceRoots.length === 0) return undefined
  if (cwd === undefined) {
    return `session ${sessionId} has no cwd in header; cannot verify workspaceRoots`
  }
  const canonical = await canonicalCwd(cwd)
  if (!state.config.workspaceRoots.some((root) => isWithin(root, canonical))) {
    return `session cwd not allowed (outside workspaceRoots): ${canonical} (session ${sessionId})`
  }
  return undefined
}

/** cwd 规范化(realpath) + 白名单校验(配置了 workspaceRoots 时)。task_inbox 在提交时即调用, 越界任务入队前就失败 */
export async function canonicalizeAllowedCwd(cwd: string): Promise<string> {
  // 规范化 cwd: realpath 解析符号链接与 .. 段, 避免 /a、/a/.、相对路径、符号链接成为不同 Map key
  // 导致重复创建会话/并发冲突; 同时也是与 workspace.path 精确比对的唯一 canon
  const workdir = await canonicalCwd(cwd ? resolve(cwd) : process.cwd())
  // cwd 白名单: 配置了 workspaceRoots 时, 只允许在列出的目录(含子目录)下干活(防路径穿越)
  if (state.config.workspaceRoots.length > 0) {
    const allowed = state.config.workspaceRoots.some((root) => isWithin(root, workdir))
    if (!allowed) {
      throw new Error(`cwd not allowed (outside workspaceRoots): ${workdir}`)
    }
  }
  return workdir
}
