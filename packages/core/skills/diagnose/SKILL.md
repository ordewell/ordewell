---
name: diagnose
description: Explain a failure before fixing it: a bug, a failing test or build, a regression, a crash. Not for a build with known steps or a question your research answers.
---

Find the cause before you plan a fix. A fix planned from a guess passes for the wrong reason or moves the failure. The order is fixed: reproduce, hypothesise, investigate, decide, fix.

## 1. Reproduce

Get a command that fails, and what it prints when it does. The user may have given one; otherwise search for it. Ask the user only for what you cannot find: the input, the environment, how often it happens.

- A command you can run yourself this turn: run it, in a sealed run or with `run_script`, and keep its output.
- One you cannot run this turn: a research task that runs it and reports the exact command and output.
- A failure with no command: a research task that writes a failing test in its own throwaway worktree and reports the test's text and its result. The worktree is thrown away, so the text must be in the report. A fix task will add the test itself.
- A script task fails when the bug reproduces. That is its answer, but it also reads as a failed task, and everything that depends on it is blocked. Use one only when nothing depends on it.

If nothing reproduces it, say so and make that the first round: a failure you cannot trigger cannot be checked fixed.

## 2. Hypotheses

Write two to four causes that differ in mechanism, not in wording. A hypothesis is a claim about the code or its inputs, such as "the cache is keyed by path, so a rename serves the old entry", not "something is wrong with the cache". Say what each one predicts that the others do not.

## 3. Investigate

When one sealed command can settle a hypothesis, test it yourself this turn: run it, and keep the command and its output. Give a hypothesis its own research task only when testing it needs a worktree (a failing test, a build, a long run) or another model. Those run side by side while you keep talking with the user. Each brief stands alone and holds:

- the failure: the command and the output you reproduced;
- the one hypothesis to test, and where to start;
- a prediction that could prove it wrong: "if this is the cause, then changing X makes the failure go away, and Y shows Z. If it does not, the hypothesis is wrong";
- the report: the prediction's result first, then evidence for and against with file paths and line numbers, and the command it ran and what it printed. It may name a cause you missed.

Tell the user in a line what you are testing, then wait. Each report wakes you.

## 4. Decide from evidence

A hypothesis stands when its prediction was tested and held, and the rest are shown wrong or not shown right. A report's confident prose is not evidence; its commands and their output are. Re-run the one command that decides when the plan rests on it.

- Two survive, or one survives untested: plan a research task whose experiment separates them, or tries to break the survivor.
- All fail: say what they ruled out, form new hypotheses from what the reports found, and run another round.
- One stands: tell the user the cause and the evidence in a few lines, then plan the fix.

## 5. Fix, checked against the reproduction

A change task for the fix. It adds the reproduction as a test if the workspace lacks one, and runs it and the wider suite itself before it completes. A research task's test was thrown away, so the fix task depends on that task and reads its report with `read`; do not copy the test into the brief. Its brief names the cause and the files, and says to change the cause and nothing near it.

Put the fix in a loop only when the user asked to iterate until the reproduction passes, or it is a specific acceptance gate that needs independent repeated checking and fixing; say why in the outline. Then:

- If the reproduction is not yet a test the workspace holds, a first change task adds it and changes no production code. Make the loop's check depend on a research task whose test was thrown away: the body tasks may then depend on it too, and read its report with `read`.
- The check is a script task running the reproduction. Add the wider suite as a second command so a fix that breaks something else fails the round.
- Choose the rounds deliberately. A check that runs out of rounds blocks what follows, which is the right outcome when the fix does not converge.

When the fix ends, tell the user whether the reproduction passes and what changed.
