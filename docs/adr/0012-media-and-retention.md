# ADR-0012 — Media quarantine, signed access, and retention classes

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P2 media handling
- **Requirement IDs:** MEDIA-01..MEDIA-05, DEL-04

## Context

Inbound media is attacker-influenced content fetched from a URL, in a request path that must stay fast. Outbound media may be a private note attachment that must never reach a customer. Retention has to satisfy replay needs, privacy law and storage cost simultaneously.

## Decision

**Fetching is a separate worker, never in the ACK path.** Downloads go only to allowlisted provider endpoints, with safe DNS resolution, redirect restrictions, size and time limits, and no access to private address ranges.

**Trust nothing the payload says.** MIME is determined by content sniffing, not by extension or the declared `Content-Type`. Files land in a quarantine bucket, are scanned, and only then become available. A scan failure leaves the attachment unavailable with a visible reason.

**Access is short-lived, tenant-scoped and authorized per request** against the parent object's permissions — not by knowing the object key. Storage prefixes are tenant-scoped.

**Private stays private.** A private note attachment is a different record class from a public message attachment. Making one public requires an explicit authorized re-share operation that creates a *new* public attachment record; a public message can never reference a note attachment by ID.

**Retention classes** (defaults; tenant-configurable within policy limits):

| Class | Default retention | Notes |
|---|---|---|
| Raw provider event journal | 30 days | Enough for replay and incident forensics |
| Normalized events | 12 months | Feeds reporting and reconciliation |
| Message content + attachments | tenant-configured, default 24 months | Deletion is real deletion, including derived copies |
| Media in quarantine (failed scan) | 7 days | Then purged |
| Audit events | 24 months minimum | Longer than the data they describe |
| Idempotency records | operation lifetime + 30 days | Never expires while a campaign is active |
| AI traces | 90 days, redacted | Separate toggle |

Deletion propagates to derived copies: thumbnails, search indexes, caches and (P7) retrieval indexes, within a documented bound.

## Consequences

- Media availability is eventual, and the UI must show a scanning state.
- Storage sizing follows the master's estimate method (≈2 KB metadata per message; ≈25 GB/day media at 1 M messages/day with 5% attachments at 0.5 MB) — an estimate to be **measured**, never a machine specification.

## Alternatives rejected

- **Fetch media synchronously during ingestion.** Rejected on latency and blast radius.
- **Serve media from a long-lived public URL.** Rejected: unauthenticated cross-tenant exposure.
- **One global retention setting.** Rejected: audit and idempotency have different needs from content.

## How this is verified

- SSRF corpus, redirect chains, DNS rebinding, private-range targets.
- MIME/extension spoofing tests.
- Cross-tenant and expired signed-URL denial.
- UI-02: private note attachment never sent to a customer or unauthorized participant.
- Retention job evidence at P8, including proof that derived copies disappear.
