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
writes the answer to `.ccd/config.json`. If it cannot tell, it writes the safe
default and says so.

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
