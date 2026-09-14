import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitState, MAX_PATHSPEC } from '../lib/gitstate.mjs'

function repo () {
  const root = mkdtempSync(join(tmpdir(), 'ccd-git-'))
  const run = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  run('init', '-q')
  run('config', 'user.email', 't@t.t')
  run('config', 'user.name', 'T')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'mine.js'), 'const a = 1\n')
  writeFileSync(join(root, 'src', 'theirs.js'), 'const b = 1\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'init')
  return root
}

test('returns empty state when no files are given', () => {
  const root = repo()
  const out = gitState(root, [])
  assert.deepEqual(out.files, [])
  assert.equal(out.status, '')
  assert.equal(out.diffstat, '')
})

test('reports changes for the scoped file only', () => {
  const root = repo()
  writeFileSync(join(root, 'src', 'mine.js'), 'const a = 2\n')
  writeFileSync(join(root, 'src', 'theirs.js'), 'const b = 2\n')
  const out = gitState(root, ['src/mine.js'])
  assert.match(out.status, /mine\.js/)
  assert.doesNotMatch(out.status, /theirs\.js/)
  assert.match(out.diffstat, /mine\.js/)
  assert.doesNotMatch(out.diffstat, /theirs\.js/)
})

test('reports untracked files inside the scope', () => {
  const root = repo()
  writeFileSync(join(root, 'src', 'new.js'), 'const c = 1\n')
  const out = gitState(root, ['src/new.js'])
  assert.match(out.status, /new\.js/)
})

test('truncates an oversized file list and flags it', () => {
  const root = repo()
  const many = Array.from({ length: MAX_PATHSPEC + 10 }, (_, i) => `src/f${i}.js`)
  const out = gitState(root, many)
  assert.equal(out.truncated, true)
  assert.equal(out.files.length, MAX_PATHSPEC)
})

test('returns empty strings rather than throwing outside a repository', () => {
  const notRepo = mkdtempSync(join(tmpdir(), 'ccd-norepo-'))
  const out = gitState(notRepo, ['a.js'])
  assert.equal(out.status, '')
  assert.equal(out.diffstat, '')
})
