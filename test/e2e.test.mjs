import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
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

// --- C1, reproduced end to end: a null areas used to kill the whole relay ---

test('a hand-written ledger with a null areas does not swallow the refusal', () => {
  const root = project()
  writeFileSync(join(root, 'src', 'inject', 'a.c'), 'int main(void){return 1;}' + String.fromCharCode(10))
  const transcript = refusedTranscript(root)
  mkdirSync(join(root, '.ccd'), { recursive: true })
  writeFileSync(join(root, '.ccd', 'risk-ledger.json'), '{"version":1,"areas":null}')

  const stop = runHook(STOP, {
    agent_id: 'dead-null',
    agent_type: 'general-purpose',
    agent_transcript_path: transcript
  }, root)

  assert.ok(stop !== null, 'the hook must not exit silently')
  assert.match(stop.systemMessage, /refused by guardrails/i)
  assert.ok(existsSync(join(root, '.ccd', 'runs', 'dead-null', 'baton.json')))
  const ledger = JSON.parse(readFileSync(join(root, '.ccd', 'risk-ledger.json'), 'utf8'))
  assert.equal(ledger.areas['src/inject/**'].kills, 1)
})

// --- C3, reproduced end to end: the pointer targets the right run ---

test('the pointer hands the successor its own run, not the newest', () => {
  const root = project()
  writeFileSync(join(root, 'src', 'inject', 'a.c'), 'int main(void){return 1;}' + String.fromCharCode(10))
  const transcriptA = join(root, 'deadA.jsonl')
  writeFileSync(transcriptA, JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-4-8', stop_reason: 'refusal', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(root, 'src', 'inject', 'a.c') } }] }
  }))
  runHook(STOP, { agent_id: 'runA', agent_type: 'general-purpose', agent_transcript_path: transcriptA }, root)

  const transcriptB = refusedTranscript(root)
  runHook(STOP, { agent_id: 'runB', agent_type: 'general-purpose', agent_transcript_path: transcriptB }, root)

  writeFileSync(join(root, '.ccd', 'next-claim'), 'runA')
  const start = runHook(START, { agent_type: 'ccd-continuation', agent_id: 'succ-A' }, root)
  assert.match(start.hookSpecificOutput.additionalContext, /runA/)
  assert.doesNotMatch(start.hookSpecificOutput.additionalContext, /resuming run `runB`/)
  assert.ok(existsSync(join(root, '.ccd', 'runs', 'runB', 'baton.json')))
  assert.equal(existsSync(join(root, '.ccd', 'runs', 'runB', 'claimed.lock')), false, 'runB must not be orphaned')
})

test('six concurrent refusals all reach the ledger', async () => {
  const root = project()
  writeFileSync(join(root, 'src', 'inject', 'a.c'), 'int main(void){return 1;}' + String.fromCharCode(10))
  const transcript = refusedTranscript(root)
  const run = promisify(execFile)
  await Promise.all(Array.from({ length: 6 }, (unused, i) => {
    const child = run(process.execPath, [STOP], { cwd: root, encoding: 'utf8' })
    child.child.stdin.end(JSON.stringify({
      agent_id: `race-${i}`,
      agent_type: 'general-purpose',
      agent_transcript_path: transcript
    }))
    return child
  }))
  const ledger = JSON.parse(readFileSync(join(root, '.ccd', 'risk-ledger.json'), 'utf8'))
  assert.equal(ledger.areas['src/inject/**'].kills, 6, 'clustered refusals are the design case')
  assert.equal(ledger.areas['src/inject/**'].attempts, 6)
})
