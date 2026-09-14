import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ccdPaths } from '../lib/paths.mjs'
import { writeBaton, writeOrigin, readOrigin, claimNewestBaton, runDir } from '../lib/baton.mjs'

function fixture () {
  const root = mkdtempSync(join(tmpdir(), 'ccd-baton-'))
  return ccdPaths(root)
}

test('writeBaton creates the run directory and file', () => {
  const paths = fixture()
  writeBaton(paths, 'agent-1', { attempt: 1, transcript: '/t.jsonl' })
  assert.ok(existsSync(join(runDir(paths, 'agent-1'), 'baton.json')))
})

test('claimNewestBaton returns the most recently written baton', () => {
  const paths = fixture()
  writeBaton(paths, 'old', { attempt: 1, marker: 'old' })
  const oldFile = join(runDir(paths, 'old'), 'baton.json')
  const past = new Date(Date.now() - 60000)
  utimesSync(oldFile, past, past)
  writeBaton(paths, 'new', { attempt: 1, marker: 'new' })
  const claimed = claimNewestBaton(paths)
  assert.equal(claimed.runId, 'new')
  assert.equal(claimed.baton.marker, 'new')
})

test('a baton can only be claimed once', () => {
  const paths = fixture()
  writeBaton(paths, 'only', { attempt: 1 })
  assert.equal(claimNewestBaton(paths).runId, 'only')
  assert.equal(claimNewestBaton(paths), null)
})

test('claiming skips already-locked batons and takes the next one', () => {
  const paths = fixture()
  writeBaton(paths, 'first', { attempt: 1, marker: 'first' })
  const firstFile = join(runDir(paths, 'first'), 'baton.json')
  const past = new Date(Date.now() - 60000)
  utimesSync(firstFile, past, past)
  writeBaton(paths, 'second', { attempt: 1, marker: 'second' })
  assert.equal(claimNewestBaton(paths).runId, 'second')
  assert.equal(claimNewestBaton(paths).runId, 'first')
})

test('claimNewestBaton returns null when there is nothing to claim', () => {
  assert.equal(claimNewestBaton(fixture()), null)
})

test('origin round-trips and returns null when absent', () => {
  const paths = fixture()
  assert.equal(readOrigin(paths, 'nobody'), null)
  writeOrigin(paths, 'agent-2', { fromRunId: 'agent-1', attempt: 1 })
  assert.deepEqual(readOrigin(paths, 'agent-2'), { fromRunId: 'agent-1', attempt: 1 })
})

test('readOrigin survives a corrupt origin file', () => {
  const paths = fixture()
  mkdirSync(runDir(paths, 'bad'), { recursive: true })
  writeFileSync(join(runDir(paths, 'bad'), 'origin.json'), 'nope')
  assert.equal(readOrigin(paths, 'bad'), null)
})
