# cyber-delegation

A Claude Code plugin. When a subagent is refused by model guardrails, it captures what that agent touched and hands the work to a successor pinned to Opus 4.6.

## Install

```
/plugin marketplace add 0xntpower/Claude-Cyber-Delegation
/plugin install cyber-delegation@cyber-delegation
```

Then arm it in a project that needs it with `/ccd-enable`. Installing alone
does nothing.

To run from a local clone instead, point the marketplace at the checkout:
`/plugin marketplace add /path/to/Claude-Cyber-Delegation`.

## How it works
This Claude code plugin will have your main agent
estimate the likelyhood of different parts in the upcming implementation plan to trigger
the model's Cyber guardrails.

using those assessed risk levels your model will decide which tasks it should dispatch an Opus 5 subagent for and which to dispatch an Opus 4.6 subagent for which from my experience has very forgiving guardrails.

In addition to that, if an Opus 5 subagent was dispatched and got terminated by guardrails your main agent will recognize that, adjust the scoring for that area of the project and then dispatch an Opus 4.6 subagent to continue the work.

Your main agent is considered the Orchestrator and also will be educated to use different techniques to limit its exposure to details that could trigger its own guardrails while still
being able to effectively orchestrate and manage the development through the subagents it sends
out to take the larger risks and keep the development going.

This plugins is enabled per project manually as I would not recommend using it in projects where its not needed. Its useful for projects that might have certain areas and components that would trigger guardrails while other areas dont and you want the highest quality possible models to work on it while not risking your sessions constantly getting killed by overly sensitive guardrails.

## Tooling
The Agent tool's model parameter takes an alias: sonnet, opus, haiku, fable. There is no way to type claude-opus-4-6 into it. Agent definition frontmatter does accept a full model ID, so a file can pin what a parameter cannot. This plugin ships those files.

## How the relay works

`SubagentStop` fires when a subagent ends. If the transcript shows a refusal,
the hook reads which files that agent edited out of its own transcript, scopes
`git status` and `git diff` to exactly those paths, and writes a baton under
`.ccd/runs/`. Scoping matters because several agents usually share one working
tree, and an unscoped diff would hand a successor someone else's changes.

`SubagentStart` fires when `ccd-continuation` begins. It claims the baton and
injects the dead agent's transcript and scoped diff as context. The orchestrator
passes a run id and never handles the payload itself.

Two attempts, then the run halts and writes a handoff report. A rate limit is
not treated as a refusal, since waiting fixes one and downshifting does not.

## Agents

| Agent | Use |
|---|---|
| `ccd-continuation` | Resume work a refused subagent left unfinished |
| `ccd-implementer` | Start clean where an Opus 5 attempt would only be refused |
| `ccd-reviewer` | Review those areas, read-only by construction |

All three pin `model: claude-opus-4-6`. A live dispatch confirmed the pin holds:
the agent reported `claude-opus-4-6[1m]` while its parent session ran Opus 5.
The `[1m]` arrives from session configuration, so
no hand edit is needed and no frontmatter suffix either. One caveat on that
evidence: a model reads its own ID from its system prompt rather than from the
routing layer.

`scripts/probe-1m.mjs` checks whether `claude-opus-4-6[1m]` resolves on your
account and records the answer in `.ccd/config.json`. It records, it does not
enable. Nothing at runtime reads that value.

## Risk ledger

`.ccd/risk-ledger.json` holds a 1-to-10 score per path glob, built from observed
kills and successes with the evidence kept beside each number. It is advice. No
code path in this plugin gates, blocks, or overrides a dispatch.

Record a prior:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/set-prior.mjs" 'src/inject/**' 8
```

Kills that wrote nothing to disk cannot be attributed to any path, and roughly
four in five land that way. Those increment an `unattributed` counter instead,
so a thin score reads as thin rather than as safe.

## Status

Off by default. Installing the plugin changes nothing until you arm it, per
project:

```
/ccd-enable
```

That creates `.ccd/enabled`. Both hooks check for it first, before reading a
transcript, loading the ledger, or invoking git, so an unarmed project pays
only for a directory stat. The setting is sticky: it survives across sessions
until `/ccd-disable` removes the marker. The first hook fire of a session in
an armed project prints a one-line notice, even when the outcome is otherwise
silent, so a sticky enable does not go unnoticed. The notice is skipped when
the harness sends no session id, since there is nothing to key it to. Check
the current state, including the risk ledger summary, with `/ccd-status`.

## Test

```bash
npm test
```

No runtime dependencies. The count is whatever `npm test` reports, which is
why it is not written down here.
