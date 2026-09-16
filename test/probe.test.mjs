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

// --- I1: the probe records, it does not enable ---

test('the README says the probe only records the answer', () => {
  const readme = readFileSync('README.md', 'utf8')
  assert.match(readme, /records/i)
})

// --- Doc correction: the 1m question is settled by measurement, not deferred ---

// Asserts the claim, not one word of the prose that carries it. The earlier
// version pinned the literal "measured" and went red the next time the README
// was reworded, which is the failure mode of testing wording rather than
// meaning.
test('the README states the pin is honoured and no hand edit is needed', () => {
  const readme = readFileSync('README.md', 'utf8')
  assert.match(readme, /pin holds|pin is honoured|confirmed the pin/i)
  assert.match(readme, /no hand edit is needed/i)
  assert.doesNotMatch(readme, /unconfirmed/i)
})

test('the spec says the probe records rather than enables', () => {
  const spec = readFileSync('docs/superpowers/specs/2026-09-14-cyber-delegation-design.md', 'utf8')
  assert.match(spec, /probe records, it does not enable/i)
})

// --- I2: the ladder cannot select a model, and the spec must say so ---

test('the spec says nextModel records intent rather than selecting a model', () => {
  const spec = readFileSync('docs/superpowers/specs/2026-09-14-cyber-delegation-design.md', 'utf8')
  assert.match(spec, /records intent, it does not select a model/i)
})
