# Runbook: alert conditions

These are the minimum release alert rules. They are deliberately stated in
terms of existing request logs, worker `/metrics`, queue SQL and PostgreSQL
metrics so they can be installed in any monitoring product without changing
the application.

| Signal | Warning | Critical | Window / action |
| --- | --- | --- | --- |
| API availability | readiness failure | public health or readiness failure | 2 consecutive minutes; page critical |
| API 5xx rate | >1% | >2% | 5 minutes; group by route and request ID |
| API p95 | >750 ms | >1,500 ms | 5 minutes at pilot traffic |
| Worker heartbeat | last tick >45 s | last tick >60 s | restart the affected role after preserving logs |
| Interactive/inbound queue age | >15 s | >30 s | scale role or investigate provider/database |
| Bulk/automation/report queue age | >2 min | >5 min | scale role or stop new bulk work |
| Provider failures | 3 typed failures/min | 5/min or any auth/signature failure | 5 minutes; signature/auth is immediately critical |
| Email terminal failures | any | >5 in 15 min | inspect provider code and durable delivery row |
| Automation terminal failures | >2% | >5% | 15 minutes |
| PostgreSQL connections | >70% | >85% | 5 minutes; do not blindly raise `max_connections` |
| PostgreSQL CPU/memory | >70% | >85% | 10 minutes |

Every alert must include environment, service/worker role, first/last observed
time, queue age or error rate, and a link to `INCIDENT_RESPONSE.md`. Alerts must
not include message bodies, recipient identifiers, tokens, cookies or secrets.

`BLOCKED_EXTERNAL_CONFIG`: no Slack, PagerDuty, email or webhook destination was
provided. The conditions are complete and testable, but delivery cannot be
installed or demonstrated until the operator supplies a named on-call target.
