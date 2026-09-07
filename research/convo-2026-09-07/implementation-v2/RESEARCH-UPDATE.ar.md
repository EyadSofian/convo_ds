# CONVO — تحديث البحث والقرارات التنفيذية

**التاريخ: 7 سبتمبر 2026.** هذا تحديث للمواصفات الموجودة في المشروع، وليس تقرير تشغيل تطبيق أو اختبار إرسال فعلي. تأكيد المستخدم الجديد: المنتج يدعم **SaaS لشركات متعددة وSelf-hosted لشركة واحدة**.

## ما وجدناه في المشروع

المجلد يحتوي على prompt سابق، تقرير بحث عربي ونسخة مرجعية من Chatwoot؛ لم نجد تطبيق CONVO منفذًا في الملفات التي فُحصت. احتفظنا بالـprompt والتقرير الأصليين دون تعديل، وبنينا نسخة v2 مستقلة.

- [الـprompt السابق](../EXECUTION-PROMPT.md).
- [التقرير البحثي السابق](../internal/report-source.md): يتضمن مقارنة تسعة منتجات، المعمارية المقترحة، Meta، Odoo، السعة وAI.
- [الـprompt المحدّث](MASTER-PROMPT.md).
- [بطاقات التنفيذ المرحلي](PHASE-PROMPTS.md).

الأرقام الموروثة، ومنها 1,000 مستخدم متزامن وحملات مليونية، **فرضيات اختبار** وليست سعة أثبتناها أو أرقامًا أعاد المستخدم تأكيدها في هذه المحادثة. أبقينا أيضًا نطاق Odoo وAI الموجود في المستند السابق، مع وضعهما بعد نواة الرسائل والحملات. لا توجد تجربة حمل أو نشر إنتاجي في هذا التسليم.

## مراجعة السوق: ما الذي يغيّر منتجنا؟

هذه ملاحظات عن مصادر الشركات الرسمية، وتفصل بين ما تقوله المصادر وقرار التصميم المقترح لمنتجنا. ليست benchmark مستقلًا أو توصية شراء قائمة على سعر البداية.

| المرجع | الملاحظة الموثقة | القرار داخل CONVO |
|---|---|---|
| respond.io — المستخدمون | يميز الأدوار ويتيح قيودًا إضافية؛ الوصول ليس اسم دور فقط. [User settings](https://respond.io/help/workspace-settings/users) | صلاحيات فعل + نطاق inbox/team + سياسة حقول؛ API يفرضها حتى لو تجاوز المستخدم الواجهة |
| respond.io — الحملات | يعرض الجمهور والقناة والحالة والتوقيت، ويفرق اكتمال محاولة الإرسال عن نجاح التسليم. كما أن تغيير حالة محادثة الدعم لا ينتج تلقائيًا من إرسال حملة. [Broadcasts overview](https://respond.io/help/broadcasts-module/broadcasts-overview) | شاشة حملة مرتبطة بسجل مستلمين ومحاولات؛ عدادات dispatch وdelivery منفصلة؛ reply هو الذي يفتح مسار الدعم |
| respond.io — تعديل الحملات | التوثيق المفحوص يقصر إلغاء الحملة على scheduled، لا in-progress. [Managing broadcasts](https://respond.io/help/broadcasts-module/managing-broadcasts) | نختار دعم إيقاف الأعمال التي لم تُرسل؛ لا ندّعي أنه سلوك منسوخ منه، ولا أن الطلب الخارج للمزود قابل للاسترجاع |
| Chatwoot — الحملات | الموقع يعرض live chat وWhatsApp templates وSMS campaigns. [Campaigns](https://www.chatwoot.com/features/campaigns) | لا نبني قرار المنتج على المعلومة القديمة بأن Chatwoot لا يملك WhatsApp campaigns |
| Chatwoot — الصلاحيات والاستضافة | الصلاحيات المخصصة لها حدود حسب الخطة، وصفحة self-hosted تميز CE وPremium وEnterprise. [Roles](https://www.chatwoot.com/features/roles-permissions)، [Self-hosted plans](https://www.chatwoot.com/pricing/self-hosted-plans) | نفصل وجود الميزة في التسويق عن وجودها في النسخة المستهدفة؛ بناء الصلاحيات عندنا له عقد مستقل |
| SleekFlow | الصفحة تميز inbox والحملات وworkflows، وتضع API/webhooks وRBAC ضمن Premium؛ رسوم الرسائل منفصلة، وعبارات الاستخدام غير المحدود تخضع لشروطه. [Pricing and features](https://sleekflow.io/pricing) | نفصل entitlements واستهلاك المنصة عن حدود Meta ورسومها؛ لا نعِد بإرسال غير محدود |

تمت إعادة فتح صفحة WATI أيضًا، لكن لم نعتمد سعرًا أو مصفوفة خطة منها في هذا التحديث؛ التفاصيل الموروثة في التقرير السابق ليست إعادة تحقق شاملة لكل خطة. المقارنة الأوسع محفوظة في التقرير السابق مع مصادرها وتاريخها.

**استنتاج التصميم:** Chatwoot مرجع مفيد لنموذج inbox/self-hosted، وrespond.io مرجع مفيد لتشغيل الحملات. متطلباتنا تجمع إدارة فرق وصلاحيات دقيقة وحملات موثوقة ونسختَي تشغيل؛ لا تكفي واجهة شبيهة بأحدهما لإثبات اكتمال المنتج.

## Meta: ما تأكد، وما يتطلب حسابًا فعليًا؟

### WhatsApp

السياسة العامة المفحوصة تشترط الإذن بالتواصل واحترام الانسحاب، وتحدد نافذة رد 24 ساعة، مع استخدام القوالب المعتمدة خارجها، وتطلب مسار تصعيد واضح عند الأتمتة. لذلك الاستيراد لا يساوي opt-in، وقرار الإرسال يحتاج إعادة تحقق عند التنفيذ. [WhatsApp Business Policy](https://whatsappbusiness.com/policy/).

مجموعة Meta الرسمية على Postman تعرض إرسال الرسائل وربط الاشتراك بالـWABA، لكنها تحتوي أيضًا أمثلة قديمة. تستخدم كمرجع للعمليات، ولا يُنسخ رقم إصدار قديم منها إلى الإنتاج. [Meta WhatsApp collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api).

ظهر إعلان رسمي عن Direct Send للرسائل الخدمية. لم نفحص أهلية حساب بعينه أو عقد API التفصيلي الخاص به، لذا لا نستخدمه لتجاوز السياسة العامة أو تعميم إرسال تسويقي بلا قوالب. يُفعّل فقط بعد تحقق مستقل. [Meta Direct Send video](https://developers.meta.com/resources/videos/whatsapp-direct-send-api/).

### Instagram

فتحنا توثيق Meta نفسه في المتصفح، بعد فشل جلبه بأداة الويب. الصفحة بعنوان Send Messages ومؤرخة 6 مايو 2026. تؤكد لمسار Instagram Login: حسابًا احترافيًا، token من نوع Instagram User، الصلاحيتين `instagram_business_basic` و`instagram_business_manage_messages`، واستخدام `graph.instagram.com`. التفاعل يبدأ من العميل والرد القياسي خلال 24 ساعة. خدمة حسابات لا تملكها/تديرها تحتاج Advanced Access. [Meta Instagram messaging](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api).

**قرارنا:** إعداد منفصل لمسار Facebook Login؛ capabilities واختبارات منفصلة بدل خلط host أو token أو scopes. فحص byte length للنص العربي ضروري، وليس الاقتصار على عدد الحروف. ظهور v26.0 في مثال الصفحة ليس شهادة بأنه الإصدار الأحدث لكل منتجات Meta.

### Messenger

المصدر الرسمي يوضح Page وPage access token وصلاحية `pages_messaging`، مع قواعد للنافذة ومراسلة المستلم. [Meta Messenger collection](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api).

**قرارنا:** لا تنسخ نافذة/capabilities WhatsApp أو قوالبه إلى Messenger. الـBroadcast عندنا عملية orchestration؛ السماح بالإرسال يظل متعلقًا بالقناة والمستلم والمحتوى والسياسة الفعلية.

### حدود التحقق الحالية

عدة روابط Meta أعادت HTTP 429 في الجلب النصي. نجح الوصول عبر المتصفح لصفحة Instagram، لكن لم نسجل دخولًا لحساب Meta أو نفحص أصول المستخدم. لم نستخرج أسرارًا، أو نربط قناة، أو نرسل رسالة. حالة App Review، scopes الممنوحة، asset ownership، webhook subscriptions، الحدود الفعلية، تاريخ انتهاء tokens والأسعار تتطلب تحققًا عند التنفيذ على البيئة المصرح بها.

الـprompt يلزم بتوثيق ذلك لكل اتصال، ويفصل نجاح اختبارات simulator عن `provider_live_verified`. لا يسمح بعبارة «القناة شغالة» اعتمادًا على وجود token في حقل.

## البحث الهندسي وأثره على الـprompt

أعدنا التحقق من HEAD للنسخة المحلية من Chatwoot: `c9f1867369ea87580adac3df9f2058bc63da1ef2`. قرأنا root/enterprise licenses وملفات حملة WhatsApp وصلاحيات المحادثات؛ لم نشغّل Chatwoot ولم ندّعِ مراجعة المستودع كله.

خدمة الحملة المفحوصة تحتوي تحققًا من النوع والحالة والمزود والـfeature flag، وتمر على الجمهور. سياسة المحادثات المفحوصة تربط الوصول بأدوار وعضويات inbox/team. نستخدم ذلك لفهم حدود المجال، لا لإثبات سعة أو أمان المنتج كله. [Campaign service at pinned commit](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/app/services/whatsapp/oneoff_campaign_service.rb)، [Conversation policy](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/app/policies/conversation_policy.rb).

محتوى `enterprise/` له ترخيص منفصل عن بقية المصدر؛ لا ننقل تنفيذًا من هذا المجلد إلى منتج جديد على افتراض أن المستودع كله MIT. اختيار منتج أصلي في الـprompt يحافظ على استقلال هذه الوظائف. [Root license](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/LICENSE)، [Enterprise license](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/enterprise/LICENSE).

| المرجع الهندسي | ما نأخذه منه | الأثر التنفيذي المقترح |
|---|---|---|
| [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | سياسات الصفوف لها سياق صلاحيات، ومالكو الجداول/الأدوار المتجاوزة يحتاجون انتباهًا | runtime role مستقل، قراءة وكتابة scoped، اختبارات pool/jobs/export فوق اختبارات API |
| [RabbitMQ reliability](https://www.rabbitmq.com/docs/reliability) | التأكيد وإعادة التسليم جزء من عقد الموثوقية، ولا يعفي المستهلك من التعامل مع التكرار | transactional outbox، ACK بعد commit، dedupe، حالات crash وreplay واضحة |
| [OWASP API Security](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) | صلاحيات الأشياء/الأفعال، استهلاك الموارد وSSRF من المخاطر الأساسية | اختبار IDOR والـscope ceiling وrate limits والتصدير والروابط، لا إخفاء الأزرار فقط |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | متطلبات وصول قابلة للتحقق عبر حالات واستخدامات متعددة | keyboard/focus/contrast/zoom وRTL ضمن قبول الواجهة |

اختيار React/TypeScript/NestJS/PostgreSQL والأدوار التشغيلية المنفصلة **اقتراح هندسي موروث ومحسّن**؛ ليس نتيجة benchmark تقارن لغات البرمجة. كذلك 30 ثانية لإبطال القراءة و60 دقيقة لجلسة دعم و100% line/function coverage أهداف جودة مقترحة داخل المشروع، وليست قواعد مفروضة من Meta أو ضمانًا بانعدام الأخطاء.

## Figma وواجهة لا تبدو قالبًا مولدًا

فحصنا صفحة المرجع وصورتها العامة المكبّرة في المتصفح. المصممة Rashmi، وعرضت الصفحة ترخيص CC BY 4.0. لم ندخل editable nodes ولم ننشئ ملف Figma جديدًا. [Customer Support Chat Dashboard UI — SaaS Admin Panel](https://www.figma.com/community/file/1514208352310179359/customer-support-chat-dashboard-ui-saas-admin-panel).

المشاهد فعلًا: واجهة فاتحة، شريط أيقونات ضيق، فلاتر مجمعة، قائمة محادثات، timeline/composer في المركز، وبيانات العميل/ملاحظاته في الطرف. توجد فقاعات صادرة زرقاء ولمسات دافئة محدودة. **لم نقس hex أو الخط أو الأبعاد من nodes**؛ هذه قيم يجب استخراجها في handoff أو تمييزها كتقديرات.

ما أضفناه: عقود للشاشات، tokens موحدة، component states، RTL/LTR، قائمة حالات تصوير ومقارنة مرئية. تصميم الشاشات الجديدة يكمل لغة المرجع، بما يشمل الحملات والأدوار والإعدادات، وليس تكرار شاشة Inbox لكل شيء. مواد Figma الرسمية تدعم تنظيم ذلك عبر variables/modes وvariants؛ استخدامها اقتراح لتنظيم التصميم. [Variables](https://help.figma.com/hc/en-us/articles/15339657135383-Guide-to-variables-in-Figma)، [Variants](https://help.figma.com/hc/en-us/articles/360056440594-Create-and-use-variants).

## الفجوات التي أغلقتها v2

1. نسختا تشغيل صريحتان، installer لكل منهما، وعدم إسناد وعود HA لنسخة single-host.
2. Super Admin منفصل عن Owner/Admin، مع scope ceiling لمفاتيح التكاملات واختبارات منع الوصول.
3. قواعد للمحادثة: open/pending/snoozed/resolved/reopen، مع فصلها عن read state وAI ownership؛ preview محدود لغير المعيّن دون كشف transcript قبل claim.
4. قواعد للحملة: snapshot ثابت، approval مربوط بالنسخة، تنفيذ واحد غير قابل لتغيير المحتوى بعد launch، إعادة فحص الأهلية، إيقاف صادق، وعدم إخفاء outcome_unknown.
5. جرد APIs مرتبط بالشاشات والوظائف والصلاحيات والتخزين، مع مثال إرسال/error/pagination وتعليمات OpenAPI/runtime validation.
6. فصل إثبات كتابة الكود عن الاختبارات وعن تشغيل المزود والنشر، وبطاقات P0–P9 واستئناف لحماية الـagent محدود السياق من نسيان المتطلبات.
7. بعد disaster restore مع احتمال فقدان بيانات: recovery_hold خارجي يمنع الإرسال حتى مصالحة/عزل سجلات opt-out والإرسال المفقودة. RPO غير صفري لا يتحول إلى وعد بأن كل حدث بعد نقطة الاستعادة محفوظ.

## ما لا يثبته هذا التسليم

هذا تسليم بحث ومواصفات وprompts. لا يثبت أن CONVO بُني، أو أن tests للتطبيق نجحت، أو أن حسابات Meta وافقت على الربط، أو أن السيرفر يستوعب الحمل. الاختبارات المذكورة تعليمات إلزامية للمنفّذ، ونتائج مراجعة المستندات في REVIEW.md منفصلة تمامًا عن اختبارات التطبيق. جودة الـprompt تقلل الغموض وتفرض الأدلة؛ لا تجعل احتمال الخطأ صفرًا.
