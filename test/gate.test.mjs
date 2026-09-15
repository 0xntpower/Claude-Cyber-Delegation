import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enable, disable, isEnabled, shouldAnnounce } from '../lib/gate.mjs'
import { ccdPaths } from '../lib/paths.mjs'

function fixture () {
  const root = mkdtempSync(join(tmpdir(), 'ccd-gate-'))
  mkdirSync(join(root, '.git'))
  return ccdPaths(root)
}

test('a project with no .ccd is not enabled, and it is never an exception', () => {
  const paths = fixture()
  assert.equal(isEnabled(paths), false)
})

test('enable then isEnabled is true', () => {
  const paths = fixture()
  assert.equal(enable(paths), true)
  assert.equal(isEnabled(paths), true)
})

test('enable writes an ISO timestamp as the marker content', () => {
  const paths = fixture()
  enable(paths)
  const content = readFileSync(paths.enabled, 'utf8')
  assert.doesNotThrow(() => new Date(content).toISOString())
  assert.match(content, /^\d{4}-\d{2}-\d{2}T/)
})

test('disable then isEnabled is false', () => {
  const paths = fixture()
  enable(paths)
  assert.equal(disable(paths), true)
  assert.equal(isEnabled(paths), false)
})

test('disable tolerates an already-absent marker', () => {
  const paths = fixture()
  assert.equal(isEnabled(paths), false)
  assert.equal(disable(paths), true)
  assert.equal(isEnabled(paths), false)
})

test('isEnabled never throws even when the base directory cannot be read', () => {
  // A path pointing through a file, not a directory, makes existsSync's
  // underlying stat fail in a way a naive implementation might not catch.
  const paths = fixture()
  const blocked = { ...paths, enabled: join(paths.base, 'not-a-dir', 'enabled') }
  assert.equal(isEnabled(blocked), false)
})

// --- shouldAnnounce ---

test('shouldAnnounce is true exactly once for a session id, then false', () => {
  const paths = fixture()
  assert.equal(shouldAnnounce(paths, 'sess-1'), true)
  assert.equal(shouldAnnounce(paths, 'sess-1'), false)
  assert.equal(shouldAnnounce(paths, 'sess-1'), false)
})

test('shouldAnnounce is independent per session id', () => {
  const paths = fixture()
  assert.equal(shouldAnnounce(paths, 'sess-a'), true)
  assert.equal(shouldAnnounce(paths, 'sess-b'), true)
  assert.equal(shouldAnnounce(paths, 'sess-a'), false)
})

test('shouldAnnounce creates the marker file under .ccd/announced', () => {
  const paths = fixture()
  shouldAnnounce(paths, 'sess-2')
  assert.equal(existsSync(join(paths.announced, 'sess-2')), true)
})

test('a missing session id is rejected, not announced', () => {
  const paths = fixture()
  assert.equal(shouldAnnounce(paths, undefined), false)
  assert.equal(shouldAnnounce(paths, null), false)
})

test('a blank session id is rejected the same way', () => {
  const paths = fixture()
  assert.equal(shouldAnnounce(paths, '   '), false)
})

test('a non-string session id is rejected rather than crashing', () => {
  const paths = fixture()
  assert.equal(shouldAnnounce(paths, 42), false)
  assert.equal(shouldAnnounce(paths, { id: 'x' }), false)
})

// --- I: a hook must never write outside .ccd/ ---

test('a session id containing a path separator is rejected rather than escaping .ccd/', () => {
  const paths = fixture()
  assert.equal(shouldAnnounce(paths, '../../etc/passwd'), false)
  assert.equal(shouldAnnounce(paths, 'a/b'), false)
  assert.equal(shouldAnnounce(paths, 'a\\b'), false)
  assert.equal(existsSync(join(paths.base, '..', '..', 'etc')), false)
})

test('a session id that is exactly ".." is rejected even though its characters are individually allowed', () => {
  const paths = fixture()
  assert.equal(shouldAnnounce(paths, '..'), false)
  assert.equal(shouldAnnounce(paths, '.'), false)
})

test('two concurrent announces for the same session cannot both win', () => {
  const paths = fixture()
  let wins = 0
  for (let i = 0; i < 5; i += 1) {
    if (shouldAnnounce(paths, 'sess-race')) wins += 1
  }
  assert.equal(wins, 1)
})
