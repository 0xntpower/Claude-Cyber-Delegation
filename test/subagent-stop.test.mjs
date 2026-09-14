import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleStop } from '../hooks/subagent-stop.mjs'
import { ccdPaths } from '../lib/paths.mjs'
import { writeOrigin } from '../lib/baton.mjs'

function deps (overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ccd-stop-'))
  mkdirSync(join(root, '.git'))
  return {
    root,
    readTailFn: () => '{"model":"claude-opus-4-8","stop_reason":"refusal"}',
    classifyFn: () => 'refusal',
    extractFn: () => ['src/inject/a.c'],
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
  const d = deps({ readTailFn: () => '{"model":"claude-opus-5[1m]","stop_reason":"refusal"}' })
  const out = handleStop({ agent_id: 'a7', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  const baton = JSON.parse(readFileSync(join(ccdPaths(d.root).runs, 'a7', 'baton.json'), 'utf8'))
  assert.equal(baton.refusedModel, 'claude-opus-5[1m]')
})
