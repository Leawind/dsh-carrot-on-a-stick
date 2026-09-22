// Dev-only: 端口冲突时 apply() 必须显式 reject(旧行为是静默成功)
import net from 'node:net'
import { apply } from './lib/index.js'

const ctx = {
  effect: (fn) => fn(),
  // 依赖注入桩: 假 ctx 不是真 cordis(webServer 类可选依赖不出现)
  inject: () => undefined,
  get: () => undefined,
}

const blocker = net.createServer()
blocker.listen(8097, '127.0.0.1', async () => {
  let result
  try {
    await apply(ctx, { port: 8097, host: '127.0.0.1' })
    result = 'BAD: apply resolved'
  } catch (e) {
    result = `OK: apply rejected (${e.message})`
  }
  console.log(result)
  blocker.close()
  process.exit(result.startsWith('OK') ? 0 : 1)
})
