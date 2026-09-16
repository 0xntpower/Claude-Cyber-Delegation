import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAgentPost, relayContext } from '../hooks/agent-post.mjs'
import { handleStart } from '../hooks/subagent-start.mjs'
import { ccdPaths } from '../lib/paths.mjs'
import { enable } from '../lib/gate.mjs'
import { writeBaton, pendingBatons, claimAnnounce } from '../lib/baton.mjs'
import { inspectTail, modelFromFrames, parseFrames } from '../lib/classify.mjs'

// The harness truncates `additionalContext` to these limits, from the front,
// and reports it to nobody the hook can reach. Anything injected has to fit.
const MAX_CONTEXT_CHARS = 8000
const MAX_CONTEXT_LINES = 200

function fixture () {
  const root = mkdtempSync(join(tmpdir(), 'ccd-relay-'))
  mkdirSync(join(root, '.git'))
  enable(ccdPaths(root))
  return root
}

const BATON = {
  runId: 'dead-1',
  agentType: 'general-purpose',
  files: ['src/inject/a.c'],
  area: 'src/inject/**',
  state: { status: ' M src/inject/a.c', diffstat: '1 file changed', files: ['src/inject/a.c'], truncated: false },
  attempt: 1,
  category: 'cyber',
  nextModel: 'claude-opus-4-6',
  refusedModel: 'claude-opus-4-8',
  transcript: '/t.jsonl'
}

function frames (...objs) {
  return objs.map(o => JSON.stringify(o)).join(String.fromCharCode(10))
}

// --- The relay reaches the orchestrator, not just the terminal ---

test('a written baton is announced into the parent as injected context', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-1', BATON)
  const out = handleAgentPost({ tool_name: 'Agent' }, { root })
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse')
  const ctx = out.hookSpecificOutput.additionalContext
  assert.match(ctx, /dead-1/)
  assert.match(ctx, /ccd-continuation/)
  assert.match(ctx, /next-claim/, 'the pointer step must be spelled out, not left to a skill')
})

test('the announcement names the refusal category when the baton carries one', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-1', BATON)
  const ctx = handleAgentPost({ tool_name: 'Agent' }, { root }).hookSpecificOutput.additionalContext
  assert.match(ctx, /cyber guardrails/i)
})

test('a run is announced exactly once, however many Agent calls finish', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-1', BATON)
  assert.notEqual(handleAgentPost({ tool_name: 'Agent' }, { root }), null)
  assert.equal(handleAgentPost({ tool_name: 'Agent' }, { root }), null, 'a second Agent call must not repeat it')
})

test('a claimed baton is never announced', () => {
  const root = fixture()
  const paths = ccdPaths(root)
  writeBaton(paths, 'dead-1', BATON)
  handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-1' }, { root, readTailFn: () => 'T' })
  assert.equal(handleAgentPost({ tool_name: 'Agent' }, { root }), null)
})

test('nothing is announced in an unarmed project', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-unarmed-'))
  mkdirSync(join(root, '.git'))
  writeBaton(ccdPaths(root), 'dead-1', BATON)
  assert.equal(handleAgentPost({ tool_name: 'Agent' }, { root }), null)
})

test('an ordinary Agent call with no refusal pending emits nothing', () => {
  const root = fixture()
  assert.equal(handleAgentPost({ tool_name: 'Agent' }, { root }), null)
})

test('two overlapping refusals are both announced, each with its own run id', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'runA', { ...BATON, runId: 'runA' })
  writeBaton(ccdPaths(root), 'runB', { ...BATON, runId: 'runB' })
  const ctx = handleAgentPost({ tool_name: 'Agent' }, { root }).hookSpecificOutput.additionalContext
  assert.match(ctx, /runA/)
  assert.match(ctx, /runB/)
})

test('the announcement never carries the refused content itself', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-1', { ...BATON, explanation: 'REFUSED TEXT BODY' })
  const ctx = handleAgentPost({ tool_name: 'Agent' }, { root }).hookSpecificOutput.additionalContext
  assert.doesNotMatch(ctx, /REFUSED TEXT BODY/)
})

test('an announcement fits inside the harness context caps', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    runId: `run-${i}`,
    baton: { ...BATON, runId: `run-${i}`, files: Array.from({ length: 400 }, (_, n) => `src/x/f${n}.c`) }
  }))
  const ctx = relayContext(many.slice(0, 4))
  assert.ok(ctx.length <= MAX_CONTEXT_CHARS, `announcement was ${ctx.length} chars`)
  assert.ok(ctx.split('\n').length <= MAX_CONTEXT_LINES, 'announcement exceeded the line cap')
})

// --- The handoff brief fits, and the evidence is on disk instead ---

test('the injected brief fits the caps even when the transcript is huge', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-1', {
    ...BATON,
    files: Array.from({ length: 500 }, (_, n) => `src/deep/nested/file-${n}.c`)
  })
  const out = handleStart(
    { agent_type: 'ccd-continuation', agent_id: 'succ-1' },
    { root, readTailFn: () => 'X'.repeat(400000) }
  )
  const ctx = out.hookSpecificOutput.additionalContext
  assert.ok(ctx.length <= MAX_CONTEXT_CHARS, `brief was ${ctx.length} chars`)
  assert.ok(ctx.split('\n').length <= MAX_CONTEXT_LINES, 'brief exceeded the line cap')
  // The bytes the cap would have eaten are on disk in full.
  const body = readFileSync(join(ccdPaths(root).runs, 'dead-1', 'handoff.md'), 'utf8')
  assert.ok(body.length > MAX_CONTEXT_CHARS, 'the handoff file is the uncapped copy')
})

test('a handoff file that cannot be written still yields a usable brief', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-1', BATON)
  const out = handleStart(
    { agent_type: 'ccd-continuation', agent_id: 'succ-1' },
    { root, readTailFn: () => 'T', writeHandoffFn: () => null }
  )
  const ctx = out.hookSpecificOutput.additionalContext
  assert.match(ctx, /baton\.json/, 'it must name a fallback the successor can actually read')
  assert.match(ctx, /dead-1/)
})

// --- Classification reads structure, not text ---

test('an agent that merely read a refusal string is not treated as refused', () => {
  const tail = frames(
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'const REFUSAL = /"stop_reason":"refusal"|safeguards flagged/i' }]
      }
    },
    { type: 'assistant', message: { model: 'claude-opus-5', stop_reason: 'end_turn' } }
  )
  assert.equal(inspectTail(tail).outcome, 'normal')
})

test('a refusal the platform recovered from on a fallback model is not a kill', () => {
  const tail = frames(
    { type: 'assistant', message: { model: 'claude-opus-5', stop_reason: 'tool_use' } },
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } },
    { type: 'system', subtype: 'model_refusal_fallback' },
    { type: 'assistant', message: { model: 'claude-opus-4-8', stop_reason: 'end_turn' } }
  )
  assert.equal(inspectTail(tail).outcome, 'normal', 'the turn finished on the fallback model')
})

test('a refusal nothing caught is still a kill', () => {
  const tail = frames(
    { type: 'assistant', message: { model: 'claude-opus-5', stop_reason: 'tool_use' } },
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } },
    { type: 'system', subtype: 'model_refusal_no_fallback' }
  )
  const seen = inspectTail(tail)
  assert.equal(seen.outcome, 'refusal')
  assert.equal(seen.category, 'cyber')
})

test('an earlier recovered refusal does not excuse a later fatal one', () => {
  const tail = frames(
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } },
    { type: 'system', subtype: 'model_refusal_fallback' },
    { type: 'assistant', message: { model: 'claude-opus-4-8', stop_reason: 'tool_use' } },
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } }
  )
  assert.equal(inspectTail(tail).outcome, 'refusal')
})

test('the synthetic refusal frame does not become the recorded model', () => {
  const tail = frames(
    { type: 'assistant', message: { model: 'claude-opus-4-8', stop_reason: 'tool_use' } },
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal' } }
  )
  assert.equal(modelFromFrames(parseFrames(tail)), 'claude-opus-4-8')
})

test('a tail beginning mid-line drops the fragment and reads the rest', () => {
  const whole = frames(
    { type: 'assistant', message: { model: 'claude-opus-5', stop_reason: 'tool_use' } },
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio' } } }
  )
  const seen = inspectTail(whole.slice(20))
  assert.equal(seen.outcome, 'refusal')
  assert.equal(seen.category, 'bio')
})

// --- Baton bookkeeping the announcement depends on ---

test('pendingBatons skips claimed and already-announced runs', () => {
  const root = fixture()
  const paths = ccdPaths(root)
  writeBaton(paths, 'runA', { ...BATON, runId: 'runA' })
  writeBaton(paths, 'runB', { ...BATON, runId: 'runB' })
  assert.equal(pendingBatons(paths).length, 2)
  assert.equal(claimAnnounce(paths, 'runA'), true)
  assert.equal(claimAnnounce(paths, 'runA'), false, 'the announce lock is one-shot')
  assert.deepEqual(pendingBatons(paths).map(b => b.runId), ['runB'])
})

test('claimAnnounce refuses a run id that would escape the runs directory', () => {
  const root = fixture()
  const paths = ccdPaths(root)
  assert.equal(claimAnnounce(paths, '../escape'), false)
  assert.equal(claimAnnounce(paths, '..'), false)
  assert.equal(existsSync(join(paths.runs, '..', 'announced.lock')), false)
})

// --- The wiring itself ---

test('hooks.json restricts SubagentStart to continuations and relays through PostToolUse', () => {
  const cfg = JSON.parse(readFileSync('hooks/hooks.json', 'utf8'))
  assert.equal(cfg.hooks.SubagentStart[0].matcher, 'ccd-continuation',
    'an ordinary dispatch must not spawn a process just to return null')
  assert.equal(cfg.hooks.SubagentStop[0].matcher, '*',
    'any subagent can be refused, so the stop hook stays universal')
  assert.match(cfg.hooks.PostToolUse[0].matcher, /Agent/)
  assert.match(cfg.hooks.PostToolUse[0].hooks[0].command, /agent-post\.mjs/)
})

// The frame layout below is the one sampled transcripts actually carry: the
// system frame announcing the platform's handling sits one line *ahead* of the
// synthetic refusal frame it describes, not behind it.
test('a recovery announced before the refusal frame still counts as recovered', () => {
  const tail = frames(
    { type: 'assistant', message: { model: 'claude-opus-5', stop_reason: 'tool_use' } },
    { type: 'system', subtype: 'model_refusal_fallback' },
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } },
    { type: 'assistant', message: { model: 'claude-opus-4-8', stop_reason: 'end_turn' } }
  )
  assert.equal(inspectTail(tail).outcome, 'normal',
    'the platform caught this turn, so no baton is owed for it')
})

test('a kill announced before the refusal frame is still a kill', () => {
  const tail = frames(
    { type: 'assistant', message: { model: 'claude-opus-5', stop_reason: 'tool_use' } },
    { type: 'system', subtype: 'model_refusal_no_fallback' },
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } }
  )
  const seen = inspectTail(tail)
  assert.equal(seen.outcome, 'refusal')
  assert.equal(seen.category, 'cyber')
})

// Two refusals in a row, the first recovered. The marker for the first sits
// two frames ahead of the second, and reading it as the second's would drop a
// real kill's baton and abandon the work it was holding.
test('a preceding marker belonging to an earlier refusal is not borrowed', () => {
  const tail = frames(
    { type: 'system', subtype: 'model_refusal_fallback' },
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } },
    { type: 'assistant', message: { model: 'claude-opus-4-8', stop_reason: 'tool_use' } },
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } }
  )
  assert.equal(inspectTail(tail).outcome, 'refusal')
})

test('a later refusal does not reach past itself for a marker', () => {
  const tail = frames(
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } },
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } },
    { type: 'system', subtype: 'model_refusal_fallback' }
  )
  assert.equal(inspectTail(tail).outcome, 'normal',
    'the marker directly after the last refusal is that refusal\'s own')
})
