import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const STOP = resolve('hooks/subagent-stop.mjs')
const START = resolve('hooks/subagent-start.mjs')

function runHook (script, payload, cwd) {
  const out = execFileSync('node', [script], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  })
  return out.trim().length === 0 ? null : JSON.parse(out)
}

function project () {
  const root = mkdtempSync(join(tmpdir(), 'ccd-e2e-'))
  const run = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  run('init', '-q')
  run('config', 'user.email', 't@t.t')
  run('config', 'user.name', 'T')
  mkdirSync(join(root, 'src', 'inject'), { recursive: true })
  writeFileSync(join(root, 'src', 'inject', 'a.c'), 'int main(void){return 0;}\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'init')
  return root
}

function refusedTranscript (root) {
  const file = join(root, 'dead.jsonl')
  const lines = [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(root, 'src', 'inject', 'a.c') } }] } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', stop_reason: 'refusal' } })
  ]
  writeFileSync(file, lines.join('\n'))
  return file
}

test('hooks.json wires both events to the entry points', () => {
  const cfg = JSON.parse(readFileSync('hooks/hooks.json', 'utf8'))
  assert.ok(Array.isArray(cfg.hooks.SubagentStop))
  assert.ok(Array.isArray(cfg.hooks.SubagentStart))
  assert.match(cfg.hooks.SubagentStop[0].hooks[0].command, /subagent-stop\.mjs/)
  assert.match(cfg.hooks.SubagentStart[0].hooks[0].command, /subagent-start\.mjs/)
})

test('stop_hook_active produces no output at all', () => {
  const root = project()
  assert.equal(runHook(STOP, { stop_hook_active: true, agent_id: 'x' }, root), null)
})

test('a refusal followed by a continuation start completes the relay', () => {
  const root = project()
  writeFileSync(join(root, 'src', 'inject', 'a.c'), 'int main(void){return 1;}\n')
  const transcript = refusedTranscript(root)

  const stop = runHook(STOP, {
    agent_id: 'dead-1',
    agent_type: 'general-purpose',
    agent_transcript_path: transcript
  }, root)
  assert.match(stop.systemMessage, /refused by guardrails/i)
  assert.ok(existsSync(join(root, '.ccd', 'runs', 'dead-1', 'baton.json')))

  const ledger = JSON.parse(readFileSync(join(root, '.ccd', 'risk-ledger.json'), 'utf8'))
  assert.equal(ledger.areas['src/inject/**'].kills, 1)

  const start = runHook(START, {
    agent_type: 'ccd-continuation',
    agent_id: 'succ-1'
  }, root)
  const ctx = start.hookSpecificOutput.additionalContext
  assert.match(ctx, /src\/inject\/a\.c/)
  assert.match(ctx, /claude-opus-4-8/)
  assert.match(ctx, /stop_reason/)
})

test('a malformed stdin payload exits cleanly', () => {
  const root = project()
  const out = execFileSync('node', [STOP], { input: 'not json', cwd: root, encoding: 'utf8' })
  assert.equal(out.trim(), '')
})
