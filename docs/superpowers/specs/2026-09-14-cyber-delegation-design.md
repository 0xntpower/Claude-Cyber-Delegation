# Cyber Delegation — Design

**Date:** 2026-09-14
**Status:** Design approved, pending spec review
**Plugin name:** `cyber-delegation` (internal prefix `ccd`)

## Problem

Claude Code sessions doing subagent-driven development on security-adjacent
projects lose subagents to guardrail refusals. Observed rate in a live Opus 5
orchestrator session on this machine, **three of four local subagent dispatches
died on a guardrail**, plus two earlier on a rate limit.

The workaround in use today is manual. A permanently-running Opus 4.6 1M session
sits in the same directory, driven by cross-session messaging, because the
orchestrator cannot dispatch an Opus 4.6 subagent itself. This plugin replaces
that arrangement.

### Why the orchestrator cannot do this today

The `Agent` tool's `model` parameter is an **alias enum** (`sonnet | opus |
haiku | fable`). There is no way to express `claude-opus-4-6` through it. The
orchestrator's report that "its tool won't allow it" is literally correct.

**Agent definition frontmatter does accept full model IDs.** From the shipped
schema, quoted in part:

> Model alias (e.g. 'fable', 'opus', 'sonnet', 'haiku') or full model ID
> (e.g. 'claude-fable-5').

So a file can pin what a parameter cannot. That file is the plugin's headline
deliverable.

## Verified platform facts

All confirmed against the Claude Code 2.1.270 binary on this machine.

| Fact | Evidence |
|---|---|
| `claude-opus-4-6` is a live model ID | present in the embedded model catalog alongside 4-7, 4-8, opus-5 |
| Agent frontmatter takes full model IDs | agent-definition schema string, quoted above |
| `SubagentStop` hook exists with a usable payload | `{stop_hook_active, agent_id, agent_transcript_path, agent_type, last_assistant_message}` |
| `SubagentStart` hook exists and accepts `additionalContext` | `hookEventName:R("SubagentStart"), additionalContext` |
| `SubagentStop` additionalContext goes to the **subagent**, not the parent | *"non-error feedback delivered to the subagent"* |
| Transcripts record every edited path | `"file_path"` on each Edit and Write, 436 occurrences in one sampled transcript |
| Refusal is a distinguishable stop reason | `stop_reason == :refusal && message.stop_details` |
| Runaway relaunch is a real hazard | binary warns to honor `stop_hook_active`, and `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` exists |

### Unresolved, deferred to install-time probe

`[1m]` support is a runtime carrier check (*"doesn't have a 1M context window"*),
not a static list, and the error is named `alias_1m_unsupported`, which suggests
the suffix may be alias-level and may not compose with a full model ID. The
installer probes `claude-opus-4-6[1m]` and falls back to plain
`claude-opus-4-6` on rejection. It must never fail mid-refusal.

## Field intelligence

Gathered from the live Opus 5 orchestrator, not assumed.

1. **Guardrail failures land on 4.8, not 5.** The error text self-identified,
   *"Opus 4.8's safeguards flagged this message."* The platform's own fallback
   degrades 5 to 4.8 and 4.8 refuses anyway. The ladder must therefore start
   **below** where automatic fallback stops. That is 4.6.

2. **An alias is not a pin.** The same `"opus"` alias produced
   `claude-opus-5` on some dispatches and `claude-opus-4-8` on others within a
   single session. Model identity is only ever reported on *failure*. Successful
   dispatches report nothing at all.

3. **The orchestrator never sees refused content.** It receives status, error
   type, request ID, and the model string. The isolation this design originally
   set out to build is already free.

4. **Prompt rewording is not a remedy.** Re-dispatching with domain framing
   stripped failed too, *before the agent read a single file*. Theory falsified.
   No feature shall assume otherwise.

5. **Killed agents sometimes leave recoverable work.** One kill in five left an
   implementation plus roughly 88 lines of tests on disk. The other four left
   nothing, two having died reading their brief and two being reviewers. Capture
   unconditionally. It is cheap every time and expensive the one time it is
   missed.

6. **All agents share one working tree.** Up to three agents plus the
   orchestrator held concurrent uncommitted work. A naive kill-time diff is
   contaminated. Attribution is mandatory, not optional.

7. **Report silence is not evidence of no deviation.** A constructor returned
   with a signature differing from the locked plan, inside a report saying DONE
   with no concerns. It was caught only by mechanically diffing signatures.

## Core principles

**Opus 5 is the default because it produces better work. Opus 4.6 is damage
control, not a preference.** Every decision starts from "try Opus 5" and needs
evidence to depart from it.

**A kill is measurement, not waste.** An Opus 5 attempt that dies converts an
assumption into data about that code area. This justifies attempting Opus 5 more
often than pure efficiency would suggest.

**Everything the plugin knows is advisory.** Risk scores inform the agent. They
never gate, block, or override a dispatch. The plugin has no interception point
in the dispatch path and cannot refuse a choice the orchestrator makes.

## Risk model

Risk is a **1 to 10 spectrum**, not a boolean. 1 is routine and 10 is a
near-certain session kill.

### Inputs

- **Prior**, from model judgment at plan time or a conversational hint from the
  user such as "component X will probably be risky". The skill records it.
  **The user never edits the ledger by hand.**
- **Posterior**, adjusted by hooks from observed outcomes. A kill on an area
  adds 2, capped at 10. A clean success subtracts 1, floored at 1. Per-model
  tallies are kept alongside.

Transparent arithmetic, deliberately not a learning system.

### Areas

Areas are **file-path globs**, derived automatically. The kill hook extracts
touched paths from the dead agent's transcript, so scoring requires no
bookkeeping from the orchestrator or the user.

Known limitation, accepted. A risk that is conceptual rather than locational
smears across whatever directories happen to contain it.

### Evidence, not verdicts

The ledger stores attempts, kills, successes, and the model each outcome came
from, not merely a number. A 9 built from one kill in one attempt is weaker
evidence than a 9 from four kills in five attempts, and the record shows which.
Guardrail triggers are not deterministic. The score is guidance, never a switch.

### Advisory guidance table

This table is **advice presented to the orchestrator**, not a routing rule the
plugin enforces. The agent weighs it against everything else it knows and
decides. The plugin records what happened either way.

| Score | Reading | Suggested treatment |
|---|---|---|
| 1 to 3 | routine | normal Opus 5 dispatch, plugin stays dormant |
| 4 to 6 | plausible | Opus 5, with kill-capture armed |
| 7 to 8 | likely | still Opus 5. Quality is worth one attempt and a kill is measurement |
| 9 to 10 | near-certain | consider `ccd-implementer` directly, and `ccd-reviewer` for review |

Score also **suggests** an exposure level. Areas at 7 and above are worth
reporting tighter to the orchestrator, since high-risk content in the
orchestrator's context is what threatens the orchestrator. This is a
recommendation surfaced from the ledger, never a configured rule and never
enforced.

### Re-probing high-score areas

**Manual only.** The plugin never decides on its own to re-test a 9 or 10 area
against Opus 5. It keeps advising 4.6 until the user asks for a re-test.

To keep a stale score from silently costing Opus 5 quality forever, the ledger
**surfaces staleness**. When an area has gone `stale_after_dispatches` (default
10) without an Opus 5 attempt, and its most recent Opus 5 evidence is older than
`stale_after_days` (default 30), the plugin reports that in its status output
and in the refusal `systemMessage`. Both thresholds live in `.ccd/config.json`.
The user retains control. The plugin supplies the signal that prompts them to
use it.

## Architecture

```
.claude-plugin/plugin.json
agents/
  ccd-continuation.md    model: claude-opus-4-6
  ccd-implementer.md     model: claude-opus-4-6
  ccd-reviewer.md        model: claude-opus-4-6   (no Edit or Write)
hooks/
  hooks.json
  subagent-stop.mjs      entry point
  subagent-start.mjs     entry point
lib/
  paths.mjs              project root, .ccd locations, config with defaults
  classify.mjs           refusal / rate_limit / normal
  transcript.mjs         edited-path extraction from JSONL
  gitstate.mjs           git state scoped by pathspec
  ledger.mjs             risk scores, evidence, staleness
  baton.mjs              baton write, atomic claim, origin linkage
skills/
  cyber-delegation/SKILL.md
scripts/
  probe-1m.mjs           install-time [1m] capability probe
test/                    node:test suites, one per lib module
```

**Implementation language: Node ESM, zero dependencies.** The hooks must parse
JSON from stdin, scan JSONL transcripts, shell out to git, and emit JSON. `jq`
is not present on the target machine, which rules out the bash approach. Node
v24 is available with a built-in test runner. Using `.mjs` also avoids the
Windows `.sh` auto-detection that forced superpowers into a polyglot wrapper, so
hooks are invoked directly as `node "${CLAUDE_PLUGIN_ROOT}/hooks/<name>.mjs"`.

Runtime state lives in the project at `.ccd/`:

```
.ccd/
  config.json            ladder, attempt budget, probed 1m support,
                         stale_after_dispatches, stale_after_days
  risk-ledger.json       scores and evidence, written by hooks
  runs/<agent_id>/       batons, captured git state, transcript pointers
```

## Components

### Agents

All three share:

- `model: claude-opus-4-6`, the full ID, which is the pin unreachable through
  the `Agent` tool parameter. Probed for `[1m]` at install with clean fallback.
- **First output line states its own model ID.** Model identity is otherwise
  reported only on failure. This is the only success-path observability channel
  available.
- Report in **15 lines or fewer**, covering status, commit SHA, one-line test
  summary, exact landed signatures, and concerns, with full detail written to a
  report file. This codifies the pattern the live orchestrator arrived at
  independently. Without it, subagents return everything and it lands in the
  orchestrator's context permanently.
- **Banned git verbs:** `add -A`, `stash`, `checkout`, `restore`, `commit`.
  In a shared tree `git commit` commits the whole index, so concurrent agents
  swallow each other's staged files. The rest are outright destructive.

| Agent | Role |
|---|---|
| `ccd-continuation` | Resumes refused work. Receives the baton via `SubagentStart` injection. |
| `ccd-implementer` | Direct dispatch when the orchestrator judges an Opus 5 attempt not worth making. |
| `ccd-reviewer` | Independent review of high-risk areas. **No Edit or Write tools**, so it structurally cannot fix what it reviews. |

### Hook: `subagent-stop`

1. If `stop_hook_active` is true, exit 0 immediately. Without this the plugin
   ships an infinite refusal-to-relaunch loop.
2. Classify the outcome as `refusal`, `rate_limit`, or `normal`. **A rate limit
   is not a refusal.** Its remedy is waiting rather than downshifting, and both
   were observed in the field.

   **Classification must read the transcript tail, not `last_assistant_message`.**
   An earlier draft of this design proposed the cheaper path. Field evidence
   rules it out: on a refusal the orchestrator observed only *"whatever partial
   text the agent emitted before dying, which was typically one line like 'I'll
   start by reading the brief.'"* That field carries pre-death partial output,
   not the refusal marker, so classifying from it would report `normal` on every
   refusal. The authoritative signal is `"stop_reason":"refusal"` in the
   transcript. The hook scans the final 256 KB rather than the whole file, which
   keeps the cost bounded without sacrificing correctness.
3. On `refusal` only, write `.ccd/runs/<agent_id>/baton.json` containing:
   - `transcript`, the `agent_transcript_path` supplied directly in the payload
   - `files`, every `"file_path"` written by an Edit or Write tool call in that
     transcript, deduplicated and **filtered to paths under the project root**.
     This is authoritative attribution for a shared tree. It names exactly what
     this agent touched, with no coordination protocol and no race. The filter
     is not optional: a sampled transcript contained `file_path` entries under
     the session scratchpad in `AppData\Local\Temp`, which would otherwise
     pollute both the git scope and the derived risk area.
   - `state`, from `git diff --stat` and `git status --porcelain`, **intersected
     with `files`**
   - `attempt`, `next_model`, `agent_type`, and the derived `area` glob
4. Update `risk-ledger.json`, adding 2 for the touched area and recording the
   model.
5. Emit `systemMessage` so a refusal is visible to the user even if the skill
   never fires.

On `normal` completion, update the ledger with a success, subtracting 1, so the
score has a denominator. Without logged successes a score is only a kill count.

### Hook: `subagent-start`

When `agent_type == ccd-continuation`, claim the newest unclaimed baton and emit
its contents as `additionalContext`:

- **Attempt 1**, the full dead transcript plus scoped git state. Re-injecting
  the content that tripped Opus 4.8 is intentional. The successor is a different
  model with different guardrails, and that is the entire premise.
- **Attempt 2**, a degraded payload consisting of the original spec, the scoped
  diff, and a progress note. No transcript.

The orchestrator passes only a run id. It never handles the payload.

### Skill

Four rules:

1. A refused subagent means **do not read its output**. Dispatch
   `ccd-continuation` with the run id. The refused payload provably tripped a
   classifier.
2. Consult the ledger before dispatching and weigh the score as advice. A high
   score argues for `ccd-implementer` directly. The decision stays with the
   agent.
3. **Never reword and retry.** Empirically falsified.
4. When a successor returns, diff landed signatures against the spec it was
   given. Report silence is not evidence of no deviation.

The skill also records conversational risk hints into the ledger as priors, so
the user never edits the file.

## Failure ladder

```
Opus 5 subagent            -> refused
  |- ccd-continuation      (4.6, full transcript)     attempt 1
      |- ccd-continuation  (4.6, degraded payload)    attempt 2
          |- halt, write handoff report, notify user
```

No descent below 4.6. The ladder is configurable in `.ccd/config.json`.

## Deliberately not built

| Rejected | Reason |
|---|---|
| Hand-edited risk manifest | The user will not maintain it. Hints are conversational and the ledger is hook-written. |
| Dispatch interception | Scores are advisory. The plugin has no gate in the dispatch path. |
| Orchestrator content shielding | The platform already withholds refused content. Zero code required. |
| Reword-and-retry | Falsified in the field. |
| Git worktrees per dispatch | File-set scoping chosen instead, which keeps the current workflow unchanged. |
| Automatic re-probe of high-score areas | User chose manual control. Staleness reporting substitutes. |
| A review subsystem | Out of scope. Only the narrow signature-drift check is included. |

## Known weaknesses

1. **The contract check is prompt-level, not mechanical.** The version the
   orchestrator praised requires a plan file with locked signatures, a
   convention this project does not yet have. Inventing one unprompted would be
   worse than shipping the weaker check.
2. **Rule 1 depends on the skill firing.** It is the only model-dependent link
   in the chain. The `systemMessage` is the net. Worst case the user sees the
   refusal and dispatches by hand, which is still better than the status quo.
3. **Conceptual risk smears across path globs.** Accepted with the area model.
4. **A stale 9 or 10 score costs Opus 5 quality until the user intervenes.**
   Mitigated by staleness reporting, not eliminated.

## Success criteria

1. The orchestrator can dispatch an Opus 4.6 subagent in-session. The permanent
   peer session and its cross-session messaging are retired.
2. A refused subagent is picked up automatically, with its work-in-progress
   intact and correctly attributed in a shared tree.
3. Risk scores accumulate from real outcomes without the user editing a file.
4. The plugin is inert on low-risk work and never blocks a decision the
   orchestrator wants to make.
