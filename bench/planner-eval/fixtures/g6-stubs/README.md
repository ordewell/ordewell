# invoice-kit

Reads an invoice from CSV, totals it with tax, and renders it as text. Plain
Node, no dependencies.

| Module | What it owns | Calls |
| --- | --- | --- |
| `src/money.mjs` | amounts as whole cents, read and written | — |
| `src/tax.mjs` | the tax on an amount | — |
| `src/csv.mjs` | CSV records | — |
| `src/lines.mjs` | one invoice line and its amounts | `money`, `tax` |
| `src/invoice.mjs` | an invoice read from CSV, and its totals | `csv`, `lines` |
| `src/render.mjs` | an invoice as text | `money`, `lines`, `invoice` |

Every function's contract is its doc comment. Each module has its tests in
`test/<module>.mjs`; `npm test` runs them all.
