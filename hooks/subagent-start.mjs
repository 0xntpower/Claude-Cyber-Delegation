import { readFileSync } from 'node:fs'
import { ccdPaths, findProjectRoot, loadConfig } from '../lib/paths.mjs'
import { readTail } from '../lib/classify.mjs'
import { claimBatonById, claimNewestBaton, clearNextClaim, readNextClaim, writeOrigin } from '../lib/baton.mjs'

const CONTINUATION = 'ccd-continuation'

function block (title, body) {
  return `## ${title}\n\n${body}\n`
}

function fileList (files) {
  return files.length === 0 ? '(none attributable)' : files.map(f => `- ${f}`).join('\n')
}

function buildContext (baton, transcriptText, capBytes) {
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

  // The injected text is the tail, not the whole transcript, and saying so
  // matters: the successor must not conclude that an absent early step never
  // happened. The tail is the right end to keep, because the work-in-progress
  // and the refusal both live at the end.
  return header + work + block(
    `Final portion of the refused agent's transcript (last ${capBytes} bytes; earlier turns are cut)`,
    '```\n' + transcriptText + '\n```'
  )
}

export function handleStart (input, deps = {}) {
  if (input.agent_type !== CONTINUATION) return null

  const root = deps.root ?? findProjectRoot(process.cwd())
  const paths = ccdPaths(root)
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
      additionalContext: buildContext(claimed.baton, transcriptText, config.maxInjectedTranscriptBytes)
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
