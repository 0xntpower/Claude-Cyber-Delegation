import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ccdPaths, findProjectRoot, loadConfig } from '../lib/paths.mjs'
import { isEnabled } from '../lib/gate.mjs'
import { readTail } from '../lib/classify.mjs'
import { claimBatonById, claimNewestBaton, clearNextClaim, readNextClaim, runDir, writeOrigin } from '../lib/baton.mjs'
import { MAX_PATHSPEC } from '../lib/gitstate.mjs'

const CONTINUATION = 'ccd-continuation'
export const HANDOFF_FILE = 'handoff.md'

function block (title, body) {
  return `## ${title}\n\n${body}\n`
}

function fileList (files) {
  return files.length === 0 ? '(none attributable)' : files.map(f => `- ${f}`).join('\n')
}

// The full evidence payload, written to disk uncapped. This used to be the
// injected text itself, which is why it still reads like one.
export function handoffBody (baton, transcriptText, capBytes, opts = {}) {
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
    `# Handoff for run ${baton.runId}`,
    '',
    `Refused on \`${baton.refusedModel ?? 'an earlier model'}\`. Attempt ${baton.attempt}.`,
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
    return fallbackNote + header + work + truncationNote + block('Degraded payload', degradedLines.join('\n'))
  }

  // The captured text is the tail, not the whole transcript, and saying so
  // matters: the successor must not conclude that an absent early step never
  // happened. The tail is the right end to keep, because the work-in-progress
  // and the refusal both live at the end.
  const transcriptBlock = block(
    `Final portion of the refused agent's transcript (last ${capBytes} bytes; earlier turns are cut)`,
    '```\n' + transcriptText + '\n```'
  )
  return fallbackNote + header + work + truncationNote + transcriptBlock
}

export function writeHandoffFile (paths, runId, body) {
  const file = join(runDir(paths, runId), HANDOFF_FILE)
  try {
    mkdirSync(runDir(paths, runId), { recursive: true })
    writeFileSync(file, body)
    return file
  } catch {
    return null
  }
}

// The harness truncates `additionalContext` to 8000 characters and 200 lines,
// from the front, and reports that to nobody the hook can reach. A handoff
// written straight into it loses its transcript silently and stops mid-JSON
// under a heading claiming to be the last N bytes. So the evidence goes to a
// file, uncapped, and the injected text is a short brief pointing at it. What
// stays inline is only what must survive even if the successor never opens
// the file: which run this is, and the rules that stop it doing damage.
export function briefContext (baton, handoffFile, opts = {}) {
  const lines = [
    '# Cyber Delegation handoff',
    '',
    `You are resuming run \`${baton.runId}\`, which an earlier subagent could not finish.`,
    `That agent was refused by guardrails on \`${baton.refusedModel ?? 'an earlier model'}\`.`,
    `This is attempt ${baton.attempt}.`,
    ''
  ]

  if (opts.targetedBatonUnreadable === true) {
    lines.push(
      `The run \`${opts.targetedRunId}\` named in .ccd/next-claim had a baton that failed to parse`,
      `and was quarantined. This is a fallback claim on run \`${baton.runId}\` instead. Weigh that`,
      'run id against your dispatch prompt before trusting anything in the handoff.',
      ''
    )
  }

  if (handoffFile === null) {
    lines.push(
      `**The handoff file could not be written.** Read \`.ccd/runs/${baton.runId}/baton.json\``,
      'directly instead: it holds the file list and the scoped git state.',
      ''
    )
  } else {
    lines.push(
      `**Read \`${handoffFile}\` now, before anything else.** It holds the previous agent's`,
      'transcript tail, the exact files it touched, and the git state scoped to those files.',
      ''
    )
  }

  lines.push(
    '**State your own model ID as the first line of your output.** Model identity is',
    'otherwise only ever reported on failure, and this is the only success-path signal',
    'available.',
    '',
    'Compare the run id above against the one in your dispatch prompt. If they differ, stop',
    "and report the mismatch: you were handed another run's work, and every agent here",
    'shares one working tree.',
    '',
    'Do not reword the task and retry it. That remedy has been tested and falsified.'
  )
  return lines.join('\n') + '\n'
}

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
  const writeHandoffFn = deps.writeHandoffFn ?? writeHandoffFile

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

  const opts = { targetedBatonUnreadable, targetedRunId: pointer }
  const body = handoffBody(claimed.baton, transcriptText, config.maxInjectedTranscriptBytes, opts)
  const handoffFile = writeHandoffFn(paths, claimed.runId, body)

  return {
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext: briefContext(claimed.baton, handoffFile, opts)
    }
  }
}

export function handleStart (input, deps = {}) {
  const root = deps.root ?? findProjectRoot(process.cwd())
  const paths = ccdPaths(root)
  const isEnabledFn = deps.isEnabledFn ?? isEnabled

  // The gate is the first thing checked once the project root is known, and
  // it returns before a transcript is read or a baton is claimed. The hook is
  // registered with a `ccd-continuation` matcher, so the harness has already
  // spared an ordinary dispatch even this much: no process is spawned at all
  // for a subagent that was never going to be a continuation.
  if (!isEnabledFn(paths)) return null

  return computeStart(input, deps, root, paths)
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
