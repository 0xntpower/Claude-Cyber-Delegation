import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function blankUnattributed () {
  return { attempts: 0, kills: 0, successes: 0, byModel: {} }
}

export const EMPTY_LEDGER = { version: 1, areas: {}, unattributed: blankUnattributed() }

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

// Structural check for one area record, deliberately shaped after
// `blankArea()`'s numeric and container fields. A hand-corrupted or
// partially-written entry fails this and gets dropped rather than silently
// producing NaN scores or crashing a later write.
function isValidAreaRecord (entry) {
  return entry !== null && typeof entry === 'object' &&
    typeof entry.score === 'number' &&
    typeof entry.attempts === 'number' &&
    typeof entry.kills === 'number' &&
    typeof entry.successes === 'number' &&
    entry.byModel !== null && typeof entry.byModel === 'object' &&
    Array.isArray(entry.history)
}

// Fills in any optional field a valid-but-older record might be missing
// (source, lastOpus5AttemptAt, dispatchesSinceOpus5), without touching the
// fields that made the record pass validation in the first place.
function salvageArea (entry) {
  return isValidAreaRecord(entry) ? { ...blankArea(), ...entry } : null
}

// One bad entry must not cost every other area its accumulated evidence.
// Keeps whatever is structurally sound and drops only the rest.
function salvageAreas (areas) {
  const result = {}
  if (areas === null || typeof areas !== 'object' || Array.isArray(areas)) return result
  for (const [key, value] of Object.entries(areas)) {
    const salvaged = salvageArea(value)
    if (salvaged !== null) result[key] = salvaged
  }
  return result
}

function isValidUnattributed (u) {
  return u !== null && typeof u === 'object' && !Array.isArray(u) &&
    typeof u.attempts === 'number' && typeof u.kills === 'number' &&
    typeof u.successes === 'number' &&
    u.byModel !== null && typeof u.byModel === 'object' && !Array.isArray(u.byModel)
}

// A colon in the timestamp is illegal in a Windows filename, so it cannot
// simply be the raw ISO string.
function fsSafeTimestamp (date = new Date()) {
  return date.toISOString().replace(/:/g, '-')
}

// The backup is the only remedy when the file does not parse at all, so it
// must survive every reason writeFileSync could fail: it is best-effort, and
// losing it must not turn into losing loadLedger's never-throw guarantee too.
function backupCorruptLedger (path, raw) {
  try {
    const backupPath = join(dirname(path), `risk-ledger.corrupt-${fsSafeTimestamp()}.json`)
    writeFileSync(backupPath, raw)
  } catch { /* best-effort: the empty ledger fallback still proceeds */ }
}

// `skipBackup` exists for a read-only caller such as `/ccd-status`. Everyone
// else wants the backup: it is the only recovery path for a ledger that
// fails to parse or has a malformed `areas` shape, so both branches below
// call it unless the caller explicitly opted out.
export function loadLedger (path, opts = {}) {
  const skipBackup = opts.skipBackup === true
  if (!path || !existsSync(path)) return structuredClone(EMPTY_LEDGER)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return structuredClone(EMPTY_LEDGER)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Unparseable JSON carries no recoverable structure. The backup is the
    // only remedy, and an empty ledger is the correct fallback.
    if (!skipBackup) backupCorruptLedger(path, raw)
    return structuredClone(EMPTY_LEDGER)
  }
  // `typeof null === 'object'`, so the null check is not decoration. Without
  // it a ledger of `{"areas": null}` loads, then every write dereferences
  // null and the throw takes the whole relay down with it. This is a
  // structurally unusable ledger exactly like the unparseable case above, so
  // it gets the same backup-then-fallback treatment rather than a silent
  // reset that discards whatever evidence the file held.
  if (parsed === null || typeof parsed !== 'object' ||
      parsed.areas === null || typeof parsed.areas !== 'object' || Array.isArray(parsed.areas)) {
    if (!skipBackup) backupCorruptLedger(path, raw)
    return structuredClone(EMPTY_LEDGER)
  }
  return {
    version: typeof parsed.version === 'number' ? parsed.version : EMPTY_LEDGER.version,
    areas: salvageAreas(parsed.areas),
    unattributed: isValidUnattributed(parsed.unattributed) ? parsed.unattributed : blankUnattributed()
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

function ensureUnattributed (ledger) {
  // Same defensiveness as `ensureArea`: an old or hand-written ledger may be
  // missing this field entirely, or carry it in the wrong shape.
  if (ledger.unattributed === null || typeof ledger.unattributed !== 'object') {
    ledger.unattributed = blankUnattributed()
  }
  return ledger.unattributed
}

export function setPrior (ledger, area, score, source) {
  const entry = ensureArea(ledger, area)
  entry.score = Math.max(1, Math.min(10, score))
  entry.source = source ?? 'prior'
  return ledger
}

export function recordOutcome (ledger, { area, outcome, model, agentType, category, at }) {
  const name = model ?? 'unknown'

  // Roughly four kills in five leave no touched path at all: two die reading
  // the brief, two are reviewers that never write. That evidence is real and
  // genuinely unattributable to any one area, but it must not vanish as if
  // the kill never happened, so it goes to a dedicated bucket instead of
  // being silently dropped. It never touches an area's score, because it
  // cannot be attributed to one.
  if (!area) {
    const unattributed = ensureUnattributed(ledger)
    unattributed.attempts += 1
    if (unattributed.byModel[name] === undefined) {
      unattributed.byModel[name] = { attempts: 0, kills: 0, successes: 0 }
    }
    unattributed.byModel[name].attempts += 1
    if (outcome === 'refusal') {
      unattributed.kills += 1
      unattributed.byModel[name].kills += 1
    } else if (outcome === 'normal') {
      unattributed.successes += 1
      unattributed.byModel[name].successes += 1
    }
    return ledger
  }

  const stamp = at ?? new Date().toISOString()
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
  entry.history.push({ at: stamp, outcome, model: name, agentType: agentType ?? null, category: category ?? null })
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
