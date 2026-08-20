---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
disable-model-invocation: true
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:


❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>


Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment, explore the workspace yourself with your own read-only tools, and, where a research subagent is available to you, delegate exploration to it instead of reading everything inline. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for it to report back; ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.

The goal is a shared understanding sharp enough to decompose into independently demoable slices: questions about slice boundaries, dependencies between slices, and what's out of scope are legitimate branches of the design tree, not distractions from it.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. An empty frontier doesn't end the session — it means you now propose a prose outline of vertical tracer-bullet slices, the same outline-before-JSON step you'd reach at the end of any research phase. Do not emit the task plan JSON until the user has confirmed that outline.
