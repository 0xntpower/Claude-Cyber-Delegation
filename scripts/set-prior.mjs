import { ccdPaths, findProjectRoot } from '../lib/paths.mjs'
import { loadLedger, saveLedger, scoreFor, setPrior, withLedgerLock } from '../lib/ledger.mjs'

export const USAGE = 'Usage: node scripts/set-prior.mjs <area-glob> <score 1-10>'

// The ledger is hook-written state with a null-hostile shape and concurrent
// writers. Hand-editing it was the documented path and it is how a ledger with
// `"areas": null` gets made, which used to kill the relay outright. This is the
// supported way in: load, clamp, save, all under the same lock the hooks take.
export function applyPrior (root, rawArea, rawScore) {
  const area = typeof rawArea === 'string' ? rawArea.trim() : ''
  if (area.length === 0) {
    return { ok: false, message: USAGE }
  }
  const score = Number(rawScore)
  if (rawScore === undefined || rawScore === null || `${rawScore}`.trim().length === 0 || !Number.isFinite(score)) {
    return { ok: false, message: `Score must be a number from 1 to 10, got ${JSON.stringify(rawScore)}. ${USAGE}` }
  }

  const paths = ccdPaths(root)
  let applied = null
  let saved = false
  withLedgerLock(paths, () => {
    const ledger = loadLedger(paths.ledger)
    setPrior(ledger, area, score, 'user-hint')
    saved = saveLedger(paths.ledger, ledger)
    applied = scoreFor(ledger, area)
  })

  if (!saved) {
    return { ok: false, area, score: applied, message: `[ccd] Could not write ${paths.ledger}. The prior was not recorded.` }
  }
  const clamped = applied === score
    ? ''
    : ` (clamped from ${score}, the scale runs 1 to 10)`
  return { ok: true, area, score: applied, message: `[ccd] Prior for ${area} set to ${applied}${clamped}.` }
}

function main () {
  const [area, score] = process.argv.slice(2)
  const result = applyPrior(findProjectRoot(process.cwd()), area, score)
  process.stdout.write(`${result.message}\n`)
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('set-prior.mjs')) main()
