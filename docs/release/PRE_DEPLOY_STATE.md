# Pre-deploy state

Recorded on 2026-09-17 before this release-completion pass changed source or
Railway configuration.

## Source control

| Fact | Value |
| --- | --- |
| Repository | `/Users/eyad/Downloads/convo` |
| Starting branch | `release/production-hardening` |
| Starting SHA | `2aa0881e4b7221f5a37ec2fcff8ec9bd4e46989a` |
| Starting tags | none |
| Worktree | dirty: 49 tracked modifications/deletions and 39 untracked paths reported by porcelain status |
| Migration high-water mark in the worktree | `0031_invitation_tenant_scope.sql` |

The configured task working directory (`/Users/eyad/Downloads/convo `) has a
trailing space and is an empty sibling directory. All release work is therefore
performed against the actual Git repository at the path above.

The Apple-provided `git` is blocked by an unaccepted Xcode licence. Repository
inspection uses the read-only-compatible bundled Git binary at
`/Users/eyad/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/git`.
No source was reset, discarded, stashed, or overwritten.

The earlier hardening pass already created a full-tree safety archive before its
first edit and recorded its original dirty state in
`docs/audit/STARTING_STATE.md`. This pass preserves that work in place.

## Commands executed before edits

The required `git status`, `git diff --stat`, full `git diff`, 30-entry log,
branch listing, and tag listing were executed before this file was created.
The full diff was inspected from the current worktree; terminal presentation
truncated the displayed copy but the command itself completed successfully.

## Railway state observed before edits

| Fact | Value |
| --- | --- |
| Project | `convo-client-demo` (`09c4e61b-b956-466f-bb21-9b32fc4527f5`) |
| Environment | `production` (`ea473c79-c29e-4aab-91c4-e48f606dc057`) |
| Public web | `convo-client-demo-production.up.railway.app` |
| Existing services | `Postgres`, `convo-api`, `convo-client-demo`, `convo-database`, `convo-worker-inbound`, `convo-worker-interactive`, `convo-worker-campaign`, `convo-worker-report` |
| Missing required services | `convo-worker-integration`, `convo-worker-automation` |
| Persistent database volume | `postgres-volume`, READY, mounted at `/var/lib/postgresql/data` |

No Railway service, database, volume, variable, or deployment was changed while
collecting this state.

## Release invariants

- Do not deploy until the worktree is reviewed, the complete suite passes, and
  a release commit and tag identify the exact artifact.
- Do not delete or recreate the production database or its volume.
- Do not claim live Resend or Meta verification without real provider evidence.
- Do not run destructive recovery or load tests against production customer
  data.
