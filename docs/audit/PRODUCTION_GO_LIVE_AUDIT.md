# Production go-live audit

Audit date: 2026-10-14
Audited tree: `main` @ `f24c855`
Scope: whole repository, with a directed investigation into (a) the Meta
integration path an operator must walk to go live, and (b) why notifications do
not arrive when a customer message does.

Evidence below is `file:line` against the audited tree. Where a claim rests on
the repository's own test suite, the test is named.

---

## 1. Executive finding

The codebase is in strong shape as an engineering artifact: `pnpm lint`,
`pnpm typecheck` and `pnpm build` are all clean, 2583 unit tests pass, the
domain rules are separated from the adapters, and the hard parts (signature
verification before parsing, outcome classification on send, RLS per tenant,
forward-only migrations) are deliberately designed rather than improvised.

It is **not** able to go live on Meta today, and the notification behaviour an
operator would expect is **partly absent rather than broken**. Three findings
block or materially damage a production launch:

| # | Finding | Severity | Effect | Status |
| --- | --- | --- | --- | --- |
| F-1 | No runtime path exists to register a Meta app (`channel_apps`) | **Blocker** | Connecting WhatsApp / Messenger / Instagram is refused with HTTP 422. No Meta channel can be connected at all. | **Fixed** 2026-10-14 |
| F-2 | A customer's **first** message notifies nobody | **High** | The opening message of every new conversation produces no notification for any user. Only messages into an already-assigned conversation notify, and only its assignee. | **Fixed** 2026-10-14 |
| F-3 | Web Push variables are absent from `.env.example` | **High** | An operator who configures from `.env.example` gets no device notifications at all, and the UI reports only "unavailable". | **Fixed** 2026-10-14 |

F-2 and F-3 compound: together they are a complete explanation for "a message
arrives and no notification arrives with it".

### Fixes applied

The three above were fixed in the same working session as this audit. Sections
2–4 describe each as it was found; the fix is recorded at the end of each.
**None of the three has been exercised against a real database or a real Meta
app** — the integration suite cannot run in the audit environment (§6), so each
carries unit coverage and an unrun integration test. Treat §6's full-suite run
as the gate before relying on them.

F-4 through F-8 remain open.

---

## 2. Finding F-1 — Meta cannot be connected (blocker)

### What happens

Connecting any Meta channel resolves the named Meta app against an
installation-level `channel_apps` row, and refuses the connection if there is
no match:

- `apps/api/src/channels/channel.service.ts:642` — the lookup.
- `apps/api/src/channels/channel.service.ts:651` — `422 channel_app_not_configured`,
  *"That Meta App ID is not configured on this server yet."*

The webhook route depends on the same row. `GET|POST /webhooks/meta/:appConnectionId`
loads it by id and requires `status = 'active'`:

- `apps/api/src/channels/ingress.service.ts:273`
- `apps/api/src/channels/ingress.controller.ts:34,47`

So without that row there is no connectable channel **and** no webhook URL that
resolves.

### Why it cannot be created

The row is installation configuration by design, and the runtime role holds
`SELECT` only:

- `packages/database/migrations/0010_channels.sql:65` — `GRANT SELECT ON channel_apps TO convo_app;`
- `packages/database/migrations/0010_channels.sql:63` — *"the runtime reads it and never creates one."*

That design decision is sound. The gap is that **nothing else creates it
either**:

- The database CLI exposes exactly two commands — `bootstrap` and `migrate`
  (`packages/database/src/cli.ts:35`). There is no `register-channel-app`.
- No migration seeds a row (`packages/database/migrations/` 0001–0043).
- No API endpoint, no admin screen.
- The only `INSERT INTO channel_apps` statements in the tree are in tests and
  the load seed (`tests/integration/api-channels.test.ts:123`,
  `tests/integration/api-realtime.test.ts:151`, `tests/load/seed.ts:220,508`).

The runbook instructs the operator to use a procedure that does not exist:

> `docs/runbooks/META_WHATSAPP.md:95` — *"Register the Meta application as an
> installation-level `channel_apps` row using the approved
> database/migration-admin procedure."*

There is no such documented procedure anywhere in `docs/`.

### The fields the row needs

For a reviewer or a DBA, these are the columns and their constraints
(`packages/database/migrations/0010_channels.sql:37-61`):

| Column | Value | Constraint |
| --- | --- | --- |
| `provider` | `meta` | one of `meta`, `web_chat`, `custom` |
| `external_app_id` | the public numeric Meta App ID | unique per provider |
| `secret_ref` | e.g. `META_APP` — names `CONVO_CHANNEL_SECRET_META_APP` | `^[A-Z][A-Z0-9_]{2,63}$` |
| `secret_fingerprint` | SHA-256 hex of the app secret | `^[0-9a-f]{64}$` |
| `verify_token_hash` | **SHA-256 hex of the webhook verify token** | `^[0-9a-f]{64}$` |
| `graph_version` | `v21.0` — must match `PINNED_GRAPH_VERSION` | `^v[0-9]+\.[0-9]+$` |
| `status` | `active` | `active` \| `retired` |

The verify-token hash scheme is fixed by
`packages/domain/src/channels/meta-signature.ts:105`: the handshake compares
`sha256Hex(query['hub.verify_token'])` against the stored hash. It is a plain
SHA-256 of the UTF-8 token in lowercase hex — no salt, no HMAC.

`secret_fingerprint` is **never read by production code**. Only the `CHECK`
constraint applies. The column's stated purpose — making a rotated app secret a
visible mismatch rather than a silently failing webhook
(`packages/database/migrations/0010_channels.sql:49-51`) — is therefore not
implemented. See F-4.

### Recommended fix

Add a third command to the database CLI, which already runs with the migration
role that owns the schema. That keeps the privilege boundary the architecture
chose, makes the operation repeatable and auditable, and lets it compute both
hashes so an operator never hand-rolls a digest:

```
convo-db register-channel-app --provider meta \
  --external-app-id <numeric Meta App ID> \
  --secret-ref META_APP \
  --graph-version v21.0
```

reading the app secret and verify token from the environment, and printing the
resulting row id — which *is* the `<appConnectionId>` the Meta webhook URL
needs. Until that exists, the only route is a hand-written `INSERT` executed as
the migration role, which is not a procedure that should be part of a
documented go-live.

### Fix applied

`convo-db register-channel-app` (`packages/database/src/channel-app.ts`, wired
in `packages/database/src/cli.ts`, exposed as `pnpm db:register-channel-app`).
It runs as the migration role, computes both digests, and prints the row id as
the webhook path. Both secrets are read from the environment rather than from
arguments, which `ps` exposes; the app secret is read from the *same*
`CONVO_CHANNEL_SECRET_<REF>` the API reads at runtime, so a row that names an
unconfigured key is refused at registration instead of failing on the first
delivery. Re-running rotates in place and keeps the id, so the webhook URL
already set in Meta keeps working. `docs/runbooks/META_WHATSAPP.md` step 4 and
the README now document it in place of the procedure that did not exist.

Unit coverage in `packages/database/src/cli.test.ts`; database behaviour in
`tests/integration/register-channel-app.test.ts`, which asserts the stored
verify-token hash is one `answerMetaChallenge` accepts, that rotation keeps the
id, and that the runtime role still cannot write the table. **That integration
test has not been run** (§6).

---

## 3. Finding F-2 — the first message of a conversation notifies nobody

### What happens

`new_message` notifications are created in exactly one place, inside a guard:

`apps/api/src/conversations/conversation.service.ts:225-233`

```ts
if (conversation.assigneeMembershipId !== null) {
  await this.notifications.create(sql, tenantId, {
    recipientMembershipId: conversation.assigneeMembershipId,
    kind: 'new_message',
    ...
```

Consequences:

1. A customer writes in for the first time → the conversation is unassigned →
   `assigneeMembershipId` is `null` → **no notification for anyone.**
2. A customer writes into any still-unassigned conversation → **no
   notification for anyone.**
3. There is no team-level or unassigned-queue notification anywhere in the
   tree. `new_message` is the only inbound kind, and the assignee is its only
   recipient.

For a shared support inbox this inverts the expectation: the queue that most
needs an alert — work nobody has claimed yet — is the only queue that is
silent.

### The repository's own test encodes it

`tests/integration/api-realtime.test.ts:2303-2322` walks exactly this
sequence:

1. `customerWrites(..., 'opening message', ...)` — conversation unassigned.
2. The owner assigns it to `agentA` → `assignment` notification.
3. `customerWrites(..., 'private customer words', ...)` — now assigned →
   `new_message` notification.

and then asserts:

```ts
expect(matching.map((entry) => entry.kind).sort()).toEqual(['assignment', 'new_message']);
```

Two notifications, not three. The opening message produced none. The behaviour
is therefore current, intended by the test, and not a regression — but it is
not what an operator expects, and it is the first half of the reported symptom.

### What is *not* broken

The live inbox does update. `message.inbound` is emitted on the realtime feed
(`apps/api/src/conversations/conversation.service.ts:199`) and the browser
reacts to it (`apps/web/src/live/inbox-actions.ts:658`). So the conversation
appears in the list immediately; only the bell and the device notification stay
quiet. This is consistent with the report that the message arrives but the
notification does not.

### Recommended fix

Decide the recipient policy, then implement it in `noteInbound`:

- Unassigned conversation → notify the members who can act on it. The natural
  boundary already exists: the conversation's `teamId`, falling back to members
  holding the relevant conversation permission when there is no team.
- Assigned conversation → keep today's behaviour (assignee only).
- Keep the existing `dedupeKey` (`inbound:<inboundEventId>`) so a redelivered
  provider event still cannot double-notify; the unique constraint is
  per recipient (`packages/database/migrations/0039_notifications.sql:17`), so
  fan-out is safe.

### Fix applied

`NotificationService.notifyClaimants` (`apps/api/src/notifications/notification.service.ts`),
called from `noteInbound` when there is no assignee. An assigned conversation
still notifies its assignee alone.

The recipient set is `authorize(principal, 'conversation.claim',
resourceOf(conversation))` expressed as one SQL statement rather than invented:
active membership, active company, a `conversation.claim` grant, and — for a
`scoped` grant — a tenant-wide scope, this conversation's inbox, or its team.
`own` is excluded because it cannot reach a conversation with no assignee.

One policy decision was necessary and is documented at the method: an Owner and
an Admin hold the grant at `tenant`, so a literal reading would page them for
every message in every queue. They are therefore a **fallback**, told only when
the queue has no scoped claimant at all. That keeps the guarantee that a
message can never arrive with nobody informed, without making an Owner's
notifications useless in a staffed installation. How much wider the fan-out
should go remains the client question
`docs/CLIENT_CONFIGURATION_GAPS.md` already tracks.

Two supporting changes:

- `RealtimeService.emitNotifications` batches the SSE invalidation. This runs
  in the inbound hot path, and calling the per-recipient method in a loop would
  have cost two round trips per recipient; the counter is advanced once for the
  whole batch.
- The push queue is filled for every recipient's devices in one statement.

`tests/integration/api-realtime.test.ts` — the test quoted above, which
asserted the narrower behaviour — now expects three records rather than two,
and two new cases assert the fan-out and the fallback. **Neither has been
run** (§6).

---

## 4. Finding F-3 — Web Push is unconfigurable from `.env.example`

`.env.example` contains **no** Web Push variables. Confirmed by diffing the
variables the code reads against the file:

- Read by `apps/api/src/config.ts:294-306`: `CONVO_WEB_PUSH_PUBLIC_KEY`,
  `CONVO_WEB_PUSH_PRIVATE_KEY`, `CONVO_WEB_PUSH_SUBJECT`.
- Present in `.env.example`: none of the three.

The failure is quiet at every layer, and each layer is individually
well-behaved:

| Layer | Behaviour with no keys | Evidence |
| --- | --- | --- |
| `GET …/notifications/push-config` | returns `publicKey: null` | `apps/api/src/notifications/notification.controller.ts:41`, `device.service.ts:51` |
| Browser | sets `pushStatus = 'unavailable'` and offers nothing | `apps/web/src/live/notification-actions.ts:42-44` |
| Device registration | `503 push_unconfigured` | `apps/api/src/notifications/device.service.ts:58-60` |
| `worker-integration` push drain | returns `0`, logs nothing | `apps/api/src/notifications/push-outbox.service.ts:62-64` |

So an operator who configured the installation from `.env.example` — which is
what the README instructs (`cp .env.example .env`) — has no device
notifications, no error, and no indication of which variable is missing. The
README does document the three variables in prose, but the file an operator
actually copies does not carry them.

`CONVO_CREDENTIAL_KEYS` is present only as a commented line
(`.env.example:96`), and device registration also fails without it, because the
subscription is sealed with the same cipher as channel credentials
(`apps/api/src/notifications/device.service.ts:46-47`).

### Recommended fix

Add all three Web Push variables to `.env.example`, with the generation
command already in the README (`npx web-push generate-vapid-keys`) and a note
that the public key goes to the API while all three go to
`worker-integration`. Uncomment or clearly mark `CONVO_CREDENTIAL_KEYS` as
required before either channels or device notifications work.

Independently, consider logging once at worker start when
`worker-integration` finds push unconfigured. The code is correct to stay
silent per drain; it is the absence of any startup signal that makes this
invisible.

### Fix applied

`.env.example` now carries all three Web Push variables with the generation
command, which role needs which, and what is lost when they are absent. The
`CONVO_CREDENTIAL_KEYS` entry says that device registration needs it too, not
only channels. The README's push section now states the failure mode
explicitly — that in-app notifications and the badge keep working and only the
lock-screen alert is missing — so the symptom is recognisable without reading
the code.

Configuration only; no behaviour changed. The startup-log suggestion above was
*not* implemented.

---

## 5. Secondary findings

### F-4 — `secret_fingerprint` is never verified

`channel_apps.secret_fingerprint` is written only by tests and read by nothing
(§2). Its documented purpose is to turn a rotated-but-not-updated app secret
into a visible mismatch instead of a webhook that silently stops verifying.
Today a rotated secret produces exactly the silent failure the column exists to
prevent: `verifyMetaSignature` simply fails and every delivery is refused with
`signature_invalid`. Low severity, but it should either be enforced at ingress
or the column's comment should stop claiming a protection that is not there.

### F-5 — `campaign` and `automation_failure` notifications are never produced

Both kinds are declared in the type union
(`apps/api/src/notifications/notification.service.ts:9`), permitted by the DB
`CHECK` (`packages/database/migrations/0039_notifications.sql:8`), and routed
by the browser — `targetOf` sends them to the Broadcasts and Automations
screens (`apps/web/src/live/notification-actions.ts:186-190`). Nothing anywhere
creates one. A broadcast that finishes and an automation that fails notify
nobody; the operator must open the run log to discover it. Given that
`create_internal_notification` is also an unimplemented automation step (F-6),
the whole "the system tells you something went wrong" surface is absent.

### F-6 — automation executor implements 6 of 10 declared step types

`AUTOMATION_STEP_TYPES` declares ten
(`packages/domain/src/automations/workflow.ts:14-17`). The executor implements
`condition` (pass-through only), `delay`, `send_whatsapp_template`,
`add_label`, `remove_label`, `update_customer_field`
(`apps/api/src/automations/automation-runner.service.ts:150-178`).

Not implemented: `assign_team`, `assign_agent`,
`create_internal_notification`, `webhook`.

This is handled honestly rather than hidden, and that deserves noting: the
builder only offers the implemented steps
(`apps/web/src/ui/automations-screen.ts:29-35`), an unsupported step renders a
warning that activation will refuse it
(`apps/web/src/ui/automations-screen.ts:286-288`), and activation does refuse
it with `409 automation_action_not_supported`
(`apps/api/src/automations/automation.service.ts:68,81`). It is a scope limit,
not a defect — but it is a scope limit worth stating in writing before a client
signs off on "automations".

### F-7 — pinned Graph version expires 2027-01-21

`PINNED_GRAPH_VERSION = 'v21.0'`
(`packages/domain/src/channels/capabilities.ts:51`). The repository is candid
that the pin was never confirmed against a live Meta page — Meta's version
pages returned HTTP 429 when the research was done
(`docs/research/provider-evidence.md:43`).

Checked against Meta's published schedule on 2026-10-14: **v21.0 is still
supported, and is removed on 2027-01-21.** So this is not a launch blocker — it
is a dated one, roughly three months out. Two actions follow:

1. Schedule the bump now rather than discovering it in January. Per ADR-0009
   the bump is a config change plus a fixture re-record plus a capability-matrix
   diff, so it is a planned piece of work, not a one-line edit.
2. Note separately that Meta's v26.0 protocol deprecations are documented as
   reaching *all* remaining supported versions from 2026-10-27. Whether that
   touches the messaging endpoints this product uses was not determined in this
   audit and should be read off Meta's changelog directly before launch.

### F-8 — operators cannot send attachments

Inbound attachments are modelled and readable, but there is no operator upload
or outbound file send. Already recorded by the project
(`docs/final/REMAINING_BEFORE_HANDOVER.md`, section A) and consistent with what
the tree shows. Restated here only because for WhatsApp support work this is
usually discovered on day one of real use.

---

## 6. Test results

### Ran, in this environment

| Gate | Result |
| --- | --- |
| `pnpm lint` | **pass**, no findings |
| `pnpm typecheck` | **pass** (4 projects: build, tests, web tests, e2e) |
| `pnpm build` | **pass** — API `tsc -b`, web bundle 546.82 kB / 161.40 kB gzip |
| `pnpm test:unit` | **2583 passed**, 11 failed, 171 files |
| `pnpm test:property` | **5 passed** |

The 11 failures are all in `apps/api/src/workers/probe-server.test.ts` and are
**environmental, not defects**. Every one of them binds a local port, and the
audit sandbox refuses that:

```
Error: listen EPERM: operation not permitted 127.0.0.1
```

Verified directly with a one-line `net.createServer().listen()` probe, which
reproduces the same `EPERM`. These tests need re-running outside the sandbox
before the result is meaningful.

### Could not run, and why

| Suite | Blocker |
| --- | --- |
| `pnpm test:integration` | needs a real PostgreSQL. `tests/support/cluster.ts` starts `embedded-postgres` on a TCP port; the sandbox refuses the bind, so the suite collects **no tests** and the global setup throws `EPERM`. No external-database override exists in the harness. |
| `pnpm test:e2e`, `test:a11y`, `test:visual` | Playwright must serve the app on a port. Same restriction. |
| `pnpm test:recovery`, `test:load` | same global setup as integration. |
| `pnpm test:security` | its vitest half is integration; only `pnpm audit` would run. |
| `pnpm test:mutation` | Stryker drives the vitest projects above. |

This is a material gap in this audit, and it should not be read past. The
integration suite is where tenant isolation, authorization, the API contract,
realtime behaviour and the notification records are actually asserted —
including the test quoted in §3 — and the coverage gate is **100% on lines,
functions, branches and statements** (`vitest.config.ts`), which is only
reachable with the integration project running.

To close it, run on a machine where port binding is permitted:

```bash
pnpm test:integration && pnpm test:security && pnpm test:e2e && pnpm test:visual && pnpm test:coverage
```

Static analysis alone stands behind §§2–5; those findings are traceable to the
`file:line` references and, for F-2, to the project's own integration test.

---

## 7. Recommended order of work before go-live

1. ~~**F-1**~~, ~~**F-3**~~, ~~**F-2**~~ — done; see the fix note at the end of
   each section. All three are unverified against a real database.
2. **Run the full suite on a machine without the port restriction** (§6), and
   treat that — not this document — as the test sign-off. This is now the top
   item precisely *because* the three fixes landed: they touch the inbound hot
   path, the realtime sequence and a privileged database write, and their
   integration tests have never executed.
3. Then register a real Meta app with `pnpm db:register-channel-app`, connect
   one controlled asset, and run one inbound and one reply per channel. That is
   the first end-to-end proof any of the Meta path works.
4. **F-5** — wire `campaign` and `automation_failure` notifications, or remove
   them from the type, the `CHECK` and the browser routing so the surface stops
   implying a feature that is absent.
5. **F-7** — schedule the Graph version bump, and read Meta's v26.0 changelog
   against the endpoints in `meta-whatsapp.transport.ts` before launch.
6. **F-4** — enforce `secret_fingerprint` at ingress or correct its comment.
   Note that `register-channel-app` now writes a fingerprint computed the way
   an ingress check would need it, so the enforcement is a smaller change than
   it was.
7. Confirm with the client which of **F-6** and **F-8** are accepted for this
   delivery, in writing, before sign-off.

---

## 8. What this audit did not cover

Stated so the gaps are not mistaken for clearances:

- No live provider traffic. No Meta app, number, Page or Instagram account was
  exercised; §2 is why that was not possible in the first place.
- No deployed-environment inspection. Railway services, variables and the
  state of the current staging/production deploys were not read.
- No email delivery test. The configuration logic is unit-tested and
  fail-closed in production (`apps/api/src/email/email-config.test.ts`), but no
  mail was sent.
- No load, recovery or mutation run (§6).
- No security penetration testing. The repository carries its own
  `docs/audit/SECURITY_AUDIT.md`, which was not re-verified here.
