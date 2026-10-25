# تحليل شامل للمشروع وخطة الاختبار الكامل — 2026-10-25

الفرع: `fix/messenger-sender-names` (مبني على `main` = `207df67`).
الهدف: تجهيز المشروع لاختبار كامل للـ Backend والـ Frontend (كل زرار، وكل قاعدة Business Logic)، وإصلاح عيوب الواجهة، وحل مشكلة اسم العميل في ماسنجر.

---

## 1. الملخص التنفيذي

- المشروع ناضج: monorepo فيه API بـ NestJS/Fastify، وواجهة TypeScript بدون framework، وقاعدة PostgreSQL 17 عليها RLS، و6 workers. عليه بوابة تغطية 100% (lines/branches/functions) في CI.
- **مشكلة اسم ماسنجر اتحلّت في الكود** (تفاصيل في §4). السبب الأرجح إن Meta بترجّع ملف شخصي **فاضي** (200 بدون اسم) لما تطبيق Meta مش واخد Advanced Access لميزة *Business Asset User Profile Access*. الكود القديم كان بيعتبر ده خطأ عابر، ويعيد 5 مرات، وبعدين يبطّل خالص. الإصلاح بيجيب الاسم من مسار تاني، وبيوضّح السبب للمشغّل، وبيعيد المحاولة تلقائيًا لكل العملاء العالقين بعد الـ deploy.
- **اتلقى زرارين ميتين** في الـ Inbox واتصلحوا: "حفظ العرض الحالي" و"تحديث" في قائمة العروض المحفوظة. واتضاف اختبار حارس بيمنع أي زرار يتكتب من غير handler يوصل للـ main تاني.
- **أكبر فجوة اختبار:** كل اختبارات المتصفح (Playwright) شغالة على API **وهمي** (`page.route`). مفيش اختبار واحد بيثبت إن الواجهة الحقيقية شغالة مع الـ API الحقيقي وقاعدة البيانات الحقيقية. وده عكس اللي مكتوب في `docs/testing/strategy.md` (الطبقة 6).
- بيئة الـ sandbox هنا بتمنع فتح أي port محلي وبتمنع shared memory، فاختبارات الـ integration والـ e2e والمعاينة في المتصفح **ماتشغلتش هنا**. لازم تتشغل في CI أو على جهازك (§7).

---

## 2. خريطة المشروع

| المسار | الوصف |
|---|---|
| `apps/api` | NestJS 11 على Fastify 5. فيه REST `/api/v1` (159 route في `docs/api/openapi.v1.json`)، وwebhooks، وSSE، وكل الـ workers. |
| `apps/web` | الواجهة: TypeScript + Vite، بدون framework (دالة `h()` بترسم DOM). `server.mjs` بيقدّم الواجهة وبيعمل proxy لـ `/api`. |
| `packages/domain` | قواعد العمل المشتركة: القنوات، والسياسات، والصلاحيات، والقوالب، والـ fairness. |
| `packages/database` | 53 migration (forward-only) وأوامر `bootstrap`/`migrate`. |
| `packages/contracts` | أنواع الأخطاء والعقود المشتركة. |
| `apps/progress`, `apps/proposal` | بوابات عرض للعميل، منفصلة عن المنتج. |
| `deploy/` | Docker Compose (مثال + Hostinger) و`start.sh`. |

**الإنتاج:** Hostinger على `omnichannel.berlitzdigitalschool-eg.com`. بيتعمله deploy تلقائي من `main` بعد نجاح CI (`.github/workflows/deploy-hostinger.yml`). كل الخدمات بتقرأ نفس الملف `.env.runtime`.

**الـ Workers:** inbound (بيحوّل الرسائل الواردة لمحادثات **وبيجيب أسماء ماسنجر/إنستجرام**)، وinteractive (ردود الموظفين)، وcampaign، وreport، وautomation، وintegration (إيميل وpush).

### 2.1 وحدات الـ Backend

| الوحدة | ملفات المصدر | ملفات الاختبار | الأسطر |
|---|---:|---:|---:|
| channels (Meta، webhooks، الإرسال، الأسماء) | 25 | 6 | 6,048 |
| conversations (Inbox، التوزيع، دورة الحياة) | 13 | 11 | 4,690 |
| campaigns (البث، الـ leads، التقارير) | 12 | 6 | 3,711 |
| people (المستخدمين، الأدوار، الفرق) | 7 | 2 | 2,226 |
| auth | 10 | 7 | 1,266 |
| email | 6 | 5 | 1,179 |
| contacts | 2 | 2 | 1,121 |
| metadata (labels، custom fields) | 3 | 1 | 908 |
| realtime (SSE) | 2 | 1 | 612 |
| notifications | 4 | 4 | 548 |
| authorization | 3 | 0* | 517 |
| workers | 3 | 3 | 459 |
| automations | 5 | 3 | 431 |
| باقي الوحدات (instance، segments، broker، health، idempotency، memberships، observability) | — | — | ~1,500 |

\* authorization مغطّاة بملفات integration مخصوصة: `api-authorization`، و`tenant-isolation`، و`permission-catalogue`.

### 2.2 شاشات الـ Frontend وعدد الأزرار

189 action مختلف (زرار أو رابط أو form) في الواجهة كلها. توزيعها:

| الشاشة/المكوّن | عدد الـ actions | ملف اختبار خاص |
|---|---:|:-:|
| live-inbox (الـ Inbox) | 38 | ✓ |
| dialogs | 28 | ✓ |
| channels-screen | 19 | ✓ |
| shell (القائمة، الإشعارات، الثيم، اللغة) | 18 | ✓ |
| campaigns-screen | 17 | ✓ |
| routing-panel (إسناد، تسليم، مشاركين) | 15 | — |
| contacts-screen | 15 | — |
| automations-screen | 15 | ✓ |
| admin-dialogs | 14 | — |
| broadcast-wizard | 12 | ✓ |
| lifecycle-panel (حالة، ملاحظات، أولوية) | 10 | — |
| auth | 10 | ✓ |
| roles / analytics / teams / contact-panel / contact-create / campaign-audience / users / settings / … | 2–8 لكل واحد | جزئي |

الشاشات اللي من غير ملف اختبار خاص بيها مغطّاة بشكل غير مباشر من `app.test.ts` و`live/*.test.ts` (التغطية الكلية 100%). لكن تغطية السطور غير تغطية السلوك: الزرارين الميتين في §5 كانوا "مغطّيين" 100% وبرضه مش شغالين.

---

## 3. حالة الاختبارات الحالية

| الطبقة | الحجم | ملاحظات |
|---|---|---|
| Unit (Vitest) | 178 ملف، ~2,790 اختبار | اتشغلت هنا: كلها نجحت ما عدا 11 اختبار في `probe-server.test.ts` بيحتاجوا يفتحوا TCP port (قيد الـ sandbox، مش bug). |
| Integration (Postgres حقيقي) | 27 ملف، ~18,000 سطر | بيغطّوا 146 من 159 route بالـ method بتاعها. **ماتشغلتش هنا** (الـ sandbox بيمنع الـ ports). |
| Property | 1 ملف (routing) | |
| E2E (Playwright) | 10 specs، ~151 اختبار | **API وهمي بالكامل.** بيذكروا 34 action بس من الـ 189. |
| Visual / a11y | ضمن الـ e2e | لقطات DOM + axe. |
| Load / Recovery / Mutation | موجودين | بيتشغلوا يدوي أو في staging. |
| Coverage gate | 100% | لآخر تقرير (`docs/testing/COVERAGE_GAPS_CURRENT.md`، 2026-09-23): مفيش فجوات. |

### 3.1 Routes من غير اختبار integration بالـ method بتاعها

- `POST /auth/logout`، و`POST /auth/recovery`، و`POST /auth/recovery/complete`، و`DELETE /auth/sessions/{id}` — المسار مذكور، لكن الـ method بيتبعت من helper. محتاجين تأكيد.
- `POST /invitations`، و`DELETE /invitations/{id}`، و`POST /invitations/{token}/accept` — نفس الحالة.
- `DELETE /conversations/{id}/collaborators/{membershipId}`
- `POST /ownership-transfers/{id}/decline`
- `GET /notifications/push-config`، و`POST /notifications/devices/{id}/revoke` — **مش مذكورين خالص** في الـ integration.
- `POST /webhooks/custom/{assetId}` (**مش مذكور**)، و`POST /webhooks/web-chat/{installationId}`.

---

## 4. مشكلة اسم الشخص في ماسنجر

### العَرَض
الـ Inbox بيعرض "عميل ماسنجر" بدل اسم الشخص. الواجهة متعمّد إنها ماتعرضش الـ PSID (رقم Meta الداخلي)، فطالما الاسم ماجاش بيفضل الـ fallback ده.

### المسار
1. webhook ماسنجر بيوصل وبيتحفظ.
2. `worker-inbound` بيعمل normalize وبينشئ contact، والـ `display_name` بتاعه = الـ PSID.
3. الـ contact بيدخل طابور `contact_profile_queue`.
4. نفس الـ worker بيطلب `GET /{PSID}?fields=id,first_name,last_name` بالـ Page token.
5. لو رجع اسم: بيتحدّث الـ contact، وبيتبعت حدث realtime، والـ Inbox بيعمل refresh.

### السبب الجذري (الأرجح)
حسب [توثيق Meta للـ User Profile API](https://developers.facebook.com/docs/messenger-platform/identity/user-profile): حقول الاسم محتاجة **Advanced Access لميزة Business Asset User Profile Access**. ولو التطبيق مش عنده الصلاحية دي، Meta بترجّع **object فاضي** بدل ما ترجّع خطأ.

الكود القديم كان بيعتبر الرد الفاضي "مفيش اسم دلوقتي" (`profile_unavailable`):
- بيعيد 5 مرات خلال نص ساعة تقريبًا، وبعدين بيوقف.
- الرسالة في شاشة القنوات كانت عامة ("Meta لم تُرجع الاسم بعد") ومش بتقول المطلوب إيه.
- العميل بيفضل "عميل ماسنجر" لحد ما يبعت رسالة جديدة، وبعدها نفس الدورة تتكرر.

### الإصلاح (في الفرع ده)
1. **مسار بديل للاسم:** لو الملف الشخصي رجع فاضي، أو اترفض بسبب صلاحية أو طلب غير صالح، الـ transport بيسأل `GET /{page-id}/conversations?platform=messenger&user_id={PSID}&fields=participants` وبيقرا `participants[].name`. ده محتاج `pages_messaging` و`pages_manage_metadata` بس ([Conversation reference](https://developers.facebook.com/docs/graph-api/reference/conversation/)). ودول نفس الصلاحيات اللي القناة محتاجاها أصلًا علشان تستقبل وترد. في إنستجرام بيقرا `username` عن طريق الـ Page المربوطة.
2. **سبب واضح:** كود جديد `profile_withheld`، وتحته رسالة في شاشة القنوات بالعربي والإنجليزي بتقول بالظبط المطلوب في تطبيق Meta.
3. **الـ worker بيبعت الـ Page ID:** `external_asset_id` لماسنجر، و`settings.facebook_page_id` لإنستجرام.
4. **Migration `0053`:** بتعيد كل العملاء اللي لسه اسمهم = الـ PSID للطابور بعد الـ deploy، على نمط `0047` و`0048`. مابتلمسش أي اسم عدّله موظف.
5. **مش بيحصل طلب تاني** لو الخطأ token مرفوض، أو rate limit، أو Meta واقعة، لأن المسار البديل هيفشل بنفس الطريقة.

### اتأكدنا من إيه
- اختبارات الـ transport: 79 اختبار نجحوا، ومنهم 18 حالة جديدة للمسار البديل وكل فروعه. الكود الجديد متغطّي 100%.
- اختبار الرسالة الجديدة في شاشة القنوات.
- اختبار الـ integration اتعدّل علشان يتأكد إن الـ Page ID بيوصل للـ lookup، **لكن ماتشغلش هنا**.

### ماتأكدناش منه
- ماشفتش الإنتاج. لو السبب الحقيقي حاجة تانية، هتبان في كارت قناة ماسنجر في شاشة **القنوات**:
  - **"N اسم لم يُجلب بعد" ومن غير أي كود خطأ:** يبقى غالبًا `CONVO_CHANNEL_TRANSPORT` مش `meta` على `worker-inbound`، والـ lookup مابيحصلش أصلًا.
  - **`profile_credential_rejected`:** الـ token مش Page token صالح.
  - **`profile_withheld` بعد الإصلاح:** حتى المسار البديل مارجعش اسم، فلازم App Review للميزة.
- سلوك Meta الحقيقي مع المسار البديل اتختبر بـ responses مسجّلة، مش على Meta live.

---

## 5. عيوب اتلقت في التحليل

| # | العيب | الحالة |
|---|---|---|
| F1 | اسم ماسنجر/إنستجرام مابيظهرش (§4) | **اتصلح** + اختبارات + migration 0053 |
| F2 | زرار "حفظ العرض الحالي" و"تحديث" في قائمة العروض المحفوظة (Inbox) ميتين: بيبعتوا `open-dialog` والـ registry مافيهوش غير `dialog` | **اتصلح** |
| F3 | مفيش أي حماية من زرار باسم action مالوش handler | **اتصلح:** `apps/web/src/action-wiring.test.ts` بيقرأ كل أسماء الـ actions من الكود ويفشل لو أي واحد مالوش handler. واتأكدنا إنه بيمسك F2 لو اترجع. |
| F4 | الـ E2E كلها على API وهمي، ومفيش اختبار full-stack | مفتوح، خطة في §6.3 |
| F5 | كارت العميل في طابور "غير مُسند" بيرسم avatar فاضي لعميل ماسنجر من غير اسم، والـ thread header بيرسم "عم" | مفتوح (تجميلي) |
| F6 | `scripts/deploy-railway.sh` مثبّت على migration `0044` والفرع ده وصل `0053`، يعني أي deploy على Railway هيترفض | مفتوح. Railway مابقاش مسار الإنتاج، فلازم يتحدّث أو يتشال. |
| F7 | `docs/testing/strategy.md` بيقول إن الـ E2E "real backend, real DB" والواقع غير كده | مفتوح (توثيق) |

### 5.1 عيوب مفتوحة من مراجعة 2026-10-24 (`docs/audit/2026-10-24-BUG_TRACKER.md`)

| # | العيب | محتاج قرار؟ |
|---|---|---|
| C11 | إلغاء إسناد محادثة `pending`/`snoozed` بيخفيها من "غير مُسند" ومن "محادثاتي" | **اتصلح:** بقرار منك، طابور "غير مُسند" بيعرض المحادثات اللي حالتها pending أو snoozed، وعليها شارة بالحالة، وتقدر تستلمها عادي. |
| C12 | طابور "غير مُسند" مقفول على 200 من غير pagination | لأ |
| C13 | أي اختلاف بين نطاق الـ SQL والـ domain بيحوّل القائمة كلها لـ 500 | قرار تصميم |
| R2 | تقرير الحملات لسه بيقسم الأيام بتوقيت UTC، مش القاهرة | لأ |
| R4 | جمهور البث بيعدّ العميل مرتين لو عنده identity قديمة وجديدة | لأ |
| R5 | البحث في الجمهور مابيعملش escape لـ `%` و`_` | لأ |
| O1 | جدول `realtime_events` بيكبر للأبد (مفيش تنظيف) | لأ |
| O2 | كل tab مفتوحة بتسأل قاعدة البيانات مرتين في الثانية (SSE polling) | قرار معماري |

---

## 6. خطة الاختبار الكامل

### 6.0 تجهيز البيئة (لازم الأول)
- علشان أقدر أشغّل الـ integration والـ e2e وأشوف الواجهة في المتصفح من هنا: `sandbox.network.allowLocalBinding: true` في إعدادات Claude Code. Postgres كمان محتاج shared memory، والـ sandbox بيمنعها. البديل إن الاختبارات دي تتشغل على جهازك أو في CI، وأنا أقرأ النتائج.
- قاعدة بيانات seed ثابتة: شركة، وكل الأدوار السبعة، وفريقين، وقنوات (واتساب، ماسنجر، إنستجرام، custom) بـ transport وهمي معروف.

### 6.1 الـ Backend: مصفوفة الـ Business Logic
لكل قاعدة: حالة نجاح، وحالة رفض، وحالة حدّية، وحالة صلاحيات. ومعظمها موجود فعلًا، فالشغل الأساسي هو **مراجعة إن الاختبار بيثبت القاعدة نفسها، مش بس بيمشي على السطر**.

| المجال | القواعد اللي لازم تتثبت |
|---|---|
| Tenancy/RLS | مفيش قراءة أو كتابة عبر الشركات من أي route أو worker؛ دور الـ runtime مايقدرش يتخطى RLS |
| الصلاحيات | كل دور من السبعة × كل route؛ نطاقات الفريق والـ inbox؛ الـ supervisor قراءة بس |
| Auth | دخول، وقفل بعد محاولات فاشلة، وMFA، واسترجاع الباسورد، والجلسات، والدعوات، ونقل الملكية |
| المحادثات | claim، وassign، وrelease، وhandoff (قبول/رفض)، وcollaborators، وpriority، وsnooze بالمنطقة الزمنية، وresolve/reopen (episodes)، وarchive (غير قابل للتعديل)، والقراءة/عدم القراءة، والـ version conflicts (409) |
| نافذة واتساب 24 ساعة | قبلها، وعند حدّها بالظبط، وبعدها، والقالب بس بعد قفلها |
| الإرسال | idempotency، والـ outbox lease، والنتائج الثلاثة (accepted / rejected / unknown)، وإعادة المحاولة بـ backoff، وإيصالات التسليم والقراءة |
| الاستقبال | التوقيع، وحد الحجم، وتكرار الحدث، والترتيب العكسي، والـ echo، والمرفقات، وأسماء المرسلين (F1) |
| جهات الاتصال | إنشاء بقناة أو من غيرها، وidentities، والدمج (ممنوع تلقائي)، وCSV import/export، والموافقة (opt-out دايمًا بيكسب) |
| البث | الجمهور (استبعاد opt-out بس)، والـ preview، والـ validate، والـ approve، والـ launch، والـ pause/resume/cancel، والـ retry، والـ test-send، والـ leads ونتايجها، والـ clone |
| الأتمتة | triggers بالأحداث والجدولة، والمنطقة الزمنية، والخطوات (template، label، field، wait)، والـ run log، والتفعيل/الإيقاف |
| التقارير | كل تقرير × فلتر التاريخ بتوقيت القاهرة (R1/R2)، ونطاق القراءة، والـ export (CSV/Excel) |
| الإشعارات | in-app، وpush (VAPID)، والإيميل (SMTP/Resend)، وrevoke للجهاز |
| Realtime | البداية من آخر حدث، والـ reset، والإغلاق لما العميل يخرج (H1–H4) |

### 6.2 الـ Frontend: "كل زرار شغال ولا لأ"
1. **الحارس الثابت (اتعمل):** كل action ليه handler.
2. **مصفوفة الأزرار:** جدول بالـ 189 action، وقدام كل واحد الشاشة، والأثر المتوقع (API call / dialog / navigation / state)، والاختبار اللي بيثبته. 183 منهم مذكورين في unit tests، والمطلوب نتأكد إن كل اختبار بيضغط الزرار فعلًا ويشوف أثره، مش بيستدعي الـ handler مباشرة.
3. **اختبارات ضغط حقيقي:** لكل شاشة، اختبار في happy-dom بيرسم الشاشة، ويضغط كل زرار ظاهر، ويتأكد إن فيه أثر، وإن مفيش أخطاء.

### 6.3 E2E حقيقي (أهم إضافة)
suite جديدة في Playwright بتشغّل **API حقيقي + Postgres حقيقي + الواجهة المبنية**، من غير `page.route`. والـ transport بتاع Meta بس هو اللي وهمي. الرحلات الأساسية:
- دخول ← رسالة واردة من ماسنجر (webhook موقّع) ← تظهر في "غير مُسند" **باسم العميل** ← claim ← رد ← إيصال تسليم.
- واتساب: نافذة مفتوحة ← رد؛ نافذة مقفولة ← قالب.
- إنشاء جهة اتصال ← إضافة قناة ← labels وcustom fields ← export.
- بث: جمهور ← قالب ← test-send ← approve ← launch ← pause ← تقرير.
- أتمتة: إنشاء ← تفعيل ← حدث ← run log.
- إدارة: دعوة ← قبول ← دور ← فريق ← صلاحيات بتتطبّق.
- كل رحلة بالعربي (RTL) والإنجليزي، فاتح وغامق، على 1440 و1366 والموبايل.

### 6.4 عيوب الواجهة وتحسينها
مراجعة بصرية في المتصفح شاشة بشاشة: المحاذاة، والـ RTL، والحالات الفاضية، والتحميل، والأخطاء، والـ overflow، والتركيز بالكيبورد، والتباين، والموبايل. وكل عيب ينزل بصورة قبل/بعد واختبار visual. **محتاجة المتصفح يشتغل (§6.0).**

### 6.5 بوابات CI
تشغيل الـ E2E الحقيقية في CI قبل deploy الـ Hostinger، مع الاحتفاظ ببوابة الـ 100%.

---

## 7. محتاجه منك
1. **من شاشة القنوات في الإنتاج:** كارت قناة ماسنجر بيقول إيه تحت "N اسم لم يُجلب بعد"؟ (كود الخطأ لو موجود)
2. **تطبيق Meta:** واخد Advanced Access لـ *Business Asset User Profile Access*؟ وعنده `pages_manage_metadata`؟
3. تفعيل `allowLocalBinding` (أو تشغيل `pnpm test:integration` و`pnpm test:e2e` عندك) علشان نكمل §6.
4. ~~قرار C11~~ (اتاخد واتنفّذ).
5. موافقة على commit وPR للفرع ده. **الـ merge على `main` بيعمل deploy تلقائي للإنتاج.**
