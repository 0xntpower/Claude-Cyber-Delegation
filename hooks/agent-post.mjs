import { readFileSync } from 'node:fs'
import { ccdPaths, findProjectRoot } from '../lib/paths.mjs'
import { isEnabled } from '../lib/gate.mjs'
import { claimAnnounce, pendingBatons } from '../lib/baton.mjs'

// More than a handful of simultaneous refusals is a situation for a human,
// not a longer prompt. The cap also keeps this well inside the harness's
// 8000-character, 200-line ceiling on injected context.
const MAX_ANNOUNCED = 4

// `SubagentStop` fires inside the dying subagent's own stream, so anything it
// emits lands in that subagent's transcript and in the user's terminal. It
// never reaches the orchestrator. `additionalContext` on a PostToolUse hook
// for the Agent tool is the one channel that does: that hook runs in the
// parent's loop, for the parent's tool call, and its output is injected into
// the parent's context. This is what makes the relay automatic rather than
// something the user has to read off the screen and repeat.
export function relayContext (announced) {
  const blocks = announced.map(({ runId, baton }) => {
    const kind = baton.category === null || baton.category === undefined
      ? 'guardrails'
      : `${baton.category} guardrails`
    const count = Array.isArray(baton.files) ? baton.files.length : 0
    const touched = count === 0
      ? 'It wrote nothing to disk before dying.'
      : `It had already changed ${count} file${count === 1 ? '' : 's'}; that work is still in the tree and is captured in the baton.`
    return [
      `### Run \`${runId}\``,
      '',
      `A \`${baton.agentType ?? 'subagent'}\` subagent was refused by ${kind} on \`${baton.refusedModel ?? 'an earlier model'}\`. This is attempt ${baton.attempt}.`,
      touched,
      '',
      'Do this now, in order:',
      '',
      `1. Do not read that agent's output. It provably tripped a classifier and your context is the one that cannot be recovered.`,
      `2. Point the claim at this run, or the successor will take whichever baton is newest instead:`,
      '',
      '   ```bash',
      `   printf '%s' '${runId}' > .ccd/next-claim`,
      '   ```',
      '',
      `3. Dispatch the \`ccd-continuation\` subagent and name run \`${runId}\` in its prompt. Its transcript, file list and scoped diff are injected for it automatically.`
    ].join('\n')
  })

  const overflow = announced.length >= MAX_ANNOUNCED
    ? '\nMore refusals may be pending. Re-check `.ccd/runs/` after handling these.\n'
    : ''

  return [
    '# Cyber Delegation: a subagent was refused',
    '',
    'Handle each run below before continuing with the plan. Steps 2 and 3 go together: run the command, then dispatch, one run at a time.',
    '',
    blocks.join('\n\n'),
    overflow
  ].join('\n')
}

export function handleAgentPost (input, deps = {}) {
  const root = deps.root ?? findProjectRoot(process.cwd())
  const paths = ccdPaths(root)
  const isEnabledFn = deps.isEnabledFn ?? isEnabled
  const pendingFn = deps.pendingFn ?? pendingBatons
  const claimFn = deps.claimAnnounceFn ?? claimAnnounce

  // Same gate, same position, same reason as the other two hooks: an unarmed
  // project pays for a directory walk and a stat and nothing else.
  if (!isEnabledFn(paths)) return null

  // The announce lock is taken here rather than after the message is built, so
  // that two Agent tool calls finishing together cannot both announce the same
  // run. Whichever hook loses the race simply has nothing to say.
  const announced = []
  for (const entry of pendingFn(paths)) {
    if (announced.length >= MAX_ANNOUNCED) break
    if (claimFn(paths, entry.runId)) announced.push(entry)
  }
  if (announced.length === 0) return null

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: relayContext(announced)
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
    result = handleAgentPost(input)
  } catch {
    process.exit(0)
  }
  if (result !== null) process.stdout.write(JSON.stringify(result))
  process.exit(0)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('agent-post.mjs')) main()
