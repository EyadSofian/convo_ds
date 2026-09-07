# CONVO — Capacity profiles and SLOs (hypotheses, not achievements)

Every number here is a **synthetic design target**. None is a measured result, a Meta entitlement, or a promise. The inherited "≈1,000 users" figure was **not** reconfirmed by the user in this cycle; it is retained only as a provisional SaaS capacity hypothesis.

## 1. Profiles

| Profile | Concurrent human users | Assumed daily business messages | Ingestion test | Campaign workload |
|---|---:|---:|---|---|
| **Pilot** (self-hosted single host) | 100 | 100,000 | 100 normalized events/s | 100,000 recipients |
| **Target** (SaaS HA) | 1,000 | 1,000,000 | 1,000 events/s for 60 min; 3,000/s burst for 10 min | 1,000,000 recipients/campaign; 20 campaigns across tenants |
| **Growth** | 1,000–3,000 | 10,000,000 | 3,000/s sustained; 10,000/s burst | Several million recipients — **only after Target is measured** |

**Units matter.** A business message and a webhook/status event are different things. One HTTP request may carry many normalized events; the load harness must declare which it is counting.

Workload mix must include: duplicate and reordered receipts, a realistic media payload mix, campaign reply surges, large imports and exports, hot tenants, and skewed inbox sizes.

For 1,000 agents: ≈1 action per 5 seconds → **200 API requests/s average** hypothesis, mixed reads/writes, realistic think time. Sockets: test **2,000** (multiple tabs) plus simultaneous reconnect storms.

## 2. Provisional SLO gates at Target

| SLO | Target |
|---|---|
| API availability | 99.9% monthly, with eligible-operation and error definitions published; dependency failures visible separately |
| Normal API reads | p95 ≤300 ms |
| Durable command acceptance | p95 ≤500 ms (p99 and failure rate also published) |
| Webhook durable ACK | p95 ≤200 ms, p99 ≤1 s |
| Inbound visible to authorized client | p95 ≤2 s **from arrival at our ingress** — not from a timestamp outside our control |
| Interactive outbound dispatch | p95 ≤1 s when provider capacity is available; rate-limited work is visibly queued and measured separately, never counted as a completed send |
| HTTP unexpected error rate | <0.1% |
| Integrity | **zero** observed accepted-work loss or cross-tenant disclosure in fault/integrity scenarios |
| AI draft (P7) | p95 ≤8 s on the golden workload; hard request budget 15 s with explicit fallback |
| Handoff decision (P7) | local decision p95 ≤1 s, excluding drainage of an already in-flight request |

HA and disaster targets apply to **SaaS/HA profiles only**. The single-host self-hosted profile has no automatic host failover and publishes separately measured downtime and restore results. Initial disaster **RPO ≤5 min, RTO ≤60 min**, verified by an actual restore drill. **RPO = 0 is not claimed** with asynchronous replication.

## 3. Reproducible arithmetic

These are the calculations behind the profiles. They are deliberately simple so anyone can check them.

- 1,000,000 messages/day ÷ 86,400 s = **11.57 messages/s average**.
- 10,000,000 messages/day ÷ 86,400 s = **115.74 messages/s average**.

Averages say nothing about a concentrated campaign:

- 1,000,000 messages at a hypothetical permitted 80/s → ≥ **3 h 28 m 20 s**.
- 1,000,000 messages at 1,000/s → ≥ **16 m 40 s**.

Both before competing traffic, per-recipient quotas and template pacing. **Adding CPU never changes provider permission.**

## 4. Storage sizing assumption

- ≈2 KB metadata per message → ≈**2 GB/day per 1 M messages**, before indexes, receipts, WAL and replicas.
- 5% attachments averaging 0.5 MB → ≈**25 GB/day** additional media.

Measure actual distributions before sizing anything. These figures are **not** machine specifications, and retention/backup/egress costs must be calculated from measured data.

## 5. Scaling rules

Scale on queue age, in-flight count and saturation — with the **DB pool and provider limits as hard upper bounds**. Never add workers without checking DB memory, IO, locks and connection utilization. Use pagination, indexes and measured partitioning before considering sharding. Single-region HA by default; multi-region writes need a confirmed requirement and an ADR.

## 6. Current verification status

**All of the above is `not_run`.** k6 is not installed on this workstation and no staging infrastructure has been provided (`blocked_env`, DEP-10). The load profiles are authored so they can be executed the moment suitable disposable infrastructure exists. No capacity claim may be made until then.
