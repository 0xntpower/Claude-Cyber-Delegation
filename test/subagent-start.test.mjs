import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleStart } from '../hooks/subagent-start.mjs'
import { ccdPaths } from '../lib/paths.mjs'
import { writeBaton, readOrigin, writeNextClaim, readNextClaim, claimNewestBaton } from '../lib/baton.mjs'
import { utimesSync } from 'node:fs'

function fixture () {
  const root = mkdtempSync(join(tmpdir(), 'ccd-start-'))
  mkdirSync(join(root, '.git'))
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
