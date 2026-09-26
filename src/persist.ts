/**
 * 队列持久化静态加密(可选 queuePersistKey): AES-256-GCM, 口令经 scrypt 派生。
 * 纯函数、无状态; 落盘的原子写(tmp + rename)与恢复编排在 index.ts 的 apply 内。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/** 加密持久化文件的 magic 头: 与 legacy 明文 JSON 文件区分, 也是"未配 key 却读到密文"的判定依据 */
export const PERSIST_MAGIC = 'DSHQ1'

/** 派生密钥: 每次写盘随机 salt, 同一口令不同文件得到不同 key */
function persistKeyOf(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32)
}

/** 明文 JSON → 'DSHQ1' + salt(16B) + iv(12B) + 密文 + auth tag(16B) */
export function encryptQueuePayload(payload: string, passphrase: string): Buffer {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', persistKeyOf(passphrase, salt), iv)
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from(PERSIST_MAGIC, 'utf8'), salt, iv, ciphertext, cipher.getAuthTag()])
}

/** encryptQueuePayload 逆操作; 口令不对/文件被改 → GCM auth 失败抛错(调用方按损坏容忍处理) */
export function decryptQueuePayload(blob: Buffer, passphrase: string): string {
  const salt = blob.subarray(PERSIST_MAGIC.length, PERSIST_MAGIC.length + 16)
  const iv = blob.subarray(PERSIST_MAGIC.length + 16, PERSIST_MAGIC.length + 28)
  const tag = blob.subarray(blob.length - 16)
  const ciphertext = blob.subarray(PERSIST_MAGIC.length + 28, blob.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', persistKeyOf(passphrase, salt), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
