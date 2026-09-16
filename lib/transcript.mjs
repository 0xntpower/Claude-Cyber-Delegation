import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function collect (node, out) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out)
    return
  }
  if (node.type === 'tool_use' && EDIT_TOOLS.has(node.name)) {
    const input = node.input ?? {}
    const found = input.file_path ?? input.notebook_path
    if (typeof found === 'string' && found.length > 0) out.add(found)
  }
  for (const value of Object.values(node)) collect(value, out)
}

// Paths outside the project root are dropped rather than clamped. A sampled
// transcript carried `file_path` entries under the session scratchpad in
// AppData\Local\Temp, which would otherwise pollute both the git pathspec and
// the risk area derived from it.
function scopePaths (found, projectRoot) {
  const root = resolve(projectRoot)
  const scoped = new Set()
  for (const candidate of found) {
    const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
    const rel = relative(root, abs)
    if (rel.length === 0) continue
    if (rel.startsWith('..')) continue
    if (isAbsolute(rel)) continue
    scoped.add(rel.split(sep).join('/'))
  }
  return [...scoped].sort()
}

// The whole-file read. Reserved for the refusal path, where the list is the
// git pathspec a successor inherits and has to be complete.
export function extractEditedPaths (transcriptPath, projectRoot) {
  if (!transcriptPath || !existsSync(transcriptPath)) return []
  let raw
  try {
    raw = readFileSync(transcriptPath, 'utf8')
  } catch {
    return []
  }
  const found = new Set()
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      collect(JSON.parse(line), found)
    } catch {
      continue
    }
  }
  return scopePaths(found, projectRoot)
}

// The bounded read, over frames the caller already parsed out of the tail.
// Used on ordinary completion, where the only consumer is the ledger's
// per-area success counter and a tail-shaped sample is enough. Measured on
// this machine, the whole-file read costs 236ms on a 38MB transcript and
// 1.67s and 561MB of RSS on a 244MB one, on every subagent that finishes.
// Nothing on the success path is worth that.
export function extractEditedPathsFromFrames (frames, projectRoot) {
  const found = new Set()
  for (const frame of Array.isArray(frames) ? frames : []) collect(frame, found)
  return scopePaths(found, projectRoot)
}
