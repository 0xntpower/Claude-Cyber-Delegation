import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ccdPaths } from '../lib/paths.mjs'
import {
  loadLedger, saveLedger, areaForPaths, setPrior,
  recordOutcome, scoreFor, stalenessFor, withLedgerLock, EMPTY_LEDGER, blankArea
} from '../lib/ledger.mjs'

const CONFIG = { staleAfterDispatches: 10, staleAfterDays: 30 }

test('loadLedger returns an empty ledger when the file is absent', () => {
  assert.deepEqual(loadLedger('/nope/ledger.json'), EMPTY_LEDGER)
})

test('loadLedger survives a corrupt file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-led-'))
  const f = join(dir, 'l.json')
  writeFileSync(f, 'not json at all')
  assert.deepEqual(loadLedger(f), EMPTY_LEDGER)
})

test('saveLedger then loadLedger round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-led2-'))
  const f = join(dir, 'nested', 'l.json')
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'src/x/**', 7, 'user-hint')
  saveLedger(f, led)
  assert.equal(scoreFor(loadLedger(f), 'src/x/**'), 7)
})

test('areaForPaths uses the longest common directory prefix', () => {
  assert.equal(areaForPaths(['src/inject/a.c', 'src/inject/b.c']), 'src/inject/**')
})

test('areaForPaths falls back to the most common top-level directory', () => {
  assert.equal(areaForPaths(['src/a.c', 'docs/b.md', 'src/c.c']), 'src/**')
})

test('areaForPaths returns null for an empty list', () => {
  assert.equal(areaForPaths([]), null)
})

test('a refusal raises the score by two and caps at ten', () => {
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'a/**', 9, 'model')
  recordOutcome(led, { area: 'a/**', outcome: 'refusal', model: 'claude-opus-4-8' })
  assert.equal(scoreFor(led, 'a/**'), 10)
  recordOutcome(led, { area: 'a/**', outcome: 'refusal', model: 'claude-opus-4-8' })
  assert.equal(scoreFor(led, 'a/**'), 10)
})

test('a success lowers the score by one and floors at one', () => {
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'a/**', 2, 'model')
  recordOutcome(led, { area: 'a/**', outcome: 'normal', model: 'claude-opus-5' })
  assert.equal(scoreFor(led, 'a/**'), 1)
  recordOutcome(led, { area: 'a/**', outcome: 'normal', model: 'claude-opus-5' })
  assert.equal(scoreFor(led, 'a/**'), 1)
})

test('evidence is recorded per model', () => {
  const led = structuredClone(EMPTY_LEDGER)
  recordOutcome(led, { area: 'a/**', outcome: 'refusal', model: 'claude-opus-4-8' })
  recordOutcome(led, { area: 'a/**', outcome: 'normal', model: 'claude-opus-5' })
  const area = led.areas['a/**']
  assert.equal(area.attempts, 2)
  assert.equal(area.kills, 1)
  assert.equal(area.successes, 1)
  assert.equal(area.byModel['claude-opus-4-8'].kills, 1)
  assert.equal(area.byModel['claude-opus-5'].successes, 1)
})

test('an Opus 5 attempt resets the dispatches-since counter', () => {
  const led = structuredClone(EMPTY_LEDGER)
  recordOutcome(led, { area: 'a/**', outcome: 'refusal', model: 'claude-opus-4-6' })
  recordOutcome(led, { area: 'a/**', outcome: 'refusal', model: 'claude-opus-4-6' })
  assert.equal(led.areas['a/**'].dispatchesSinceOpus5, 2)
  recordOutcome(led, { area: 'a/**', outcome: 'normal', model: 'claude-opus-5' })
  assert.equal(led.areas['a/**'].dispatchesSinceOpus5, 0)
  assert.ok(led.areas['a/**'].lastOpus5AttemptAt)
})

test('stalenessFor reports nothing below a score of nine', () => {
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'a/**', 8, 'model')
  assert.equal(stalenessFor(led, 'a/**', CONFIG), null)
})

test('stalenessFor reports when both thresholds are crossed', () => {
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'a/**', 10, 'model')
  led.areas['a/**'].dispatchesSinceOpus5 = 12
  led.areas['a/**'].lastOpus5AttemptAt = new Date(Date.now() - 40 * 86400000).toISOString()
  const stale = stalenessFor(led, 'a/**', CONFIG)
  assert.equal(stale.dispatchesSinceOpus5, 12)
  assert.ok(stale.daysSinceOpus5 >= 39)
})

test('stalenessFor treats never-attempted Opus 5 as infinitely stale', () => {
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'a/**', 10, 'model')
  led.areas['a/**'].dispatchesSinceOpus5 = 15
  const stale = stalenessFor(led, 'a/**', CONFIG)
  assert.equal(stale.daysSinceOpus5, null)
})

test('history is capped at one hundred entries', () => {
  const led = structuredClone(EMPTY_LEDGER)
  for (let i = 0; i < 130; i++) {
    recordOutcome(led, { area: 'a/**', outcome: 'normal', model: 'claude-opus-5' })
  }
  assert.equal(led.areas['a/**'].history.length, 100)
})

// --- C1: a null `areas` must not be mistaken for an object ---

test('loadLedger rejects a ledger whose areas is null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-null-'))
  const f = join(dir, 'l.json')
  writeFileSync(f, '{"version":1,"areas":null}')
  assert.deepEqual(loadLedger(f), EMPTY_LEDGER)
})

test('recordOutcome on a ledger with a null areas does not throw', () => {
  const led = { version: 1, areas: null }
  assert.doesNotThrow(() => {
    recordOutcome(led, { area: 'a/**', outcome: 'refusal', model: 'claude-opus-4-8' })
  })
  assert.equal(led.areas['a/**'].kills, 1)
})

test('setPrior on a ledger with a null areas does not throw', () => {
  const led = { version: 1, areas: null }
  assert.doesNotThrow(() => setPrior(led, 'a/**', 7, 'user-hint'))
  assert.equal(scoreFor(led, 'a/**'), 7)
})

// --- C2: concurrent writers must not lose updates ---

function lockFixture (name) {
  const root = mkdtempSync(join(tmpdir(), name))
  mkdirSync(join(root, '.git'))
  return ccdPaths(root)
}

test('withLedgerLock runs the body and releases the lock', () => {
  const paths = lockFixture('ccd-lock-')
  let ran = false
  withLedgerLock(paths, () => { ran = true })
  assert.equal(ran, true)
  assert.equal(existsSync(join(paths.base, 'ledger.lock')), false)
})

test('withLedgerLock releases the lock even when the body throws', () => {
  const paths = lockFixture('ccd-lock-throw-')
  assert.throws(() => withLedgerLock(paths, () => { throw new Error('boom') }))
  assert.equal(existsSync(join(paths.base, 'ledger.lock')), false)
})

test('a lock older than thirty seconds is stolen rather than waited on', () => {
  const paths = lockFixture('ccd-lock-stale-')
  const lock = join(paths.base, 'ledger.lock')
  mkdirSync(paths.base, { recursive: true })
  writeFileSync(lock, '')
  const ancient = new Date(Date.now() - 120000)
  utimesSync(lock, ancient, ancient)
  const started = Date.now()
  let ran = false
  withLedgerLock(paths, () => { ran = true })
  assert.equal(ran, true)
  assert.ok(Date.now() - started < 500, 'a stale lock must be stolen immediately, not waited out')
  assert.equal(existsSync(lock), false)
})

test('a fresh foreign lock never blocks the hook indefinitely', () => {
  const paths = lockFixture('ccd-lock-busy-')
  const lock = join(paths.base, 'ledger.lock')
  mkdirSync(paths.base, { recursive: true })
  writeFileSync(lock, '')
  let ran = false
  withLedgerLock(paths, () => { ran = true })
  assert.equal(ran, true, 'a lost ledger update beats a hung user session')
  assert.equal(existsSync(lock), true, 'a lock we never held must not be removed')
})

test('six concurrent locked updates all land', async () => {
  const paths = lockFixture('ccd-lock-race-')
  const libUrl = pathToFileURL(resolve('lib/ledger.mjs')).href
  const worker = join(paths.base, 'worker.mjs')
  mkdirSync(paths.base, { recursive: true })
  writeFileSync(worker, [
    `import { withLedgerLock, loadLedger, recordOutcome, saveLedger } from ${JSON.stringify(libUrl)}`,
    'const paths = JSON.parse(process.argv[2])',
    'withLedgerLock(paths, () => {',
    '  const led = loadLedger(paths.ledger)',
    "  recordOutcome(led, { area: 'a/**', outcome: 'refusal', model: 'claude-opus-4-8' })",
    '  saveLedger(paths.ledger, led)',
    '})',
    ''
  ].join('\n'))

  const run = promisify(execFile)
  await Promise.all(
    Array.from({ length: 6 }, () => run(process.execPath, [worker, JSON.stringify(paths)]))
  )

  const led = loadLedger(paths.ledger)
  assert.equal(led.areas['a/**'].attempts, 6)
  assert.equal(led.areas['a/**'].kills, 6)
})

// --- P3: an unattributable kill must not vanish as if it never happened ---

test('a null-area refusal increments unattributed.kills and leaves every area untouched', () => {
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'a/**', 5, 'model')
  recordOutcome(led, { area: null, outcome: 'refusal', model: 'claude-opus-4-8' })
  assert.equal(led.unattributed.kills, 1)
  assert.equal(led.unattributed.attempts, 1)
  assert.equal(led.unattributed.successes, 0)
  // The area that already existed must be completely unaffected.
  assert.equal(led.areas['a/**'].score, 5)
  assert.equal(led.areas['a/**'].attempts, 0)
  assert.equal(led.areas['a/**'].kills, 0)
})

test('per-model tallies are kept for unattributed outcomes too', () => {
  const led = structuredClone(EMPTY_LEDGER)
  recordOutcome(led, { area: null, outcome: 'refusal', model: 'claude-opus-4-8' })
  recordOutcome(led, { area: null, outcome: 'normal', model: 'claude-opus-5' })
  recordOutcome(led, { area: undefined, outcome: 'refusal', model: 'claude-opus-4-8' })
  assert.equal(led.unattributed.attempts, 3)
  assert.equal(led.unattributed.kills, 2)
  assert.equal(led.unattributed.successes, 1)
  assert.equal(led.unattributed.byModel['claude-opus-4-8'].kills, 2)
  assert.equal(led.unattributed.byModel['claude-opus-4-8'].attempts, 2)
  assert.equal(led.unattributed.byModel['claude-opus-5'].successes, 1)
})

test('an old ledger without the unattributed field loads with an empty one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-old-led-'))
  const f = join(dir, 'l.json')
  writeFileSync(f, JSON.stringify({ version: 1, areas: {} }))
  const led = loadLedger(f)
  assert.deepEqual(led.unattributed, { attempts: 0, kills: 0, successes: 0, byModel: {} })
})

test('recordOutcome with a null area does not throw on a ledger missing unattributed', () => {
  const led = { version: 1, areas: {} }
  assert.doesNotThrow(() => {
    recordOutcome(led, { area: null, outcome: 'refusal', model: 'claude-opus-4-8' })
  })
  assert.equal(led.unattributed.kills, 1)
})

// --- P4: a malformed ledger must not silently erase all accumulated evidence ---

test('an unparseable ledger produces a timestamped backup and an empty ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-corrupt-led-'))
  const f = join(dir, 'l.json')
  writeFileSync(f, 'not json at all')
  const led = loadLedger(f)
  assert.deepEqual(led, EMPTY_LEDGER)
  const backups = readdirSync(dir).filter(n => /^risk-ledger\.corrupt-.*\.json$/.test(n))
  assert.equal(backups.length, 1)
})

test('the backup file contains the original unreadable content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-corrupt-led2-'))
  const f = join(dir, 'l.json')
  writeFileSync(f, 'not json at all')
  loadLedger(f)
  const backups = readdirSync(dir).filter(n => /^risk-ledger\.corrupt-.*\.json$/.test(n))
  const contents = readFileSync(join(dir, backups[0]), 'utf8')
  assert.equal(contents, 'not json at all')
})

test('a backup is not created when the file is fine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-fine-led-'))
  const f = join(dir, 'l.json')
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'a/**', 6, 'model')
  saveLedger(f, led)
  loadLedger(f)
  const backups = readdirSync(dir).filter(n => /^risk-ledger\.corrupt-.*\.json$/.test(n))
  assert.equal(backups.length, 0)
})

test('a ledger with a mix of valid and garbage area entries retains only the valid ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-salvage-led-'))
  const f = join(dir, 'l.json')
  const good = blankArea()
  good.score = 8
  good.attempts = 3
  writeFileSync(f, JSON.stringify({
    version: 1,
    areas: {
      'good/**': good,
      'garbage-string/**': 'not an object',
      'garbage-shape/**': { foo: 1 },
      'garbage-null/**': null
    }
  }))
  const led = loadLedger(f)
  assert.equal(led.areas['good/**'].score, 8)
  assert.equal(led.areas['good/**'].attempts, 3)
  assert.equal(led.areas['garbage-string/**'], undefined)
  assert.equal(led.areas['garbage-shape/**'], undefined)
  assert.equal(led.areas['garbage-null/**'], undefined)
})
