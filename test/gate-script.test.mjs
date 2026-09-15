import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runEnable, runDisable, buildStatus, USAGE } from '../scripts/gate.mjs'
import { ccdPaths } from '../lib/paths.mjs'
import { isEnabled } from '../lib/gate.mjs'
import { loadLedger, recordOutcome, saveLedger, setPrior, withLedgerLock } from '../lib/ledger.mjs'

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'gate.mjs')

function fixture (name) {
  const root = mkdtempSync(join(tmpdir(), name))
  mkdirSync(join(root, '.git'))
  return root
}

test('runEnable creates the marker and names the project path', () => {
  const root = fixture('ccd-gate-enable-')
  const result = runEnable(root)
  assert.equal(result.ok, true)
  assert.ok(result.message.includes(root))
  assert.equal(isEnabled(ccdPaths(root)), true)
})

test('runDisable removes the marker and names the project path', () => {
  const root = fixture('ccd-gate-disable-')
  runEnable(root)
  const result = runDisable(root)
  assert.equal(result.ok, true)
  assert.ok(result.message.includes(root))
  assert.equal(isEnabled(ccdPaths(root)), false)
})

test('runDisable on an already-disarmed project still reports ok', () => {
  const root = fixture('ccd-gate-disable-idle-')
  const result = runDisable(root)
  assert.equal(result.ok, true)
})

// --- status: without a ledger ---

test('status reports unarmed when never enabled', () => {
  const root = fixture('ccd-gate-status-unarmed-')
  const result = buildStatus(root)
  assert.match(result.message, /armed:\s*no/i)
})

test('status reports armed after enable', () => {
  const root = fixture('ccd-gate-status-armed-')
  runEnable(root)
  const result = buildStatus(root)
  assert.match(result.message, /armed:\s*yes/i)
})

test('status says the ledger is absent rather than printing zeros as measurements', () => {
  const root = fixture('ccd-gate-status-noledger-')
  const result = buildStatus(root)
  assert.match(result.message, /absent/i)
  assert.doesNotMatch(result.message, /0 scored areas/i)
})

// --- status: with a ledger ---

function withLedger (root, fn) {
  const paths = ccdPaths(root)
  withLedgerLock(paths, () => {
    const ledger = loadLedger(paths.ledger)
    fn(ledger)
    saveLedger(paths.ledger, ledger)
  })
}

test('status reports the number of scored areas and their evidence', () => {
  const root = fixture('ccd-gate-status-areas-')
  withLedger(root, ledger => {
    setPrior(ledger, 'src/inject/**', 8, 'user-hint')
    recordOutcome(ledger, { area: 'src/inject/**', outcome: 'refusal', model: 'claude-opus-4-8' })
    recordOutcome(ledger, { area: 'src/other/**', outcome: 'normal', model: 'claude-opus-5' })
  })
  const result = buildStatus(root)
  assert.match(result.message, /2 scored areas/)
  assert.match(result.message, /src\/inject\/\*\*/)
  assert.match(result.message, /score 10/) // 8 + 2 from the refusal
})

test('status reports the unattributed totals', () => {
  const root = fixture('ccd-gate-status-unattr-')
  withLedger(root, ledger => {
    recordOutcome(ledger, { area: null, outcome: 'refusal', model: 'claude-opus-4-8' })
    recordOutcome(ledger, { area: null, outcome: 'refusal', model: 'claude-opus-4-8' })
  })
  const result = buildStatus(root)
  assert.match(result.message, /unattributed:.*2 attempts.*2 kills/i)
})

test('status names a stale area', () => {
  const root = fixture('ccd-gate-status-stale-')
  withLedger(root, ledger => {
    setPrior(ledger, 'src/stale/**', 9, 'user-hint')
    const entry = ledger.areas['src/stale/**']
    entry.dispatchesSinceOpus5 = 12
    entry.lastOpus5AttemptAt = new Date(Date.now() - 40 * 86400000).toISOString()
  })
  const result = buildStatus(root)
  assert.match(result.message, /stale/i)
  assert.match(result.message, /src\/stale\/\*\*/)
})

test('status says none when no area is stale', () => {
  const root = fixture('ccd-gate-status-notstale-')
  withLedger(root, ledger => {
    setPrior(ledger, 'src/fresh/**', 3, 'user-hint')
  })
  const result = buildStatus(root)
  assert.match(result.message, /stale areas:\s*none/i)
})

// --- CLI: runs as a real child process from a non-plugin cwd ---

test('the status subcommand runs as a real child process and reports sensibly with no ledger', () => {
  const root = fixture('ccd-gate-cli-status-empty-')
  const output = execFileSync(process.execPath, [SCRIPT, 'status'], { cwd: root }).toString()
  assert.match(output, /armed:\s*no/i)
  assert.match(output, /absent/i)
})

test('the enable subcommand runs as a real child process, then status shows it armed', () => {
  const root = fixture('ccd-gate-cli-enable-')
  const enableOut = execFileSync(process.execPath, [SCRIPT, 'enable'], { cwd: root }).toString()
  assert.ok(enableOut.includes(root))
  const statusOut = execFileSync(process.execPath, [SCRIPT, 'status'], { cwd: root }).toString()
  assert.match(statusOut, /armed:\s*yes/i)
})

test('the disable subcommand runs as a real child process, then status shows it unarmed', () => {
  const root = fixture('ccd-gate-cli-disable-')
  execFileSync(process.execPath, [SCRIPT, 'enable'], { cwd: root })
  execFileSync(process.execPath, [SCRIPT, 'disable'], { cwd: root })
  const statusOut = execFileSync(process.execPath, [SCRIPT, 'status'], { cwd: root }).toString()
  assert.match(statusOut, /armed:\s*no/i)
})

test('an unknown subcommand prints usage and exits non-zero', () => {
  const root = fixture('ccd-gate-cli-bad-')
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'bogus'], { cwd: root }))
  try {
    execFileSync(process.execPath, [SCRIPT], { cwd: root })
    assert.fail('expected a non-zero exit')
  } catch (err) {
    assert.equal(err.stdout.toString().trim(), USAGE)
  }
})

test('status with a real ledger written through the CLI reports it present', () => {
  const root = fixture('ccd-gate-cli-status-ledger-')
  execFileSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'set-prior.mjs'), 'src/inject/**', '7'], { cwd: root })
  const statusOut = execFileSync(process.execPath, [SCRIPT, 'status'], { cwd: root }).toString()
  assert.match(statusOut, /1 scored areas/)
  assert.match(statusOut, /score 7/)
})
