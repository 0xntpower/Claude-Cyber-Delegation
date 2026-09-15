import { existsSync } from 'node:fs'
import { ccdPaths, findProjectRoot, loadConfig } from '../lib/paths.mjs'
import { disable, enable, isEnabled } from '../lib/gate.mjs'
import { loadLedger, stalenessFor } from '../lib/ledger.mjs'

export const USAGE = 'Usage: node scripts/gate.mjs <enable|disable|status>'

export function runEnable (root) {
  const paths = ccdPaths(root)
  const ok = enable(paths)
  return {
    ok,
    message: ok
      ? `[ccd] Enabled for ${root}. The plugin is now armed in this project.`
      : `[ccd] Could not write ${paths.enabled}. The project was not armed.`
  }
}

export function runDisable (root) {
  const paths = ccdPaths(root)
  const ok = disable(paths)
  return {
    ok,
    message: ok
      ? `[ccd] Disabled for ${root}. The plugin is now inert in this project.`
      : `[ccd] Could not remove ${paths.enabled}. The project may still be armed.`
  }
}

function topAreas (ledger, limit) {
  return Object.entries(ledger.areas ?? {})
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
}

// This is the fix for a spec promise that was never implemented: staleness
// only ever surfaced in the refusal systemMessage. Reuses `stalenessFor`
// rather than reimplementing it, so the two call sites can never disagree.
export function buildStatus (root) {
  const paths = ccdPaths(root)
  const lines = [
    `[ccd] Project: ${root}`,
    `[ccd] Armed: ${isEnabled(paths) ? 'yes' : 'no'} (${paths.enabled})`
  ]

  if (!existsSync(paths.ledger)) {
    lines.push(`[ccd] Ledger: absent (${paths.ledger}). No dispatches have been recorded yet for this project.`)
    return { ok: true, message: lines.join('\n') }
  }

  const ledger = loadLedger(paths.ledger)
  const config = loadConfig(root)
  const areas = Object.entries(ledger.areas ?? {})
  lines.push(`[ccd] Ledger: present (${paths.ledger}), ${areas.length} scored areas.`)

  if (areas.length > 0) {
    lines.push('[ccd] Highest-scoring areas:')
    for (const [area, entry] of topAreas(ledger, 5)) {
      lines.push(`  - ${area}: score ${entry.score} (${entry.attempts} attempts, ${entry.kills} kills, ${entry.successes} successes)`)
    }
  }

  const stale = areas
    .map(([area]) => stalenessFor(ledger, area, config))
    .filter(s => s !== null)
  if (stale.length === 0) {
    lines.push('[ccd] Stale areas: none.')
  } else {
    lines.push('[ccd] Stale areas (no Opus 5 attempt in a while):')
    for (const s of stale) {
      const days = s.daysSinceOpus5 === null ? 'never' : `${s.daysSinceOpus5} days ago`
      lines.push(`  - ${s.area}: score ${s.score}, ${s.dispatchesSinceOpus5} dispatches since Opus 5, last Opus 5 attempt ${days}`)
    }
  }

  const u = ledger.unattributed ?? { attempts: 0, kills: 0, successes: 0 }
  lines.push(`[ccd] Unattributed: ${u.attempts} attempts, ${u.kills} kills, ${u.successes} successes.`)

  return { ok: true, message: lines.join('\n') }
}

function main () {
  const [sub] = process.argv.slice(2)
  const root = findProjectRoot(process.cwd())
  let result
  if (sub === 'enable') result = runEnable(root)
  else if (sub === 'disable') result = runDisable(root)
  else if (sub === 'status') result = buildStatus(root)
  else result = { ok: false, message: USAGE }
  process.stdout.write(`${result.message}\n`)
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gate.mjs')) main()
