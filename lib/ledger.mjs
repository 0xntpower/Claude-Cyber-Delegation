import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const EMPTY_LEDGER = { version: 1, areas: {} }

const OPUS5 = /^claude-opus-5/
const DEFAULT_SCORE = 5
const MAX_HISTORY = 100
const LOCK_ATTEMPTS = 50
const LOCK_BACKOFF_MS = 20
const LOCK_STALE_MS = 30000

export function blankArea () {
  return {
    score: DEFAULT_SCORE,
    source: 'unset',
    attempts: 0,
    kills: 0,
    successes: 0,
    byModel: {},
    lastOpus5AttemptAt: null,
    dispatchesSinceOpus5: 0,
    history: []
  }
}

export function loadLedger (path) {
  if (!path || !existsSync(path)) return structuredClone(EMPTY_LEDGER)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    // `typeof null === 'object'`, so the null check is not decoration. Without
    // it a ledger of `{"areas": null}` loads, then every write dereferences
    // null and the throw takes the whole relay down with it.
    if (parsed !== null && typeof parsed === 'object' &&
        typeof parsed.areas === 'object' && parsed.areas !== null) {
      return parsed
    }
    return structuredClone(EMPTY_LEDGER)
  } catch {
    return structuredClone(EMPTY_LEDGER)
  }
}

export function saveLedger (path, ledger) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    // The temp name must be unique per writer. A shared `${path}.tmp` lets two
    // concurrent writers truncate and fill the same file while a third renames
    // it, publishing a half-written ledger.
    const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    writeFileSync(tmp, JSON.stringify(ledger, null, 2))
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

export function areaForPaths (paths) {
  if (!Array.isArray(paths) || paths.length === 0) return null
  const dirs = paths.map(p => {
    const cut = p.lastIndexOf('/')
    return cut === -1 ? '' : p.slice(0, cut)
  })
  let prefix = dirs[0].split('/').filter(Boolean)
  for (const dir of dirs.slice(1)) {
    const parts = dir.split('/').filter(Boolean)
    let i = 0
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i += 1
    prefix = prefix.slice(0, i)
  }
  const common = prefix.join('/')
  if (common.length > 0) return `${common}/**`
  const counts = new Map()
  for (const dir of dirs) {
    const top = dir.split('/').filter(Boolean)[0] ?? ''
    counts.set(top, (counts.get(top) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const best = ranked[0][0]
  return best.length > 0 ? `${best}/**` : '*'
}

function sleepSync (ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch { /* a sleep that cannot happen is not worth failing a hook over */ }
}

// Serialises the ledger read-modify-write across concurrent hook processes,
// using the same atomic `openSync(lock, 'wx')` primitive the baton claim uses.
// Three rules, in priority order: never lose an update, never brick the plugin
// on a lock a dead hook left behind, and never hang a live user session. The
// last one wins ties, so after the retries are spent this proceeds unlocked.
export function withLedgerLock (paths, fn) {
  const lock = join(paths.base, 'ledger.lock')
  let held = false
  try {
    mkdirSync(paths.base, { recursive: true })
  } catch { /* an unwritable base directory is handled by saveLedger */ }
  for (let i = 0; i < LOCK_ATTEMPTS; i += 1) {
    try {
      closeSync(openSync(lock, 'wx'))
      held = true
      break
    } catch { /* contended, stale, or unwritable, all handled below */ }
    let stale = false
    try {
      stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS
    } catch { /* the lock vanished under us, which the next attempt handles */ }
    if (stale) {
      try {
        rmSync(lock, { force: true })
      } catch { /* someone else stole it first */ }
      continue
    }
    sleepSync(LOCK_BACKOFF_MS)
  }
  try {
    return fn()
  } finally {
    if (held) {
      try {
        rmSync(lock, { force: true })
      } catch { /* a lock we cannot remove goes stale and gets stolen */ }
    }
  }
}

function ensureArea (ledger, area) {
  // Defensive: a hand-written or truncated ledger can carry a null or
  // primitive `areas`. Re-initialising beats throwing out of a hook.
  if (ledger.areas === null || typeof ledger.areas !== 'object') ledger.areas = {}
  if (ledger.areas[area] === undefined) ledger.areas[area] = blankArea()
  return ledger.areas[area]
}

export function setPrior (ledger, area, score, source) {
  const entry = ensureArea(ledger, area)
  entry.score = Math.max(1, Math.min(10, score))
  entry.source = source ?? 'prior'
  return ledger
}

export function recordOutcome (ledger, { area, outcome, model, agentType, at }) {
  if (!area) return ledger
  const stamp = at ?? new Date().toISOString()
  const name = model ?? 'unknown'
  const entry = ensureArea(ledger, area)
  if (entry.source === 'unset') entry.source = 'observed'
  entry.attempts += 1
  if (entry.byModel[name] === undefined) {
    entry.byModel[name] = { attempts: 0, kills: 0, successes: 0 }
  }
  entry.byModel[name].attempts += 1
  if (outcome === 'refusal') {
    entry.kills += 1
    entry.byModel[name].kills += 1
    entry.score = Math.min(10, entry.score + 2)
  } else if (outcome === 'normal') {
    entry.successes += 1
    entry.byModel[name].successes += 1
    entry.score = Math.max(1, entry.score - 1)
  }
  if (OPUS5.test(name)) {
    entry.lastOpus5AttemptAt = stamp
    entry.dispatchesSinceOpus5 = 0
  } else {
    entry.dispatchesSinceOpus5 += 1
  }
  entry.history.push({ at: stamp, outcome, model: name, agentType: agentType ?? null })
  if (entry.history.length > MAX_HISTORY) {
    entry.history = entry.history.slice(-MAX_HISTORY)
  }
  return ledger
}

export function scoreFor (ledger, area) {
  const entry = ledger.areas?.[area]
  return entry === undefined ? DEFAULT_SCORE : entry.score
}

export function stalenessFor (ledger, area, config, now = Date.now()) {
  const entry = ledger.areas?.[area]
  if (entry === undefined) return null
  if (entry.score < 9) return null
  const last = entry.lastOpus5AttemptAt
  const days = last === null ? Infinity : (now - Date.parse(last)) / 86400000
  if (entry.dispatchesSinceOpus5 < config.staleAfterDispatches) return null
  if (days < config.staleAfterDays) return null
  return {
    area,
    score: entry.score,
    dispatchesSinceOpus5: entry.dispatchesSinceOpus5,
    daysSinceOpus5: Number.isFinite(days) ? Math.floor(days) : null
  }
}
