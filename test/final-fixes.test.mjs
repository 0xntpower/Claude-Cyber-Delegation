import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ccdPaths, loadConfig, DEFAULT_CONFIG } from '../lib/paths.mjs'
import { loadLedger, EMPTY_LEDGER } from '../lib/ledger.mjs'
import { writeBaton, claimNewestBaton, writeOrigin } from '../lib/baton.mjs'
import { handleStart } from '../hooks/subagent-start.mjs'
import { handleStop } from '../hooks/subagent-stop.mjs'
import { interpretProbe, probeMessageLines } from '../scripts/probe-1m.mjs'
import { enable } from '../lib/gate.mjs'

function project () {
  const root = mkdtempSync(join(tmpdir(), 'ccd-final-'))
  mkdirSync(join(root, '.git'))
  return root
}

function armed () {
  const root = project()
  enable(ccdPaths(root))
  return root
}

function writeLedgerFile (root, text) {
  const paths = ccdPaths(root)
  mkdirSync(paths.base, { recursive: true })
  writeFileSync(paths.ledger, text)
  return paths
}

function backupCount (paths) {
  try {
    return readdirSync(paths.base).filter(f => f.startsWith('risk-ledger.corrupt-')).length
  } catch {
    return 0
  }
}

// --- I1: a shape-malformed ledger is backed up, not silently destroyed ---


// Real transcript frames: the refusal frame reports `model: "<synthetic>"`,
// so the refusing model is the last real one named before it.
function refusedTail (model) {
  return [
    JSON.stringify({ type: 'assistant', message: { model, stop_reason: 'tool_use' } }),
    JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } })
  ].join(String.fromCharCode(10))
}

test('a ledger that parses but has a non-object areas is backed up before the fallback', () => {
  const root = project()
  const paths = writeLedgerFile(root, JSON.stringify({ version: 1, areas: [{ score: 9, kills: 4 }] }))
  const led = loadLedger(paths.ledger)
  assert.deepEqual(led.areas, {})
  assert.equal(backupCount(paths), 1, 'the unusable ledger must be copied aside')
})

test('a ledger with areas set to null is backed up too', () => {
  const root = project()
  const paths = writeLedgerFile(root, JSON.stringify({ version: 1, areas: null }))
  loadLedger(paths.ledger)
  assert.equal(backupCount(paths), 1)
})

test('valid area entries survive alongside garbage ones', () => {
  const root = project()
  const good = { score: 7, source: 'observed', attempts: 2, kills: 1, successes: 1, byModel: {}, lastOpus5AttemptAt: null, dispatchesSinceOpus5: 0, history: [] }
  const paths = writeLedgerFile(root, JSON.stringify({ version: 1, areas: { 'a/**': good, 'b/**': 'garbage' } }))
  const led = loadLedger(paths.ledger)
  assert.equal(led.areas['a/**'].score, 7)
  assert.equal(led.areas['b/**'], undefined)
})

test('skipBackup leaves the corrupt file alone, so status stays read-only', () => {
  const root = project()
  const paths = writeLedgerFile(root, 'not json at all')
  loadLedger(paths.ledger, { skipBackup: true })
  assert.equal(backupCount(paths), 0)
})

// --- I2: the spec documents the config key names the code actually reads ---

test('every config key the spec names is a real DEFAULT_CONFIG key', () => {
  const spec = readFileSync('docs/superpowers/specs/2026-09-14-cyber-delegation-design.md', 'utf8')
  const known = new Set(Object.keys(DEFAULT_CONFIG))
  // Only config and baton field names are checked here. Hook payload fields
  // such as agent_type really are snake_case, because that is what the
  // harness sends, so matching them would force a wrong edit to the spec.
  const snakeCase = spec.match(/\b(stale_after_dispatches|stale_after_days|next_model)\b/g)
  assert.equal(snakeCase, null, `spec names config keys no code reads: ${snakeCase}`)
  for (const key of ['staleAfterDispatches', 'staleAfterDays', 'maxAttempts', 'ladder']) {
    assert.ok(known.has(key), `${key} must exist in DEFAULT_CONFIG`)
    assert.ok(spec.includes(key), `spec must name ${key} as the code spells it`)
  }
})

// --- I3: the probe's own output matches what measurement settled ---

test('the probe never tells the operator to hand-edit an agent file', () => {
  for (const r of [
    interpretProbe('OK', '', false),
    interpretProbe('', 'alias_1m_unsupported', true),
    interpretProbe('', 'Credit balance is too low', true)
  ]) {
    const text = probeMessageLines(r).join('\n')
    assert.doesNotMatch(text, /by hand|hand.edit/i, 'the hand edit guidance was retracted')
    assert.doesNotMatch(text, /unconfirmed/i, 'the pin is confirmed by live dispatch')
  }
})

// --- I4: a start payload with no agent_id must not strand the baton ---

test('a continuation start without agent_id leaves the baton claimable', () => {
  const root = armed()
  const paths = ccdPaths(root)
  writeBaton(paths, 'dead-1', { runId: 'dead-1', files: [], area: null, state: {}, attempt: 1, transcript: null })

  const out = handleStart({ agent_type: 'ccd-continuation', session_id: 's1' }, { root, readTailFn: () => 'T' })
  assert.match(out.systemMessage, /agent_id/i)

  const claimed = claimNewestBaton(paths)
  assert.notEqual(claimed, null, 'the baton must still be claimable afterwards')
  assert.equal(claimed.runId, 'dead-1')
})

test('writeOrigin with an invalid agent id returns false rather than throwing', () => {
  const root = project()
  assert.equal(writeOrigin(ccdPaths(root), undefined, { fromRunId: 'x', attempt: 1 }), false)
})

// --- I5: bad config values fall back instead of killing the refusal path ---

test('a non-array ladder falls back to the default', () => {
  const root = project()
  const paths = ccdPaths(root)
  mkdirSync(paths.base, { recursive: true })
  writeFileSync(paths.config, JSON.stringify({ ladder: null }))
  assert.deepEqual(loadConfig(root).ladder, DEFAULT_CONFIG.ladder)
})

test('a ladder of non-strings falls back, and each numeric key falls back independently', () => {
  const root = project()
  const paths = ccdPaths(root)
  mkdirSync(paths.base, { recursive: true })
  writeFileSync(paths.config, JSON.stringify({
    ladder: [1, 2], maxAttempts: 'two', staleAfterDays: -4, transcriptTailBytes: null
  }))
  const cfg = loadConfig(root)
  assert.deepEqual(cfg.ladder, DEFAULT_CONFIG.ladder)
  assert.equal(cfg.maxAttempts, DEFAULT_CONFIG.maxAttempts)
  assert.equal(cfg.staleAfterDays, DEFAULT_CONFIG.staleAfterDays)
  assert.equal(cfg.transcriptTailBytes, DEFAULT_CONFIG.transcriptTailBytes)
})

test('a refusal still writes a baton when the config ladder is corrupt', () => {
  const root = armed()
  const paths = ccdPaths(root)
  writeFileSync(paths.config, JSON.stringify({ ladder: null }))
  handleStop({ agent_id: 'r1', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl', session_id: 's2' }, {
    root,
    readTailFn: () => refusedTail('claude-opus-4-8'),
    extractFn: () => ['src/a.c'],
    framesExtractFn: () => ['src/a.c'],
    gitStateFn: () => ({ files: ['src/a.c'], status: '', diffstat: '', truncated: false })
  })
  const baton = JSON.parse(readFileSync(join(paths.runs, 'r1', 'baton.json'), 'utf8'))
  assert.equal(baton.nextModel, DEFAULT_CONFIG.ladder[0])
})

// --- I6: a corrupted attempt counter must not make a run immortal ---

test('a non-integer origin attempt is treated as absent so the run restarts at one', () => {
  const root = armed()
  const paths = ccdPaths(root)
  mkdirSync(join(paths.runs, 'bad'), { recursive: true })
  writeFileSync(join(paths.runs, 'bad', 'origin.json'), JSON.stringify({ fromRunId: 'x', attempt: 'two' }))
  handleStop({ agent_id: 'bad', agent_type: 'ccd-continuation', agent_transcript_path: '/t.jsonl', session_id: 's3' }, {
    root,
    readTailFn: () => refusedTail('claude-opus-4-6'),
    extractFn: () => [],
    framesExtractFn: () => [],
    gitStateFn: () => ({ files: [], status: '', diffstat: '', truncated: false })
  })
  const baton = JSON.parse(readFileSync(join(paths.runs, 'bad', 'baton.json'), 'utf8'))
  assert.equal(baton.attempt, 1, 'a corrupt counter must not produce a non-numeric attempt')
})

test('a negative origin attempt is also treated as absent', () => {
  const root = armed()
  const paths = ccdPaths(root)
  mkdirSync(join(paths.runs, 'neg'), { recursive: true })
  writeFileSync(join(paths.runs, 'neg', 'origin.json'), JSON.stringify({ fromRunId: 'x', attempt: -5 }))
  handleStop({ agent_id: 'neg', agent_type: 'ccd-continuation', agent_transcript_path: '/t.jsonl', session_id: 's4' }, {
    root,
    readTailFn: () => refusedTail('claude-opus-4-6'),
    extractFn: () => [],
    framesExtractFn: () => [],
    gitStateFn: () => ({ files: [], status: '', diffstat: '', truncated: false })
  })
  assert.equal(existsSync(join(paths.runs, 'neg', 'baton.json')), true)
})

// --- Minor: an array byModel must not be accepted as a valid unattributed record ---

test('an array byModel is rejected rather than silently losing its keys', () => {
  const root = project()
  const paths = writeLedgerFile(root, JSON.stringify({
    version: 1,
    areas: {},
    unattributed: { attempts: 1, kills: 1, successes: 0, byModel: [] }
  }))
  const led = loadLedger(paths.ledger)
  assert.deepEqual(led.unattributed, EMPTY_LEDGER.unattributed)
})
