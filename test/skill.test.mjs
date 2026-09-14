import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const RAW = () => readFileSync('skills/cyber-delegation/SKILL.md', 'utf8')

test('the skill has name and description frontmatter', () => {
  const match = /^---\n([\s\S]*?)\n---/.exec(RAW())
  assert.ok(match)
  assert.match(match[1], /name:\s*cyber-delegation/)
  assert.match(match[1], /description:/)
})

test('the skill forbids reading refused output', () => {
  assert.match(RAW(), /do not read/i)
})

test('the skill forbids reword-and-retry', () => {
  assert.match(RAW(), /reword/i)
})

test('the skill names all three agents', () => {
  const raw = RAW()
  for (const name of ['ccd-continuation', 'ccd-implementer', 'ccd-reviewer']) {
    assert.ok(raw.includes(name), `skill must name ${name}`)
  }
})

test('the skill states that scores are advisory', () => {
  assert.match(RAW(), /advisor/i)
})

test('the skill explains how to record a risk hint', () => {
  assert.match(RAW(), /risk-ledger\.json/)
})
