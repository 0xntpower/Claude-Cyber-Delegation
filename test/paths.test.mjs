import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProjectRoot, ccdPaths, loadConfig, DEFAULT_CONFIG } from '../lib/paths.mjs'

function fixture () {
  const root = mkdtempSync(join(tmpdir(), 'ccd-paths-'))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  return root
}

test('findProjectRoot walks up to the directory containing .git', () => {
  const root = fixture()
  assert.equal(findProjectRoot(join(root, 'src', 'deep')), root)
})

test('findProjectRoot falls back to the start directory when no .git exists', () => {
  const lonely = mkdtempSync(join(tmpdir(), 'ccd-nogit-'))
  assert.equal(findProjectRoot(lonely), lonely)
})

test('ccdPaths places state under .ccd', () => {
  const p = ccdPaths('/proj')
  assert.ok(p.base.endsWith('.ccd'))
  assert.ok(p.config.endsWith('config.json'))
  assert.ok(p.ledger.endsWith('risk-ledger.json'))
  assert.ok(p.runs.endsWith('runs'))
})

test('loadConfig returns defaults when no config file exists', () => {
  const root = fixture()
  assert.deepEqual(loadConfig(root), DEFAULT_CONFIG)
})

test('loadConfig merges a partial config over defaults', () => {
  const root = fixture()
  mkdirSync(join(root, '.ccd'))
  writeFileSync(join(root, '.ccd', 'config.json'), JSON.stringify({ maxAttempts: 5 }))
  const cfg = loadConfig(root)
  assert.equal(cfg.maxAttempts, 5)
  assert.deepEqual(cfg.ladder, DEFAULT_CONFIG.ladder)
})

test('loadConfig survives a corrupt config file', () => {
  const root = fixture()
  mkdirSync(join(root, '.ccd'))
  writeFileSync(join(root, '.ccd', 'config.json'), '{ not json')
  assert.deepEqual(loadConfig(root), DEFAULT_CONFIG)
})
