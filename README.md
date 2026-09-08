# CONVO

منصة لإدارة المحادثات والقنوات والحملات للشركات، من مصدر واحد وبنمطَي تشغيل:

- **SaaS متعدد الشركات** (`CONVO_DEPLOYMENT_MODE=saas`)
- **Self-hosted لشركة واحدة** (`CONVO_DEPLOYMENT_MODE=self_hosted_single`)

نفس الـschema وعقود الـAPI والصلاحيات في النمطين. قيد الشركة الواحدة يُفرض داخل PostgreSQL، وليس بافتراض في الواجهة أو الخدمة.

## الحالة الحالية

اكتملت **P1-T4**: أساس workspace وقاعدة البيانات وRLS، وضع التنصيب وbootstrap لمرة واحدة، وتطبيق NestJS/Fastify على `/api/v1` مع OpenAPI ثابت وidempotency ذرّي، بالإضافة إلى تسجيل الدخول والجلسات الدائمة وCSRF ومنع الإساءة وعزل عضويات الشركات وأول حدّ صلاحيات بالمفتاح. لا توجد بعد إدارة المستخدمين والأدوار الكاملة أو قنوات Meta أو inbox أو broadcasts أو واجهة أمامية أو نشر. الدليل التفصيلي والمهمة التالية في [`docs/execution/current-task.md`](docs/execution/current-task.md).

## التشغيل المحلي

المتطلبات: Node 22، pnpm 9.12، وعنقود PostgreSQL يمكن الوصول إليه. انسخ `.env.example` إلى `.env`، ضع كلمات مرور فعلية، وأنشئ السرّين المستقلين بأداة آمنة مثل `openssl rand -hex 32`.

```bash
pnpm install --frozen-lockfile
pnpm build
set -a; source .env; set +a
pnpm db:bootstrap
pnpm db:migrate
pnpm start:api
```

بعد الإقلاع:

- `GET /api/v1/instance` عام ويرجع وصف التنصيب المنقّى.
- `POST /api/v1/instance/bootstrap` يتطلب `X-Bootstrap-Token` و`Idempotency-Key` وينشئ أول شركة وOwner مرة واحدة.
- مسارات `/api/v1/auth/*` تنفذ login/logout والجلسة الحالية وقائمة الجلسات وإلغاءها، مع cookies محصنة وCSRF.
- `GET /api/v1/me/memberships` و`GET /api/v1/tenants/{tenantId}/permissions` يطبقان العضوية النشطة وفحص `role.manage` داخل RLS.
- العقد المنفّذ موجود في [`docs/api/openapi.v1.json`](docs/api/openapi.v1.json).

## بوابات التحقق

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:coverage
```

اختبارات integration وcoverage تشغّل PostgreSQL 17.4 مؤقتًا داخل العملية ولا تحتاج Docker. آخر نتيجة مسجلة: 299 اختبارًا وتغطية 100% للسطور والعبارات والدوال والفروع.

## المراجع الملزمة

| الملف | الدور |
|---|---|
| `research/convo-2026-09-07/implementation-v2/MASTER-PROMPT.md` | المواصفة الملزمة |
| `research/convo-2026-09-07/implementation-v2/PHASE-PROMPTS.md` | ترتيب التنفيذ P0–P9 |
| `docs/requirements/traceability.md` | سجل المتطلبات وحالات التنفيذ والاختبار والتحقق الحي والنشر |
| `docs/execution/current-task.md` | آخر مهمة، الأدلة، العوائق، والمهمة التالية |
| `docs/architecture.md` و`docs/adr/` | المعمارية والقرارات |
| `docs/testing/strategy.md` | بوابات الاختبار وقواعد الأدلة |

نجاح build لا يعني أن المنتج اكتمل، واختبار simulator لا يُسجّل كتحقق حي من مزوّد.
