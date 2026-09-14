import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleStart } from '../hooks/subagent-start.mjs'
import { ccdPaths } from '../lib/paths.mjs'
import { writeBaton, readOrigin } from '../lib/baton.mjs'

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
