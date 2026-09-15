---
name: cyber-delegation
description: Use when dispatching subagents on security-adjacent work, when a subagent has been refused by guardrails, or when the user says a component is likely to trigger guardrails. Covers handing refused work to Opus 4.6 and reading the advisory risk ledger.
---

# Cyber Delegation

**Arm the plugin first.** None of this fires until `/ccd-enable` has been run
in this project. The gate is off by default and sticky once on. Check with
`/ccd-status`.

Opus 5 is the default because it produces better work. Opus 4.6 is damage
control, not a preference. Every decision starts from "try Opus 5" and needs
evidence to depart from it.

A kill is measurement, not waste. An Opus 5 attempt that dies converts an
assumption into data about that code area.

## Rule 1: a refused subagent

When a subagent fails with a guardrail error:

1. **Do not read its output.** That payload provably tripped a classifier, and
   your context is the one that cannot be recovered. The platform gives you
   status and error text only, which is all you need.
2. **Write the run id to `.ccd/next-claim` before you dispatch.** The `[ccd]`
   message names the run. One line, the run id, nothing else:

   ```bash
   printf '%s' 'dead-1' > .ccd/next-claim
   ```

   This is how the successor is told which run it is picking up. The
   `SubagentStart` payload cannot carry the run id, so without this pointer the
   hook falls back to **the newest unclaimed baton**, whichever run that
   happens to be. With one refusal in flight that is the same thing. With two,
   it is a coin flip, and the loser gets another run's transcript and another
   run's diff while its own baton is orphaned. In a shared working tree that
   means confidently editing the wrong files.

3. Dispatch `ccd-continuation`. Pass the run id in the prompt for the reader's
   benefit and nothing else. The transcript, the file list, and the scoped git
   state are injected into that agent automatically from the baton the pointer
   selected.
4. A rate limit is not a guardrail refusal. Its remedy is waiting. The `[ccd]`
   message tells you which one happened. Nothing is recorded in the ledger for
   a rate limit, because the dispatch never ran.
5. If the `[ccd]` message says the capture FAILED, do not dispatch a
   continuation. There is no baton to claim. The refused agent's work, if any,
   is still in the working tree.

## Rule 2: the risk ledger is advisory

`.ccd/risk-ledger.json` holds a 1-to-10 score per path glob, with the evidence
that produced it. Read it before dispatching into an area you have seen fail.

It is advice, not a rule. Nothing in this plugin gates a dispatch. Weigh the
score against everything else you know and decide.

| Score | Reading | Suggested treatment |
|---|---|---|
| 1 to 3 | routine | normal dispatch |
| 4 to 6 | plausible | normal dispatch |
| 7 to 8 | likely | still Opus 5. Quality is worth one attempt and a kill is measurement |
| 9 to 10 | near-certain | consider `ccd-implementer` directly, and `ccd-reviewer` for review |

Check the evidence, not just the number. A 9 built from one kill in one attempt
is weaker than a 9 from four kills in five attempts.

A low or missing score can mean the area is safe, or it can mean the kills
that would have scored it never touched a file to be attributed against.
`unattributed` in the ledger, a sibling of `areas`, counts exactly those
kills, so it shows how much of that silence to expect before you read a low
score as safety.

**The evidence is biased low, and knowing which way matters.** Areas come from
the files a dead agent actually edited, so a kill that wrote nothing to disk
produces no area and lands in no ledger entry. In the field roughly one kill in
five got far enough to touch a file. The rest died reading their brief, or were
reviewers who never write. So a low score on an area is weak evidence of safety,
and an area with no entry at all is not evidence of anything. Scores are a floor
on observed hostility, never a ceiling. Read a high score as informative and a
low one as mostly silence.

When the ledger reports that a high-score area has gone stale, surface that to
the user. Only they decide when to re-test an area against Opus 5.

## Rule 3: never reword and retry

Re-dispatching a refused task with the domain framing stripped out has been
tested and falsified. It failed before the agent read a single file. Do not
build on the theory that wording was the trigger.

## Rule 4: verify the contract on return

When any agent reports done, diff the signatures it landed against the ones the
task specified. A report saying DONE with no concerns has been observed to hide
a changed constructor signature. Report silence is not evidence of no deviation.

This matters most after a `ccd-continuation` returns, because a different model
finished work it did not start.

## Recording a risk hint

When the user says a component is likely to trigger guardrails, record it as a
prior with the script. Area glob first, score from 1 to 10 second. Use
`${CLAUDE_PLUGIN_ROOT}` to find the script — a skill runs with the target
project as cwd, not the plugin directory, so a bare `scripts/set-prior.mjs`
path does not exist there:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/set-prior.mjs" 'src/inject/**' 8
```

**Do not hand-write `.ccd/risk-ledger.json`, and do not hand-merge into it.**
The hooks own that file, several can be writing it at once, and its shape has
edges that are not visible from a sample. The script loads it, clamps the score,
and saves it under the same lock the hooks take. A hand-written ledger with the
wrong shape used to take the whole relay down silently.

The user never edits this file by hand either. Their hint is conversational and
you run the script.
