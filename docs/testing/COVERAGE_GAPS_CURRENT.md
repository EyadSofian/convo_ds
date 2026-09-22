# Current coverage gate

Fresh `pnpm test:coverage` result on 2026-09-22:

| Metric | Covered | Total | Result |
| --- | ---: | ---: | ---: |
| Statements | 28,497 | 28,497 | 100% |
| Functions | 2,120 | 2,120 | 100% |
| Branches | 10,941 | 10,941 | 100% |

Remaining gaps: none.

Coverage thresholds remain unchanged. No coverage exclusions or ignore
directives were added. The existing process-entry exclusions are unchanged.

The final uncovered UI cases were covered with focused rendered tests. Two
redundant fallbacks were removed where their input had already been narrowed by
the surrounding code: an operator fallback after operator normalization, and
unreachable Agent/Channel selection paths in the Overview renderer. Custom
boolean filter forms now retain their actual custom-field type when building a
query, correcting the boolean-value mapping at that same public form boundary.
