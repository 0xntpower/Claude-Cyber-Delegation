import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadLedger, saveLedger, areaForPaths, setPrior,
  recordOutcome, scoreFor, stalenessFor, EMPTY_LEDGER
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
