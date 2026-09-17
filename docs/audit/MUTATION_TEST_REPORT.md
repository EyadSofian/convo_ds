# Mutation test report

Date: 2026-09-17
Tool: StrykerJS 10.0.0 with the Vitest runner 10.0.0

## Scope and gate

The mutation gate targets bounded, high-consequence decision code rather than
the entire UI or database orchestration graph:

- trusted-proxy parsing and hop predicate;
- Meta payload construction, template normalization, error/outcome
  classification, provider message-id validation, and timeout recognition;
- automation schedule validation and next-run calculation;
- automation workflow and variable-map validation;
- invitation/recovery URL construction and token encoding.

The break threshold is 80%. String-literal, object-literal, and optional-chain
mutators are excluded: they overwhelmingly mutate localized diagnostic copy,
issue-object shape already pinned by contract tests, or defensive access whose
typed outcome is independently asserted. Behavioral conditional, equality,
logical, arithmetic, regex, boolean, block, and function mutations remain in
scope.

## Result

| Result | Count |
| --- | ---: |
| Generated | 807 |
| Explicitly excluded by mutator class | 243 |
| Scored | 564 |
| Killed | 470 |
| Timed out (infinite/slow mutation, counted detected) | 2 |
| Survived | 92 |
| No coverage | 0 |
| Mutation score | **83.69%** |
| Command result | **exit 0** |

## Survivor review

No survivor changes a tested provider outcome class, retryability decision,
proxy trust boundary, required email-link token encoding, or accepted automation
action into a rejected one (or the reverse). Those mutations are killed.

The remaining survivors group as follows:

| Area | Survivors | Review disposition |
| --- | ---: | --- |
| Meta transport | 35 | Redundant branches within compound type guards, normalization fallbacks for malformed catalogue entries, and equivalent boundary forms. Provider acceptance/rejection/unknown status and retryability mutants are killed. |
| Trusted proxy | 2 | Equivalent false branch for absent/empty input and lower-bound comparison after integer/non-negative checks. Spoofable-hop and over-trust mutations are killed. |
| Automation schedule | 38 | Equivalent calendar search/boundary forms for the validated input domain and defensive branches unreachable after schedule validation. Invalid kind/time/range, recurrence, timezone, start/end, and next-instant behavior mutations are killed. |
| Automation workflow | 17 | Defensive type checks already dominated by membership/record validation, and diagnostic path mapping. Trigger/target/step acceptance, duplicate IDs, schedule requirement, safety bounds, and variable closure mutations are killed. |

The machine-readable report is generated at `reports/mutation/mutation.json`
and intentionally ignored by Git. This summary is the reviewable release
evidence.
