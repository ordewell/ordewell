---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
disable-model-invocation: true
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it. Walk the tree one branch at a time, resolving each decision before the ones that depend on it.

**Ask exactly one question per message.** Never batch, number, or stack several questions, and never tack a second question onto the first, even if you already know what you'd ask next. Then stop and wait for the user's answer. Which question comes next depends on that answer, so anything you queue up now is a guess at an answer you haven't heard.

Format each question like so:

❓ **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

Finding _facts_ is your job, never the user's. When a question needs a fact from the environment, explore the workspace yourself with your own read-only tools, and, where a research subagent is available to you, delegate exploration to it instead of reading everything inline. Don't ask the user for anything you could look up yourself. The _decisions_ are the user's: put each to them and wait.

The goal is a shared understanding sharp enough to decompose into independently demoable slices: questions about slice boundaries, dependencies between slices, and what's out of scope are legitimate branches of the design tree, not distractions from it.

The session is done when every branch of the design tree has been visited and nothing is left silently assumed. That doesn't end the session on its own: you now propose a prose outline of vertical tracer-bullet slices, the same outline-before-JSON step you'd reach at the end of any research phase. Do not emit the task plan JSON until the user has confirmed that outline.
