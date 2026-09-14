import { existsSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'

const REFUSAL = /"stop_reason"\s*:\s*"refusal"|safeguards flagged|stop_details[^}]{0,80}refusal/i
const RATE_LIMIT = /rate_limit_error|"status"\s*:\s*429|rate limit exceeded/i

export function readTail (path, maxBytes) {
  if (!path || !existsSync(path)) return ''
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    if (len <= 0) return ''
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
  }
}

export function classifyTail (text) {
  const tail = text ?? ''
  if (REFUSAL.test(tail)) return 'refusal'
  if (RATE_LIMIT.test(tail)) return 'rate_limit'
  return 'normal'
}

export function classify ({ transcriptPath, tailBytes = 262144, readTailFn = readTail }) {
  return classifyTail(transcriptPath ? readTailFn(transcriptPath, tailBytes) : '')
}
