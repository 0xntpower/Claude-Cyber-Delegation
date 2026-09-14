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
