---
name: tdd
description: Work test-first in red-green slices. Attach to tasks that implement or change behaviour; not to verification-only, docs or ops tasks.
applies-to: task
disable-model-invocation: true
---

Work test-first in vertical slices at the seams your task prompt names. A seam is the public boundary you test at — if the prompt names none, identify the highest public interface and test there, never against internals.

1. RED: Write ONE failing test for the next behavior, through the public interface
2. GREEN: Write minimal production code to make that test pass

Rules:
- One test per RED-GREEN cycle — do not write all tests first
- Expected values must come from an independent source of truth (spec, worked example, known-good literal), never recomputed the way the code computes them
- Prefer integration-style tests over unit tests with mocks; tests should survive internal refactors
- Use the project's existing test framework and patterns
- While iterating, run the typechecker and the single test file you are touching frequently; run the full test suite once at the end of the task
- Refactoring is not part of the red-green cycle: only once all tests are green, tidy what this task touched, keeping tests green
