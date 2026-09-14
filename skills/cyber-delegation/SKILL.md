---
name: cyber-delegation
description: Use when dispatching subagents on security-adjacent work, when a subagent has been refused by guardrails, or when the user says a component is likely to trigger guardrails. Covers handing refused work to Opus 4.6 and reading the advisory risk ledger.
---

# Cyber Delegation

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
2. Dispatch `ccd-continuation`. Pass the run id from the `[ccd]` message and
   nothing else. The transcript, the file list, and the scoped git state are
   injected into that agent automatically.
3. A rate limit is not a guardrail refusal. Its remedy is waiting. The `[ccd]`
   message tells you which one happened.

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

When the user says a component is likely to trigger guardrails, write it into
`.ccd/risk-ledger.json` as a prior:

```json
{
  "version": 1,
  "areas": {
    "src/inject/**": { "score": 8, "source": "user-hint", "attempts": 0, "kills": 0, "successes": 0, "byModel": {}, "lastOpus5AttemptAt": null, "dispatchesSinceOpus5": 0, "history": [] }
  }
}
```

Merge into the existing file rather than overwriting it. The user never edits
this file by hand.
