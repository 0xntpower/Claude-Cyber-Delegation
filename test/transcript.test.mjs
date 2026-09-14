import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractEditedPaths } from '../lib/transcript.mjs'

function toolUse (name, filePath) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input: { file_path: filePath } }] }
  }
}

test('returns project-relative forward-slashed paths, sorted and deduplicated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-tx2-'))
  const f = join(dir, 't.jsonl')
  writeFileSync(f, [
    JSON.stringify(toolUse('Write', join(dir, 'src', 'b.js'))),
    JSON.stringify(toolUse('Edit', join(dir, 'src', 'a.js'))),
    JSON.stringify(toolUse('Edit', join(dir, 'src', 'a.js')))
  ].join('\n'))
  assert.deepEqual(extractEditedPaths(f, dir), ['src/a.js', 'src/b.js'])
})

test('drops paths outside the project root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-tx3-'))
  const f = join(dir, 't.jsonl')
  writeFileSync(f, [
    JSON.stringify(toolUse('Write', join(dir, 'keep.js'))),
    JSON.stringify(toolUse('Write', join(tmpdir(), 'elsewhere', 'drop.output')))
  ].join('\n'))
  assert.deepEqual(extractEditedPaths(f, dir), ['keep.js'])
})

test('ignores non-editing tool calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-tx4-'))
  const f = join(dir, 't.jsonl')
  writeFileSync(f, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(dir, 'r.js') } }] } }),
    JSON.stringify(toolUse('Edit', join(dir, 'e.js')))
  ].join('\n'))
  assert.deepEqual(extractEditedPaths(f, dir), ['e.js'])
})

test('tolerates malformed lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-tx5-'))
  const f = join(dir, 't.jsonl')
  writeFileSync(f, '{ broken\n' + JSON.stringify(toolUse('Edit', join(dir, 'ok.js'))) + '\n\n')
  assert.deepEqual(extractEditedPaths(f, dir), ['ok.js'])
})

test('picks up notebook_path for NotebookEdit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-tx6-'))
  const f = join(dir, 't.jsonl')
  writeFileSync(f, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: join(dir, 'n.ipynb') } }] }
  }))
  assert.deepEqual(extractEditedPaths(f, dir), ['n.ipynb'])
})

test('returns an empty array for a missing transcript', () => {
  assert.deepEqual(extractEditedPaths('/nope/t.jsonl', '/proj'), [])
})
