import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
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


// The evidence moved out of the injected text and into a file, because the
// harness silently truncates additionalContext to 8000 characters and 200
// lines. Assertions about the file list, the diff and the transcript belong
// against the file now; assertions about run identity and the rules belong
// against the injected brief.
function handoff (root, runId) {
  return readFileSync(join(ccdPaths(root).runs, runId, 'handoff.md'), 'utf8')
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
  const body = handoff(root, 'dead-1')
  assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart')
  assert.match(body, /FULL TRANSCRIPT BODY/)
  assert.match(body, /src\/inject\/a\.c/)
  assert.match(ctx, /claude-opus-4-8/)
  assert.match(ctx, /handoff\.md/, 'the brief must point at the file holding the evidence')
})

test('attempt two degrades and omits the transcript', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-2', { ...BATON, runId: 'dead-2', attempt: 2 })
  const out = handleStart(
    { agent_type: 'ccd-continuation', agent_id: 'succ-2' },
    { root, readTailFn: () => 'SHOULD NOT APPEAR' }
  )
  const ctx = out.hookSpecificOutput.additionalContext
  const body = handoff(root, 'dead-2')
  assert.doesNotMatch(ctx, /SHOULD NOT APPEAR/)
  assert.doesNotMatch(body, /SHOULD NOT APPEAR/)
  assert.match(body, /degraded/i)
  assert.match(body, /1 file changed/)
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
  assert.doesNotMatch(ctx, /runB/)
  assert.match(handoff(root, 'runA'), /src\/alpha\/a\.c/)
  assert.doesNotMatch(handoff(root, 'runA'), /src\/beta\/b\.c/)
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
  assert.match(ctx, /runB/)
  assert.doesNotMatch(ctx, /runA/)
  assert.equal(claimNewestBaton(paths), null, 'both batons must now be claimed, neither orphaned')
})

test('with no pointer it falls back to the newest unclaimed baton', () => {
  const root = fixture()
  twoRuns(root)
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-N' }, { root, readTailFn: () => 'T' })
  assert.match(out.hookSpecificOutput.additionalContext, /runB/)
})

test('a pointer naming a nonexistent run falls back to the newest', () => {
  const root = fixture()
  twoRuns(root)
  writeNextClaim(ccdPaths(root), 'runZ')
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-Z' }, { root, readTailFn: () => 'T' })
  assert.match(out.hookSpecificOutput.additionalContext, /runB/)
})

test('a pointer naming an already-claimed run falls back to the newest', () => {
  const root = fixture()
  const paths = twoRuns(root)
  writeNextClaim(paths, 'runA')
  handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-1' }, { root, readTailFn: () => 'T' })
  writeNextClaim(paths, 'runA')
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-2' }, { root, readTailFn: () => 'T' })
  assert.match(out.hookSpecificOutput.additionalContext, /runB/)
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
  // The mtimes are set explicitly: two writes inside the same millisecond tie
  // on mtimeMs, and "newest" then depends on sort stability rather than on
  // which baton is actually newer.
  writeBaton(paths, 'runA', { ...BATON, runId: 'runA', files: ['src/alpha/a.c'] })
  writeBaton(paths, 'runB', { ...BATON, runId: 'runB', files: ['src/beta/b.c'] })
  utimesSync(join(paths.runs, 'runA', 'baton.json'), new Date(1000), new Date(1000))
  utimesSync(join(paths.runs, 'runB', 'baton.json'), new Date(2000), new Date(2000))

  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-B' }, { root, readTailFn: () => 'T' })
  const ctx = out.hookSpecificOutput.additionalContext
  assert.match(ctx, /runB/)
  assert.doesNotMatch(ctx, /runA/)
})

// --- M2: the injected block must not claim to be the whole transcript ---

test('the transcript block is labelled as the final portion with its byte cap', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-5', { ...BATON, runId: 'dead-5' })
  handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-5' }, { root, readTailFn: () => 'T' })
  const body = handoff(root, 'dead-5')
  assert.match(body, /final portion/i)
  assert.match(body, /400000 bytes/)
  assert.doesNotMatch(body, /## Full transcript/i)
})

// --- P2: a truncated file list must say so, not just carry the flag silently ---

test('a truncated baton mentions the truncation and names the cap', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-6', {
    ...BATON,
    runId: 'dead-6',
    state: { ...BATON.state, truncated: true }
  })
  handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-6' }, { root, readTailFn: () => 'T' })
  const body = handoff(root, 'dead-6')
  assert.match(body, /truncat/i)
  assert.match(body, /500/)
})

test('an untruncated baton says nothing about truncation', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-7', { ...BATON, runId: 'dead-7' })
  handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-7' }, { root, readTailFn: () => 'T' })
  assert.doesNotMatch(handoff(root, 'dead-7'), /truncat/i)
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

// --- Gate: the armed notice belongs to subagent-stop now ---

// This hook is registered with a `ccd-continuation` matcher, so the harness
// never fires it for an ordinary dispatch and it has no chance to carry a
// once-per-session notice. `subagent-stop` keeps that job, and keeps its
// tests for it; what matters here is that nothing is emitted by mistake.
test('a non-continuation dispatch emits nothing even with a session id', () => {
  const root = fixture()
  assert.equal(handleStart({ agent_type: 'general-purpose', agent_id: 'x', session_id: 'sess-1' }, { root }), null)
})

test('a continuation context carries no armed notice of its own', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-8', { ...BATON, runId: 'dead-8' })
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-8', session_id: 'sess-3' }, { root, readTailFn: () => 'T' })
  assert.equal(out.systemMessage, undefined)
  assert.match(out.hookSpecificOutput.additionalContext, /dead-8/)
})
