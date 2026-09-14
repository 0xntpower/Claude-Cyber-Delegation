import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const AGENTS = ['ccd-continuation', 'ccd-implementer', 'ccd-reviewer']

function frontmatter (name) {
  const raw = readFileSync(`agents/${name}.md`, 'utf8')
  const match = /^---\n([\s\S]*?)\n---/.exec(raw)
  assert.ok(match, `${name} must have frontmatter`)
  const fields = {}
  for (const line of match[1].split('\n')) {
    const cut = line.indexOf(':')
    if (cut === -1) continue
    fields[line.slice(0, cut).trim()] = line.slice(cut + 1).trim()
  }
  return { fields, body: raw.slice(match[0].length) }
}

for (const name of AGENTS) {
  test(`${name} pins the fully qualified model ID`, () => {
    assert.equal(frontmatter(name).fields.model, 'claude-opus-4-6')
  })

  test(`${name} declares a name matching its filename`, () => {
    assert.equal(frontmatter(name).fields.name, name)
  })

  test(`${name} instructs the agent to state its model first`, () => {
    assert.match(frontmatter(name).body, /first line/i)
  })

  test(`${name} bans the destructive git verbs`, () => {
    const body = frontmatter(name).body
    for (const verb of ['git add -A', 'git stash', 'git checkout', 'git restore', 'git commit']) {
      assert.ok(body.includes(verb), `${name} must ban ${verb}`)
    }
  })
}

test('ccd-reviewer has no write tools', () => {
  const tools = frontmatter('ccd-reviewer').fields.tools
  assert.doesNotMatch(tools, /\bEdit\b/)
  assert.doesNotMatch(tools, /\bWrite\b/)
})
