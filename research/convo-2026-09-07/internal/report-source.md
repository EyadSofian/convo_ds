# CONVO — بحث المنتج والمعمارية وخطة التنفيذ

**تاريخ البحث: ٧ سبتمبر ٢٠٢٦ · موجّه إلى إياد وفريق المنتج والهندسة · مرحلة البحث والتصميم**

هذا التقرير يغطي منصة لإدارة محادثات شركات متعددة، مستضافة ذاتيًا، تدعم WhatsApp الرسمي وMessenger وInstagram، وحملات كبيرة، وربط CRM، ثم AI agent مع تسليم للموظف. الاسم CONVO اسم عمل مؤقت. المستخدم ذكر نحو ألف مستخدم؛ اعتبرناهم **١٠٠٠ مستخدم متزامن** احتياطيًا، وليس رقمًا مقاسًا. عدد الشركات والرسائل وبلد الاستضافة والميزانية لم تُحسم.

## ١. القرار الذي أوصي به

**للمنتج المستقل طويل الأجل: نبني نواة أصلية متعددة الشركات، بمعمارية modular monolith، مع تشغيل منفصل لاستقبال webhooks، وردود الموظفين، والحملات، والـrealtime والتكاملات.** نستفيد من نماذج Chatwoot ونضج تجربة respond.io، ثم نختبر السعة على بيانات وأحمال ممثلة. اختيار اللغة وحده لا يثبت التحمل؛ عنق الزجاجة عادةً يشمل استعلامات البيانات والصفوف والـfan-out وحدود المزود.

أفضل مرجع self-hosted مطابق للاحتياج ضمن المنتجات المفحوصة هو **Chatwoot**. أفضل مرجع وظيفي للحملات والتوجيه والـworkflows هو **respond.io**. هذه توصية ملاءمة للاحتياج، وليست ترتيبًا مطلقًا للسوق أو إثباتًا أن أي منصة تتحمل الحمل المطلوب دون تجربة. [Chatwoot](https://www.chatwoot.com/features)، [respond.io](https://respond.io/pricing).

لو موعد الإطلاق أهم من امتلاك منتج مستقل، فالبديل الجاد هو **Chatwoot بإصدار ثابت + خدمة حملات أصلية + adapters للتكاملات**، ثم قياس الأداء وتكلفة التخصيص. لا أنصح بعمل fork ضخم ثم تغيير الـbackend والـfrontend بالكامل؛ بذلك نخسر ميزة المنتج الجاهز ونحتفظ بتكلفة دمجه مع تحديثات المصدر.

| المسار | المكسب | التكلفة/الحد | اختياره المناسب |
|---|---|---|---|
| شراء SaaS | أقصر طريق لتجربة التشغيل الفعلي | لا يحقق استضافة التطبيق على بنيتنا وفق العروض العامة المفحوصة؛ الاشتراك والحصص وحقوق إعادة البيع تحتاج اتفاقًا | شراء أداة تشغيل داخلية |
| Chatwoot مع امتدادات محدودة | أساس inbox وقنوات ومستخدمين قائم | Rails/Vue، حدود CE/EE، متابعة الترقيات، إثبات محرك الحملات تحت الحمل | إطلاق أسرع بفريق يعرف التقنيات |
| منتج أصلي — التوصية | تحكم في tenant isolation وAPIs والتكلفة وUX | مسؤولية كل ميزة وتشغيل وأمان واختبار؛ يحتاج فريقًا ووقتًا | منصة تجارية لشركات كثيرة |

**الاستضافة الذاتية تخص منتجنا وبياناته؛ WhatsApp Cloud API تستضيفها Meta.** استخدام موديل AI خارجي يعني كذلك خروج البيانات المحددة له، ولو كان التطبيق self-hosted. [Meta Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api).

## ٢. ماذا يوجد في السوق؟

الجدول يفرق بين ميزة موثقة وميزة تحتاج خطة أو تكاملًا. كلمة «غير مثبت» لا تعني الاستحالة؛ تعني أن الأدلة العامة لم تكفِ. لم أجد قياسات موحدة مستقلة تسمح بمقارنة throughput بين المنتجات.

| المنتج | الاستضافة | القنوات والحملات | AI والتكامل والصلاحيات | ما نستفيده |
|---|---|---|---|---|
| **Chatwoot** | Self-hosted CE/EE | WhatsApp وMessenger وInstagram وقنوات أخرى؛ الموقع الحالي يعرض حملات WhatsApp templates | API/webhooks؛ Captain والصلاحيات المتقدمة ميزات مدفوعة؛ صلاحيات admin/agent الأساسية موجودة | نموذج المحادثة والـinbox والملاحظات والتعيين. [الميزات](https://www.chatwoot.com/features)، [الحملات](https://www.chatwoot.com/features/campaigns) |
| **respond.io** | SaaS في العرض المفحوص | Broadcasts وinbox وworkflows | API/AI في Growth؛ webhooks وHTTP requests وSSO وغيرها في Advanced وفق صفحة الخطط | مرجع مباشر لتجربة الحملات والتوجيه. [الخطط](https://respond.io/pricing) |
| **Trengo** | SaaS | قنوات اجتماعية وبريد وشات؛ WhatsApp broadcasting إضافة مدفوعة | AI Journeys وتكاملات وصلاحيات تختلف بالخطة | تجربة الفرق والتشغيل. [الخطط](https://trengo.com/prices) |
| **SleekFlow** | SaaS | Broadcasts وقنوات اجتماعية متعددة | API/webhooks وRBAC في Premium؛ AI handoff وCRM | الشرائح وملف العميل وتدفقات التجارة. [الخطط](https://sleekflow.io/pricing)، [القنوات](https://help.sleekflow.io/en_US/connecting-channels)، [WhatsApp](https://sleekflow.io/en-us/channels-integrations/whatsapp) |
| **WATI** | SaaS | تركيز قوي على WhatsApp campaigns وteam inbox | API وحدود webhooks والخدمات الإضافية تختلف بالخطة؛ Growth المعروضة دون webhooks | onboarding وحملات WhatsApp. [الخطط](https://www.wati.io/pricing/)، [handoff](https://support.wati.io/en/articles/14664818-how-to-assign-a-conversation-to-agents-in-wati) |
| **Zendesk** | SaaS | WhatsApp للدعم؛ proactive templates عبر Relay أو Notification API | منظومة دعم وAPIs؛ صلاحية API المعنية تتطلب خطة مناسبة | SLA والتشغيل والحوكمة. ليست كل ميزة proactive فيه شاشة حملات WhatsApp. [توثيق WhatsApp](https://support.zendesk.com/hc/en-us/articles/9586188841626-Workflow-How-to-proactively-contact-users-on-WhatsApp-channel) |
| **Intercom** | SaaS | WhatsApp وFin؛ بدء المحادثة من Inbox موثق كـ1:1 | FAQ تقيد بدء WhatsApp عبر REST API؛ توثيق marketing templates متعارض | مرجع ممتاز لتجربة الدعم والـAI، ولا نعتمد عليه لإثبات broadcast parity. [FAQ](https://www.intercom.com/help/en/articles/9067468-whatsapp-faqs)، [بدء المحادثة](https://www.intercom.com/help/en/articles/6808174-start-a-whatsapp-conversation) |
| **Zammad** | Self-hosted، AGPLv3 | Cloud API للدعم الوارد؛ التوثيق يستبعد business-initiated templates حاليًا | REST API؛ ملاءمة AI المطلوبة غير مثبتة هنا | helpdesk بديل؛ ضعيف كأساس لمنتج محوره الحملات. [القيود](https://admin-docs.zammad.org/en/latest/channels/whatsapp/limitations.html)، [التنزيل](https://zammad.org/)، [الترخيص](https://docs.zammad.org/en/latest/about/zammad.html) |
| **Rocket.Chat** | Self-managed متاح | تطبيق WhatsApp Cloud رسمي لكن Enterprise؛ يحتاج Cloud registration | Omnichannel وبيئة دردشة؛ تكافؤ محرك الحملات المطلوب غير مثبت | مفيد لو دردشة الموظفين الداخلية محور أساسي أيضًا. [التطبيق](https://www.rocket.chat/apps/whatsapp-cloud)، [الإعداد](https://docs.rocket.chat/docs/whatsapp-cloud-app) |

لا يصح مساواة «عدة workspaces» بعزل شركات مستقل، ولا «unlimited broadcasts» بإرسال غير محدود من Meta. كذلك اختلاف وحدة المحاسبة بين seat وactive contact وconversation وAI usage يجعل سعر البداية الشهري مقارنة ناقصة. نطلب عروضًا على **نفس سيناريو السعة** ونضيف رسوم القناة والـAI والتخزين والتشغيل.

### ما تغير عن معلومات شائعة قديمة

Chatwoot يعرض بالفعل WhatsApp campaigns الآن؛ وقد تحققنا أيضًا من وجود كود لها. لكن جزءًا من تتبع المستلمين يوجد في enterprise، وميزة الحملات لها feature flag. وجود الميزة في موقع المنتج أو main branch لا يثبت أنها متاحة في نسخة CE مستقرة بعينها. [صفحة الحملات](https://www.chatwoot.com/features/campaigns)، [الكود المثبت للحملة](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/app/services/whatsapp/oneoff_campaign_service.rb).

ترخيص المستودع يفرق بين MIT خارج الأجزاء المستثناة وبين ترخيص enterprise. لا نفترض أن اشتراك EE يمنح تلقائيًا حق توزيع منصة white-label لعملاء متعددين؛ يجب مطابقة نموذجنا التجاري مع العقد قبل اختيار هذا المسار. هذا لا يمنع بناء منتج أصلي. [LICENSE](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/LICENSE)، [Enterprise LICENSE](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/enterprise/LICENSE)، [شروط Chatwoot](https://www.chatwoot.com/terms-of-service).

## ٣. ماذا وجدت داخل مستودع Chatwoot؟

تم تنزيل نسخة sparse من المستودع الرسمي وفحص ملفات فعلية عند commit **c9f1867369ea87580adac3df9f2058bc63da1ef2** بتاريخ 2026-09-07. هذا snapshot من الفرع الافتراضي، **وليس توصية بنشر main أو ادعاء فحص المستودع بالكامل**. لم أشغّل Chatwoot أو benchmark له.

| ما فُحص | الحقيقة المرصودة | الدرس لمنتجنا |
|---|---|---|
| Gemfile وpackage.json | Rails 7.2.3.1، Ruby 3.4.4، Vue 3، Vite، Sidekiq؛ وجود Vuex وPinia في dependencies | معمارية ناضجة لا تتطلب microservices لكل كيان. [Gemfile](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/Gemfile)، [package](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/package.json) |
| Deployment وcable.yml | Web وworkers وPostgres وRedis وobject storage؛ Action Cable يستخدم Redis | نفصل التخزين الدائم عن realtime والإشارات المؤقتة. [المعمارية](https://developers.chatwoot.com/self-hosted/deployment/architecture)، [cable](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/config/cable.yml) |
| account/inbox/conversation/message | Account يملك عدة موارد؛ Inbox يرتبط بقناة polymorphic؛ حالات المحادثة open/pending/resolved/snoozed | الشركة غير المستخدم؛ القناة غير الـinbox؛ حالة المحادثة غير حالة رسالة. [Inbox](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/app/models/inbox.rb)، [Conversation](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/app/models/conversation.rb) |
| WhatsApp controller/job | استقبال ثم job؛ serializing لبعض رسائل نفس جهة الاتصال بواسطة mutex؛ job على queue منخفضة الأولوية | تزامن رسائل العميل حقيقي، وعزل صفوف inbound والحملات مطلوب عندنا. [controller](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/app/controllers/webhooks/whatsapp_controller.rb)، [job](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/app/jobs/webhooks/whatsapp_events_job.rb) |
| sidekiq.yml | صفوف ذات ترتيب أولوية؛ concurrency افتراضي 10 في هذا الملف ويمكن تغييره | نفس pool قد يسبب انتظارًا للصفوف الأدنى؛ لا ننقل defaults كخطة ألف مستخدم. [الصفوف](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/config/sidekiq.yml) |
| oneoff_campaign_service | المرور على الجمهور وإرسال القوالب؛ وفي EE بناء recipient records ثم المرور عليها | الكود المفحوص لا يكفي لإثبات distributed scheduling عادل لملايين المستلمين؛ نحتاج batches وصفوف محدودة وقياسات. [CE service](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/app/services/whatsapp/oneoff_campaign_service.rb)، [EE service](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/enterprise/app/services/enterprise/whatsapp/oneoff_campaign_service.rb) |
| CampaignRecipient | حالات queued/skipped/sent/delivered/read/failed وحماية من بعض status downgrades | delivery receipts قد تتأخر؛ accepted لا تساوي delivered؛ نحتاج event journal. [الموديل](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/enterprise/app/models/campaign_recipient.rb) |
| ConversationPolicy | الوصول مربوط بعضوية inbox أو team ودور المستخدم | نضيف matrix أدق ونختبر object-level authorization لكل API. [السياسة](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/app/policies/conversation_policy.rb) |

هذه استنتاجات تصميم من ملفات محددة؛ ليست تقرير ثغرات أو حكمًا بأن Chatwoot يفشل في الإنتاج. القيمة الرئيسية هي فهم حدود الكيانات، الفصل بين workers والـweb، وضرورة إثبات semantics الإرسال والتزامن.

## ٤. قيود Meta التي تغير تصميم المنتج

### إعداد القنوات

واجهة الربط الافتراضية المقترحة «Connect with Meta»، ثم اختيار أصل الأعمال والـinbox، ثم التحقق من الاشتراك والصلاحيات واستقبال event تجريبي. الإدخال اليدوي متاح للمشرف عند وجود أصول جاهزة. **App ID ليس App Secret؛ access token ليس webhook verify token.** نخزن الأسرار مشفرة في الخادم ونظهر حالة الصلاحيات والانتهاء والإبطال، ولا نعيد التوكن كاملًا للمتصفح. [Meta Embedded Signup](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup)، [Meta webhook verification](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/).

| القناة | بيانات الربط الأساسية | القيود التي تظهر للمستخدم |
|---|---|---|
| WhatsApp | Portfolio/WABA، phone_number_id، token بالـscopes المناسبة، app configuration وwebhook subscription | قالب معتمد عند الحاجة، نافذة رد، صحة القناة وحدودها |
| Messenger | Page وPage token وpages_messaging والاشتراكات المطلوبة | سياسة window/capabilities مستقلة؛ لا نفترض broadcast مشابهًا لواتساب |
| Instagram | Professional account، اختيار مسار Instagram Login أو Facebook Login، token/scopes الخاصة بالمسار | بدء التفاعل من العميل، قدرات DM والـprivate replies حسب المسار؛ لا نخلط scopes المسارين |

المصادر الرسمية: [WhatsApp API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)، [Messenger API](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api)، [Instagram API](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api). أمثلة collections قد تتضمن أجزاء legacy؛ مرحلة الاتصال الفعلي تعيد التحقق من Graph version وApp Review وAdvanced Access بحساب خارجي عن أدوار التطبيق.

### الإرسال والحملات

سياسة WhatsApp تشترط الإذن بالتواصل واحترام الانسحاب. بدء التواصل أو الرد خارج نافذة الخدمة يحتاج قالبًا معتمدًا وفق الحالة. الأتمتة يجب أن توفر تصعيدًا واضحًا. لذلك الجمهور المستورد ليس إذن إرسال بذاته، والقالب المقبول عند الجدولة قد يصبح موقوفًا عند التنفيذ. [سياسة WhatsApp](https://whatsappbusiness.com/policy/).

حد **throughput لكل رقم بالثانية** مختلف عن **حصة المستلمين الفريدين خارج نافذة الخدمة خلال 24 ساعة متحركة على مستوى portfolio**. وثائق AWS تعرض 80 MPS افتراضيًا وإمكانية 1000 بشروط؛ هذه أدلة مزود رسمي بديلة لأن صفحات Meta التفصيلية تعذر فتح بعضها، وليست سعة مضمونة لرقم الشركة. 360dialog توضح اشتراك الأرقام في حصة portfolio. نخزن الحدود كإعدادات مؤرخة قابلة للتحديث، ولا نثبت tiers في الكود. [AWS throughput](https://docs.aws.amazon.com/social-messaging/latest/userguide/increase-message-throughput.html)، [360dialog limits](https://docs.360dialog.com/docs/resources/wabas/messaging-limits).

هناك أيضًا pacing وجودة template/account وحدود تسويق للمستلم. إقرار provider بقبول رسالة لا يعني وصولها. السياسة الداخلية المقترحة توقف أو تبطئ الحملات المتعثرة، وتحجز جزءًا من السعة لردود الموظفين. هذا لا يتجاوز حدود Meta. [360dialog campaign checklist](https://docs.360dialog.com/docs/waba-messaging/best-practices/checklist-for-message-broadcasts-and-campaigns).

### تغيير هوية العميل والتسعير

WhatsApp usernames تُطرح تدريجيًا وقد يغيب رقم الهاتف. وثائق Twilio الحالية تصف BSUID scoped إلى portfolio والمستخدم، مع تغيّره في بعض تغييرات الهوية. لذلك ننشئ contact UUID داخليًا، والهاتف nullable، ونحتفظ بهويات القنوات وaliases وتاريخ صلاحيتها؛ لا ندمج عميلين لمجرد اسم أو username متشابه. تفاصيل BSUID وparent IDs تحتاج contract tests مع النسخة الفعلية من Meta. [WhatsApp FAQ](https://faq.whatsapp.com/1131753190029163)، [Twilio key concepts](https://www.twilio.com/docs/whatsapp/key-concepts).

صفحة Meta الحالية تشرح المحاسبة على الرسائل المسلمة حسب السوق والفئة. لا نجمد السعر أو الإعفاءات: نستخدم rate-card versions وeffective dates وcurrency وbillable events ومصالحة فاتورة المزود. ظهرت أيضًا خصائص تسعير تسويقي ديناميكي في وثائق مزود وتحديثات مستقبلية؛ نسجلها كقدرات اختيارية تحتاج تحققًا، ولا نفترض إتاحتها لكل اتصال. [Meta pricing](https://whatsappbusiness.com/products/platform-pricing/)، [Twilio pricing concepts](https://www.twilio.com/docs/whatsapp/key-concepts).

ميزة Human Agent في القنوات التي تدعمها ليست تصريحًا للبوت بتمديد نافذته؛ الاستخدام الآلي غير مسموح تحت هذا المسار حسب توثيق Instagram. يظهر الفرق في permissions وسياسة الإرسال واختبارات الـAI. [Meta Human Agent](https://developers.facebook.com/docs/features-reference/human-agent)، [Instagram messaging reference](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-af579d08-121e-4897-8f45-5fd41ace49df).

## ٥. نطاق المنتج الكامل ومراحله

هذه **قائمة متطلبات مقترحة لمنتجنا** مبنية على الاحتياج والبحث؛ ليست ادعاءً بأن كل منافس يملكها. «تنفيذ كل شيء» يتحول إلى registry يمكن مراجعته؛ أي توسع جديد يضاف له acceptance criteria، ولا يختفي بند تحت مسمى MVP.

| المرحلة/الرمز | الوظائف المطلوبة | دليل القبول العملي |
|---|---|---|
| P1 · TEN | إنشاء شركة، عضويات متعددة، دعوات، تبديل شركة، فرق، quotas، إعداد اللغة والتوقيت، تعليق شركة وخروج بياناتها | المستخدم لا يرى بيانات شركة أخرى من API أو search أو socket أو export |
| P1 · IAM | Owner/Admin/Supervisor/Agent/Campaign Manager/Analyst/Developer، أدوار مخصصة، scopes، MFA، جلسات وإبطال مفاتيح | اختبارات السماح والمنع لكل مورد وفعل؛ إلغاء العضوية يقطع الاشتراكات والجلسات |
| P2 · CON | Inbox موحد، views محفوظة، بحث، unread، أولوية، tags، custom fields، assignment، open/pending/snoozed/resolved/reopen | التعيين المتزامن لا ينتج مالكين، والعدادات تتصالح مع البيانات |
| P2 · COL | ملاحظات خاصة، mentions، participants، canned replies، macros، typing/presence، تنبيه موظف آخر يكتب، سجل تغييرات | الملاحظة لا تخرج أبدًا للقناة ولا لمستخدم بلا صلاحية |
| P2 · MSG | نصوص ووسائط ومرفقات وreplies وtemplates حسب قدرات القناة؛ حالات delivery وأخطاء قابلة للتفسير | إرسال من UI حتى provider receipt على اتصال اختبار رسمي |
| P2 · CH-WA | ربط WhatsApp، sync templates/status/quality، health، token lifecycle، webhook diagnostics | الاتصال لا يصبح Connected قبل فحوص الأصول والاشتراك والحدث الاختباري |
| P3 · CH-SOC | Messenger وInstagram، reconnect، echoes، unsupported payload fallback | account خارجي عن أدوار التطبيق يعمل بعد التصاريح الفعلية |
| P3 · CT | ملف عميل موحد داخل الشركة، external identities، merge بمراجعة، تاريخ consent، استيراد وتصدير وتقسيم جمهور | هاتف غائب وتغيّر identity وعدم دمج شركات أو أسماء متشابهة |
| P4 · CMP | مسودة، اختيار template/language، personalization، فحص جمهور، exclusions، snapshot، test send، موافقات، schedule/timezone، budget، pause/resume/cancel | مليون مستلم اصطناعي دون تحميله كله للذاكرة ودون تعطيل inbox |
| P4 · DEL | fair scheduling لكل شركة/رقم، rate limiting، recipient attempts، retries محدودة، outcome_unknown، DLQ، replay آمن | crash/429/timeout لا يحول النتيجة إلى نجاح كاذب أو retry أعمى |
| P5 · CRM | Odoo contacts/leads/orders view، field mapping، اتجاهات sync، مصدر حقيقة، conflict resolution، logs/retry/replay | outage لا يوقف المحادثات؛ retries لا تنشئ lead مكررًا |
| P5 · API | REST/OpenAPI، API keys/scopes، OAuth/OIDC، signed webhooks، async exports، SDK، sandbox | مثال get/post كامل، pagination صحيحة، contract compatibility |
| P6 · OPS | routing حسب الفريق/التوفر/اللغة/السعة، business hours/holidays، SLA، escalation، CSAT، تقارير | اختبارات توقيت/DST والتوزيع العادل وعدّ SLA حسب التعريف |
| P6 · AUTO | rule builder: event/conditions/actions، نسخ ونشر ومحاكاة وrollback، تأخير وأوقات عمل، منع loops | كل run له execution trace وversion وحدود دورات ومهلة |
| P7 · AI | اقتراح رد، تلخيص، تصنيف، RAG، أدوات CRM محدودة، bot mode، handoff، takeover/resume | golden set عربي/إنجليزي؛ لا يرسل AI بعد تأكيد انتقال الملكية |
| P8 · ENT | OIDC/SAML، provisioning عند الحاجة، audit exports، retention/deletion، usage metering، backup/restore، dedicated tenant option | recovery drill وصلاحيات admin محددة وسجل قابل للتتبع |
| P9 · EXT | Email وweb widget ثم SMS/Telegram/LINE بحسب الأولوية؛ help center؛ calling/flows/catalogs قدرات اختيارية | لا تظهر قدرة غير مدعومة على القناة؛ كل adapter له contract suite |

تفاصيل الحملات التي لا يصح إسقاطها: ملف CSV كبير streaming، preview أخطاء الأعمدة، dedupe، أرقام وهوية صالحة، consent source/time/purpose، قوالب متعددة اللغات، معالجة variables الناقصة، exclusion reasons، quiet hours، suppression وfrequency caps، تعدد الحملات على نفس الرقم، quotas مشتركة، إيقاف على تدهور الجودة، انتهاء صلاحية الجدول، campaign attribution للردود، وإعادة المحاولة للمؤهل فقط.

Calling وWhatsApp Flows والكتالوجات والمدفوعات ليست مضمونة بمجرد ربط Cloud API. نسجل كل واحدة capability مستقلة بحسب السوق والحساب والتصاريح. كذلك email/SMS ليست لهما سياسة نافذة WhatsApp. نخضع أي قناة إضافية لبحث adapter خاص قبل الوعد بميزاتها.

## ٦. معمارية قابلة للنمو

### الاختيار التقني المقترح

| الطبقة | الاختيار | السبب وحدود القرار |
|---|---|---|
| Frontend | React + TypeScript + Vite؛ TanStack Query/Virtual؛ components مملوكة مبنية على primitives accessible | SPA مناسبة لمساحة عمل موظفين؛ pagination وvirtualization؛ Next.js ليس ضرورة لواجهة inbox مغلقة |
| Core API | NestJS مع Fastify وTypeScript strict؛ modules لكل domain | وضوح عقود وصلاحيات ومعاملات؛ لا توجد هنا نتيجة benchmark تقارن اللغات |
| قاعدة البيانات | PostgreSQL بإصدار stable مدعوم؛ SQL migrations وquery layer يتيح RLS والمعاملات بوضوح | مصدر الحقيقة للرسائل والحملات والأذونات؛ لا نعتمد على ORM filters وحدها |
| توزيع العمل | RabbitMQ quorum queues، publisher confirms، consumer ACK بعد commit | رسائل queue تحمل IDs صغيرة؛ outbox في Postgres يسد فجوة DB/broker |
| cache/ephemeral | Valkey أو Redis وفق توافق المكونات والترخيص المختار | حضور، caches، rate counters؛ ليست المصدر الوحيد للأعمال المقبولة |
| realtime | WebSocket gateway مستقل، event IDs وcursor/catch-up | ضياع socket event يُستدرك من API؛ subscribe authorization في كل شركة/inbox |
| الملفات | S3-compatible object storage، quarantine وفحص MIME/malware وروابط قصيرة العمر | نقل الوسائط لا يعطل event ingestion؛ quotas وretention منفصلة |
| البحث | PostgreSQL للبحث الأساسي؛ OpenSearch عند ثبوت الحاجة للبحث العربي المتقدم وحجم البيانات | index مشتق يمكن إعادة بنائه؛ authorization filter قبل إرجاع النتائج |
| AI لاحقًا | Python + PydanticAI، provider gateway abstraction، pgvector وhybrid retrieval | فصل دورة تطوير AI عن نواة المحادثات؛ اختيار الموديل بعد evals لا بالشعبية |
| durable workflows | Temporal في مرحلة AI/الموافقات والتكاملات متعددة الخطوات | لا نستخدم history واحدًا لكل مستلمي حملة مليونية؛ النقل الكثيف مسؤولية dispatch queues |
| التشغيل | Containers، Helm/Kubernetes عند توفر فريق تشغيل، IaC، OpenTelemetry، Prometheus/Grafana | Compose للتطوير والعرض فقط؛ HA وتوسع workers بناءً على عمر الصفوف وحمل DB |

هذه **قرارات هندسية مقترحة** وليست وصفًا لـChatwoot. توثيق RabbitMQ يؤكد الحاجة لتصميم يؤخذ فيه فقد الاتصال وإعادة التسليم بالحسبان؛ quorum لا يعوض غياب idempotency. [RabbitMQ reliability](https://www.rabbitmq.com/docs/reliability)، [quorum queues](https://www.rabbitmq.com/docs/quorum-queues).

### خريطة التشغيل

```text
Meta webhooks ──► Ingress + signature verification ──► Durable event inbox (Postgres)
                                                          │
                                                    Inbound workers
                                                          │
Agent UI ◄──► API / permissions / conversation core ◄───────┘
    ▲                         │ transaction
    │                         ▼
    └── Realtime gateway ◄── Outbox relay ──► RabbitMQ
                                             ├─ interactive sends → channel adapters → Meta
Campaign planner → recipient ledger ─────────┼─ campaign sends → fair scheduler → Meta
                                             ├─ CRM/webhook/export workers
                                             └─ AI/workflow workers (later)

Postgres = source of truth · Object storage = media · Redis/Valkey = ephemeral/cache
Search/analytics = derived views · Monitoring = traces, lag, errors, cost, saturation
```

نجعل modules واضحة داخل codebase واحد، ثم ننشر أدوار workers منفصلة. عدد العمليات المنشورة لا يفرض عشرات قواعد البيانات. فصل خدمة جديدة يكون عند وجود bottleneck أو ownership أو fault-isolation يبرره، لا لمجرد كبر طموح المشروع.

### مسار inbound الآمن

1. استقبال raw body بحجم محدود، التحقق من توقيع القناة، استخراج كل عناصر batch دون افتراض أول عنصر فقط.
2. تحديد اتصال القناة من identifiers موثقة وربطها بشركة؛ لا نثق في tenant_id يأتي من المتصل الخارجي.
3. حفظ event envelope أو batch journal في تخزين durable ثم ACK سريع؛ لو فشل الحفظ لا نرجع نجاحًا.
4. worker يطبع payload إلى schema داخلية versioned، ويعزل event غير المدعوم بدل إسقاطه أو تعطيل الباتش كله.
5. dedupe بمفتاح معناه خاص بالقناة والحدث؛ status event له مفتاح يشمل message/status/event-time أو event-ID موثوق، وليس message ID وحده.
6. transaction تحفظ الرسالة/receipt والتغييرات وoutbox، ثم ACK للـbroker. إعادة التشغيل آمنة بعد crash.
7. realtime/search/integrations تنطلق من outbox؛ يفصل ذلك وصول العميل عن تعطل Odoo أو AI.

إذا تكرر raw batch أو تغير ترتيبه، تظل dedupe لكل normalized event مستقلة. watermark وcursor داخليان لا يفترضان ترتيبًا عالميًا من Meta. لا نحفظ media داخل الصفوف أو الـqueue payload.

### مسار outbound والحالة المجهولة

API يقبل الأمر بعد authorization وvalidation ويخزن message command مع idempotency record وoutbox في transaction واحدة؛ يرجع **202 Accepted** مع resource قابل للاستعلام. worker يتحقق مرة أخرى من أهلية القناة والعميل والنافذة والملكية والميزانية ثم يرسل.

الحالات الداخلية المقترحة: `queued → dispatching → provider_accepted → sent → delivered → read`، مع مسارات `rejected / retry_scheduled / failed / skipped / cancelled / outcome_unknown`. ليست كلها ترتيبًا رقميًا واحدًا؛ نحتفظ بالتاريخ والأزمنة، ونعرف precedence صريحًا للأحداث المتأخرة. إخطار failed بعد delivered لا يمحو دليل التسليم؛ يُسجل كتناقض للتحقيق.

**لو provider قبل الرسالة ثم ضاع الرد قبل حفظ wamid، فالإعادة قد ترسل نسخة ثانية.** لذلك لا ندّعي exactly-once عبر Meta. نصنف الحالة `outcome_unknown`، ونحاول المصالحة إذا كان المزود يتيح correlation/status lookup موثوقًا؛ وإلا تبقى حالة تحتاج قرارًا واضحًا. نعيد تلقائيًا فقط عند خطأ يثبت عدم الإرسال أو عند idempotency مضمونة في ذلك adapter. queue وTemporal لا يخلقان ضمانًا لا يوفره النظام الخارجي. [Meta send/status API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)، [Temporal idempotency](https://temporal.io/blog/idempotency-and-durable-execution).

### محرك الحملات

الحملة لها **نسخة جمهور ثابتة** ونسخة template/variables وموافقات ووقت وتكلفة تقديرية. أي تعديل مؤثر يبطل الموافقة. نستخرج IDs على دفعات قصيرة بـkeyset pagination، ونخزن recipient ledger؛ لا ننشئ مليون Promise أو مليون object بالذاكرة.

dispatcher يوازن الشركات ثم الأرقام ثم نوع الإرسال. فصل pools للـinteractive والـcampaign مع حصة مشتركة للقناة يمنع ازدحام inbox ويحترم quota مشتركة. internal interactive reservation مبدئيًا 20% قابلة للتعديل والاستعارة عند الخمول؛ هذه سياسة تشغيلنا وليست حد Meta. وزن الشركات وحدود max-in-flight تمنع شركة واحدة من احتكار workers أو database connections.

قبل الإرسال الفعلي نعيد فحص suppression/consent/template/channel/budget وpause-version. الإلغاء يوقف الأعمال التي لم تُرسل، ولا يسترجع طلبًا خرج للشبكة. نظهر outstanding in-flight ومجهول النتيجة، ونحدد متى تصبح حالة cancelled نهائية. لا يعني اكتمال dispatch اكتمال التسليم؛ نعرض `dispatch_completed` مع receipts تتحدث لاحقًا.

## ٧. البيانات والعزل والصلاحيات

### الكيانات الأساسية

| المجموعة | الجداول/الكيانات |
|---|---|
| tenancy | tenants، users، memberships، teams، team_members، roles، permissions، inbox_members |
| channels | channel_connections، credential_refs، inboxes، channel_capabilities، templates، template_versions |
| contacts | contacts، external_identities، identity_aliases، contact_attributes، consents، suppressions، segments |
| conversations | conversations، participants، messages، attachments، message_receipts، assignment_events، notes |
| delivery | inbound_events، outbox_events، send_commands، delivery_attempts، idempotency_keys، dead_letters |
| campaigns | campaigns، campaign_versions، audience_snapshots، campaign_recipients، approvals، budget_reservations |
| integrations | integrations، field_mappings، external_object_links، sync_cursors، sync_jobs، webhook_subscriptions/deliveries |
| operations/AI | automation_versions/runs، sla_events، audit_events، usage_ledger، ai_runs، knowledge_sources/chunks، tool_approvals |

كل كيان مملوك لشركة يحمل `tenant_id`؛ المستخدم global لكن العضوية والصلاحيات tenant-scoped. `contact_id` داخلي ثابت، بينما external identity تحتوي provider + scope type/id + external id + validity interval. phone وusername attributes قابلة للتغيير. دمج identities يحتاج دليلًا وتاريخًا قابلًا للتراجع؛ لا نستخدم fuzzy matching تلقائيًا بين جهات اتصال حساسة.

قيود مهمة: composite FK مثل `(tenant_id, conversation_id)` إلى `(tenant_id, id)`، uniqueness لهوية القناة ضمن scope، uniqueness لأمر إرسال داخلي، ولـrecipient ضمن campaign version والجمهور، ولكل provider event حسب عقده. فصل identity registry غير المقسم زمنيًا عن جداول الرسائل المقسمة يحافظ على dedupe عابر للأشهر. Postgres partitioned unique constraints تحتاج اشتمال مفاتيح التقسيم؛ لا نفترض global unique index على partitions. [Postgres partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html).

### Tenant isolation

نطبق RLS في Postgres مع `USING` و`WITH CHECK`، runtime role ليس owner أو superuser ولا BYPASSRLS؛ وFORCE RLS حيث يلزم. tenant context transaction-local وتُعاد تهيئته مع connection pool. workers والتصدير وsearch وcache keys وobject paths وWebSocket subscriptions تخضع لنفس الحدود. RLS طبقة دفاع فوق authorization، ولا تمنع وحدها تسريبًا من index أو cache أو log. [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

نبدأ shared database بعزل منطقي قوي. خيار dedicated database/deployment لشركة كبيرة أو متطلبات إقامة بيانات يظل مدعومًا عبر tenant placement registry. الانتقال إلى cells/shards لا يبدأ قبل قياسات فعلية، وخطة نقل تحفظ cursors والـin-flight sends وcredentials وidempotency.

### مصفوفة الصلاحيات المقترحة

| الفعل | Owner/Admin | Supervisor | Agent | Campaign Manager | Analyst | Developer |
|---|---|---|---|---|---|---|
| إدارة شركة ومستخدمين | نعم حسب delegation | فريقه فقط إن مُنح | لا | لا | لا | لا |
| قراءة محادثة | ضمن الشركة والسياسة | فرق/inboxes محددة | المسموح له | لا افتراضيًا | بيانات مجمعة افتراضيًا | عبر scopes فقط |
| الرد/التعيين | حسب صلاحية inbox | نعم ضمن نطاقه | ضمن نطاقه | لا افتراضيًا | لا | messages:write إذا مُنح |
| إعداد حملة | نعم | إن مُنح | لا | نعم | لا | campaigns:write إذا مُنح |
| اعتماد/إطلاق حملة | permission مستقل | إن مُنح | لا | لا يعتمد حملته الحساسة بنفسه | لا | منفصل عن الإنشاء |
| تصدير جهات الاتصال | permission مستقل | إن مُنح | لا افتراضيًا | إن مُنح | إن مُنح | contacts:export مستقل |
| إدارة الأسرار والقنوات | permission مستقل | لا افتراضيًا | لا | لا | لا | مدير اتصال مخول فقط |
| استعراض audit/analytics | نعم وفق النطاق | فريقه | نشاطه عند السماح | حملاته | مجمع | deliveries الخاصة بتكامله |

دور Platform Operator منفصل عن مدير الشركة: يدير الحالة التشغيلية والاشتراكات؛ قراءة المحادثات ليست تلقائية. وصول الدعم الاستثنائي يكون محدود المدة ومسببًا ومؤرخًا. إخفاء زر لا يُعتبر حماية؛ المنع يجب أن يمر في API وworker وsocket. تهديدات BOLA/BFLA وresource consumption وSSRF جزء من مراجعة الأمان. [OWASP API Security](https://owasp.org/API-Security/editions/2023/en/0x11-t10/).

## ٨. API والتكامل مع Odoo

عقدنا API-first على `/api/v1`، OpenAPI مثبتة النسخة التي تدعمها الأدوات بعد التحقق؛ لا يلزم اعتماد أحدث minor لمجرد وجوده. الـAPI الذي تستخدمه الواجهة يستند إلى نفس domain services التي تستخدمها المفاتيح والتكاملات. [OpenAPI specification](https://spec.openapis.org/oas/latest.html).

| أمثلة المسارات | السلوك المطلوب |
|---|---|
| GET /tenants/{t}/conversations?cursor=… | فلاتر موثقة، حد أعلى للصفحة، ترتيب ثابت بـtimestamp وID |
| POST /tenants/{t}/conversations/{id}/messages | Idempotency-Key، 202، command/message ID؛ منع private note على provider |
| PATCH /tenants/{t}/conversations/{id} | optimistic concurrency عبر version/If-Match؛ 409 عند تعارض حقيقي |
| POST /tenants/{t}/conversations/{id}/handoffs | انتقال ملكية موثق وحالة pending/confirmed |
| GET/POST /tenants/{t}/contacts | validation، external identity mapping، dedupe scoped |
| POST /tenants/{t}/campaigns/{id}/validate | تقرير audience/template/consent/budget قابل للمراجعة؛ بلا إرسال |
| POST /tenants/{t}/campaigns/{id}/launch | يفحص version والموافقات؛ 202 ويمنع double launch |
| POST /tenants/{t}/campaigns/{id}/pause أو cancel | command idempotent؛ يوضح in-flight |
| GET /tenants/{t}/campaigns/{id}/recipients | cursor/status filters وfailure reasons؛ export async |
| GET/POST /tenants/{t}/integrations | فحص اتصال، field mapping، secret references |
| POST /tenants/{t}/exports | job + download مؤقت؛ لا يبقي HTTP مفتوحًا لملف ضخم |
| GET /operations/{id} | حالة العملية ونطاق authorization مطابق للكيان الأصلي |

الخطأ يحتوي `code/message/request_id/details` دون أسرار؛ 401 للهوية، 403 للمنع، 404 حسب سياسة إخفاء الموارد، 409 للتعارض، 422 للمدخلات، 429 مع Retry-After للحدود، و503 للاعتمادية. idempotency scope يشمل tenant/principal/operation/key؛ نفس المفتاح ونفس payload يعيدان نفس resource، payload مختلف يرجع conflict. retention للمفتاح يغطي عمر العملية وأفق retries الموثق، ولا نفقد الحماية في عملية طويلة.

Webhook صادر: event_id وschema_version وoccurred_at وtenant resource، توقيع HMAC على timestamp + raw body، تدوير سرين أثناء الانتقال، retries مع jitter وحد أقصى، DLQ وreplay UI. retries تستعمل نفس event_id. المستقبل مسؤول عن dedupe، ونشرح ذلك بأمثلة. Endpoint registration يحمي من SSRF وDNS rebinding والشبكات المحلية غير المصرح بها؛ عنوان CRM داخلي مسموح فقط عبر connector/egress policy صريحة، وليس باستثناء شامل.

### Odoo

نكتب adapter حسب الإصدار وطريقة الاستضافة. Odoo 17 توثق external RPC/API keys، وOdoo 19 أضافت JSON-2. لا نرسل عقد 19 إلى 17. توافر external API في عروض Odoo السحابية مرتبط بالخطة؛ نفحص deployment الفعلي ولا نعمم اشتراك SaaS على installation self-hosted. [Odoo 17 API](https://www.odoo.com/documentation/17.0/developer/reference/external_api.html)، [Odoo 19 JSON-2](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html).

| بيانات | مصدر الحقيقة المقترح | اتجاه التدفق |
|---|---|---|
| consent وسجل المحادثة | CONVO | لا يسمح CRM قديم بإعادة تفعيل انسحاب |
| lead وstage وsales owner | Odoo | عرض في inbox وتحديث عبر أمر مخول |
| order/invoice status | Odoo | قراءة/cache قصيرة مع وقت آخر مزامنة |
| contact name/email/phone | policy لكل field | mapping صريح؛ آخر تعديل وحده لا يحل كل تعارض |

هوية الربط `(tenant, integration, model, external_id)` تمنع إنشاء CRM object جديد في كل retry. نبدأ contact lookup/create lead وعرض order مع audit؛ عمليات بيع/تعديل مالي لها صلاحيات وموافقات منفصلة. نستخدم cursor `(write_date,id)` مع overlap وdedupe حيث لا توجد events مناسبة، أو module webhook موثق عند الحاجة. outage Odoo يظهر «تعذر التحديث» ويؤجل المهمة دون فقد الرسائل. نمنع sync loops بـorigin/correlation/version ونوفر conflict queue وreplay لا يكرر الأثر.

## ٩. AI agent وHuman in the loop

هدف latency المبدئي: قرار handoff محلي p95 أقل من ثانية حين لا يوجد إرسال جارٍ؛ مسودة رد AI p95 أقل من 8 ثوانٍ على golden workload؛ مهلة مطلقة 15 ثانية بعدها fallback واضح. هذه أهداف مقترحة تحتاج قياسًا، ويتحدد اختيار الموديل والاستضافة بناءً عليها.

نبدأ بـcopilot يقترح ويلخص، ثم intent routing، ثم bot في intents محددة. inference وretrieval لا يعملان داخل request استقبال webhook. PydanticAI يوفر typing للأدوات والمخرجات، وTemporal للتنفيذ طويل العمر؛ كلاهما لا يحل authorization أو idempotency نيابة عنا. [PydanticAI](https://pydantic.dev/docs/ai/overview/)، [Temporal](https://temporal.io/blog/idempotency-and-durable-execution).

ملكية المحادثة explicit: `bot_active / handoff_pending / human_active / bot_paused` مع `owner_version`. عند takeover نوقف queued AI outputs ونرفع version، ونمرر كل إرسال لنفس per-conversation dispatch gate. الرد الناتج من سياق قديم يُلغى. إذا كان طلب خارجي خرج بالفعل، نعرض handoff pending وحالة الطلب حتى drain/reconciliation؛ لا ندّعي استرجاع ما قبلته Meta. لا نعلن takeover confirmed قبل اجتياز الحاجز الذي يمنع dispatch جديدًا من المالك السابق. استئناف البوت فعل مخول وصريح، لا يحدث بمجرد مرور وقت أو وصول رسالة جديدة.

نموذج respond.io موثق في توقيف ردود AI عند takeover والحاجة لإعادة إسناد لاستئنافه؛ نأخذ سلوك المستخدم مرجعًا ونبني ضمانات التزامن داخل خدمتنا. [respond.io AI Agents](https://respond.io/help/ai-agents/getting-started-with-ai-agents).

الأدوات مثل lookup-order/create-lead تعمل بهوية خدمة محددة الشركة والنطاق. الـLLM لا يختار tenant_id ولا يملك API key واسعًا ولا ينفذ SQL عشوائيًا. أي إجراء خارج سياسة التشغيل المسموحة يمر على موافقة بشرية مربوطة بالـarguments hash والـversion ومدة صلاحية؛ تغيير البيانات يبطل الموافقة. فشل AI أو retrieval لا يمنع العميل من الوصول لموظف.

للمعرفة العربية: نحفظ النص الأصلي، ونسخة normalized للبحث، ونستخدم dense + lexical retrieval مع Arabic analyzer، ثم fusion/reranking وفلترة tenant/source permissions قبل وصول النص إلى الموديل. لا نطبق normalization المدمر على الأسماء والمعرفات الأصلية. نقيس recall والنفي والأرقام والأسماء ولهجة مصرية وخليجية وcode-switching. pgvector نقطة بداية داخل Postgres، وOpenSearch للبحث اللغوي عندما يتطلبه اختبار الاسترجاع. [pgvector](https://github.com/pgvector/pgvector)، [OpenSearch Arabic analyzer](https://docs.opensearch.org/latest/analyzers/language-analyzers/arabic/).

مجموعة قبول AI مبدئية 300 حالة labeled تشمل 100 مصرية/عربية فصحى و60 خليجية و60 إنجليزية و40 مختلطة و40 adversarial؛ التقسيم **مقترح** يتغير مع بيانات الجمهور. كل تغيير موديل/prompt/retrieval يعيد الاختبار. نقيّم دقة الأداة والحجج والمصادر وقرار التصعيد وتسريب البيانات ومخرجات غير مدعومة. لا يكفي confidence يذكره الموديل عن نفسه. «عدم التحيز» يعني أيضًا فحص اختلاف الأداء بين اللهجات واللغات بأمثلة متوازنة، وليس وعدًا بأن الموديل خالٍ من كل bias.

## ١٠. السعة والاعتمادية والتكلفة

### أرقام تصميم قابلة للتعديل

الأرقام التالية **سيناريوهات اختبار اصطناعية وليست نتائج تحققت أو حدودًا معلنة للمنتج**. «رسالة» تعني inbound/outbound business message؛ webhook/status events لها عدد مستقل.

| المستوى | المستخدمون المتزامنون | حجم رسائل يومي افتراضي | معدل events للاختبار | سيناريو حملة |
|---|---:|---:|---:|---|
| Pilot | 100 | 100 ألف | 100 event/s مستمر | 100 ألف recipient |
| Target | 1000 | 1 مليون | 1000 event/s لـ60 دقيقة + 3000 event/s لـ10 دقائق | مليون recipient لكل حملة، و20 حملة عبر شركات مختلفة |
| Growth | 1000–3000 | 10 ملايين | 3000 event/s مستمر + 10000 event/s burst | عدة ملايين، بعد إثبات target وإعادة capacity planning |

ألف session قد تعني أكثر من ألف socket بسبب التبويبات؛ نختبر 2000 socket أيضًا، وreconnection storm. workload الموظفين: متوسط فعل كل 5 ثوانٍ يعطي 200 API request/s قبل الأتمتة؛ نختبر مزيج قراءة/كتابة واقعي وفلاتر مختلفة وtenant skew. تختبر الحملة مع replay status events وmedia بنسبة ممثلة، لا بعشرة requests مكررة على cache ساخنة.

مثال حسابي: مليون رسالة/يوم ≈ 11.57 رسالة/ثانية متوسطًا؛ 10 ملايين ≈ 115.74. الذروة قد تكون أكبر كثيرًا. حملة مليون مستلم على سعة نظرية 80 رسالة/ثانية تحتاج على الأقل **3 ساعات و28 دقيقة و20 ثانية**، وعند 1000 تحتاج **16 دقيقة و40 ثانية**، قبل الوارد والحصص والـpacing. توزيع الحمل على أرقام portfolio واحد لا يلغي حصة ذلك portfolio. [مرجع معدل الرقم](https://docs.aws.amazon.com/social-messaging/latest/userguide/increase-message-throughput.html).

التخزين مثال معلن الافتراض: مليون رسالة × 2KB metadata = نحو 2GB/يوم، أو 60GB/30 يومًا قبل indexes وWAL والنسخ. 5% مرفقات بمتوسط 0.5MB = 25GB/يوم أو 750GB/30 يومًا. عند 10 ملايين نضرب هذه الأرقام في 10. نضيف receipts/attempts والنسخ الاحتياطية والتكرار ونقيس نسبة overhead فعليًا؛ لا نشتري خادمًا بناءً على حجم نص الرسالة فقط.

### أهداف إطلاق مقترحة

| القياس | الهدف المقترح | حد القياس |
|---|---|---|
| API availability | 99.9% شهريًا في البداية | عملياتنا الصحيحة؛ نفرق عطلنا عن رفض المزود ونظهر كليهما |
| API latency | read p95 ≤300ms؛ command accept p95 ≤500ms | عند target workload مع قياس p99 أيضًا |
| Webhook ACK | p95 ≤200ms، p99 ≤1s | بعد durable acceptance، وليس مجرد push إلى ذاكرة |
| Inbound visible | p95 ≤2s من استلام event عندنا | لا يشمل تأخر provider قبل وصوله |
| Interactive dispatch | p95 ≤1s في السعة المتاحة | rate-limited يظهر queued مع السبب، لا يدخل كنجاح سريع زائف |
| Integrity | صفر فقد أعمال أُقرت داخل failure tests؛ صفر tenant leaks | ضمان داخل سيناريوهات الاختبار وحدود failure domain المعلنة |
| Recovery | RPO ≤5min وRTO ≤60min لفقد الموقع في البداية | تُثبت باستعادة فعلية؛ HA داخل الموقع له هدف مختلف |
| Error budget | نحو 43.2 دقيقة/30 يومًا عند 99.9% | سياسة إيقاف توسعات خطرة عند استهلاكه |

لا نعد RPO=0 لكارثة موقع مع replication غير متزامن. وللحصول على ضمان أقوى يجب تغيير replication والـack boundary وتحمل تكلفة latency والتشغيل. HA proposal يبدأ replicas متعددة للـAPI والـworkers، broker quorum موزع على 3 failure domains عند توفرها، Postgres HA وPITR، object versioning، واختبار restore. لا نحدد حجم CPU/RAM نهائيًا قبل benchmark على نفس نوع الأقراص والشبكة.

autoscaling يتابع queue age وin-flight وCPU/memory وDB pool pressure؛ زيادة workers دون حدود يمكن أن تسقط DB. raw events وreceipts قابلة للتقسيم والـretention؛ reports الثقيلة تذهب read models أو analytics store بعد القياس. metrics العادية لا تحمل labels ذات cardinality انفجارية لكل contact/message؛ التفاصيل في traces وlogs scoped.

التكلفة = بنية HA + تخزين/نسخ/egress + رسوم القنوات + AI inference/embedding + مراقبة + صيانة/on-call + اشتراكات/تراخيص إن وجدت. نربط budget reservations والإرسال بمصالحة usage ledger؛ الحملة تعرض estimate versioned لا فاتورة نهائية. لا توجد تسعيرة إجمالية موثوقة قبل معرفة البلدان ومزيج القوالب والحجم والاستضافة.

## ١١. الاختبار: من شرط «كل سطر وكل function» إلى بوابات حقيقية

المطلوب في الـprompt: **100% line وfunction coverage لكل executable first-party source**، و100% branch coverage للـcritical domain modules، مع هدف ≥95% branches عام. الاستثناءات فقط generated/vendor/type declarations أو مسارات ثبت استحالة بلوغها مع سبب ومراجعة صريحة. أي سطر executable مستثنى يُعرض؛ لا نغير thresholds لتجميل النتيجة. نسبة coverage العالية وحدها لا تثبت صحة business logic، لذلك نضيف mutation/property/concurrency/contract/load tests.

| المجال | حالات يجب إثباتها |
|---|---|
| Tenant isolation | شركتان وثلاث هويات وصلاحيات متغيرة؛ API/list/search/export/socket/media/RAG/cache/jobs؛ منع IDOR وmass assignment |
| Webhooks | توقيع صحيح/خاطئ/مفقود، raw body مختلف، oversized payload، batched entries، duplicates، reordered receipts، unsupported event |
| Transaction safety | crash قبل commit وبعد commit وقبل broker confirm وبعد send قبل حفظ الرد؛ broker redelivery؛ DB failover |
| Message state | read قبل delivered؛ duplicate failed؛ incoming/echo لنفس event؛ reply window تنتهي أثناء الانتظار |
| Campaigns | double launch، نفس recipient مكرر، opt-out بعد الجدولة، template paused، variable ناقص، ميزانية مستنفدة، pause/resume/cancel أثناء العمل |
| Fairness | شركة كبيرة مقابل شركات صغيرة، كل الحملات على رقم واحد، quotas مشتركة، نفاد resources، response traffic أثناء batch pressure |
| Assignment/handoff | موظفان يتسلمان معًا، bot reply متأخر، takeover أثناء provider request، resume صريح، حذف/إلغاء عضوية أثناء عمل job |
| CRM | 429/5xx/timeout، replay، duplicate create، mapping conflict، حذف سجل، فرق timezone، loop prevention، Odoo17 و19 كل بعقده |
| Security | token leak، XSS عبر نص ومرفق، SSRF عبر webhook/CRM URL، CSRF عند cookies، CSV injection، أذونات مرفقات وaudit |
| UI | كل شاشة وكل فعل وكل error/empty/loading/offline/permission-denied state، RTL/LTR، bidi، keyboard/focus، 200% zoom |
| Performance | target mix وsoak وburst وreconnect storm، tenant skew، بيانات كبيرة وفهارس حقيقية، queue drain وعدّ الأعمال |
| Recovery | backup restore وفقد worker/broker/DB وتأخر object store، رجوع التشغيل دون blind replay أو فقد suppression |
| AI | تهديد injection من العميل/المعرفة، cross-tenant retrieval، أداة ممنوعة، سقف تكلفة، timeout، hallucination، تفاوت لهجات |

أدوات مقترحة: Vitest/Jest مع توحيد اختيار واحد لكل package، Testing Library، Playwright، Testcontainers، property tests، mutation tool مناسب للغة، k6، dependency/secret scans وDAST على staging. اختبارات integration تستخدم Postgres وbroker حقيقيين؛ mock providers للحمل الاصطناعي وfixtures موثقة، ثم contract/smoke tests محدودة على حسابات رسمية مخصصة للاختبار. لا تُرسل حملات ضغط حقيقية إلى عملاء. k6 thresholds يجب أن تُفشل CI، لا مجرد check أخضر بجانب طلب HTTP. [k6 thresholds](https://grafana.com/docs/k6/latest/using-k6/thresholds/).

CI على كل تغيير: format/lint/types → unit/property/coverage/mutation critical → DB/integration/contracts → frontend build/E2E/a11y → security gates. اختبارات الضغط الطويلة والاستعادة قبل release وعلى schedule تشغيل متفق عليه، لا نعيد 24 ساعة soak على كل تعديل لون. تستهدف mutation score ≥90% في critical modules، مع مراجعة surviving mutants بدل كتابة assert يكرر implementation.

Definition of Done لكل ميزة: requirement ID، contract، UI، persistence، authorization، failure paths، tests، observability، docs، migration/rollback. no-op buttons ونجاح mock غير المعلن وTODO داخل مسار production تمنع إعلان الاكتمال. نُسلّم تقرير test commands والـSHA والبيئة والحجم والنتائج وما تعذر؛ «صفر أخطاء معروفة بعد هذه الاختبارات» عبارة دقيقة، أما «مستحيل يحصل bug» فليست قابلة للإثبات.

## ١٢. التصميم المعتمد: مراجع Figma وDribbble، دون صور مولدة

**تحديث حسب توجيه إياد:** تم رفض اتجاه الصور المولدة. لا تُستخدم كـreference ولا كـUI specification. التنفيذ المطلوب يعتمد على مرجع Figma الفعلي، مع الاستفادة من مراجع Dribbble التالية في توزيع المعلومات. لا يوجد ملف Figma جديد منشأ أو تصميم نهائي معتمد بعد.

| المرجع | ما تمت مراجعته | كيف نستخدمه |
|---|---|---|
| [Customer Support Chat Dashboard UI — Rashmi](https://www.figma.com/community/file/1514208352310179359/customer-support-chat-dashboard-ui-saas-admin-panel) | صفحة الملف والـpreview فُحصا بصريًا؛ تعرض CC BY 4.0 وقت الفحص | **المرجع الأول**: navigation دقيقة، filters، قائمة chats، conversation، details/notes؛ محتوى العمل هو البطل |
| [Customer Support Dashboard UI Kit — Silverthread Labs](https://www.figma.com/community/file/1502557663697104018/customer-support-dashboard-ui-kit) | ظهر في نتائج Community؛ لم نفحص كل frames | مرجع ثانوي محتمل للمكونات؛ لا ندّعي استخراج tokens منه |
| [Customer Support Responsive UI](https://www.figma.com/community/file/1467454631293042205/customer-support-responsive-ui) | ظهر في نتائج Community فقط | استكمال دراسة responsive في مرحلة التنفيذ |
| [Unified Inbox — Arafat Ovi](https://dribbble.com/shots/27539689-Unified-Inbox-Omnichannel-Customer-Support-Dashboard-CXM-SaaS) | صفحة وpreview فُحصا بصريًا؛ المصمم يذكر RTL Arabic | profile context وchannel filtering وسرعة الانتقال بين المحادثات |
| [Cosmo — Royhan Darmawan / Flow Forge](https://dribbble.com/shots/26783582-Cosmo-Customer-Support-Dashboard-Unified-Inbox) | الصفحة والوصف المنشور | وضوح الرسائل والـassignee وquick replies |
| [Closr — Filllo](https://dribbble.com/shots/27322893-CRM-Unified-Inbox-UI-Email-Management-for-Sales-Teams-Closr) | الصفحة والوصف المنشور | فلاتر الملكية والأولوية ومعلومات CRM داخل الصف |

مرجع Figma الأساسي يعرض مساحة عمل فاتحة بكثافة عملية، وخطوط فصل رفيعة، وألوان فعل محدودة. لا نفرض عليه ألوان petrol والصور السابقة. قبل coding نفتح frame الفعلي ونوثق dimensions وspacing وtype scale وradii والألوان المرصودة؛ إذا تعذر inspect للـnodes نميز القيم المقدرة عن المقاسة، ولا ندّعي pixel-perfect. تُحفظ attribution للمرجع عند الاقتباس/التكييف وفق ترخيصه؛ Dribbble إلهام للتنظيم وليس إذن إعادة توزيع أصول المصمم.

### الشاشة المرتبطة بالوظيفة

| الشاشة | تفاصيل UX التي يجب تنفيذها | الربط الخلفي |
|---|---|---|
| Inbox | فلاتر ownership/status/channel، قائمة virtualized، chat history، private note composer، profile drawer، handoff banner، keyboard shortcuts | conversation/message/query + scoped realtime + ownership version |
| Contacts | search/segments، attributes، identities، consent، merge review، import progress/errors | contacts/imports/consents/identity registry |
| Campaigns | جدول واضح، wizard: audience → template → schedule/budget → review → launch؛ recipients والأخطاء وتقدم dispatch والتسليم | versioned campaign + ledger + async commands |
| Channels/Inboxes | connection state، permission gaps، reconnect، assigned inbox/teams، health diagnostic | adapters + encrypted credentials + capabilities |
| People & Roles | members/invites/teams، role matrix ونطاق inbox، آخر نشاط | IAM + audit + session revocation |
| Integrations | Odoo connection، field mappings، source of truth، history/replay/conflicts | adapter jobs/cursors/object links |
| Automations | visual rules، draft/published، simulation trace وتاريخ نسخ | bounded durable runs |
| AI & knowledge | مصادر وحالتها، test console، scope وأدوات مسموحة، handoff rules، budgets، eval report | isolated retrieval/AI services |
| Analytics | أوقات رد/حل، backlog/SLA، أداء حملات مع تعريف denominator، وقت تحديث البيانات | derived read models |
| API & Webhooks | scopes، إنشاء مفتاح مرة واحدة، rotation، events/test deliveries، replay permissions | integration identity + delivery logs |

RTL حقيقي باستخدام logical CSS؛ الأرقام والهاتف والمعرفات داخل bidi isolation، وليس قلب screenshot فقط. عند عرض ضيق نطوي contact panel ثم نستبدل قائمة المحادثات بـdrawer؛ الهاتف يركز على محادثة واحدة. accessibility تستهدف WCAG 2.2 AA مع contrast وfocus وkeyboard وscreen-reader وتكبير، وتُختبر عمليًا. [WCAG 2.2](https://www.w3.org/TR/WCAG22/).

## ١٣. ترتيب التنفيذ وبوابات الانتقال

| المرحلة | الناتج | شرط الانتقال |
|---|---|---|
| P0 Discovery freeze | ADRs، threat model، load profile، المرجع البصري، capability matrix، Graph/Odoo contracts | كل افتراض معلن، وإصدار كل dependency مثبت |
| P1 Foundation | tenancy/IAM/schema/migrations/OpenAPI/CI/dev environment | اختبارات عزل tenant وصلاحيات تمر قبل CRUD الموسع |
| P2 Vertical slice | WhatsApp inbound → inbox → رد → receipt + realtime | الرحلة كاملة مع DB/broker حقيقيين وحساب اختبار للقناة |
| P3 Social/contacts | Messenger/Instagram وcontact model/imports | app permissions + contract tests + identity fixtures |
| P4 Campaign engine | audience snapshots، dispatch، budgets، pause/replay | target load + fairness + crash/unknown outcomes |
| P5 Integrations | Odoo وpublic API/webhooks/export | idempotent side effects وconflict handling |
| P6 Operations | routing/SLA/rules/reports/CSAT | business-clock/automation-loop tests |
| P7 AI | copilot ثم autonomous intents + handoff/RAG | golden set + side-effect policy + takeover barrier |
| P8 Hardening | HA/DR/security/accessibility/SSO/usage | staging release report وrestore drill وrunbooks |
| P9 Expansion | بقية القنوات والقدرات ذات الأولوية | capability-specific discovery واختبارات لكل adapter |

تقدير تخطيطي غير تعاقدي: فريق ثابت يضم backend/infra وfrontend وQA automation وproduct/design قد يحتاج عدة أشهر للوصول إلى إطلاق واسع؛ مثل 4–6 أشهر لنسخة أساسية قوية و9–12+ شهرًا لنطاق واسع مع AI وعمليات مؤسسية، حسب حجم الفريق وخبرته والتصاريح. لا نربط App Review بموعد نتحكم فيه. لا يكفي prompt واحد ليجعل كل هذه المراحل مكتملة في جلسة؛ دوره فرض التنفيذ المرحلي والأدلة وعدم إسقاط المتطلبات.

## ١٤. حدود البحث والقرارات التي ما زالت مفتوحة

المكتمل: مقارنة 9 منتجات بمصادرها الرسمية، فحص ملفات Chatwoot المثبتة، مراجعة قواعد Meta المتاحة ومصادر BSP عند التعذر، نموذج معمارية وبيانات وصلاحيات وAPIs، تصور سعة، قائمة features واختبارات، ومراجع تصميم فعلية.

المتبقي قبل release: العدد الفعلي للشركات والـactive users، نمط bursts وmedia/retention، بلد الإقامة والميزانية وفريق التشغيل، خطط Odoo وإصداراته، أصول Meta والتصاريح والحدود الفعلية، وتقرير أداء على staging. بعض صفحات Meta رجعت login/429؛ exact Embedded Signup version وBSUID fields والتسعير المقبل تبقى gates للتحقق بحساب الشركة. Intercom لديه تعارض وثائقي في marketing؛ لا نعتمد عليه لقرار broadcast.

لم تُبنَ منصة production في هذه المرحلة، ولم تُنفذ اختبارات حمل أو إرسال فعلي أو إعداد حسابات خارجية. الصور المولدة المستبعدة لا تدخل التسليم. الأدلة تحدد ما يمكن البناء عليه؛ أرقام السعة وSLOs والـstack ومراحل التنفيذ قرارات مقترحة قابلة للاختبار.

توقف البحث بعد تغطية قرارات المنتج والمعمارية بمصادر أولية أو قيود صريحة. الأسئلة الباقية تحتاج حسابات وإصدارًا وتجارب تشغيل، لا مزيدًا من قوائم المنافسين.
