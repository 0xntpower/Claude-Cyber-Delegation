import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleStart } from '../hooks/subagent-start.mjs'
import { ccdPaths } from '../lib/paths.mjs'
import { enable } from '../lib/gate.mjs'
import { writeBaton, readOrigin, writeNextClaim, readNextClaim, claimNewestBaton } from '../lib/baton.mjs'
import { utimesSync } from 'node:fs'

// The relay tests below are about the gated behaviour, not the gate itself,
// so the fixture arms the project by default. The gate's own on/off and
// announce behaviour gets its own tests further down.
function fixture () {
  const root = mkdtempSync(join(tmpdir(), 'ccd-start-'))
  mkdirSync(join(root, '.git'))
  enable(ccdPaths(root))
  return root
}

const BATON = {
  runId: 'dead-1',
  files: ['src/inject/a.c'],
  area: 'src/inject/**',
  state: { status: ' M src/inject/a.c', diffstat: '1 file changed', files: ['src/inject/a.c'], truncated: false },
  attempt: 1,
  nextModel: 'claude-opus-4-6',
  refusedModel: 'claude-opus-4-8',
  transcript: '/t.jsonl'
}

test('non-continuation agents are ignored entirely', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-1', BATON)
  assert.equal(handleStart({ agent_type: 'general-purpose', agent_id: 'x' }, { root }), null)
})

test('a continuation with no baton available emits nothing', () => {
  const root = fixture()
  assert.equal(handleStart({ agent_type: 'ccd-continuation', agent_id: 'x' }, { root }), null)
})

test('attempt one injects the full transcript', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-1', BATON)
  const out = handleStart(
    { agent_type: 'ccd-continuation', agent_id: 'succ-1' },
    { root, readTailFn: () => 'FULL TRANSCRIPT BODY' }
  )
  const ctx = out.hookSpecificOutput.additionalContext
  assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart')
  assert.match(ctx, /FULL TRANSCRIPT BODY/)
  assert.match(ctx, /src\/inject\/a\.c/)
  assert.match(ctx, /claude-opus-4-8/)
})

test('attempt two degrades and omits the transcript', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-2', { ...BATON, runId: 'dead-2', attempt: 2 })
  const out = handleStart(
    { agent_type: 'ccd-continuation', agent_id: 'succ-2' },
    { root, readTailFn: () => 'SHOULD NOT APPEAR' }
  )
  const ctx = out.hookSpecificOutput.additionalContext
  assert.doesNotMatch(ctx, /SHOULD NOT APPEAR/)
  assert.match(ctx, /degraded/i)
  assert.match(ctx, /1 file changed/)
})

test('claiming records origin so the next refusal counts attempts', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-3', { ...BATON, runId: 'dead-3', attempt: 1 })
  handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-3' }, { root, readTailFn: () => 'T' })
  assert.deepEqual(readOrigin(ccdPaths(root), 'succ-3'), { fromRunId: 'dead-3', attempt: 1 })
})

test('the injected context instructs the successor to state its model', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-4', { ...BATON, runId: 'dead-4' })
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-4' }, { root, readTailFn: () => 'T' })
  assert.match(out.hookSpecificOutput.additionalContext, /first line/i)
})

// --- C3: the pointer decides which run the successor picks up ---

function twoRuns (root) {
  const paths = ccdPaths(root)
  writeBaton(paths, 'runA', { ...BATON, runId: 'runA', files: ['src/alpha/a.c'], transcript: '/a.jsonl' })
  const aFile = join(paths.runs, 'runA', 'baton.json')
  const past = new Date(Date.now() - 60000)
  utimesSync(aFile, past, past)
  writeBaton(paths, 'runB', { ...BATON, runId: 'runB', files: ['src/beta/b.c'], transcript: '/b.jsonl' })
  return paths
}

test('a targeted claim beats a newer unclaimed baton', () => {
  const root = fixture()
  twoRuns(root)
  writeNextClaim(ccdPaths(root), 'runA')
  const out = handleStart(
    { agent_type: 'ccd-continuation', agent_id: 'succ-A' },
    { root, readTailFn: () => 'T' }
  )
  const ctx = out.hookSpecificOutput.additionalContext
  assert.match(ctx, /runA/)
  assert.match(ctx, /src\/alpha\/a\.c/)
  assert.doesNotMatch(ctx, /src\/beta\/b\.c/)
  assert.deepEqual(readOrigin(ccdPaths(root), 'succ-A'), { fromRunId: 'runA', attempt: 1 })
})

test('a successful targeted claim clears the pointer', () => {
  const root = fixture()
  twoRuns(root)
  writeNextClaim(ccdPaths(root), 'runA')
  handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-A' }, { root, readTailFn: () => 'T' })
  assert.equal(readNextClaim(ccdPaths(root)), null)
})

test('two unclaimed batons are never conflated', () => {
  const root = fixture()
  const paths = twoRuns(root)
  writeNextClaim(paths, 'runA')
  handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-A' }, { root, readTailFn: () => 'T' })
  writeNextClaim(paths, 'runB')
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-B' }, { root, readTailFn: () => 'T' })
  const ctx = out.hookSpecificOutput.additionalContext
  assert.match(ctx, /src\/beta\/b\.c/)
  assert.doesNotMatch(ctx, /src\/alpha\/a\.c/)
  assert.equal(claimNewestBaton(paths), null, 'both batons must now be claimed, neither orphaned')
})

test('with no pointer it falls back to the newest unclaimed baton', () => {
  const root = fixture()
  twoRuns(root)
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-N' }, { root, readTailFn: () => 'T' })
  assert.match(out.hookSpecificOutput.additionalContext, /src\/beta\/b\.c/)
})

test('a pointer naming a nonexistent run falls back to the newest', () => {
  const root = fixture()
  twoRuns(root)
  writeNextClaim(ccdPaths(root), 'runZ')
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-Z' }, { root, readTailFn: () => 'T' })
  assert.match(out.hookSpecificOutput.additionalContext, /src\/beta\/b\.c/)
})

test('a pointer naming an already-claimed run falls back to the newest', () => {
  const root = fixture()
  const paths = twoRuns(root)
  writeNextClaim(paths, 'runA')
  handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-1' }, { root, readTailFn: () => 'T' })
  writeNextClaim(paths, 'runA')
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-2' }, { root, readTailFn: () => 'T' })
  assert.match(out.hookSpecificOutput.additionalContext, /src\/beta\/b\.c/)
})

// --- N1: the pointer must be one-shot, even across a dry run that claims nothing ---

test('a pointer that survives a claimless dry run must not resurrect for a later dispatch', () => {
  const root = fixture()
  const paths = ccdPaths(root)

  // The pointer is written for runA, but at this point runA has no baton yet
  // (its continuation is effectively never dispatched with real data): the
  // dry run below finds nothing to claim.
  writeNextClaim(paths, 'runA')
  const dryRun = handleStart({ agent_type: 'ccd-continuation', agent_id: 'ghost' }, { root, readTailFn: () => 'T' })
  assert.equal(dryRun, null)

  // runA's baton lands late, then runB is refused after it with no new pointer.
  writeBaton(paths, 'runA', { ...BATON, runId: 'runA', files: ['src/alpha/a.c'] })
  writeBaton(paths, 'runB', { ...BATON, runId: 'runB', files: ['src/beta/b.c'] })

  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-B' }, { root, readTailFn: () => 'T' })
  const ctx = out.hookSpecificOutput.additionalContext
  assert.match(ctx, /src\/beta\/b\.c/)
  assert.doesNotMatch(ctx, /src\/alpha\/a\.c/)
})

// --- M2: the injected block must not claim to be the whole transcript ---

test('the transcript block is labelled as the final portion with its byte cap', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-5', { ...BATON, runId: 'dead-5' })
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-5' }, { root, readTailFn: () => 'T' })
  const ctx = out.hookSpecificOutput.additionalContext
  assert.match(ctx, /final portion/i)
  assert.match(ctx, /400000 bytes/)
  assert.doesNotMatch(ctx, /## Full transcript/i)
})

// --- P2: a truncated file list must say so, not just carry the flag silently ---

test('a truncated baton mentions the truncation and names the cap', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-6', {
    ...BATON,
    runId: 'dead-6',
    state: { ...BATON.state, truncated: true }
  })
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-6' }, { root, readTailFn: () => 'T' })
  const ctx = out.hookSpecificOutput.additionalContext
  assert.match(ctx, /truncat/i)
  assert.match(ctx, /500/)
})

test('an untruncated baton says nothing about truncation', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-7', { ...BATON, runId: 'dead-7' })
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-7' }, { root, readTailFn: () => 'T' })
  const ctx = out.hookSpecificOutput.additionalContext
  assert.doesNotMatch(ctx, /truncat/i)
})

// --- Gate: the hook does no work at all in an unarmed project ---

test('an unarmed project does no work and emits nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-start-gate-'))
  mkdirSync(join(root, '.git'))
  // No enable() call: this project is never armed.
  writeBaton(ccdPaths(root), 'dead-unarmed', { ...BATON, runId: 'dead-unarmed' })
  let touched = false
  const out = handleStart(
    { agent_type: 'ccd-continuation', agent_id: 'succ-unarmed' },
    { root, readTailFn: () => { touched = true; return 'SHOULD NOT BE READ' } }
  )
  assert.equal(out, null)
  assert.equal(touched, false, 'the gate must return before any transcript read or baton claim')
  // Nothing was claimed: the baton is still there for later, once armed.
  assert.notEqual(claimNewestBaton(ccdPaths(root)), null)
})

test('an armed project still claims a baton and injects context, so the gate did not break the relay', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-armed', { ...BATON, runId: 'dead-armed' })
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-armed' }, { root, readTailFn: () => 'BODY' })
  assert.match(out.hookSpecificOutput.additionalContext, /dead-armed/)
})

// --- Gate: once-per-session armed notice ---

test('the first hook fire of a session in an armed project announces itself', () => {
  const root = fixture()
  const out = handleStart({ agent_type: 'general-purpose', agent_id: 'x', session_id: 'sess-1' }, { root })
  assert.match(out.systemMessage, /armed/i)
})

test('a non-continuation dispatch in an armed project emits nothing without a session id', () => {
  const root = fixture()
  const out = handleStart({ agent_type: 'general-purpose', agent_id: 'x' }, { root })
  assert.equal(out, null)
})

test('a second hook fire in the same session does not announce again', () => {
  const root = fixture()
  handleStart({ agent_type: 'general-purpose', agent_id: 'x1', session_id: 'sess-2' }, { root })
  const out = handleStart({ agent_type: 'general-purpose', agent_id: 'x2', session_id: 'sess-2' }, { root })
  assert.equal(out, null)
})

test('the armed notice is prepended to a continuation context rather than replacing it', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-8', { ...BATON, runId: 'dead-8' })
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-8', session_id: 'sess-3' }, { root, readTailFn: () => 'T' })
  assert.match(out.systemMessage, /armed/i)
  assert.ok(out.hookSpecificOutput.additionalContext.length > 0)
})
