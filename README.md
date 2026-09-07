# CONVO

منصة إدارة محادثات وقنوات وحملات للشركات. منتج واحد بنسختَي تشغيل:

- **SaaS متعدد الشركات** (`DEPLOYMENT_MODE=saas`)
- **Self-hosted لشركة واحدة** (`DEPLOYMENT_MODE=self_hosted_single`)

نفس المصدر، نفس الـschema، نفس عقود الـAPI، نفس الصلاحيات. لا يوجد فرع منطق أعمال لكل عميل، ولا تخفيف للتصاريح في النسخة أحادية الشركة.

## الحالة الحالية

**P0 (اكتشاف وتعاقدات) — قيد التنفيذ.** لا يوجد تطبيق قابل للتشغيل بعد. لا يوجد اتصال Meta فعلي، ولا نشر، ولا نتائج حمل. راجع `docs/execution/current-task.md` لآخر حالة موثقة بأدلة.

## المرجع الملزم

| الملف | الدور |
|---|---|
| `research/convo-2026-09-07/implementation-v2/MASTER-PROMPT.md` | المواصفة الملزمة (أقسام 0–22) |
| `research/convo-2026-09-07/implementation-v2/PHASE-PROMPTS.md` | بطاقات التنفيذ P0–P9 |
| `docs/requirements/traceability.md` | سجل المتطلبات وحالاتها الأربع المنفصلة |
| `docs/execution/current-task.md` | آخر مهمة، الأدلة، العوائق، المهمة التالية |
| `docs/architecture.md` + `docs/adr/` | المعمارية والقرارات المسجلة |

## خريطة المستندات

- `docs/product/business-rules.md` — قواعد الأعمال، دورات الحياة، مصفوفة الأدوار
- `docs/product/capacity-hypotheses.md` — ملفات السعة (Pilot/Target/Growth) كفرضيات
- `docs/database/erd.md` — نموذج البيانات والقيود
- `docs/api/operation-inventory.md` — جرد عمليات `/api/v1`
- `docs/design/design-reference.md` — قياسات ومقدّرات مرجع Figma وtokens
- `docs/testing/strategy.md` — منظومة الاختبار والبوابات
- `docs/security/threat-model.md` — نموذج التهديد
- `docs/research/provider-evidence.md` — أدلة مزوّدي Meta وحدود التحقق

## قواعد الأدلة

أربع حالات منفصلة لكل متطلب، ولا تُشتق واحدة من الأخرى:
`implementation_status` / `automated_verification_status` / `provider_live_status` / `deployment_status`.

أمر اختبار لم يُنفَّذ = `not_run`، مش `passed`. Mock للمزود ≠ `provider_live_verified`. Build ناجح ≠ منتج مُسلَّم.
