// Dev-only: dump a dsh session log (zstd jsonl) to readable text.
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const p = process.argv[2]
const out = process.argv[3] ?? 'session-dump.txt'
const buf = zstdDecompressSync(readFileSync(p))
const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim())
const rendered = lines.map((line) => {
  try {
    const e = JSON.parse(line)
    const d = e.data === undefined ? '' : JSON.stringify(e.data).slice(0, 500)
    return `${e.seq ?? '-'}\t${e.type}\t${d}`
  } catch {
    return `RAW\t${line.slice(0, 500)}`
  }
})
writeFileSync(out, rendered.join('\n'), 'utf8')
console.log(`${lines.length} events -> ${out}`)
