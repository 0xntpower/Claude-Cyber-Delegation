import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { applyPrior, USAGE } from '../scripts/set-prior.mjs'
import { ccdPaths } from '../lib/paths.mjs'
import { loadLedger, scoreFor } from '../lib/ledger.mjs'

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'set-prior.mjs')

function fixture (name) {
  const root = mkdtempSync(join(tmpdir(), name))
  mkdirSync(join(root, '.git'))
  return root
}

test('a valid area and score are written to the ledger', () => {
  const root = fixture('ccd-prior-')
  const result = applyPrior(root, 'src/inject/**', '8')
  assert.equal(result.ok, true)
  assert.equal(result.score, 8)
  const ledger = loadLedger(ccdPaths(root).ledger)
  assert.equal(scoreFor(ledger, 'src/inject/**'), 8)
  assert.equal(ledger.areas['src/inject/**'].source, 'user-hint')
})

test('a missing area is a usage error and writes nothing', () => {
  const root = fixture('ccd-prior-noarea-')
  const result = applyPrior(root, undefined, '8')
  assert.equal(result.ok, false)
  assert.equal(result.message, USAGE)
  assert.deepEqual(loadLedger(ccdPaths(root).ledger).areas, {})
})

test('a blank area is a usage error', () => {
  const root = fixture('ccd-prior-blank-')
  assert.equal(applyPrior(root, '   ', '8').ok, false)
})

test('a missing score is rejected', () => {
  const root = fixture('ccd-prior-noscore-')
  const result = applyPrior(root, 'src/**', undefined)
  assert.equal(result.ok, false)
  assert.match(result.message, /number from 1 to 10/)
})

test('a non-numeric score is rejected', () => {
  const root = fixture('ccd-prior-nan-')
  const result = applyPrior(root, 'src/**', 'high')
  assert.equal(result.ok, false)
  assert.match(result.message, /number from 1 to 10/)
})

test('a score above ten is clamped to ten and says so', () => {
  const root = fixture('ccd-prior-hi-')
  const result = applyPrior(root, 'src/**', '99')
  assert.equal(result.ok, true)
  assert.equal(result.score, 10)
  assert.match(result.message, /clamped/i)
})

test('a score below one is clamped to one and says so', () => {
  const root = fixture('ccd-prior-lo-')
  const result = applyPrior(root, 'src/**', '-4')
  assert.equal(result.ok, true)
  assert.equal(result.score, 1)
  assert.match(result.message, /clamped/i)
})

test('an in-range score is not reported as clamped', () => {
  const root = fixture('ccd-prior-ok-')
  assert.doesNotMatch(applyPrior(root, 'src/**', '5').message, /clamped/i)
})

test('an existing ledger is merged into, not overwritten', () => {
  const root = fixture('ccd-prior-merge-')
  applyPrior(root, 'src/a/**', 3)
  applyPrior(root, 'src/b/**', 7)
  const ledger = loadLedger(ccdPaths(root).ledger)
  assert.equal(scoreFor(ledger, 'src/a/**'), 3)
  assert.equal(scoreFor(ledger, 'src/b/**'), 7)
})

// --- N2: the documented command must actually run from an arbitrary cwd ---

test('the script runs as a real child process from a non-plugin cwd and writes the ledger', () => {
  const root = fixture('ccd-prior-cli-')

  // SCRIPT is an absolute path, standing in for what the skill's
  // ${CLAUDE_PLUGIN_ROOT} substitution resolves to. cwd is the target
  // project, not the plugin directory -- the one cwd the orchestrator
  // actually has when it runs this command for real.
  const output = execFileSync(process.execPath, [SCRIPT, 'src/inject/**', '8'], { cwd: root }).toString()
  assert.match(output, /Prior for src\/inject\/\*\* set to 8/)

  const ledger = loadLedger(ccdPaths(root).ledger)
  assert.equal(scoreFor(ledger, 'src/inject/**'), 8)
})

test('a ledger with a null areas is repaired rather than fatal', () => {
  const root = fixture('ccd-prior-null-')
  const paths = ccdPaths(root)
  mkdirSync(paths.base, { recursive: true })
  writeFileSync(paths.ledger, '{"version":1,"areas":null}')
  const result = applyPrior(root, 'src/**', 6)
  assert.equal(result.ok, true)
  const raw = JSON.parse(readFileSync(paths.ledger, 'utf8'))
  assert.equal(raw.areas['src/**'].score, 6)
})
