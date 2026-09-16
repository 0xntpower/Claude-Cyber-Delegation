import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleStop } from '../hooks/subagent-stop.mjs'
import { ccdPaths } from '../lib/paths.mjs'
import { enable } from '../lib/gate.mjs'
import { writeOrigin } from '../lib/baton.mjs'


// Real transcript frames, matching refused transcripts sampled from disk: the
// refusal frame reports `model: "<synthetic>"`, so the model that actually
// refused is the last real one named before it.
function frames (...objs) {
  return objs.map(o => JSON.stringify(o)).join(String.fromCharCode(10))
}

function refusedTail (model, category = 'cyber') {
  return frames(
    { type: 'assistant', message: { model, stop_reason: 'tool_use' } },
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category } } }
  )
}

function plainTail (model) {
  return frames({ type: 'assistant', message: { model, stop_reason: 'end_turn' } })
}

// The relay tests below are about the gated behaviour, not the gate itself,
// so the fixture arms the project by default. The gate's own on/off and
// announce behaviour gets its own tests further down.
function deps (overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ccd-stop-'))
  mkdirSync(join(root, '.git'))
  enable(ccdPaths(root))
  return {
    root,
    readTailFn: () => refusedTail('claude-opus-4-8'),
    classifyFn: () => 'refusal',
    extractFn: () => ['src/inject/a.c'],
    framesExtractFn: () => ['src/inject/a.c'],
    gitStateFn: () => ({ files: ['src/inject/a.c'], status: ' M src/inject/a.c', diffstat: '1 file changed', truncated: false }),
    ...overrides
  }
}

test('stop_hook_active short-circuits before any work', () => {
  let touched = false
  const d = deps({ classifyFn: () => { touched = true; return 'refusal' } })
  assert.equal(handleStop({ stop_hook_active: true, agent_id: 'a' }, d), null)
  assert.equal(touched, false)
})

test('a normal outcome records a success and emits nothing', () => {
  const d = deps({ classifyFn: () => 'normal' })
  const out = handleStop({ agent_id: 'a1', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  assert.equal(out, null)
  const ledger = JSON.parse(readFileSync(ccdPaths(d.root).ledger, 'utf8'))
  assert.equal(ledger.areas['src/inject/**'].successes, 1)
})

test('a rate limit emits a message and writes no baton', () => {
  const d = deps({ classifyFn: () => 'rate_limit' })
  const out = handleStop({ agent_id: 'a2', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  assert.match(out.systemMessage, /rate limit/i)
  assert.equal(existsSync(join(ccdPaths(d.root).runs, 'a2', 'baton.json')), false)
})

test('a refusal writes a baton with scoped files and git state', () => {
  const d = deps()
  const out = handleStop({ agent_id: 'a3', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  const baton = JSON.parse(readFileSync(join(ccdPaths(d.root).runs, 'a3', 'baton.json'), 'utf8'))
  assert.equal(baton.attempt, 1)
  assert.deepEqual(baton.files, ['src/inject/a.c'])
  assert.equal(baton.area, 'src/inject/**')
  assert.equal(baton.nextModel, 'claude-opus-4-6')
  assert.equal(baton.refusedModel, 'claude-opus-4-8')
  assert.match(out.systemMessage, /refused/i)
  assert.match(out.systemMessage, /a3/)
})

test('the refused model is recorded in per-model evidence', () => {
  const d = deps()
  handleStop({ agent_id: 'a6', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  const ledger = JSON.parse(readFileSync(ccdPaths(d.root).ledger, 'utf8'))
  assert.equal(ledger.areas['src/inject/**'].byModel['claude-opus-4-8'].kills, 1)
  assert.equal(ledger.areas['src/inject/**'].dispatchesSinceOpus5, 1)
})

test('a refusal raises the ledger score for the touched area', () => {
  const d = deps()
  handleStop({ agent_id: 'a4', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  const ledger = JSON.parse(readFileSync(ccdPaths(d.root).ledger, 'utf8'))
  assert.equal(ledger.areas['src/inject/**'].score, 7)
  assert.equal(ledger.areas['src/inject/**'].kills, 1)
})

test('a refused continuation increments the attempt number', () => {
  const d = deps()
  handleStop({ agent_id: 'first', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  writeOrigin(ccdPaths(d.root), 'second', { fromRunId: 'first', attempt: 1 })
  handleStop({ agent_id: 'second', agent_type: 'ccd-continuation', agent_transcript_path: '/t.jsonl' }, d)
  const baton = JSON.parse(readFileSync(join(ccdPaths(d.root).runs, 'second', 'baton.json'), 'utf8'))
  assert.equal(baton.attempt, 2)
})

test('exceeding maxAttempts halts and writes a handoff report', () => {
  const d = deps()
  writeOrigin(ccdPaths(d.root), 'final', { fromRunId: 'x', attempt: 2 })
  const out = handleStop({ agent_id: 'final', agent_type: 'ccd-continuation', agent_transcript_path: '/t.jsonl' }, d)
  assert.match(out.systemMessage, /halted/i)
  assert.equal(existsSync(join(ccdPaths(d.root).runs, 'final', 'handoff.md')), true)
  assert.equal(existsSync(join(ccdPaths(d.root).runs, 'final', 'baton.json')), false)
})

test('a refusal with no attributable files still records and still emits', () => {
  const d = deps({ extractFn: () => [] })
  const out = handleStop({ agent_id: 'a5', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  const baton = JSON.parse(readFileSync(join(ccdPaths(d.root).runs, 'a5', 'baton.json'), 'utf8'))
  assert.deepEqual(baton.files, [])
  assert.equal(baton.area, null)
  assert.ok(out.systemMessage.length > 0)
})

test('captures a model ID carrying a 1M context suffix', () => {
  const d = deps({ readTailFn: () => refusedTail('claude-opus-5[1m]') })
  const out = handleStop({ agent_id: 'a7', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  const baton = JSON.parse(readFileSync(join(ccdPaths(d.root).runs, 'a7', 'baton.json'), 'utf8'))
  assert.equal(baton.refusedModel, 'claude-opus-5[1m]')
})

// --- I4: a rate limit is not evidence ---

test('a rate limit leaves the ledger completely untouched', () => {
  const d = deps({
    classifyFn: () => 'rate_limit',
    readTailFn: () => plainTail('claude-opus-5')
  })
  handleStop({ agent_id: 'rl-1', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  assert.equal(existsSync(ccdPaths(d.root).ledger), false, 'a non-event must not create a ledger')
})

test('a rate limit does not reset the Opus 5 staleness clock', () => {
  const d = deps()
  // Establish real evidence from a genuine 4.6 refusal first.
  handleStop({ agent_id: 'real-1', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, {
    ...d,
    readTailFn: () => refusedTail('claude-opus-4-6')
  })
  const before = JSON.parse(readFileSync(ccdPaths(d.root).ledger, 'utf8')).areas['src/inject/**']
  assert.equal(before.dispatchesSinceOpus5, 1)

  handleStop({ agent_id: 'rl-2', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, {
    ...d,
    classifyFn: () => 'rate_limit',
    readTailFn: () => plainTail('claude-opus-5')
  })
  const after = JSON.parse(readFileSync(ccdPaths(d.root).ledger, 'utf8')).areas['src/inject/**']
  assert.equal(after.attempts, 1, 'a dispatch that never ran must not inflate the denominator')
  assert.equal(after.dispatchesSinceOpus5, 1)
  assert.equal(after.lastOpus5AttemptAt, null, 'an Opus 5 rate limit is not an Opus 5 attempt')
})

// --- I5: never assert a capture that did not happen ---

test('a payload with no agent_id names the problem and writes nothing', () => {
  const d = deps()
  const out = handleStop({ agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  assert.match(out.systemMessage, /agent_id/)
  assert.equal(existsSync(ccdPaths(d.root).ledger), false, 'the ledger must not be mutated first')
})

test('a blank agent_id is rejected the same way', () => {
  const d = deps()
  const out = handleStop({ agent_id: '   ', agent_transcript_path: '/t.jsonl' }, d)
  assert.match(out.systemMessage, /agent_id/)
})

test('a failed baton write says FAILED instead of claiming success', () => {
  const d = deps()
  // Occupying the run directory path with a file makes mkdirSync fail, which is
  // exactly the shape of the real failure: writeBaton returns null.
  mkdirSync(ccdPaths(d.root).runs, { recursive: true })
  writeFileSync(join(ccdPaths(d.root).runs, 'blocked'), 'not a directory')
  const out = handleStop({ agent_id: 'blocked', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  assert.match(out.systemMessage, /FAILED/)
  assert.doesNotMatch(out.systemMessage, /Baton written/)
  assert.match(out.systemMessage, /blocked/)
})

// --- M1: the model that refused is the last one named, not the first ---

test('a mid-session degrade records the later model, not the earlier one', () => {
  const d = deps({
    readTailFn: () => frames(
      { type: 'assistant', message: { model: 'claude-opus-5', stop_reason: 'tool_use' } },
      { type: 'assistant', message: { model: 'claude-opus-4-8', stop_reason: 'tool_use' } },
      { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } }
    )
  })
  handleStop({ agent_id: 'deg-1', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  const baton = JSON.parse(readFileSync(join(ccdPaths(d.root).runs, 'deg-1', 'baton.json'), 'utf8'))
  assert.equal(baton.refusedModel, 'claude-opus-4-8')
  const area = JSON.parse(readFileSync(ccdPaths(d.root).ledger, 'utf8')).areas['src/inject/**']
  assert.equal(area.byModel['claude-opus-4-8'].kills, 1)
  assert.equal(area.dispatchesSinceOpus5, 1, 'a degraded dispatch is not an Opus 5 attempt')
  assert.equal(area.lastOpus5AttemptAt, null)
})

test('an unknown model is still recorded rather than crashing', () => {
  const d = deps({ readTailFn: () => 'no model field here' })
  handleStop({ agent_id: 'unk-1', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  const baton = JSON.parse(readFileSync(join(ccdPaths(d.root).runs, 'unk-1', 'baton.json'), 'utf8'))
  assert.equal(baton.refusedModel, 'unknown')
})

// --- P2: the systemMessage must say when the file list and diff are partial ---

test('a truncated file set is named in the refusal systemMessage', () => {
  const d = deps({
    gitStateFn: () => ({ files: ['src/inject/a.c'], status: ' M src/inject/a.c', diffstat: '1 file changed', truncated: true })
  })
  const out = handleStop({ agent_id: 'trunc-1', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  assert.match(out.systemMessage, /truncat/i)
  assert.match(out.systemMessage, /500/)
})

test('an untruncated file set says nothing about truncation', () => {
  const d = deps()
  const out = handleStop({ agent_id: 'trunc-2', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  assert.doesNotMatch(out.systemMessage, /truncat/i)
})

// --- Gate: the hook does no work at all in an unarmed project ---

test('an unarmed project does no work and emits nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-stop-gate-'))
  mkdirSync(join(root, '.git'))
  // No enable() call: this project is never armed.
  let touched = false
  const out = handleStop(
    { agent_id: 'gated-1', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' },
    {
      root,
      readTailFn: () => { touched = true; return refusedTail('claude-opus-4-8') },
      classifyFn: () => { touched = true; return 'refusal' },
      extractFn: () => { touched = true; return ['src/inject/a.c'] },
      gitStateFn: () => { touched = true; return { files: [], status: '', diffstat: '', truncated: false } }
    }
  )
  assert.equal(out, null)
  assert.equal(touched, false, 'the gate must return before any transcript read, classification, or git call')
  assert.equal(existsSync(ccdPaths(root).ledger), false)
})

test('an armed project still produces a baton on refusal, so the gate did not break the relay', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-stop-gate-'))
  mkdirSync(join(root, '.git'))
  enable(ccdPaths(root))
  const out = handleStop(
    { agent_id: 'gated-2', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' },
    {
      root,
      readTailFn: () => refusedTail('claude-opus-4-8'),
      classifyFn: () => 'refusal',
      extractFn: () => ['src/inject/a.c'],
      gitStateFn: () => ({ files: ['src/inject/a.c'], status: ' M src/inject/a.c', diffstat: '1 file changed', truncated: false })
    }
  )
  assert.match(out.systemMessage, /refused/i)
  const baton = JSON.parse(readFileSync(join(ccdPaths(root).runs, 'gated-2', 'baton.json'), 'utf8'))
  assert.equal(baton.attempt, 1)
})

// --- Gate: once-per-session armed notice ---

test('the first hook fire of a session in an armed project announces itself', () => {
  const d = deps({ classifyFn: () => 'normal' })
  const out = handleStop({ agent_id: 'announce-1', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl', session_id: 'sess-1' }, d)
  assert.match(out.systemMessage, /armed/i)
})

test('a normal outcome in an armed project emits nothing without a session id', () => {
  const d = deps({ classifyFn: () => 'normal' })
  const out = handleStop({ agent_id: 'announce-nosession', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  assert.equal(out, null)
})

test('a second hook fire in the same session does not announce again', () => {
  const d = deps({ classifyFn: () => 'normal' })
  handleStop({ agent_id: 'announce-2', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl', session_id: 'sess-2' }, d)
  const out = handleStop({ agent_id: 'announce-3', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl', session_id: 'sess-2' }, d)
  assert.equal(out, null)
})

test('the armed notice is prepended to an existing systemMessage rather than replacing it', () => {
  const d = deps()
  const out = handleStop({ agent_id: 'announce-4', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl', session_id: 'sess-4' }, d)
  assert.match(out.systemMessage, /armed/i)
  assert.match(out.systemMessage, /refused/i)
})
