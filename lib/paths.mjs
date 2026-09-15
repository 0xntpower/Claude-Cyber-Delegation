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
    runs: join(base, 'runs'),
    enabled: join(base, 'enabled'),
    announced: join(base, 'announced')
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
