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

// --- N4: the successor's own prompt must not claim to get the full transcript ---

test('ccd-continuation does not claim to receive the full transcript', () => {
  assert.doesNotMatch(frontmatter('ccd-continuation').body, /full transcript/i)
})

test('ccd-continuation says it receives a capped final portion instead', () => {
  const body = frontmatter('ccd-continuation').body
  assert.match(body, /final portion/i)
  assert.match(body, /capped/i)
  // The evidence is a file now, not injected text, and the agent has to be
  // told to open it or it will work from the brief alone.
  assert.match(body, /\.ccd\/runs\//)
  assert.match(body, /read that file first/i)
})

// --- N3: the successor must be told to check it got the right run ---

test('ccd-continuation is told to compare its run id against the injected header', () => {
  const body = frontmatter('ccd-continuation').body
  assert.match(body, /run id/i)
  assert.match(body, /mismatch|differ/i)
})

test('ccd-reviewer has no write tools', () => {
  const tools = frontmatter('ccd-reviewer').fields.tools
  assert.doesNotMatch(tools, /\bEdit\b/)
  assert.doesNotMatch(tools, /\bWrite\b/)
})
