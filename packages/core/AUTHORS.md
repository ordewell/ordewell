# Authors

Ordewell is copyright 2026 Alessandro Costanzo Ciano and the Ordewell
contributors, and is released under the Apache License 2.0 (see [LICENSE](LICENSE)).

This repository starts from a single commit. The project was developed over a
longer private history, and that history is not published — so this file is the
record of who built what, rather than `git log`.

## Author and maintainer

- **Alessandro Costanzo Ciano** ([@ac-ciano](https://github.com/ac-ciano)) —
  author, maintainer and copyright owner. Wrote the core, the planner, the
  orchestrator, the verification engine, the VS Code extension, the terminal UI
  and the API server.

## Contributors

- **Luca Palumbo** ([@LucaPalumbo](https://github.com/LucaPalumbo)) — strict
  typing across the monorepo, the ESLint configuration, and the original CI
  workflow.
- [@directsol](https://github.com/directsol) — verified the Codex transcript
  reader against a live rollout store (#16) and made the VS Code chat panel
  follow light themes (#20).
- **Mayuri** ([@mayuriphad](https://github.com/mayuriphad)) — diagnosed and fixed the
  planner's duplicated usage-limit message (#79, #96).
- [@haltingstate](https://github.com/haltingstate) — made the terminal UI's
  stepper say what a saved step does next, instead of encoding it in a
  sentinel index (#123), and improved tool-call errors (#124).
- [@Logic769](https://github.com/Logic769) — made `/resume` an alias of
  `/sessions` in the planner chat (#139).
- Hanbin Tan ([@hskl18](https://github.com/hskl18)) — documented how
  planners and runners get their models and credentials (#140).

Thank you. Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgements

The deep-interview planning workflows — `grill-me`, PRD drafting, and TDD task
augmentation — are adapted from
[Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT).
