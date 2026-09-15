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

// Split from `main` so a test can inspect exactly what the operator sees
// without shelling out. A live dispatch settled the question this used to
// hedge on: the pin in agents/ccd-*.md is honoured, and the [1m] modifier
// arrives from session configuration and propagates onto it without ever
// appearing in frontmatter. So this records an observation and nothing more.
export function probeMessageLines (result) {
  return [
    `[ccd] 1M suffix probed as: ${result.suffix === '' ? 'unavailable' : 'available'}`,
    `[ccd] ${result.reason}`,
    '[ccd] This probe RECORDS whether claude-opus-4-6[1m] resolves for this account.',
    '[ccd] Nothing at runtime reads oneMillionSuffix from .ccd/config.json, and no hand',
    '[ccd] edit of agents/ccd-*.md is needed: a live dispatch showed the [1m] modifier',
    '[ccd] arrives from session configuration and reaches a bare frontmatter pin on its own.'
  ]
}

function main () {
  const root = findProjectRoot(process.cwd())
  const result = probeAndWrite(root)
  for (const line of probeMessageLines(result)) process.stdout.write(`${line}\n`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('probe-1m.mjs')) main()
