import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ccdPaths, findProjectRoot, loadConfig } from '../lib/paths.mjs'
import { classifyTail, readTail } from '../lib/classify.mjs'
import { extractEditedPaths } from '../lib/transcript.mjs'
import { gitState, MAX_PATHSPEC } from '../lib/gitstate.mjs'
import { areaForPaths, loadLedger, recordOutcome, saveLedger, stalenessFor, withLedgerLock } from '../lib/ledger.mjs'
import { readOrigin, runDir, writeBaton } from '../lib/baton.mjs'

const MODEL_IN_TAIL = /"model"\s*:\s*"(claude-[a-z0-9-]+(?:\[[a-z0-9]+\])?)"/gi

// The LAST match, not the first. The platform degrades Opus 5 to 4.8 mid-session
// as a matter of course, so the first model named in a 256KB tail is often the
// pre-degrade one while the refusal came from the model that replaced it.
function modelFromTranscript (tailText) {
  const matches = String(tailText ?? '').matchAll(MODEL_IN_TAIL)
  let last = null
  for (const match of matches) last = match[1]
  return last === null ? 'unknown' : last
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

  // Without an agent id there is no run directory, so the origin read throws,
  // the hook exits 0 with empty stdout, and the refusal disappears silently.
  // Say so instead, and say it before anything has been written.
  if (typeof input.agent_id !== 'string' || input.agent_id.trim().length === 0) {
    return {
      systemMessage: '[ccd] A subagent stopped but the hook payload carried no agent_id, so its work could not be captured and no baton was written. If that subagent was refused, its work-in-progress is still in the working tree and needs picking up by hand.'
    }
  }

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

  // A rate limit is not a refusal, and it is not evidence either. The dispatch
  // never ran. Recording it would inflate the attempts denominator with a
  // non-event and, on an Opus 5 model string, reset the staleness clock for an
  // attempt that never happened. So return before the ledger is touched.
  if (outcome === 'rate_limit') {
    return {
      systemMessage: `[ccd] ${input.agent_type ?? 'subagent'} ${input.agent_id} stopped on a rate limit, not a guardrail. Wait and retry. No downshift performed, and no ledger evidence recorded.`
    }
  }

  // Read-modify-write under a lock. Clustered concurrent refusals are the
  // design case, and unsynchronised writers measurably lose half of them.
  let ledger = null
  withLedgerLock(paths, () => {
    ledger = loadLedger(paths.ledger)
    recordOutcome(ledger, { area, outcome, model, agentType: input.agent_type })
    saveLedger(paths.ledger, ledger)
  })

  if (outcome === 'normal') return null

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

  const batonFile = writeBaton(paths, input.agent_id, {
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

  // Never assert a baton that is not on disk. Telling the orchestrator to
  // dispatch a continuation when the capture failed sends it to claim nothing,
  // or worse, a stale baton from an unrelated run.
  if (batonFile === null) {
    return {
      systemMessage: `[ccd] ${input.agent_type ?? 'subagent'} ${input.agent_id} was refused by guardrails (attempt ${attempt}), but capturing its work FAILED and no baton was written for run ${input.agent_id}. Do not dispatch ccd-continuation for this run. Check that .ccd/runs is writable. The refused agent's work-in-progress, if any, is still in the working tree.`
    }
  }

  const stale = area === null || ledger === null ? null : stalenessFor(ledger, area, config)
  const staleNote = stale === null
    ? ''
    : ` Note: ${stale.area} has had no Opus 5 attempt in ${stale.dispatchesSinceOpus5} dispatches. Consider a re-test.`

  // Say plainly when the file list and diff are incomplete. Without this the
  // successor, and whoever reads this message, may conclude a partial capture
  // is the whole picture and that there is nothing left to do.
  const truncNote = state.truncated === true
    ? ` Note: this agent touched more than ${MAX_PATHSPEC} files, the cap for git scoping. The file list and diff in the baton are truncated and incomplete.`
    : ''

  return {
    systemMessage: `[ccd] ${input.agent_type ?? 'subagent'} ${input.agent_id} was refused by guardrails (attempt ${attempt}). Baton written to .ccd/runs/${input.agent_id}/. Dispatch ccd-continuation with this run id. Do not read the refused output.${staleNote}${truncNote}`
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
