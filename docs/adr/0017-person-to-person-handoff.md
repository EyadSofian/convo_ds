# ADR-0017 — Person-to-person handoff is an offer, not a transfer

- **Status:** accepted
- **Date:** 2026-09-10
- **Phase gate:** P2 work routing (assignment, handoff, priority, collaborators)
- **Requirement IDs:** CON-07, CON-08, IAM-13, OWN-01; clarifies `business-rules.md` §7

## Context

Three different acts move a conversation between people, and every product that
collapses them into one ends up lying about at least one of them:

1. **Self-claim.** An agent takes work nobody holds. Already built: fenced on the
   version shown on the queue card, exactly one winner.
2. **Direct assignment.** Somebody with routing authority puts a conversation on
   a named person's desk, whether or not that person agreed. This is
   `conversation.assign` in `business-rules.md` §7, row *"Assign others /
   override routing"* — `Tenant` for Owner and Admin, `Scoped` for Supervisor,
   and **`No` for Agent**.
3. **A handoff between two people.** An agent who is holding a conversation asks
   a named colleague to take it. The colleague may say no.

The matrix has no row for (3), and the master prompt requires it (§17: *"…
participants and agent handoff"*). Read literally, the only way to build it with
today's catalogue is to give agents `conversation.assign` — which would also let
every agent reassign anybody else's work, and would contradict the matrix.

There is a second collision. `ADR-0008` already defines a conversation ownership
state named **`handoff_pending`**. That state is about a **bot** whose send is in
flight while a human is taking over; it exists so we never claim an atomic recall
across Meta. It is not a person asking a colleague for help, and the two facts
have different actors, different evidence and different failure modes.

## Decision

**A person-to-person handoff is a time-bounded offer with an explicit decision,
recorded in its own table.** It is never an assignment that happens immediately
and is dressed up as a request by the UI.

- States: `pending`, `accepted`, `declined`, `cancelled`, `expired`. Every
  transition is written to append-only evidence in the same transaction as its
  effect.
- **While an offer is pending, the current assignee is still the assignee.** A
  conversation with an unanswered offer is not in limbo: somebody is responsible
  for it, and that somebody is whoever was responsible before.
- Acceptance settles the offer **and** applies the reassignment in one
  transaction.
- **A newer ownership decision supersedes the offer.** An offer records who held
  the conversation when it was made; if somebody else holds it at acceptance,
  accepting is refused with `handoff_superseded`. A version fence alone cannot
  express this — the version also moves for a priority change that has nothing
  to do with who owns the work — and without it, accepting an offer made when
  Hana held the conversation would take it from Layla, who never agreed to
  anything, on the word of somebody who no longer had it to give. Declining a
  superseded offer stays possible: saying no to a request that has been
  overtaken is still an answer, and leaving it pending forever helps nobody.
- Decline, cancel and expiry change no assignment at all.
- At most one `pending` offer per conversation, enforced by a partial unique
  index rather than by a read-then-write. A queue of competing offers would make
  "who is being asked" unanswerable, which is the one thing the feature exists to
  answer.
- Expiry is derived from a **stored instant** and settled by a durable sweep. A
  browser timer may grey out a button; it may never be what makes an offer
  expire.

**A new permission key, `conversation.handoff.request`.** Requesting a handoff
from a conversation you are working is a different act from reassigning other
people's work, so it gets a different key rather than borrowing one:

| Role | `conversation.assign` | `conversation.handoff.request` |
|---|---|---|
| Owner | tenant | tenant |
| Admin | tenant | tenant |
| Supervisor | scoped | scoped |
| Agent | **none** | **own** |
| Campaign Manager, Analyst, Integration Developer | none | none |

`own` is what makes the clarification safe: an Agent may offer **their own**
conversation to a colleague, and can still not touch anybody else's. It is
delegable to a custom role but is not in the non-delegable set — it moves no
money, grants no permission and reaches no credential.

**Accepting is authorized by being the named recipient**, not by holding
`conversation.assign`. The recipient must additionally still be *eligible* — the
same predicate a direct assignment applies to its target — because an offer made
last week to somebody who has since lost the inbox must not let them back in.
**Cancelling** is for the person who made the offer, or for anybody who could
have made the assignment directly (`conversation.assign`), because tidying up a
stale offer is a routing act.

**Priority and collaborators are routing.** `business-rules.md` §7's row is
*"Assign others / **override routing**"*, and changing a conversation's priority
or adding somebody to it is overriding routing. Both are therefore governed by
`conversation.assign`, with the same scope rules. An Agent cannot re-prioritise
their own conversation; if that turns out to be wrong for real operators it is a
matrix change with its own ADR, not something to decide by leaving the check out.

**`handoff_pending` stays ADR-0008's.** The person-to-person offer never writes
`conversations.owner_state`. The two are separate columns in separate tables with
separate vocabularies, and this ADR does not change ADR-0008's rule that we never
claim an atomic undo across Meta.

### Ownership addendum to ADR-0008

Two clarifications this slice needs in order to implement the ownership model
truthfully, neither of which weakens the original rule:

- **A human owner change bumps `owner_version`.** Claim, direct assignment and
  handoff acceptance all set `owner_state = 'human_active'` and increment
  `owner_version`, writing a transition row. ADR-0008 already says the bot
  resumes *"only by an authorized explicit resume or reassignment"*; making
  reassignment a real ownership transition is what gives that sentence a
  mechanism.
- **A human send is refused while `handoff_pending`.** The barrier exists
  because a bot request may already be with the provider; a human reply sent
  into that window is precisely the double-reply nobody can recall. The refusal
  is typed and visible, and it is *not* a claim that the bot's message was
  cancelled.

No bot exists in this build, so `bot_active`, `bot_paused` and `handoff_pending`
are unreachable through any route today. The ownership **predicate** is
implemented as a total function and proved exhaustively by unit tests; the
**enforcement point** is live in the outbound permit path and reads the stored
state. OWN-02 and OWN-03 stay `planned`: they describe behaviour of an AI
generation path that does not exist, and no test here proves them.

## Consequences

- One more permission key, one more migration, and four more mechanical drift
  tests. Cheap.
- An agent cannot force work onto a colleague. The colleague can decline, and
  declining is a recorded fact rather than a silence.
- A handoff has a settlement latency an immediate reassignment does not. That is
  the feature, not a cost.
- Two ways to move a conversation to a named person now exist. They are
  deliberately not merged: one is authority, the other is a request, and an
  audit that could not tell them apart would be useless in exactly the argument
  it exists to settle.

## Alternatives rejected

- **Give Agent `conversation.assign`.** Rejected: it contradicts §7 and lets any
  agent reassign any conversation in their inbox scope, which is the authority
  Supervisor exists to hold.
- **Model the offer as an immediate reassignment the recipient may undo.**
  Rejected: between the assignment and the undo the conversation really is the
  recipient's, so a decline would have to *take work back*, and the audit trail
  would record a transfer that everybody involved would describe as never having
  happened.
- **Reuse `handoff_pending` for both facts.** Rejected: one state cannot mean
  "a bot's send may be in flight" and "Layla has been asked and has not
  answered". The send barrier would fire for the wrong reason, or not fire at
  all.
- **Let a pending offer freeze the conversation.** Rejected: it makes an
  unanswered request into an outage for the customer.
- **A queue of offers per conversation.** Rejected for this slice: "who is being
  asked" stops having one answer, and nothing in the product requires it yet.

## How this is verified

- An Agent is refused a direct assignment and permitted a handoff request on
  their own conversation, both by key and both at the HTTP boundary.
- A pending offer leaves `assignee_membership_id` unchanged; the integration test
  asserts the column, not the response body.
- Only the named recipient accepts or declines; only the creator or an
  `conversation.assign` holder cancels.
- Accept applies exactly once under a repeated request; decline, cancel and
  expiry never assign.
- An offer whose conversation was reassigned (`handoff_superseded`), whose
  recipient lost the inbox (`assignee_not_eligible`), or whose window ran out
  (`handoff_expired`) cannot later assign.
- Two direct assignments at one version produce one winner and one
  `conversation_version_conflict`; the same for claim versus assignment.
- The ownership predicate is exhaustive over the four states × two actors, and
  the outbound permit refuses a human send under `handoff_pending`.
