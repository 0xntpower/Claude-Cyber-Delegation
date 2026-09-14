import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function runDir (paths, agentId) {
  return join(paths.runs, agentId)
}

export function writeBaton (paths, agentId, baton) {
  const dir = runDir(paths, agentId)
  const file = join(dir, 'baton.json')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(baton, null, 2))
    return file
  } catch {
    return null
  }
}

export function writeOrigin (paths, agentId, origin) {
  const dir = runDir(paths, agentId)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'origin.json'), JSON.stringify(origin, null, 2))
    return true
  } catch {
    return false
  }
}

export function readOrigin (paths, agentId) {
  const file = join(runDir(paths, agentId), 'origin.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function claimNewestBaton (paths) {
  if (!existsSync(paths.runs)) return null
  let entries
  try {
    entries = readdirSync(paths.runs)
  } catch {
    return null
  }
  const candidates = []
  for (const id of entries) {
    const file = join(paths.runs, id, 'baton.json')
    if (!existsSync(file)) continue
    if (existsSync(join(paths.runs, id, 'claimed.lock'))) continue
    try {
      candidates.push({ id, file, mtime: statSync(file).mtimeMs })
    } catch {
      continue
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  for (const candidate of candidates) {
    const lock = join(paths.runs, candidate.id, 'claimed.lock')
    try {
      closeSync(openSync(lock, 'wx'))
    } catch {
      continue
    }
    try {
      return { runId: candidate.id, baton: JSON.parse(readFileSync(candidate.file, 'utf8')) }
    } catch {
      return null
    }
  }
  return null
}
