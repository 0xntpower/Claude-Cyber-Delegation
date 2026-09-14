import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, classifyTail, readTail } from '../lib/classify.mjs'

function withTail (text) {
  return () => text
}

test('detects a refusal from the stop_reason marker', () => {
  const tail = withTail('{"type":"assistant","message":{"stop_reason":"refusal"}}')
  assert.equal(classify({ transcriptPath: 'x', readTailFn: tail }), 'refusal')
})

test('detects a refusal from safeguard error text', () => {
  const tail = withTail('Opus 4.8\'s safeguards flagged this message.')
  assert.equal(classify({ transcriptPath: 'x', readTailFn: tail }), 'refusal')
})

test('detects a rate limit', () => {
  const tail = withTail('{"error":{"type":"rate_limit_error"}}')
  assert.equal(classify({ transcriptPath: 'x', readTailFn: tail }), 'rate_limit')
})

test('a refusal outranks a rate limit when both appear', () => {
  const tail = withTail('rate_limit_error ... later "stop_reason":"refusal"')
  assert.equal(classify({ transcriptPath: 'x', readTailFn: tail }), 'refusal')
})

test('a clean transcript classifies as normal', () => {
  const tail = withTail('{"type":"assistant","message":{"stop_reason":"end_turn"}}')
  assert.equal(classify({ transcriptPath: 'x', readTailFn: tail }), 'normal')
})

test('a missing transcript path classifies as normal', () => {
  assert.equal(classify({ transcriptPath: undefined }), 'normal')
})

test('readTail returns only the final bytes of a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-tail-'))
  const f = join(dir, 't.jsonl')
  writeFileSync(f, 'A'.repeat(1000) + 'TAILMARK')
  const out = readTail(f, 16)
  assert.ok(out.endsWith('TAILMARK'))
  assert.equal(out.length, 16)
})

test('readTail returns an empty string for a missing file', () => {
  assert.equal(readTail('/definitely/not/here.jsonl', 100), '')
})

test('classifyTail works directly on already-read text', () => {
  assert.equal(classifyTail('"stop_reason":"refusal"'), 'refusal')
  assert.equal(classifyTail('rate_limit_error'), 'rate_limit')
  assert.equal(classifyTail(''), 'normal')
  assert.equal(classifyTail(undefined), 'normal')
})
