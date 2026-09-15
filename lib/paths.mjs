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

// The numeric config values every consumer trusts without re-checking. A hand
// edit that lands `null`, a string, zero, or a negative number must fall back
// to the shipped default here, once, rather than throwing wherever the value
// is first used (`config.ladder[0]`, a byte cap, an attempt cap).
const NUMERIC_CONFIG_KEYS = [
  'maxAttempts', 'staleAfterDispatches', 'staleAfterDays',
  'transcriptTailBytes', 'maxInjectedTranscriptBytes'
]

function isPositiveNumber (value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isNonEmptyStringArray (value) {
  return Array.isArray(value) && value.length > 0 &&
    value.every(item => typeof item === 'string' && item.length > 0)
}

export function loadConfig (root) {
  const { config } = ccdPaths(root)
  if (!existsSync(config)) return { ...DEFAULT_CONFIG }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(config, 'utf8'))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
  const merged = { ...DEFAULT_CONFIG, ...parsed }
  if (!isNonEmptyStringArray(merged.ladder)) merged.ladder = DEFAULT_CONFIG.ladder
  for (const key of NUMERIC_CONFIG_KEYS) {
    if (!isPositiveNumber(merged[key])) merged[key] = DEFAULT_CONFIG[key]
  }
  return merged
}
