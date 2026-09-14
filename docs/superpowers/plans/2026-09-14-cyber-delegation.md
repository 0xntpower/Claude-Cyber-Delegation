# Cyber Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that lets an orchestrator dispatch Opus 4.6 subagents directly, and automatically hands guardrail-refused work to them with the dead agent's transcript and correctly scoped git state intact.

**Architecture:** Two hooks and a small library. `SubagentStop` detects a refusal, extracts which files the dead agent touched from its own transcript, scopes git state to those files, and writes a baton to disk. `SubagentStart` claims that baton and injects it into a continuation agent whose frontmatter pins `claude-opus-4-6`. A risk ledger accumulates advisory 1-to-10 scores per path glob from observed outcomes. Nothing the plugin knows ever gates a dispatch.

**Tech Stack:** Node ESM, zero runtime dependencies, `node:test` built-in test runner, git CLI.

**Spec:** `docs/superpowers/specs/2026-09-14-cyber-delegation-design.md`

## Global Constraints

- **Node ESM only, zero runtime dependencies.** `jq` is absent on the target machine. Node v24.11.1 is present.
- **All JavaScript is written without statement-terminating semicolons.** A repository `humanize` hook rejects writes containing them. Avoid ASI hazards by never starting a line with `(`, `[`, or a backtick.
- **Hooks must never throw.** A hook that crashes degrades the user's session. Every file read, JSON parse, and git invocation is wrapped so that failure yields a safe default and exit code 0.
- **`stop_hook_active` must short-circuit before any other work** in `subagent-stop.mjs`. Without it the plugin ships an infinite refusal-to-relaunch loop.
- **The pinned model is `claude-opus-4-6`**, declared in agent frontmatter. The `Agent` tool's `model` parameter is an alias enum and cannot express it.
- **Scores are advisory.** No code path may block, gate, or override a dispatch.
- Target model ladder default: `["claude-opus-4-6"]`. Default `maxAttempts`: `2`.
- Staleness defaults: `staleAfterDispatches` `10`, `staleAfterDays` `30`.
- Transcript tail scanned for classification: `262144` bytes. Maximum transcript injected into a successor: `400000` bytes.

---

## File Structure

| File | Responsibility |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest |
| `hooks/hooks.json` | Event wiring for SubagentStop and SubagentStart |
| `hooks/subagent-stop.mjs` | Entry point. Classify, capture, write baton, update ledger |
| `hooks/subagent-start.mjs` | Entry point. Claim baton, emit additionalContext |
| `lib/paths.mjs` | Project root discovery, `.ccd` locations, config with defaults |
| `lib/classify.mjs` | Transcript tail reading and outcome classification |
| `lib/transcript.mjs` | Edited-path extraction from JSONL, filtered to the project |
| `lib/gitstate.mjs` | Git status and diffstat scoped to a file list |
| `lib/ledger.mjs` | Risk scores, evidence accumulation, area derivation, staleness |
| `lib/baton.mjs` | Baton write, atomic claim, origin linkage for attempt counting |
| `agents/ccd-continuation.md` | Pinned-4.6 agent that resumes refused work |
| `agents/ccd-implementer.md` | Pinned-4.6 agent for direct dispatch |
| `agents/ccd-reviewer.md` | Pinned-4.6 reviewer, no Edit or Write tools |
| `skills/cyber-delegation/SKILL.md` | Orchestrator-facing rules |
| `scripts/probe-1m.mjs` | Install-time `[1m]` capability probe |
| `test/*.test.mjs` | One suite per lib module, plus two entry-point suites |

---

## Task 1: Plugin skeleton and configuration

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `package.json`
- Create: `lib/paths.mjs`
- Create: `.gitignore`
- Test: `test/paths.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `findProjectRoot(startDir) -> string`, `ccdPaths(root) -> {base, config, ledger, runs}`, `loadConfig(root) -> object`, `DEFAULT_CONFIG`

- [ ] **Step 1: Write the failing test**

Create `test/paths.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paths.test.mjs`
Expected: FAIL with `Cannot find module '../lib/paths.mjs'`

- [ ] **Step 3: Write the manifest and package files**

Create `.claude-plugin/plugin.json`:

```json
{
  "name": "cyber-delegation",
  "description": "Dispatch Opus 4.6 subagents directly, and hand guardrail-refused work to them automatically with transcript and git state intact",
  "version": "0.1.0",
  "author": { "name": "ntpower" },
  "license": "MIT",
  "keywords": ["guardrails", "delegation", "subagents", "failover"]
}
```

Create `package.json`:

```json
{
  "name": "cyber-delegation",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "node --test test/"
  }
}
```

Create `.gitignore`:

```
node_modules/
.ccd/
.superpowers/
```

- [ ] **Step 4: Write minimal implementation**

Create `lib/paths.mjs`:

```js
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const DEFAULT_CONFIG = {
  ladder: ['claude-opus-4-6'],
  maxAttempts: 2,
  oneMillionSuffix: '',
  staleAfterDispatches: 10,
  staleAfterDays: 30,
  transcriptTailBytes: 262144,
  maxInjectedTranscriptBytes: 400000
}

export function findProjectRoot (startDir) {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(startDir)
    dir = parent
  }
}

export function ccdPaths (root) {
  const base = join(root, '.ccd')
  return {
    base,
    config: join(base, 'config.json'),
    ledger: join(base, 'risk-ledger.json'),
    runs: join(base, 'runs')
  }
}

export function loadConfig (root) {
  const { config } = ccdPaths(root)
  if (!existsSync(config)) return { ...DEFAULT_CONFIG }
  try {
    const parsed = JSON.parse(readFileSync(config, 'utf8'))
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/paths.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json package.json .gitignore lib/paths.mjs test/paths.test.mjs
git commit -m "feat: plugin skeleton and configuration loading"
```

---

## Task 2: Outcome classification

**Files:**
- Create: `lib/classify.mjs`
- Test: `test/classify.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `readTail(path, maxBytes) -> string`, `classifyTail(text) -> 'refusal' | 'rate_limit' | 'normal'`, `classify({transcriptPath, tailBytes, readTailFn}) -> 'refusal' | 'rate_limit' | 'normal'`

`classifyTail` exists so that `subagent-stop.mjs` can read the tail once and use the same text for both classification and model extraction, rather than reading the file twice.

**Why this reads the transcript and not `last_assistant_message`:** on a refusal that field carries the partial text the agent emitted before dying, not the refusal marker. Classifying from it would report `normal` on every refusal.

- [ ] **Step 1: Write the failing test**

Create `test/classify.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, classifyTail, readTail } from '../lib/classify.mjs'

function withTail (text) {
  return () => text
}

test('detects a refusal from the stop_reason marker', () => {
  const tail = withTail('{"type":"assistant","message":{"stop_reason":"refusal"}}')
  assert.equal(classify({ transcriptPath: 'x', readTailFn: tail }), 'refusal')
})

test('detects a refusal from safeguard error text', () => {
  const tail = withTail('Opus 4.8’s safeguards flagged this message.')
  assert.equal(classify({ transcriptPath: 'x', readTailFn: tail }), 'refusal')
})

test('detects a rate limit', () => {
  const tail = withTail('{"error":{"type":"rate_limit_error"}}')
  assert.equal(classify({ transcriptPath: 'x', readTailFn: tail }), 'rate_limit')
})

test('a refusal outranks a rate limit when both appear', () => {
  const tail = withTail('rate_limit_error ... later "stop_reason":"refusal"')
  assert.equal(classify({ transcriptPath: 'x', readTailFn: tail }), 'refusal')
})

test('a clean transcript classifies as normal', () => {
  const tail = withTail('{"type":"assistant","message":{"stop_reason":"end_turn"}}')
  assert.equal(classify({ transcriptPath: 'x', readTailFn: tail }), 'normal')
})

test('a missing transcript path classifies as normal', () => {
  assert.equal(classify({ transcriptPath: undefined }), 'normal')
})

test('readTail returns only the final bytes of a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-tail-'))
  const f = join(dir, 't.jsonl')
  writeFileSync(f, 'A'.repeat(1000) + 'TAILMARK')
  const out = readTail(f, 16)
  assert.ok(out.endsWith('TAILMARK'))
  assert.equal(out.length, 16)
})

test('readTail returns an empty string for a missing file', () => {
  assert.equal(readTail('/definitely/not/here.jsonl', 100), '')
})

test('classifyTail works directly on already-read text', () => {
  assert.equal(classifyTail('"stop_reason":"refusal"'), 'refusal')
  assert.equal(classifyTail('rate_limit_error'), 'rate_limit')
  assert.equal(classifyTail(''), 'normal')
  assert.equal(classifyTail(undefined), 'normal')
})
```


- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/classify.test.mjs`
Expected: FAIL with `Cannot find module '../lib/classify.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/classify.mjs`:

```js
import { existsSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'

const REFUSAL = /"stop_reason"\s*:\s*"refusal"|safeguards flagged|stop_details[^}]{0,80}refusal/i
const RATE_LIMIT = /rate_limit_error|"status"\s*:\s*429|rate limit exceeded/i

export function readTail (path, maxBytes) {
  if (!path || !existsSync(path)) return ''
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    if (len <= 0) return ''
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
  }
}

export function classifyTail (text) {
  const tail = text ?? ''
  if (REFUSAL.test(tail)) return 'refusal'
  if (RATE_LIMIT.test(tail)) return 'rate_limit'
  return 'normal'
}

export function classify ({ transcriptPath, tailBytes = 262144, readTailFn = readTail }) {
  return classifyTail(transcriptPath ? readTailFn(transcriptPath, tailBytes) : '')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/classify.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add lib/classify.mjs test/classify.test.mjs
git commit -m "feat: classify subagent outcome from transcript tail"
```

---

## Task 3: Edited-path extraction from transcripts

**Files:**
- Create: `lib/transcript.mjs`
- Test: `test/transcript.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `extractEditedPaths(transcriptPath, projectRoot) -> string[]` returning project-relative, forward-slashed, sorted, deduplicated paths

**Critical behaviour:** paths outside the project root must be dropped. A sampled real transcript contained `file_path` entries under `AppData\Local\Temp`, which would otherwise pollute both the git scope and the derived risk area.

- [ ] **Step 1: Write the failing test**

Create `test/transcript.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractEditedPaths } from '../lib/transcript.mjs'

function toolUse (name, filePath) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input: { file_path: filePath } }] }
  }
}

test('returns project-relative forward-slashed paths, sorted and deduplicated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-tx2-'))
  const f = join(dir, 't.jsonl')
  writeFileSync(f, [
    JSON.stringify(toolUse('Write', join(dir, 'src', 'b.js'))),
    JSON.stringify(toolUse('Edit', join(dir, 'src', 'a.js'))),
    JSON.stringify(toolUse('Edit', join(dir, 'src', 'a.js')))
  ].join('\n'))
  assert.deepEqual(extractEditedPaths(f, dir), ['src/a.js', 'src/b.js'])
})

test('drops paths outside the project root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-tx3-'))
  const f = join(dir, 't.jsonl')
  writeFileSync(f, [
    JSON.stringify(toolUse('Write', join(dir, 'keep.js'))),
    JSON.stringify(toolUse('Write', join(tmpdir(), 'elsewhere', 'drop.output')))
  ].join('\n'))
  assert.deepEqual(extractEditedPaths(f, dir), ['keep.js'])
})

test('ignores non-editing tool calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-tx4-'))
  const f = join(dir, 't.jsonl')
  writeFileSync(f, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(dir, 'r.js') } }] } }),
    JSON.stringify(toolUse('Edit', join(dir, 'e.js')))
  ].join('\n'))
  assert.deepEqual(extractEditedPaths(f, dir), ['e.js'])
})

test('tolerates malformed lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-tx5-'))
  const f = join(dir, 't.jsonl')
  writeFileSync(f, '{ broken\n' + JSON.stringify(toolUse('Edit', join(dir, 'ok.js'))) + '\n\n')
  assert.deepEqual(extractEditedPaths(f, dir), ['ok.js'])
})

test('picks up notebook_path for NotebookEdit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-tx6-'))
  const f = join(dir, 't.jsonl')
  writeFileSync(f, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: join(dir, 'n.ipynb') } }] }
  }))
  assert.deepEqual(extractEditedPaths(f, dir), ['n.ipynb'])
})

test('returns an empty array for a missing transcript', () => {
  assert.deepEqual(extractEditedPaths('/nope/t.jsonl', '/proj'), [])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/transcript.test.mjs`
Expected: FAIL with `Cannot find module '../lib/transcript.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/transcript.mjs`:

```js
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function collect (node, out) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out)
    return
  }
  if (node.type === 'tool_use' && EDIT_TOOLS.has(node.name)) {
    const input = node.input ?? {}
    const found = input.file_path ?? input.notebook_path
    if (typeof found === 'string' && found.length > 0) out.add(found)
  }
  for (const value of Object.values(node)) collect(value, out)
}

export function extractEditedPaths (transcriptPath, projectRoot) {
  if (!transcriptPath || !existsSync(transcriptPath)) return []
  let raw
  try {
    raw = readFileSync(transcriptPath, 'utf8')
  } catch {
    return []
  }
  const found = new Set()
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      collect(JSON.parse(line), found)
    } catch {
      continue
    }
  }
  const root = resolve(projectRoot)
  const scoped = new Set()
  for (const candidate of found) {
    const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
    const rel = relative(root, abs)
    if (rel.length === 0) continue
    if (rel.startsWith('..')) continue
    if (isAbsolute(rel)) continue
    scoped.add(rel.split(sep).join('/'))
  }
  return [...scoped].sort()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/transcript.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add lib/transcript.mjs test/transcript.test.mjs
git commit -m "feat: extract edited paths from a subagent transcript"
```

---

## Task 4: Scoped git state capture

**Files:**
- Create: `lib/gitstate.mjs`
- Test: `test/gitstate.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `gitState(root, files) -> {files: string[], status: string, diffstat: string, truncated: boolean}`

**Why pathspec arguments rather than an unscoped diff:** every agent shares one working tree, with up to three agents plus the orchestrator holding concurrent uncommitted work. An unscoped diff would hand a successor another agent's changes.

- [ ] **Step 1: Write the failing test**

Create `test/gitstate.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/gitstate.test.mjs`
Expected: FAIL with `Cannot find module '../lib/gitstate.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/gitstate.mjs`:

```js
import { execFileSync } from 'node:child_process'

export const MAX_PATHSPEC = 500

function git (root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024
    })
  } catch {
    return ''
  }
}

export function gitState (root, files) {
  const list = Array.isArray(files) ? files : []
  if (list.length === 0) {
    return { files: [], status: '', diffstat: '', truncated: false }
  }
  const truncated = list.length > MAX_PATHSPEC
  const scoped = truncated ? list.slice(0, MAX_PATHSPEC) : list
  const status = git(root, ['status', '--porcelain', '--', ...scoped]).trim()
  const diffstat = git(root, ['diff', '--stat', '--', ...scoped]).trim()
  return { files: scoped, status, diffstat, truncated }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/gitstate.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add lib/gitstate.mjs test/gitstate.test.mjs
git commit -m "feat: capture git state scoped to one agent's files"
```

---

## Task 5: Risk ledger

**Files:**
- Create: `lib/ledger.mjs`
- Test: `test/ledger.test.mjs`

**Interfaces:**
- Consumes: `loadConfig` shape from `lib/paths.mjs` (`staleAfterDispatches`, `staleAfterDays`)
- Produces: `loadLedger(path)`, `saveLedger(path, ledger)`, `blankArea()`, `areaForPaths(paths) -> string | null`, `setPrior(ledger, area, score, source)`, `recordOutcome(ledger, {area, outcome, model, agentType, at})`, `scoreFor(ledger, area) -> number`, `stalenessFor(ledger, area, config, now) -> object | null`, `EMPTY_LEDGER`

- [ ] **Step 1: Write the failing test**

Create `test/ledger.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadLedger, saveLedger, areaForPaths, setPrior,
  recordOutcome, scoreFor, stalenessFor, EMPTY_LEDGER
} from '../lib/ledger.mjs'

const CONFIG = { staleAfterDispatches: 10, staleAfterDays: 30 }

test('loadLedger returns an empty ledger when the file is absent', () => {
  assert.deepEqual(loadLedger('/nope/ledger.json'), EMPTY_LEDGER)
})

test('loadLedger survives a corrupt file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-led-'))
  const f = join(dir, 'l.json')
  writeFileSync(f, 'not json at all')
  assert.deepEqual(loadLedger(f), EMPTY_LEDGER)
})

test('saveLedger then loadLedger round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-led2-'))
  const f = join(dir, 'nested', 'l.json')
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'src/x/**', 7, 'user-hint')
  saveLedger(f, led)
  assert.equal(scoreFor(loadLedger(f), 'src/x/**'), 7)
})

test('areaForPaths uses the longest common directory prefix', () => {
  assert.equal(areaForPaths(['src/inject/a.c', 'src/inject/b.c']), 'src/inject/**')
})

test('areaForPaths falls back to the most common top-level directory', () => {
  assert.equal(areaForPaths(['src/a.c', 'docs/b.md', 'src/c.c']), 'src/**')
})

test('areaForPaths returns null for an empty list', () => {
  assert.equal(areaForPaths([]), null)
})

test('a refusal raises the score by two and caps at ten', () => {
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'a/**', 9, 'model')
  recordOutcome(led, { area: 'a/**', outcome: 'refusal', model: 'claude-opus-4-8' })
  assert.equal(scoreFor(led, 'a/**'), 10)
  recordOutcome(led, { area: 'a/**', outcome: 'refusal', model: 'claude-opus-4-8' })
  assert.equal(scoreFor(led, 'a/**'), 10)
})

test('a success lowers the score by one and floors at one', () => {
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'a/**', 2, 'model')
  recordOutcome(led, { area: 'a/**', outcome: 'normal', model: 'claude-opus-5' })
  assert.equal(scoreFor(led, 'a/**'), 1)
  recordOutcome(led, { area: 'a/**', outcome: 'normal', model: 'claude-opus-5' })
  assert.equal(scoreFor(led, 'a/**'), 1)
})

test('evidence is recorded per model', () => {
  const led = structuredClone(EMPTY_LEDGER)
  recordOutcome(led, { area: 'a/**', outcome: 'refusal', model: 'claude-opus-4-8' })
  recordOutcome(led, { area: 'a/**', outcome: 'normal', model: 'claude-opus-5' })
  const area = led.areas['a/**']
  assert.equal(area.attempts, 2)
  assert.equal(area.kills, 1)
  assert.equal(area.successes, 1)
  assert.equal(area.byModel['claude-opus-4-8'].kills, 1)
  assert.equal(area.byModel['claude-opus-5'].successes, 1)
})

test('an Opus 5 attempt resets the dispatches-since counter', () => {
  const led = structuredClone(EMPTY_LEDGER)
  recordOutcome(led, { area: 'a/**', outcome: 'refusal', model: 'claude-opus-4-6' })
  recordOutcome(led, { area: 'a/**', outcome: 'refusal', model: 'claude-opus-4-6' })
  assert.equal(led.areas['a/**'].dispatchesSinceOpus5, 2)
  recordOutcome(led, { area: 'a/**', outcome: 'normal', model: 'claude-opus-5' })
  assert.equal(led.areas['a/**'].dispatchesSinceOpus5, 0)
  assert.ok(led.areas['a/**'].lastOpus5AttemptAt)
})

test('stalenessFor reports nothing below a score of nine', () => {
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'a/**', 8, 'model')
  assert.equal(stalenessFor(led, 'a/**', CONFIG), null)
})

test('stalenessFor reports when both thresholds are crossed', () => {
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'a/**', 10, 'model')
  led.areas['a/**'].dispatchesSinceOpus5 = 12
  led.areas['a/**'].lastOpus5AttemptAt = new Date(Date.now() - 40 * 86400000).toISOString()
  const stale = stalenessFor(led, 'a/**', CONFIG)
  assert.equal(stale.dispatchesSinceOpus5, 12)
  assert.ok(stale.daysSinceOpus5 >= 39)
})

test('stalenessFor treats never-attempted Opus 5 as infinitely stale', () => {
  const led = structuredClone(EMPTY_LEDGER)
  setPrior(led, 'a/**', 10, 'model')
  led.areas['a/**'].dispatchesSinceOpus5 = 15
  const stale = stalenessFor(led, 'a/**', CONFIG)
  assert.equal(stale.daysSinceOpus5, null)
})

test('history is capped at one hundred entries', () => {
  const led = structuredClone(EMPTY_LEDGER)
  for (let i = 0; i < 130; i++) {
    recordOutcome(led, { area: 'a/**', outcome: 'normal', model: 'claude-opus-5' })
  }
  assert.equal(led.areas['a/**'].history.length, 100)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ledger.test.mjs`
Expected: FAIL with `Cannot find module '../lib/ledger.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/ledger.mjs`:

```js
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const EMPTY_LEDGER = { version: 1, areas: {} }

const OPUS5 = /^claude-opus-5/
const DEFAULT_SCORE = 5
const MAX_HISTORY = 100

export function blankArea () {
  return {
    score: DEFAULT_SCORE,
    source: 'unset',
    attempts: 0,
    kills: 0,
    successes: 0,
    byModel: {},
    lastOpus5AttemptAt: null,
    dispatchesSinceOpus5: 0,
    history: []
  }
}

export function loadLedger (path) {
  if (!path || !existsSync(path)) return structuredClone(EMPTY_LEDGER)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.areas === 'object') {
      return parsed
    }
    return structuredClone(EMPTY_LEDGER)
  } catch {
    return structuredClone(EMPTY_LEDGER)
  }
}

export function saveLedger (path, ledger) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(ledger, null, 2))
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

export function areaForPaths (paths) {
  if (!Array.isArray(paths) || paths.length === 0) return null
  const dirs = paths.map(p => {
    const cut = p.lastIndexOf('/')
    return cut === -1 ? '' : p.slice(0, cut)
  })
  let prefix = dirs[0].split('/').filter(Boolean)
  for (const dir of dirs.slice(1)) {
    const parts = dir.split('/').filter(Boolean)
    let i = 0
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i += 1
    prefix = prefix.slice(0, i)
  }
  const common = prefix.join('/')
  if (common.length > 0) return `${common}/**`
  const counts = new Map()
  for (const dir of dirs) {
    const top = dir.split('/').filter(Boolean)[0] ?? ''
    counts.set(top, (counts.get(top) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const best = ranked[0][0]
  return best.length > 0 ? `${best}/**` : '*'
}

function ensureArea (ledger, area) {
  if (ledger.areas[area] === undefined) ledger.areas[area] = blankArea()
  return ledger.areas[area]
}

export function setPrior (ledger, area, score, source) {
  const entry = ensureArea(ledger, area)
  entry.score = Math.max(1, Math.min(10, score))
  entry.source = source ?? 'prior'
  return ledger
}

export function recordOutcome (ledger, { area, outcome, model, agentType, at }) {
  if (!area) return ledger
  const stamp = at ?? new Date().toISOString()
  const name = model ?? 'unknown'
  const entry = ensureArea(ledger, area)
  if (entry.source === 'unset') entry.source = 'observed'
  entry.attempts += 1
  if (entry.byModel[name] === undefined) {
    entry.byModel[name] = { attempts: 0, kills: 0, successes: 0 }
  }
  entry.byModel[name].attempts += 1
  if (outcome === 'refusal') {
    entry.kills += 1
    entry.byModel[name].kills += 1
    entry.score = Math.min(10, entry.score + 2)
  } else if (outcome === 'normal') {
    entry.successes += 1
    entry.byModel[name].successes += 1
    entry.score = Math.max(1, entry.score - 1)
  }
  if (OPUS5.test(name)) {
    entry.lastOpus5AttemptAt = stamp
    entry.dispatchesSinceOpus5 = 0
  } else {
    entry.dispatchesSinceOpus5 += 1
  }
  entry.history.push({ at: stamp, outcome, model: name, agentType: agentType ?? null })
  if (entry.history.length > MAX_HISTORY) {
    entry.history = entry.history.slice(-MAX_HISTORY)
  }
  return ledger
}

export function scoreFor (ledger, area) {
  const entry = ledger.areas?.[area]
  return entry === undefined ? DEFAULT_SCORE : entry.score
}

export function stalenessFor (ledger, area, config, now = Date.now()) {
  const entry = ledger.areas?.[area]
  if (entry === undefined) return null
  if (entry.score < 9) return null
  const last = entry.lastOpus5AttemptAt
  const days = last === null ? Infinity : (now - Date.parse(last)) / 86400000
  if (entry.dispatchesSinceOpus5 < config.staleAfterDispatches) return null
  if (days < config.staleAfterDays) return null
  return {
    area,
    score: entry.score,
    dispatchesSinceOpus5: entry.dispatchesSinceOpus5,
    daysSinceOpus5: Number.isFinite(days) ? Math.floor(days) : null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ledger.test.mjs`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add lib/ledger.mjs test/ledger.test.mjs
git commit -m "feat: advisory risk ledger with per-model evidence and staleness"
```

---

## Task 6: Baton write and atomic claim

**Files:**
- Create: `lib/baton.mjs`
- Test: `test/baton.test.mjs`

**Interfaces:**
- Consumes: `ccdPaths(root)` shape from `lib/paths.mjs`
- Produces: `runDir(paths, agentId)`, `writeBaton(paths, agentId, baton)`, `writeOrigin(paths, agentId, origin)`, `readOrigin(paths, agentId)`, `claimNewestBaton(paths) -> {runId, baton} | null`

**Why a lock file:** two continuation agents could start concurrently. `openSync(lock, 'wx')` is an atomic exclusive create, so exactly one claimant wins a given baton.

- [ ] **Step 1: Write the failing test**

Create `test/baton.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/baton.test.mjs`
Expected: FAIL with `Cannot find module '../lib/baton.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/baton.mjs`:

```js
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function runDir (paths, agentId) {
  return join(paths.runs, agentId)
}

export function writeBaton (paths, agentId, baton) {
  const dir = runDir(paths, agentId)
  const file = join(dir, 'baton.json')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(baton, null, 2))
    return file
  } catch {
    return null
  }
}

export function writeOrigin (paths, agentId, origin) {
  const dir = runDir(paths, agentId)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'origin.json'), JSON.stringify(origin, null, 2))
    return true
  } catch {
    return false
  }
}

export function readOrigin (paths, agentId) {
  const file = join(runDir(paths, agentId), 'origin.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function claimNewestBaton (paths) {
  if (!existsSync(paths.runs)) return null
  let entries
  try {
    entries = readdirSync(paths.runs)
  } catch {
    return null
  }
  const candidates = []
  for (const id of entries) {
    const file = join(paths.runs, id, 'baton.json')
    if (!existsSync(file)) continue
    if (existsSync(join(paths.runs, id, 'claimed.lock'))) continue
    try {
      candidates.push({ id, file, mtime: statSync(file).mtimeMs })
    } catch {
      continue
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  for (const candidate of candidates) {
    const lock = join(paths.runs, candidate.id, 'claimed.lock')
    try {
      closeSync(openSync(lock, 'wx'))
    } catch {
      continue
    }
    try {
      return { runId: candidate.id, baton: JSON.parse(readFileSync(candidate.file, 'utf8')) }
    } catch {
      return null
    }
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/baton.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add lib/baton.mjs test/baton.test.mjs
git commit -m "feat: baton write and atomic single-claim handoff"
```

---

## Task 7: SubagentStop entry point

**Files:**
- Create: `hooks/subagent-stop.mjs`
- Test: `test/subagent-stop.test.mjs`

**Interfaces:**
- Consumes: `findProjectRoot`, `ccdPaths`, `loadConfig`, `readTail`, `classifyTail`, `extractEditedPaths`, `gitState`, `loadLedger`, `saveLedger`, `areaForPaths`, `recordOutcome`, `stalenessFor`, `writeBaton`, `readOrigin`, `runDir`
- Produces: `handleStop(input, deps) -> object | null`, the pure decision function the executable wraps

- [ ] **Step 1: Write the failing test**

Create `test/subagent-stop.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleStop } from '../hooks/subagent-stop.mjs'
import { ccdPaths } from '../lib/paths.mjs'
import { writeOrigin } from '../lib/baton.mjs'

function deps (overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ccd-stop-'))
  mkdirSync(join(root, '.git'))
  return {
    root,
    readTailFn: () => '{"model":"claude-opus-4-8","stop_reason":"refusal"}',
    classifyFn: () => 'refusal',
    extractFn: () => ['src/inject/a.c'],
    gitStateFn: () => ({ files: ['src/inject/a.c'], status: ' M src/inject/a.c', diffstat: '1 file changed', truncated: false }),
    ...overrides
  }
}

test('stop_hook_active short-circuits before any work', () => {
  let touched = false
  const d = deps({ classifyFn: () => { touched = true; return 'refusal' } })
  assert.equal(handleStop({ stop_hook_active: true, agent_id: 'a' }, d), null)
  assert.equal(touched, false)
})

test('a normal outcome records a success and emits nothing', () => {
  const d = deps({ classifyFn: () => 'normal' })
  const out = handleStop({ agent_id: 'a1', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  assert.equal(out, null)
  const ledger = JSON.parse(readFileSync(ccdPaths(d.root).ledger, 'utf8'))
  assert.equal(ledger.areas['src/inject/**'].successes, 1)
})

test('a rate limit emits a message and writes no baton', () => {
  const d = deps({ classifyFn: () => 'rate_limit' })
  const out = handleStop({ agent_id: 'a2', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  assert.match(out.systemMessage, /rate limit/i)
  assert.equal(existsSync(join(ccdPaths(d.root).runs, 'a2', 'baton.json')), false)
})

test('a refusal writes a baton with scoped files and git state', () => {
  const d = deps()
  const out = handleStop({ agent_id: 'a3', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  const baton = JSON.parse(readFileSync(join(ccdPaths(d.root).runs, 'a3', 'baton.json'), 'utf8'))
  assert.equal(baton.attempt, 1)
  assert.deepEqual(baton.files, ['src/inject/a.c'])
  assert.equal(baton.area, 'src/inject/**')
  assert.equal(baton.nextModel, 'claude-opus-4-6')
  assert.equal(baton.refusedModel, 'claude-opus-4-8')
  assert.match(out.systemMessage, /refused/i)
  assert.match(out.systemMessage, /a3/)
})

test('the refused model is recorded in per-model evidence', () => {
  const d = deps()
  handleStop({ agent_id: 'a6', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  const ledger = JSON.parse(readFileSync(ccdPaths(d.root).ledger, 'utf8'))
  assert.equal(ledger.areas['src/inject/**'].byModel['claude-opus-4-8'].kills, 1)
  assert.equal(ledger.areas['src/inject/**'].dispatchesSinceOpus5, 1)
})

test('a refusal raises the ledger score for the touched area', () => {
  const d = deps()
  handleStop({ agent_id: 'a4', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  const ledger = JSON.parse(readFileSync(ccdPaths(d.root).ledger, 'utf8'))
  assert.equal(ledger.areas['src/inject/**'].score, 7)
  assert.equal(ledger.areas['src/inject/**'].kills, 1)
})

test('a refused continuation increments the attempt number', () => {
  const d = deps()
  handleStop({ agent_id: 'first', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  writeOrigin(ccdPaths(d.root), 'second', { fromRunId: 'first', attempt: 1 })
  handleStop({ agent_id: 'second', agent_type: 'ccd-continuation', agent_transcript_path: '/t.jsonl' }, d)
  const baton = JSON.parse(readFileSync(join(ccdPaths(d.root).runs, 'second', 'baton.json'), 'utf8'))
  assert.equal(baton.attempt, 2)
})

test('exceeding maxAttempts halts and writes a handoff report', () => {
  const d = deps()
  writeOrigin(ccdPaths(d.root), 'final', { fromRunId: 'x', attempt: 2 })
  const out = handleStop({ agent_id: 'final', agent_type: 'ccd-continuation', agent_transcript_path: '/t.jsonl' }, d)
  assert.match(out.systemMessage, /halted/i)
  assert.equal(existsSync(join(ccdPaths(d.root).runs, 'final', 'handoff.md')), true)
  assert.equal(existsSync(join(ccdPaths(d.root).runs, 'final', 'baton.json')), false)
})

test('a refusal with no attributable files still records and still emits', () => {
  const d = deps({ extractFn: () => [] })
  const out = handleStop({ agent_id: 'a5', agent_type: 'general-purpose', agent_transcript_path: '/t.jsonl' }, d)
  const baton = JSON.parse(readFileSync(join(ccdPaths(d.root).runs, 'a5', 'baton.json'), 'utf8'))
  assert.deepEqual(baton.files, [])
  assert.equal(baton.area, null)
  assert.ok(out.systemMessage.length > 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/subagent-stop.test.mjs`
Expected: FAIL with `Cannot find module '../hooks/subagent-stop.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `hooks/subagent-stop.mjs`:

```js
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ccdPaths, findProjectRoot, loadConfig } from '../lib/paths.mjs'
import { classifyTail, readTail } from '../lib/classify.mjs'
import { extractEditedPaths } from '../lib/transcript.mjs'
import { gitState } from '../lib/gitstate.mjs'
import { areaForPaths, loadLedger, recordOutcome, saveLedger, stalenessFor } from '../lib/ledger.mjs'
import { readOrigin, runDir, writeBaton } from '../lib/baton.mjs'

function modelFromTranscript (tailText) {
  const match = /"model"\s*:\s*"(claude-[a-z0-9-]+)"/i.exec(tailText ?? '')
  return match === null ? 'unknown' : match[1]
}

function handoffReport (input, attempt, files, state) {
  const lines = [
    `# Handoff: run ${input.agent_id} halted`,
    '',
    `Agent type: ${input.agent_type ?? 'unknown'}`,
    `Attempts made: ${attempt}`,
    '',
    '## Files this agent touched',
    files.length === 0 ? '(none attributable)' : files.map(f => `- ${f}`).join('\n'),
    '',
    '## Git state, scoped to those files',
    '```',
    state.status.length === 0 ? '(clean)' : state.status,
    '```',
    '```',
    state.diffstat.length === 0 ? '(no diff)' : state.diffstat,
    '```',
    '',
    'Two Opus 4.6 attempts were refused. This needs a human decision.',
    'Prompt rewording is not a remedy and has been falsified in the field.'
  ]
  return lines.join('\n')
}

export function handleStop (input, deps = {}) {
  if (input.stop_hook_active === true) return null

  const root = deps.root ?? findProjectRoot(process.cwd())
  const paths = ccdPaths(root)
  const config = loadConfig(root)
  const readTailFn = deps.readTailFn ?? readTail
  const classifyFn = deps.classifyFn ?? classifyTail
  const extractFn = deps.extractFn ?? extractEditedPaths
  const gitStateFn = deps.gitStateFn ?? gitState

  const transcript = input.agent_transcript_path

  // Read the tail exactly once. It feeds both classification and model
  // extraction, and the model is what gives the ledger its per-model evidence
  // and its "has Opus 5 been tried here" signal.
  const tail = readTailFn(transcript, config.transcriptTailBytes)
  const outcome = classifyFn(tail)
  const model = modelFromTranscript(tail)
  const files = extractFn(transcript, root)
  const area = areaForPaths(files)

  const ledger = loadLedger(paths.ledger)
  recordOutcome(ledger, { area, outcome, model, agentType: input.agent_type })
  saveLedger(paths.ledger, ledger)

  if (outcome === 'normal') return null

  if (outcome === 'rate_limit') {
    return {
      systemMessage: `[ccd] ${input.agent_type ?? 'subagent'} ${input.agent_id} stopped on a rate limit, not a guardrail. Wait and retry. No downshift performed.`
    }
  }

  const origin = readOrigin(paths, input.agent_id)
  const attempt = origin === null ? 1 : origin.attempt + 1
  const state = gitStateFn(root, files)

  if (attempt > config.maxAttempts) {
    const dir = runDir(paths, input.agent_id)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'handoff.md'), handoffReport(input, attempt - 1, files, state))
    } catch { /* a failed report must not crash the hook */ }
    return {
      systemMessage: `[ccd] Run ${input.agent_id} halted after ${attempt - 1} Opus 4.6 attempts. Handoff report written to .ccd/runs/${input.agent_id}/handoff.md. This needs a human decision.`
    }
  }

  writeBaton(paths, input.agent_id, {
    runId: input.agent_id,
    agentType: input.agent_type ?? null,
    transcript: transcript ?? null,
    files,
    area,
    state,
    attempt,
    nextModel: config.ladder[0],
    refusedModel: model,
    at: new Date().toISOString()
  })

  const stale = area === null ? null : stalenessFor(ledger, area, config)
  const staleNote = stale === null
    ? ''
    : ` Note: ${stale.area} has had no Opus 5 attempt in ${stale.dispatchesSinceOpus5} dispatches. Consider a re-test.`

  return {
    systemMessage: `[ccd] ${input.agent_type ?? 'subagent'} ${input.agent_id} was refused by guardrails (attempt ${attempt}). Baton written to .ccd/runs/${input.agent_id}/. Dispatch ccd-continuation with this run id. Do not read the refused output.${staleNote}`
  }
}

function main () {
  let input = {}
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    process.exit(0)
  }
  let result = null
  try {
    result = handleStop(input)
  } catch {
    process.exit(0)
  }
  if (result !== null) process.stdout.write(JSON.stringify(result))
  process.exit(0)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('subagent-stop.mjs')) main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/subagent-stop.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add hooks/subagent-stop.mjs test/subagent-stop.test.mjs
git commit -m "feat: SubagentStop hook detects refusals and writes batons"
```

---

## Task 8: SubagentStart entry point

**Files:**
- Create: `hooks/subagent-start.mjs`
- Test: `test/subagent-start.test.mjs`

**Interfaces:**
- Consumes: `ccdPaths`, `loadConfig`, `claimNewestBaton`, `writeOrigin`, `readTail`
- Produces: `handleStart(input, deps) -> object | null`

- [ ] **Step 1: Write the failing test**

Create `test/subagent-start.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleStart } from '../hooks/subagent-start.mjs'
import { ccdPaths } from '../lib/paths.mjs'
import { writeBaton, readOrigin } from '../lib/baton.mjs'

function fixture () {
  const root = mkdtempSync(join(tmpdir(), 'ccd-start-'))
  mkdirSync(join(root, '.git'))
  return root
}

const BATON = {
  runId: 'dead-1',
  files: ['src/inject/a.c'],
  area: 'src/inject/**',
  state: { status: ' M src/inject/a.c', diffstat: '1 file changed', files: ['src/inject/a.c'], truncated: false },
  attempt: 1,
  nextModel: 'claude-opus-4-6',
  refusedModel: 'claude-opus-4-8',
  transcript: '/t.jsonl'
}

test('non-continuation agents are ignored entirely', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-1', BATON)
  assert.equal(handleStart({ agent_type: 'general-purpose', agent_id: 'x' }, { root }), null)
})

test('a continuation with no baton available emits nothing', () => {
  const root = fixture()
  assert.equal(handleStart({ agent_type: 'ccd-continuation', agent_id: 'x' }, { root }), null)
})

test('attempt one injects the full transcript', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-1', BATON)
  const out = handleStart(
    { agent_type: 'ccd-continuation', agent_id: 'succ-1' },
    { root, readTailFn: () => 'FULL TRANSCRIPT BODY' }
  )
  const ctx = out.hookSpecificOutput.additionalContext
  assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart')
  assert.match(ctx, /FULL TRANSCRIPT BODY/)
  assert.match(ctx, /src\/inject\/a\.c/)
  assert.match(ctx, /claude-opus-4-8/)
})

test('attempt two degrades and omits the transcript', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-2', { ...BATON, runId: 'dead-2', attempt: 2 })
  const out = handleStart(
    { agent_type: 'ccd-continuation', agent_id: 'succ-2' },
    { root, readTailFn: () => 'SHOULD NOT APPEAR' }
  )
  const ctx = out.hookSpecificOutput.additionalContext
  assert.doesNotMatch(ctx, /SHOULD NOT APPEAR/)
  assert.match(ctx, /degraded/i)
  assert.match(ctx, /1 file changed/)
})

test('claiming records origin so the next refusal counts attempts', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-3', { ...BATON, runId: 'dead-3', attempt: 1 })
  handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-3' }, { root, readTailFn: () => 'T' })
  assert.deepEqual(readOrigin(ccdPaths(root), 'succ-3'), { fromRunId: 'dead-3', attempt: 1 })
})

test('the injected context instructs the successor to state its model', () => {
  const root = fixture()
  writeBaton(ccdPaths(root), 'dead-4', { ...BATON, runId: 'dead-4' })
  const out = handleStart({ agent_type: 'ccd-continuation', agent_id: 'succ-4' }, { root, readTailFn: () => 'T' })
  assert.match(out.hookSpecificOutput.additionalContext, /first line/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/subagent-start.test.mjs`
Expected: FAIL with `Cannot find module '../hooks/subagent-start.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `hooks/subagent-start.mjs`:

```js
import { readFileSync } from 'node:fs'
import { ccdPaths, findProjectRoot, loadConfig } from '../lib/paths.mjs'
import { readTail } from '../lib/classify.mjs'
import { claimNewestBaton, writeOrigin } from '../lib/baton.mjs'

const CONTINUATION = 'ccd-continuation'

function block (title, body) {
  return `## ${title}\n\n${body}\n`
}

function fileList (files) {
  return files.length === 0 ? '(none attributable)' : files.map(f => `- ${f}`).join('\n')
}

function buildContext (baton, transcriptText) {
  const header = [
    '# Cyber Delegation handoff',
    '',
    `You are resuming run \`${baton.runId}\`, which an earlier subagent could not finish.`,
    `That agent was refused by guardrails on \`${baton.refusedModel ?? 'an earlier model'}\`.`,
    `This is attempt ${baton.attempt}.`,
    '',
    '**State your own model ID as the first line of your output.** Model identity is',
    'otherwise only ever reported on failure, and this is the only success-path signal',
    'available.',
    '',
    'Do not reword the task and retry it. That remedy has been tested and falsified.',
    ''
  ].join('\n')

  const work = [
    block('Files the previous agent touched', fileList(baton.files ?? [])),
    block('Git status, scoped to those files', '```\n' + ((baton.state?.status ?? '').length === 0 ? '(clean)' : baton.state.status) + '\n```'),
    block('Git diffstat, scoped to those files', '```\n' + ((baton.state?.diffstat ?? '').length === 0 ? '(no diff)' : baton.state.diffstat) + '\n```')
  ].join('\n')

  if (baton.attempt >= 2) {
    const note = block(
      'Degraded payload',
      [
        'This is a degraded second attempt. The previous transcript is deliberately',
        'withheld because it was refused twice. Work from the task specification, the',
        'file list, and the diff above. Re-derive only what you must.'
      ].join('\n')
    )
    return header + work + note
  }

  return header + work + block(
    'Full transcript of the refused agent',
    '```\n' + transcriptText + '\n```'
  )
}

export function handleStart (input, deps = {}) {
  if (input.agent_type !== CONTINUATION) return null

  const root = deps.root ?? findProjectRoot(process.cwd())
  const paths = ccdPaths(root)
  const config = loadConfig(root)
  const readTailFn = deps.readTailFn ?? readTail

  const claimed = claimNewestBaton(paths)
  if (claimed === null) return null

  writeOrigin(paths, input.agent_id, {
    fromRunId: claimed.runId,
    attempt: claimed.baton.attempt
  })

  const transcriptText = claimed.baton.attempt >= 2
    ? ''
    : readTailFn(claimed.baton.transcript, config.maxInjectedTranscriptBytes)

  return {
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext: buildContext(claimed.baton, transcriptText)
    }
  }
}

function main () {
  let input = {}
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    process.exit(0)
  }
  let result = null
  try {
    result = handleStart(input)
  } catch {
    process.exit(0)
  }
  if (result !== null) process.stdout.write(JSON.stringify(result))
  process.exit(0)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('subagent-start.mjs')) main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/subagent-start.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add hooks/subagent-start.mjs test/subagent-start.test.mjs
git commit -m "feat: SubagentStart hook claims batons and injects handoff context"
```

---

## Task 9: Hook wiring and end-to-end test

**Files:**
- Create: `hooks/hooks.json`
- Test: `test/e2e.test.mjs`

**Interfaces:**
- Consumes: both entry points as executables reading JSON from stdin
- Produces: a working plugin that Claude Code loads

- [ ] **Step 1: Write the failing test**

Create `test/e2e.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/e2e.test.mjs`
Expected: FAIL, cannot read `hooks/hooks.json`

- [ ] **Step 3: Write the hook wiring**

Create `hooks/hooks.json`:

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/subagent-stop.mjs\"",
            "async": false
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/subagent-start.mjs\"",
            "async": false
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/e2e.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, all suites green

- [ ] **Step 6: Commit**

```bash
git add hooks/hooks.json test/e2e.test.mjs
git commit -m "feat: wire hooks and verify the refusal relay end to end"
```

---

## Task 10: Pinned-4.6 agent definitions

**Files:**
- Create: `agents/ccd-continuation.md`
- Create: `agents/ccd-implementer.md`
- Create: `agents/ccd-reviewer.md`
- Test: `test/agents.test.mjs`

**Interfaces:**
- Consumes: `agent_type` values referenced by `hooks/subagent-start.mjs` (`ccd-continuation`)
- Produces: three dispatchable `subagent_type` names

**This is the plugin's headline deliverable.** The `Agent` tool's `model` parameter is an alias enum and cannot express `claude-opus-4-6`. Agent frontmatter can.

- [ ] **Step 1: Write the failing test**

Create `test/agents.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/agents.test.mjs`
Expected: FAIL, cannot read `agents/ccd-continuation.md`

- [ ] **Step 3: Write the continuation agent**

Create `agents/ccd-continuation.md`:

```markdown
---
name: ccd-continuation
description: Resumes work that another subagent could not finish because guardrails refused it. Dispatched with a run id. Receives the dead agent's transcript and scoped git state automatically.
model: claude-opus-4-6
---

You resume work that another subagent started and could not finish.

**State your own model ID as the very first line of your output.** Model
identity is otherwise only ever reported on failure, so this is the only
success-path signal the orchestrator has.

A handoff block is injected into your context automatically. It contains the
previous agent's full transcript, the exact files it touched, and the git state
scoped to those files. Read it before doing anything else.

## How to resume

1. Trust the file list. It was extracted from the previous agent's own
   transcript, so it names exactly what that agent changed and nothing another
   concurrently running agent changed.
2. Check the scoped diff before re-implementing anything. Work already on disk
   is real work. Resume from where it stops.
3. Finish the task as specified. Do not re-scope it.

## Do not

- Do not reword the task and retry it. That remedy was tested in the field and
  falsified. It failed before the agent read a single file.
- Do not run `git add -A`, `git stash`, `git checkout`, `git restore`, or
  `git commit`. Every agent here shares one working tree. `git commit` commits
  the whole index, so it would swallow another agent's staged files, and the
  rest are outright destructive. Report the files you changed and let the
  orchestrator commit them.

## Reporting

Return 15 lines or fewer: status, the exact signatures you landed, a one-line
test summary, and any concerns. Write full detail to a report file under
`.ccd/runs/` and name that file in your summary.

Before you report done, diff the signatures you actually landed against the
ones the task specified. Report any deviation explicitly. A silent report is
not evidence that nothing drifted.
```

- [ ] **Step 4: Write the implementer agent**

Create `agents/ccd-implementer.md`:

```markdown
---
name: ccd-implementer
description: Implements a task on Opus 4.6 directly, for code areas the risk ledger measures as hostile to Opus 5. Use when an Opus 5 attempt is judged not worth making.
model: claude-opus-4-6
---

You implement a task that the orchestrator judged not worth attempting on a
newer model first.

**State your own model ID as the very first line of your output.** Model
identity is otherwise only ever reported on failure, so this is the only
success-path signal the orchestrator has.

You are not a fallback for a failed run. You are starting clean. If you were
meant to resume someone else's work, the orchestrator should have dispatched
`ccd-continuation` instead. Say so and stop.

## Do not

- Do not run `git add -A`, `git stash`, `git checkout`, `git restore`, or
  `git commit`. Every agent here shares one working tree. `git commit` commits
  the whole index, so it would swallow another agent's staged files, and the
  rest are outright destructive. Report the files you changed and let the
  orchestrator commit them.

## Reporting

Return 15 lines or fewer: status, the exact signatures you landed, a one-line
test summary, and any concerns. Write full detail to a report file under
`.ccd/runs/` and name that file in your summary.

Before you report done, diff the signatures you actually landed against the
ones the task specified. Report any deviation explicitly. A silent report is
not evidence that nothing drifted.
```

- [ ] **Step 5: Write the reviewer agent**

Create `agents/ccd-reviewer.md`:

```markdown
---
name: ccd-reviewer
description: Reviews code in areas the risk ledger measures as hostile to Opus 5, where an Opus 5 reviewer would be refused while reading. Read-only by construction.
model: claude-opus-4-6
tools: Read, Grep, Glob, Bash
---

You review code that another agent wrote. You have no Edit or Write tools. That
is deliberate. An agent that can fix what it reviews stops being an independent
reviewer.

**State your own model ID as the very first line of your output.** Model
identity is otherwise only ever reported on failure, so this is the only
success-path signal the orchestrator has.

## What to look for

1. **Does the code do what the specification says?** Diff the landed signatures
   against the specified ones. A report claiming DONE with no concerns has been
   observed to hide a changed constructor signature.
2. **Do the tests actually exercise the code under test?** A passing suite has
   been observed to drive a test-only duplicate of the function it claimed to
   test, making a 200-iteration race test incapable of failing.
3. Correctness before style. Report defects, not preferences.

## Do not

- Do not run `git add -A`, `git stash`, `git checkout`, `git restore`, or
  `git commit`. Every agent here shares one working tree and those verbs are
  destructive or would swallow another agent's staged files.
- Do not fix anything. Report it.

## Reporting

Return 15 lines or fewer: a verdict, then each defect as file, line, and what is
wrong. Write full detail to a report file under `.ccd/runs/` and name it.
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/agents.test.mjs`
Expected: PASS, 13 tests

- [ ] **Step 7: Commit**

```bash
git add agents/ test/agents.test.mjs
git commit -m "feat: three Opus 4.6 agent definitions with the model pinned in frontmatter"
```

---

## Task 11: Orchestrator skill

**Files:**
- Create: `skills/cyber-delegation/SKILL.md`
- Test: `test/skill.test.mjs`

**Interfaces:**
- Consumes: agent names from Task 10, ledger shape from Task 5
- Produces: orchestrator-facing rules

- [ ] **Step 1: Write the failing test**

Create `test/skill.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/skill.test.mjs`
Expected: FAIL, cannot read `skills/cyber-delegation/SKILL.md`

- [ ] **Step 3: Write minimal implementation**

Create `skills/cyber-delegation/SKILL.md`:

```markdown
---
name: cyber-delegation
description: Use when dispatching subagents on security-adjacent work, when a subagent has been refused by guardrails, or when the user says a component is likely to trigger guardrails. Covers handing refused work to Opus 4.6 and reading the advisory risk ledger.
---

# Cyber Delegation

Opus 5 is the default because it produces better work. Opus 4.6 is damage
control, not a preference. Every decision starts from "try Opus 5" and needs
evidence to depart from it.

A kill is measurement, not waste. An Opus 5 attempt that dies converts an
assumption into data about that code area.

## Rule 1: a refused subagent

When a subagent fails with a guardrail error:

1. **Do not read its output.** That payload provably tripped a classifier, and
   your context is the one that cannot be recovered. The platform gives you
   status and error text only, which is all you need.
2. Dispatch `ccd-continuation`. Pass the run id from the `[ccd]` message and
   nothing else. The transcript, the file list, and the scoped git state are
   injected into that agent automatically.
3. A rate limit is not a guardrail refusal. Its remedy is waiting. The `[ccd]`
   message tells you which one happened.

## Rule 2: the risk ledger is advisory

`.ccd/risk-ledger.json` holds a 1-to-10 score per path glob, with the evidence
that produced it. Read it before dispatching into an area you have seen fail.

It is advice, not a rule. Nothing in this plugin gates a dispatch. Weigh the
score against everything else you know and decide.

| Score | Reading | Suggested treatment |
|---|---|---|
| 1 to 3 | routine | normal dispatch |
| 4 to 6 | plausible | normal dispatch |
| 7 to 8 | likely | still Opus 5. Quality is worth one attempt and a kill is measurement |
| 9 to 10 | near-certain | consider `ccd-implementer` directly, and `ccd-reviewer` for review |

Check the evidence, not just the number. A 9 built from one kill in one attempt
is weaker than a 9 from four kills in five attempts.

When the ledger reports that a high-score area has gone stale, surface that to
the user. Only they decide when to re-test an area against Opus 5.

## Rule 3: never reword and retry

Re-dispatching a refused task with the domain framing stripped out has been
tested and falsified. It failed before the agent read a single file. Do not
build on the theory that wording was the trigger.

## Rule 4: verify the contract on return

When any agent reports done, diff the signatures it landed against the ones the
task specified. A report saying DONE with no concerns has been observed to hide
a changed constructor signature. Report silence is not evidence of no deviation.

This matters most after a `ccd-continuation` returns, because a different model
finished work it did not start.

## Recording a risk hint

When the user says a component is likely to trigger guardrails, write it into
`.ccd/risk-ledger.json` as a prior:

```json
{
  "version": 1,
  "areas": {
    "src/inject/**": { "score": 8, "source": "user-hint", "attempts": 0, "kills": 0, "successes": 0, "byModel": {}, "lastOpus5AttemptAt": null, "dispatchesSinceOpus5": 0, "history": [] }
  }
}
```

Merge into the existing file rather than overwriting it. The user never edits
this file by hand.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/skill.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add skills/ test/skill.test.mjs
git commit -m "feat: orchestrator skill for refusal handling and the advisory ledger"
```

---

## Task 12: Install-time 1M capability probe

**Files:**
- Create: `scripts/probe-1m.mjs`
- Create: `README.md`
- Test: `test/probe.test.mjs`

**Interfaces:**
- Consumes: `ccdPaths`, `loadConfig`, `DEFAULT_CONFIG`
- Produces: `interpretProbe(stdout, stderr, failed) -> {suffix, conclusive, reason}`, `probeAndWrite(root, runner) -> object`

**Why a probe:** `[1m]` support is a runtime carrier check, and the error is named `alias_1m_unsupported`, which suggests the suffix may be alias-level and may not compose with a full model ID. Failing at install is recoverable. Failing mid-refusal is not.

- [ ] **Step 1: Write the failing test**

Create `test/probe.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interpretProbe, probeAndWrite } from '../scripts/probe-1m.mjs'
import { ccdPaths } from '../lib/paths.mjs'

test('a clean run enables the 1m suffix', () => {
  const out = interpretProbe('OK', '', false)
  assert.equal(out.suffix, '[1m]')
  assert.equal(out.conclusive, true)
})

test('an explicit unsupported error disables the suffix', () => {
  const out = interpretProbe('', "Opus 4.6 doesn't have a 1M context window", true)
  assert.equal(out.suffix, '')
  assert.equal(out.conclusive, true)
})

test('the alias_1m_unsupported marker disables the suffix', () => {
  const out = interpretProbe('', 'alias_1m_unsupported', true)
  assert.equal(out.suffix, '')
  assert.equal(out.conclusive, true)
})

test('an unrelated failure is inconclusive and defaults to no suffix', () => {
  const out = interpretProbe('', 'Credit balance is too low', true)
  assert.equal(out.suffix, '')
  assert.equal(out.conclusive, false)
  assert.match(out.reason, /inconclusive/i)
})

test('probeAndWrite persists the result into config', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-probe-'))
  mkdirSync(join(root, '.git'))
  const result = probeAndWrite(root, () => ({ stdout: 'OK', stderr: '', failed: false }))
  assert.equal(result.suffix, '[1m]')
  const cfg = JSON.parse(readFileSync(ccdPaths(root).config, 'utf8'))
  assert.equal(cfg.oneMillionSuffix, '[1m]')
})

test('probeAndWrite preserves existing config keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-probe2-'))
  mkdirSync(join(root, '.git'))
  probeAndWrite(root, () => ({ stdout: '', stderr: 'alias_1m_unsupported', failed: true }))
  const cfg = JSON.parse(readFileSync(ccdPaths(root).config, 'utf8'))
  assert.equal(cfg.oneMillionSuffix, '')
  assert.equal(cfg.maxAttempts, 2)
  assert.deepEqual(cfg.ladder, ['claude-opus-4-6'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/probe.test.mjs`
Expected: FAIL with `Cannot find module '../scripts/probe-1m.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/probe-1m.mjs`:

```js
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ccdPaths, findProjectRoot, loadConfig } from '../lib/paths.mjs'

const UNSUPPORTED = /alias_1m_unsupported|does not have a 1M context window|doesn.t have a 1M context window/i

export function interpretProbe (stdout, stderr, failed) {
  const blob = `${stdout ?? ''}\n${stderr ?? ''}`
  if (UNSUPPORTED.test(blob)) {
    return { suffix: '', conclusive: true, reason: 'The carrier reports no 1M context window for this model.' }
  }
  if (failed !== true) {
    return { suffix: '[1m]', conclusive: true, reason: 'Probe succeeded with the 1m suffix.' }
  }
  return {
    suffix: '',
    conclusive: false,
    reason: 'Probe was inconclusive, so the safe default of no suffix was written. Re-run after fixing the underlying error if you want 1M context.'
  }
}

export function defaultRunner () {
  try {
    const stdout = execFileSync('claude', ['--model', 'claude-opus-4-6[1m]', '-p', 'ok'], {
      encoding: 'utf8',
      timeout: 90000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { stdout, stderr: '', failed: false }
  } catch (error) {
    return {
      stdout: error.stdout ?? '',
      stderr: `${error.stderr ?? ''}${error.message ?? ''}`,
      failed: true
    }
  }
}

export function probeAndWrite (root, runner = defaultRunner) {
  const { stdout, stderr, failed } = runner()
  const result = interpretProbe(stdout, stderr, failed)
  const paths = ccdPaths(root)
  const merged = { ...loadConfig(root), oneMillionSuffix: result.suffix }
  try {
    mkdirSync(dirname(paths.config), { recursive: true })
    writeFileSync(paths.config, JSON.stringify(merged, null, 2))
  } catch { /* an unwritable config must not fail the install */ }
  return result
}

function main () {
  const root = findProjectRoot(process.cwd())
  const result = probeAndWrite(root)
  process.stdout.write(`[ccd] 1M suffix: ${result.suffix === '' ? 'disabled' : 'enabled'}\n`)
  process.stdout.write(`[ccd] ${result.reason}\n`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('probe-1m.mjs')) main()
```

- [ ] **Step 4: Write the README**

Create `README.md`:

```markdown
# cyber-delegation

A Claude Code plugin that lets an orchestrator dispatch Opus 4.6 subagents
directly, and hands guardrail-refused work to them automatically with the dead
agent's transcript and correctly scoped git state intact.

## Why it exists

The `Agent` tool's `model` parameter is an alias enum. There is no way to type
`claude-opus-4-6` into it. Agent definition frontmatter does accept full model
IDs, so a file can pin what a parameter cannot. This plugin ships those files.

Guardrail failures were observed landing on Opus 4.8 after the platform's own
fallback had already degraded from Opus 5. The ladder therefore starts below
where automatic fallback stops.

## Install

```bash
node scripts/probe-1m.mjs
```

The probe determines whether `claude-opus-4-6[1m]` resolves on your account and
writes the answer to `.ccd/config.json`. If it cannot tell, it writes the safe
default and says so.

## What it does

- `SubagentStop` detects a guardrail refusal, extracts the files the dead agent
  touched from its own transcript, scopes git state to exactly those files, and
  writes a baton.
- `SubagentStart` claims that baton and injects it into `ccd-continuation`,
  whose frontmatter pins `claude-opus-4-6`.
- A risk ledger accumulates advisory 1-to-10 scores per path glob from observed
  outcomes. Nothing it knows ever gates a dispatch.

## Agents

| Agent | Use |
|---|---|
| `ccd-continuation` | Resume work a refused subagent could not finish |
| `ccd-implementer` | Start clean on an area measured hostile to Opus 5 |
| `ccd-reviewer` | Review such an area, read-only by construction |

## Test

```bash
npm test
```
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/probe.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS, all suites green

- [ ] **Step 7: Commit**

```bash
git add scripts/probe-1m.mjs README.md test/probe.test.mjs
git commit -m "feat: install-time 1M capability probe and README"
```

---

## Post-implementation verification

- [ ] **Confirm the plugin loads.** Install it locally and run `/agents`. All three `ccd-*` agents must appear.
- [ ] **Confirm the pin holds.** Dispatch `ccd-continuation` on a trivial task. Its first output line must name `claude-opus-4-6`. If it names anything else, the frontmatter pin is not being honoured and the design's core assumption has failed. Report that before going further.
- [ ] **Confirm the loop guard.** Force two consecutive refusals and verify the run halts with a handoff report rather than relaunching indefinitely.
