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
