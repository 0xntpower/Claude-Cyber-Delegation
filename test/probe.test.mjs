import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interpretProbe, probeAndWrite } from '../scripts/probe-1m.mjs'
import { ccdPaths } from '../lib/paths.mjs'

test('a clean run enables the 1m suffix', () => {
  const out = interpretProbe('OK', '', false)
  assert.equal(out.suffix, '[1m]')
  assert.equal(out.conclusive, true)
})

test('an explicit unsupported error disables the suffix', () => {
  const out = interpretProbe('', "Opus 4.6 doesn't have a 1M context window", true)
  assert.equal(out.suffix, '')
  assert.equal(out.conclusive, true)
})

test('the alias_1m_unsupported marker disables the suffix', () => {
  const out = interpretProbe('', 'alias_1m_unsupported', true)
  assert.equal(out.suffix, '')
  assert.equal(out.conclusive, true)
})

test('an unrelated failure is inconclusive and defaults to no suffix', () => {
  const out = interpretProbe('', 'Credit balance is too low', true)
  assert.equal(out.suffix, '')
  assert.equal(out.conclusive, false)
  assert.match(out.reason, /inconclusive/i)
})

test('probeAndWrite persists the result into config', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-probe-'))
  mkdirSync(join(root, '.git'))
  const result = probeAndWrite(root, () => ({ stdout: 'OK', stderr: '', failed: false }))
  assert.equal(result.suffix, '[1m]')
  const cfg = JSON.parse(readFileSync(ccdPaths(root).config, 'utf8'))
  assert.equal(cfg.oneMillionSuffix, '[1m]')
})

test('probeAndWrite preserves existing config keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-probe2-'))
  mkdirSync(join(root, '.git'))
  probeAndWrite(root, () => ({ stdout: '', stderr: 'alias_1m_unsupported', failed: true }))
  const cfg = JSON.parse(readFileSync(ccdPaths(root).config, 'utf8'))
  assert.equal(cfg.oneMillionSuffix, '')
  assert.equal(cfg.maxAttempts, 2)
  assert.deepEqual(cfg.ladder, ['claude-opus-4-6'])
})
