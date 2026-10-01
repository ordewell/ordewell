---
name: to-spec
description: Turn the current conversation into a product spec and save it to the project.
disable-model-invocation: true
---

This skill takes the current conversation context and codebase understanding and produces a spec document. Do NOT interview the user — just synthesize what you already know.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the spec.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. The fewer seams across the codebase, the better — the ideal number is one.

Check with the user that these seams match their expectations.

3. Write the spec using the template below, then save it to `.ordewell/spec.md` in the project's working directory.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A long, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want <feature>, so that <benefit>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:
- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts

Do NOT include specific file paths or code snippets. They end up being outdated very quickly.

## Testing Decisions

A list of testing decisions that were made. Include:
- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Any further notes about the feature.

</spec-template>
