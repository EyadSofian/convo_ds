# CONVO

منصة لإدارة المحادثات والقنوات والحملات للشركات، من مصدر واحد وبنمطَي تشغيل:

- **SaaS متعدد الشركات** (`CONVO_DEPLOYMENT_MODE=saas`)
- **Self-hosted لشركة واحدة** (`CONVO_DEPLOYMENT_MODE=self_hosted_single`)

نفس الـschema وعقود الـAPI والصلاحيات في النمطين. قيد الشركة الواحدة يُفرض داخل PostgreSQL، وليس بافتراض في الواجهة أو الخدمة.

## الحالة الحالية

اكتملت **Milestone A** و**Milestone B**: أساس workspace وقاعدة البيانات وRLS، وضع التنصيب وbootstrap لمرة واحدة، تطبيق NestJS/Fastify على `/api/v1` مع OpenAPI ثابت وidempotency ذرّي، تسجيل الدخول والجلسات وCSRF ومنع الإساءة، استعادة كلمة المرور بلا كشف وجود الحساب، الدعوات بقبول أحادي الاستخدام، مصفوفة الأدوار السبعة ومحرك تقاطع النطاقات، سطح تعديلات الأفراد والأدوار والفرق ونقل الملكية، وشاشة **الأفراد والأدوار** في `apps/web` موصولة بالخادم فعليًا.

اكتملت كذلك **الشريحة الأولى من Milestone C**: أساس القنوات ومسار الوارد كاملًا — ربط أصل لدى المزوّد، استقبال webhook موقَّع، التحقق من التوقيع على البايتات الخام نفسها، تحديد الشركة من الأصل المتحقَّق منه لا من المتصل، تدوين الحدث الخام قبل الرد، ثم اشتقاق حدث وارد مُطبَّع. اعتمادات القنوات مخزَّنة بتشفير AES-256-GCM مربوط بالشركة والاتصال والغرض، وشاشة **القنوات** موصولة بالخادم فعليًا.

**لا يوجد أي محاكي مزوّد.** النقل الافتراضي يرفض كل إرسال وكل اختبار اتصال بسبب `provider_not_connected`، وهذه هي الحقيقة إلى أن تتوفر أصول Meta مُصرَّح بها.

شاشات الوارد والحملات والتحليلات والإعدادات ما زالت مبنية على بيانات عرض محلية في `apps/web/src/data.ts` ولا تُجري أي طلب. لا يوجد بعد مسار صادر ولا outbox ولا realtime ولا محوّلات ماسنجر/إنستغرام/محادثة الموقع/القناة المخصّصة ولا نشر، ولا أي تحقق حيّ مع أي مزوّد. الدليل التفصيلي والمهمة التالية في [`docs/execution/current-task.md`](docs/execution/current-task.md).

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

### الواجهة

```bash
pnpm --filter @convo/web dev
```

المتصفح يطلب `/api/v1/...` كمسار على نفس الأصل، في التطوير وفي النشر معًا. خادم التطوير في [`apps/web/vite.config.ts`](apps/web/vite.config.ts) يمرّر `/api` إلى `http://127.0.0.1:3000`، و`CONVO_API_ORIGIN` يغيّر الوجهة لمن يشغّل الـAPI في مكان آخر. لا يوجد عنوان أساسي ثانٍ موجود محليًا فقط — وهو مصدر أخطاء CORS والكوكيز التي لا تظهر إلا بعد النشر.

شاشة **الأفراد والأدوار** تحتاج خادمًا يعمل وجلسة حقيقية؛ بدونهما تعرض فشل اتصال، وهو ما يجب أن تعرضه صفحة بلا خادم خلفها.

## بوابات التحقق

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:coverage
pnpm test:contracts
pnpm test:security
pnpm test:e2e
pnpm test:a11y
pnpm test:visual
```

اختبارات integration وcoverage تشغّل PostgreSQL 17.4 مؤقتًا داخل العملية ولا تحتاج Docker. آخر نتيجة مسجلة: `test:coverage` 74 ملفًا و**1214 اختبارًا** بتغطية 100% للسطور والعبارات والدوال والفروع؛ `test:integration` 230 اختبارًا؛ `test:e2e` 146؛ `test:a11y` 22 بلا أي مخالفة WCAG 2.1 AA؛ `test:visual` 19. عتبات التغطية عند 100 في `vitest.config.ts` ولا يجوز خفضها لتمرير تشغيلة.

`test:security` يشغّل مجموعات العزل والتفويض والتحقق من التوقيع، ثم `pnpm audit --audit-level high --prod`. `test:contracts` يشغّل عقود المحوّلات ومطابقة OpenAPI في الاتجاهين. `test:mutation` و`test:load:target` و`test:recovery` ما زالت ترجع 1 معلنةً `not_run` أو `blocked_env` بصراحة.

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
