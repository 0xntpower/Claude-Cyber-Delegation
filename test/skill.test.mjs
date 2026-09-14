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

// --- I3: the skill must not teach hand-writing the ledger ---

test('the skill points at the set-prior script for risk hints', () => {
  assert.match(RAW(), /scripts\/set-prior\.mjs/)
})

test('the skill no longer shows a raw ledger JSON body to copy', () => {
  const raw = RAW()
  assert.doesNotMatch(raw, /"lastOpus5AttemptAt"/)
  assert.doesNotMatch(raw, /"dispatchesSinceOpus5"/)
  assert.match(raw, /do not hand-write/i)
})

// --- C3: the skill must teach the pointer, and admit the fallback ---

test('the skill tells the orchestrator to write the run id pointer', () => {
  const raw = RAW()
  assert.match(raw, /\.ccd\/next-claim/)
  assert.match(raw, /before you dispatch/i)
})

test('the skill states plainly what happens without the pointer', () => {
  assert.match(RAW(), /newest unclaimed baton/i)
})

// --- M4: the evidence bias must be stated where a score is read ---

test('the skill warns that ledger evidence is biased low', () => {
  const raw = RAW()
  assert.match(raw, /wrote nothing to disk|never write/i)
  assert.match(raw, /one kill in\s+five/i)
})
