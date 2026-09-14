# cyber-delegation

A Claude Code plugin that lets an orchestrator dispatch Opus 4.6 subagents
directly, and hands guardrail-refused work to them automatically with the dead
agent's transcript and correctly scoped git state intact.

## Why it exists

The `Agent` tool's `model` parameter is an alias enum. There is no way to type
`claude-opus-4-6` into it. Agent definition frontmatter does accept full model
IDs, so a file can pin what a parameter cannot. This plugin ships those files.

Guardrail failures were observed landing on Opus 4.8 after the platform's own
fallback had already degraded from Opus 5. The ladder therefore starts below
where automatic fallback stops.

## Install

```bash
node scripts/probe-1m.mjs
```

The probe determines whether `claude-opus-4-6[1m]` resolves on your account and
**records** the answer in `.ccd/config.json` for you to act on. If it cannot
tell, it records the safe default and says so.

Recording is all it does. Nothing at runtime reads that value: the three agents
carry a static `model: claude-opus-4-6` in their frontmatter, because frontmatter
is the only place a full model ID can be pinned.

**This has now been measured, and no hand edit is needed.** A live probe
dispatched a project agent whose frontmatter said exactly `model:
claude-opus-4-6`, no suffix, from a session configured as `opus[1m]`, and the
agent reported itself back as `claude-opus-4-6[1m]`. The full model ID is
honoured as written, the agent did not inherit its parent session's model, and
the `[1m]` modifier propagates from session configuration onto the pinned
model without ever needing to appear in frontmatter. Writing
`claude-opus-4-6[1m]` into an agent file remains both untested and
unnecessary, and the agents keep the bare ID. The one honest caveat: a model
reports its own ID from its system prompt, not from the routing layer, so this
is strong evidence rather than proof, strengthened by the fact that the
reported ID differed from the parent session's model.

## What it does

- `SubagentStop` detects a guardrail refusal, extracts the files the dead agent
  touched from its own transcript, scopes git state to exactly those files, and
  writes a baton.
- `SubagentStart` claims that baton and injects it into `ccd-continuation`,
  whose frontmatter pins `claude-opus-4-6`.
- A risk ledger accumulates advisory 1-to-10 scores per path glob from observed
  outcomes. Nothing it knows ever gates a dispatch.

## Agents

| Agent | Use |
|---|---|
| `ccd-continuation` | Resume work a refused subagent could not finish |
| `ccd-implementer` | Start clean on an area measured hostile to Opus 5 |
| `ccd-reviewer` | Review such an area, read-only by construction |

## Test

```bash
npm test
```
