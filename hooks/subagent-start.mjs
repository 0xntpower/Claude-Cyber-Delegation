import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ccdPaths, findProjectRoot, loadConfig } from '../lib/paths.mjs'
import { isEnabled, shouldAnnounce } from '../lib/gate.mjs'
import { readTail } from '../lib/classify.mjs'
import { claimBatonById, claimNewestBaton, clearNextClaim, readNextClaim, runDir, writeOrigin } from '../lib/baton.mjs'
import { MAX_PATHSPEC } from '../lib/gitstate.mjs'

const CONTINUATION = 'ccd-continuation'
const ARMED_NOTICE = '[ccd] Cyber Delegation is armed in this project (.ccd/enabled). Run /ccd-disable to turn it off.'

// A sticky enable must never be invisible. Wraps whatever the rest of the
// hook produced (including null) with a once-per-session notice, so a
// non-continuation dispatch that would otherwise emit nothing still tells
// the user the plugin is live.
function withAnnounce (paths, sessionId, result, announceFn) {
  if (!announceFn(paths, sessionId)) return result
  if (result === null) return { systemMessage: ARMED_NOTICE }
  const existing = result.systemMessage
  return { ...result, systemMessage: existing ? `${ARMED_NOTICE}\n${existing}` : ARMED_NOTICE }
}

function block (title, body) {
  return `## ${title}\n\n${body}\n`
}

function fileList (files) {
  return files.length === 0 ? '(none attributable)' : files.map(f => `- ${f}`).join('\n')
}

function buildContext (baton, transcriptText, capBytes, opts = {}) {
  const fallbackNote = opts.targetedBatonUnreadable === true
    ? block(
      'Targeted baton unreadable — fallback claim',
      `The run \`${opts.targetedRunId}\` named in .ccd/next-claim had a baton that failed to ` +
        `parse and was quarantined. This handoff falls back to the newest unclaimed baton ` +
        `instead, run \`${baton.runId}\`. Compare that run id against your dispatch prompt ` +
        'before trusting the file list below.'
    )
    : ''

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

  // The dead agent touched more files than the pathspec cap. Say so plainly:
  // without this, the successor sees a partial file list and diff with no
  // indication they are partial, and may conclude there is nothing left to do.
  const truncationNote = baton.state?.truncated === true
    ? block(
      'Truncated file list',
      `This agent touched more than ${MAX_PATHSPEC} files, the cap for git scoping. ` +
        `The file list and diff above are incomplete: only the first ${MAX_PATHSPEC} touched paths were scoped.`
    )
    : ''

  if (baton.attempt >= 2) {
    const degradedLines = ['This is a degraded second attempt. The previous transcript is deliberately',
      'withheld because it was refused twice. Work from the task specification, the',
      'file list, and the diff above. Re-derive only what you must.']
    const note = block('Degraded payload', degradedLines.join('\n'))
    return fallbackNote + header + work + truncationNote + note
  }

  // The injected text is the tail, not the whole transcript, and saying so
  // matters: the successor must not conclude that an absent early step never
  // happened. The tail is the right end to keep, because the work-in-progress
  // and the refusal both live at the end.
  const transcriptBlock = block(
    `Final portion of the refused agent's transcript (last ${capBytes} bytes; earlier turns are cut)`,
    '```\n' + transcriptText + '\n```'
  )
  return fallbackNote + header + work + truncationNote + transcriptBlock
}

// Everything the plugin actually does, gated on the project being armed.
// Kept as a separate function so `handleStart` can wrap its single return
// value with the once-per-session announce notice in one place.
function computeStart (input, deps, root, paths) {
  if (input.agent_type !== CONTINUATION) return null

  // Without a valid agent_id there is no run directory to write origin.json
  // into, so nothing may be claimed yet: claiming first and failing to record
  // the origin would leave a baton locked under claimed.lock forever, with
  // claimNewestBaton never able to see it again. Checking here, before either
  // claim function runs, keeps the baton available for a correctly-identified
  // dispatch later.
  if (typeof input.agent_id !== 'string' || input.agent_id.trim().length === 0) {
    return {
      systemMessage: '[ccd] A ccd-continuation subagent started but the hook payload carried no agent_id, so no baton could be claimed. Its predecessor baton, if any, remains unclaimed and available.'
    }
  }

  const config = loadConfig(root)
  const readTailFn = deps.readTailFn ?? readTail

  // Targeted claim first. The pointer names the run the orchestrator actually
  // dispatched this successor for. Falling back to the newest unclaimed baton
  // keeps the relay working when no pointer was written, which is the only
  // behaviour that existed before.
  //
  // The pointer is one-shot: it is cleared the instant it is read, before the
  // claim is even attempted, whether or not that claim goes on to succeed. A
  // pointer left in place until a successful claim survives every dry run
  // that finds nothing to claim, and a later dispatch can then resurrect it
  // and get mis-targeted at a run it was never written for.
  const pointer = readNextClaim(paths)
  if (pointer !== null) clearNextClaim(paths)
  let claimed = pointer === null ? null : claimBatonById(paths, pointer)

  // A quarantined targeted baton and a fallback claim together are the exact
  // mis-targeting the pointer exists to prevent, just recovered from instead
  // of caused. The successor still needs to know its baton is a fallback, so
  // it can weigh the header's run id against its dispatch prompt.
  const targetedBatonUnreadable = claimed === null && pointer !== null &&
    existsSync(join(runDir(paths, pointer), 'baton.corrupt.json'))

  if (claimed === null) claimed = claimNewestBaton(paths)
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
      additionalContext: buildContext(claimed.baton, transcriptText, config.maxInjectedTranscriptBytes, {
        targetedBatonUnreadable,
        targetedRunId: pointer
      })
    }
  }
}

export function handleStart (input, deps = {}) {
  const root = deps.root ?? findProjectRoot(process.cwd())
  const paths = ccdPaths(root)
  const isEnabledFn = deps.isEnabledFn ?? isEnabled
  const announceFn = deps.announceFn ?? shouldAnnounce

  // The gate is the first thing checked once the project root is known, and
  // it returns before a transcript is read or a baton is claimed. This runs
  // for every subagent start, not only ccd-continuation, so an unarmed
  // project pays only for a directory walk and a stat on every dispatch.
  if (!isEnabledFn(paths)) return null

  const result = computeStart(input, deps, root, paths)
  return withAnnounce(paths, input.session_id, result, announceFn)
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
