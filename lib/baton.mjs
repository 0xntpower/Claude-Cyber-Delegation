import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const NEXT_CLAIM = 'next-claim'

function safeRunId (runId) {
  if (typeof runId !== 'string') return null
  const trimmed = runId.trim()
  if (trimmed.length === 0 || trimmed.length > 200) return null
  if (trimmed === '.' || trimmed === '..') return null
  if (/[\\/]/.test(trimmed)) return null
  return trimmed
}

// A baton that fails to parse must not brick its run forever with no trace.
// Renaming it out of the way both preserves the evidence for the operator and
// makes the run directory stop looking like it has a claimable baton, so a
// later fallback scan skips it cleanly instead of tripping over it again.
function quarantine (file) {
  try {
    renameSync(file, join(dirname(file), 'baton.corrupt.json'))
  } catch { /* the lock already taken is what actually prevents a retry loop */ }
}

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

// Targeted claim. `claimNewestBaton` is a guess that goes wrong the moment two
// refusals overlap: the successor dispatched for run A gets run B's transcript
// and run B's diff, and in a shared working tree it then edits the wrong files
// with confidence. The run id cannot ride in on the SubagentStart payload, so
// the orchestrator leaves it in a pointer file instead.
export function claimBatonById (paths, runId) {
  const id = safeRunId(runId)
  if (id === null) return null
  const file = join(paths.runs, id, 'baton.json')
  if (!existsSync(file)) return null
  const lock = join(paths.runs, id, 'claimed.lock')
  try {
    closeSync(openSync(lock, 'wx'))
  } catch {
    return null
  }
  try {
    return { runId: id, baton: JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    quarantine(file)
    return null
  }
}

export function writeNextClaim (paths, runId) {
  const id = safeRunId(runId)
  if (id === null) return false
  try {
    mkdirSync(paths.base, { recursive: true })
    writeFileSync(join(paths.base, NEXT_CLAIM), id)
    return true
  } catch {
    return false
  }
}

export function readNextClaim (paths) {
  const file = join(paths.base, NEXT_CLAIM)
  if (!existsSync(file)) return null
  try {
    return safeRunId(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function clearNextClaim (paths) {
  try {
    rmSync(join(paths.base, NEXT_CLAIM), { force: true })
    return true
  } catch {
    return false
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
      // A corrupt newest baton must not orphan every older one behind it.
      // The lock taken above already keeps this run from being retried, so
      // quarantine the evidence and fall through to the next candidate.
      quarantine(candidate.file)
      continue
    }
  }
  return null
}
