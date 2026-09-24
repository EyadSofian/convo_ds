import type { IconName } from '../icons.js';
import type { Phrase } from './copy.js';

/**
 * How the permission catalogue is presented: module, human label and icon.
 *
 * Presentation only. The keys, their delegability and every decision about who
 * may grant what come from the server (`GET /permissions`, migration 0003); a
 * key the server lists but this table does not know still renders — under
 * "Other", labelled by its key — so a newer server never loses a permission in
 * an older browser.
 */

export interface PermissionGroup {
  readonly id: string;
  readonly name: Phrase;
  readonly icon: IconName;
  readonly keys: readonly string[];
}

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    id: 'conversations',
    name: { ar: 'المحادثات', en: 'Conversations' },
    icon: 'chat',
    keys: [
      'conversation.read', 'conversation.unassigned.preview', 'conversation.reply', 'conversation.note',
      'conversation.claim', 'conversation.assign', 'conversation.handoff.request', 'conversation.close',
    ],
  },
  { id: 'contacts', name: { ar: 'جهات الاتصال', en: 'Contacts' }, icon: 'contacts', keys: ['contact.read', 'contact.edit', 'contact.merge', 'contact.export'] },
  { id: 'consent', name: { ar: 'الموافقة والانسحاب', en: 'Consent & suppression' }, icon: 'badgeCheck', keys: ['consent.read', 'consent.record', 'suppression.write'] },
  { id: 'campaigns', name: { ar: 'الحملات', en: 'Campaigns' }, icon: 'broadcasts', keys: ['campaign.read', 'campaign.draft', 'campaign.approve', 'campaign.launch', 'campaign.control'] },
  {
    id: 'automations',
    name: { ar: 'الأتمتة', en: 'Automations' },
    icon: 'workflow',
    keys: ['automation.read', 'automation.create', 'automation.edit', 'automation.activate', 'automation.pause', 'automation.test'],
  },
  { id: 'channels', name: { ar: 'القنوات وبيانات الاعتماد', en: 'Channels & credentials' }, icon: 'plug', keys: ['channel.manage', 'credential.rotate'] },
  { id: 'members', name: { ar: 'الأعضاء والأدوار', en: 'Members & roles' }, icon: 'shieldUser', keys: ['member.manage', 'role.manage'] },
  { id: 'catalog', name: { ar: 'الكتالوج', en: 'Catalog' }, icon: 'book', keys: ['catalog.read', 'catalog.manage'] },
  { id: 'integrations', name: { ar: 'التكاملات', en: 'Integrations' }, icon: 'webhook', keys: ['integration.manage', 'api_key.manage'] },
  { id: 'reporting', name: { ar: 'التقارير والتدقيق', en: 'Reporting & audit' }, icon: 'analytics', keys: ['report.read', 'audit.read'] },
  { id: 'security', name: { ar: 'الأمان والاحتفاظ', en: 'Security & retention' }, icon: 'shield', keys: ['retention.manage', 'tenant.delete'] },
];

/** The group a key the table does not know is shown under. */
export const OTHER_GROUP: PermissionGroup = { id: 'other', name: { ar: 'أخرى', en: 'Other' }, icon: 'key', keys: [] };

export const PERMISSION_LABELS: Readonly<Record<string, Phrase>> = {
  'conversation.read': { ar: 'قراءة المحادثات', en: 'Read conversations' },
  'conversation.unassigned.preview': { ar: 'معاينة المحادثات غير المسندة', en: 'Preview unassigned conversations' },
  'conversation.reply': { ar: 'الرد على المحادثات', en: 'Reply to conversations' },
  'conversation.note': { ar: 'إضافة ملاحظات داخلية', en: 'Add private notes' },
  'conversation.claim': { ar: 'استلام المحادثات', en: 'Claim conversations' },
  'conversation.assign': { ar: 'إسناد المحادثات', en: 'Assign conversations' },
  'conversation.handoff.request': { ar: 'طلب تسليم المحادثة لزميل', en: 'Request a handoff' },
  'conversation.close': { ar: 'إغلاق المحادثات', en: 'Close conversations' },
  'contact.read': { ar: 'قراءة جهات الاتصال', en: 'Read contacts' },
  'contact.edit': { ar: 'تعديل جهات الاتصال', en: 'Edit contacts' },
  'contact.merge': { ar: 'دمج جهات الاتصال', en: 'Merge contacts' },
  'contact.export': { ar: 'تصدير جهات الاتصال', en: 'Export contacts' },
  'consent.read': { ar: 'قراءة سجل الموافقة', en: 'Read consent' },
  'consent.record': { ar: 'تسجيل الموافقة', en: 'Record consent' },
  'suppression.write': { ar: 'إدارة قائمة الانسحاب', en: 'Manage suppressions' },
  'campaign.read': { ar: 'عرض الحملات', en: 'View campaigns' },
  'campaign.draft': { ar: 'إنشاء مسودات الحملات', en: 'Draft campaigns' },
  'campaign.approve': { ar: 'اعتماد الحملات', en: 'Approve campaigns' },
  'campaign.launch': { ar: 'إطلاق الحملات', en: 'Launch campaigns' },
  'campaign.control': { ar: 'إيقاف الحملات واستئنافها', en: 'Pause and resume campaigns' },
  'automation.read': { ar: 'عرض الأتمتة', en: 'View automations' },
  'automation.create': { ar: 'إنشاء الأتمتة', en: 'Create automations' },
  'automation.edit': { ar: 'تعديل الأتمتة', en: 'Edit automations' },
  'automation.activate': { ar: 'تفعيل الأتمتة', en: 'Activate automations' },
  'automation.pause': { ar: 'إيقاف الأتمتة مؤقتًا', en: 'Pause automations' },
  'automation.test': { ar: 'اختبار الأتمتة', en: 'Test automations' },
  'channel.manage': { ar: 'إدارة القنوات', en: 'Manage channels' },
  'credential.rotate': { ar: 'تدوير بيانات الاعتماد', en: 'Rotate credentials' },
  'member.manage': { ar: 'إدارة الأعضاء والفرق', en: 'Manage members and teams' },
  'role.manage': { ar: 'إدارة الأدوار', en: 'Manage roles' },
  'catalog.read': { ar: 'عرض الكتالوج', en: 'View catalog' },
  'catalog.manage': { ar: 'إدارة الكتالوج', en: 'Manage catalog' },
  'integration.manage': { ar: 'إدارة التكاملات', en: 'Manage integrations' },
  'api_key.manage': { ar: 'إدارة مفاتيح API', en: 'Manage API keys' },
  'report.read': { ar: 'عرض التقارير', en: 'View reports' },
  'audit.read': { ar: 'قراءة سجل التدقيق', en: 'Read the audit log' },
  'retention.manage': { ar: 'إدارة الاحتفاظ بالبيانات', en: 'Manage data retention' },
  'tenant.delete': { ar: 'حذف مساحة العمل', en: 'Delete the workspace' },
};

/** Scope levels a grant may carry, as the server stores them. */
export const SCOPE_OPTIONS: readonly { readonly value: 'tenant' | 'scoped' | 'own'; readonly label: Phrase }[] = [
  { value: 'tenant', label: { ar: 'مساحة العمل كلها', en: 'Whole workspace' } },
  { value: 'scoped', label: { ar: 'ضمن النطاق', en: 'Scoped' } },
  { value: 'own', label: { ar: 'الخاص به فقط', en: 'Own only' } },
];

/** The keys the server lists, arranged into the modules above, in catalogue order. */
export function groupPermissions(serverKeys: readonly string[]): readonly PermissionGroup[] {
  const listed = new Set(serverKeys);
  const known = new Set(PERMISSION_GROUPS.flatMap((group) => group.keys));
  const groups = PERMISSION_GROUPS
    .map((group) => ({ ...group, keys: group.keys.filter((key) => listed.has(key)) }))
    .filter((group) => group.keys.length > 0);
  const others = serverKeys.filter((key) => !known.has(key));
  return others.length === 0 ? groups : [...groups, { ...OTHER_GROUP, keys: others }];
}
