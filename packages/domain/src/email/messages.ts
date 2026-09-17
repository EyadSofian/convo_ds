/**
 * The two transactional emails this product sends, rendered as pure functions.
 *
 * They live in the domain, not in the provider adapter, for the reason every
 * other port boundary here exists: what the message *says* is a product
 * decision, and what carries it is an operations decision. Swapping Resend for
 * SMTP must not be able to change a word of the copy, and testing the copy must
 * not require a provider.
 *
 * Three rules shape the output:
 *
 * 1. **Every link derives from the configured public base URL.** There is no
 *    fallback and no default. An email that hardcodes a host is an email that
 *    sends half your users to somebody else's installation.
 * 2. **Nothing is interpolated into HTML unescaped.** A workspace name is
 *    operator-supplied text; a company called `<img onerror=...>` must not
 *    become script in a mail client that renders it.
 * 3. **Arabic is a first-class rendering, not a translated afterthought.** The
 *    document carries `dir="rtl"` and `lang="ar"`, the table alignment flips,
 *    and the Latin fallback stack is ordered so a mixed Arabic/Latin line does
 *    not reflow mid-sentence.
 */

export type EmailLocale = 'ar' | 'en';

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface InvitationEmailInput {
  readonly locale: EmailLocale;
  /** The configured public origin. Never a literal, never a request Host. */
  readonly publicBaseUrl: string;
  readonly installationName: string;
  readonly workspaceName: string;
  readonly roleName: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface RecoveryEmailInput {
  readonly locale: EmailLocale;
  readonly publicBaseUrl: string;
  readonly installationName: string;
  readonly token: string;
  readonly expiresAt: Date;
}

/** The web routes that answer these two links. Kept beside the copy that uses them. */
export const INVITATION_PATH = '#/accept-invitation';
export const RECOVERY_PATH = '#/reset-password';

export function invitationUrl(publicBaseUrl: string, token: string): string {
  return `${origin(publicBaseUrl)}/${INVITATION_PATH}?token=${encodeURIComponent(token)}`;
}

export function recoveryUrl(publicBaseUrl: string, token: string): string {
  return `${origin(publicBaseUrl)}/${RECOVERY_PATH}?token=${encodeURIComponent(token)}`;
}

export function renderInvitationEmail(input: InvitationEmailInput): RenderedEmail {
  const url = invitationUrl(input.publicBaseUrl, input.token);
  const expiry = formatExpiry(input.expiresAt, input.locale);
  const arabic = input.locale === 'ar';

  const subject = arabic
    ? `دعوة للانضمام إلى ${input.workspaceName} على ${input.installationName}`
    : `You have been invited to ${input.workspaceName} on ${input.installationName}`;

  const heading = arabic ? 'لقد تمت دعوتك' : 'You have been invited';
  const intro = arabic
    ? `تمت دعوتك للانضمام إلى مساحة العمل <strong>${escapeHtml(input.workspaceName)}</strong> بصفة <strong>${escapeHtml(input.roleName)}</strong>.`
    : `You have been invited to join the <strong>${escapeHtml(input.workspaceName)}</strong> workspace as <strong>${escapeHtml(input.roleName)}</strong>.`;
  const cta = arabic ? 'قبول الدعوة' : 'Accept the invitation';
  const expiryLine = arabic
    ? `تنتهي صلاحية هذه الدعوة في ${expiry}. بعد ذلك ستحتاج إلى دعوة جديدة.`
    : `This invitation expires on ${expiry}. After that you will need a new one.`;
  const security = arabic
    ? 'إذا لم تكن تتوقع هذه الدعوة، تجاهل هذه الرسالة. لا تُشارك هذا الرابط مع أحد — من يملكه يستطيع استخدامه مرة واحدة للانضمام.'
    : 'If you were not expecting this invitation, ignore this message. Do not forward this link — whoever holds it can use it once to join.';

  return {
    subject,
    html: document(input.locale, input.installationName, [
      block(heading, intro),
      button(url, cta, input.locale),
      note(expiryLine),
      note(security),
      fallback(url, input.locale),
    ]),
    text: [
      subject,
      '',
      stripTags(intro),
      '',
      url,
      '',
      expiryLine,
      security,
    ].join('\n'),
  };
}

export function renderRecoveryEmail(input: RecoveryEmailInput): RenderedEmail {
  const url = recoveryUrl(input.publicBaseUrl, input.token);
  const expiry = formatExpiry(input.expiresAt, input.locale);
  const arabic = input.locale === 'ar';

  const subject = arabic
    ? `إعادة تعيين كلمة المرور — ${input.installationName}`
    : `Reset your password — ${input.installationName}`;

  const heading = arabic ? 'إعادة تعيين كلمة المرور' : 'Reset your password';
  const intro = arabic
    ? 'وصلنا طلب لإعادة تعيين كلمة مرور حسابك. اضغط الزر أدناه لاختيار كلمة مرور جديدة.'
    : 'We received a request to reset the password for your account. Use the button below to choose a new one.';
  const cta = arabic ? 'إعادة تعيين كلمة المرور' : 'Reset password';
  const expiryLine = arabic
    ? `تنتهي صلاحية هذا الرابط في ${expiry}، ويُستخدم مرة واحدة فقط.`
    : `This link expires on ${expiry} and can be used only once.`;
  // The sentence the whole flow is judged on. It must not imply anything about
  // whether an account exists for anybody who did not request this.
  const security = arabic
    ? 'إذا لم تطلب إعادة التعيين، تجاهل هذه الرسالة — كلمة مرورك لن تتغيّر. وعند استخدام الرابط سيتم إنهاء جميع الجلسات المفتوحة.'
    : 'If you did not request this, ignore this email — your password will not change. Using the link signs out every open session.';

  return {
    subject,
    html: document(input.locale, input.installationName, [
      block(heading, intro),
      button(url, cta, input.locale),
      note(expiryLine),
      note(security),
      fallback(url, input.locale),
    ]),
    text: [subject, '', intro, '', url, '', expiryLine, security].join('\n'),
  };
}

/* ------------------------------------------------------------ rendering -- */

/**
 * The shell.
 *
 * Table-based, inline-styled and single-column on purpose: mail clients are not
 * browsers, Outlook has no flexbox, and Gmail strips `<style>` blocks it does
 * not like. A 600px table with inline styles is the one layout that renders the
 * same in all of them, and it is responsive by being narrower than every
 * viewport that matters.
 */
function document(locale: EmailLocale, installationName: string, sections: readonly string[]): string {
  const rtl = locale === 'ar';
  const dir = rtl ? 'rtl' : 'ltr';
  const align = rtl ? 'right' : 'left';
  const family = rtl
    ? "'IBM Plex Sans Arabic','Segoe UI',Tahoma,Arial,sans-serif"
    : "'IBM Plex Sans','Segoe UI',Helvetica,Arial,sans-serif";
  return `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(installationName)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e3e5e8;border-radius:10px;">
<tr><td dir="${dir}" align="${align}" style="padding:24px 28px 8px 28px;font-family:${family};font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;">
${escapeHtml(installationName)}
</td></tr>
<tr><td dir="${dir}" align="${align}" style="padding:0 28px 28px 28px;font-family:${family};color:#111827;">
${sections.join('\n')}
</td></tr>
</table>
<div dir="${dir}" style="max-width:600px;margin:16px auto 0;font-family:${family};font-size:12px;color:#9ca3af;text-align:${align};">
${escapeHtml(installationName)}
</div>
</td></tr>
</table>
</body>
</html>`;
}

function block(heading: string, bodyHtml: string): string {
  return `<h1 style="margin:16px 0 12px;font-size:22px;line-height:1.35;font-weight:600;color:#111827;">${escapeHtml(heading)}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#374151;">${bodyHtml}</p>`;
}

function button(url: string, label: string, locale: EmailLocale): string {
  // `href` is built from the configured origin plus a URL-encoded token, so the
  // only escaping it needs is HTML attribute escaping.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
<tr><td align="${locale === 'ar' ? 'right' : 'left'}" bgcolor="#111827" style="border-radius:8px;">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
</td></tr></table>`;
}

function note(text: string): string {
  return `<p style="margin:0 0 12px;font-size:13px;line-height:1.7;color:#6b7280;">${escapeHtml(text)}</p>`;
}

/**
 * The link in plain text as well as a button.
 *
 * Corporate mail clients routinely strip or rewrite anchors. Without this, the
 * only recovery path for an affected user is to ask an administrator.
 */
function fallback(url: string, locale: EmailLocale): string {
  const label = locale === 'ar' ? 'أو انسخ هذا الرابط إلى المتصفح:' : 'Or copy this link into your browser:';
  return `<p style="margin:20px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#9ca3af;">${escapeHtml(label)}<br>
<span dir="ltr" style="word-break:break-all;color:#4b5563;">${escapeHtml(url)}</span></p>`;
}

/**
 * The origin, without a trailing slash.
 *
 * `CONVO_PUBLIC_BASE_URL` is already validated as a URL at boot, so this only
 * has to normalize the slash that makes `https://host//#/x` when it is present.
 */
function origin(publicBaseUrl: string): string {
  return publicBaseUrl.replace(/\/+$/, '');
}

/**
 * The expiry, in the recipient's calendar and language, always in UTC.
 *
 * UTC rather than a guessed local zone: we do not know where the recipient is,
 * and a time that is silently wrong by three hours is worse than one that says
 * which zone it means. The Arabic rendering uses Latin digits deliberately —
 * Eastern Arabic numerals are correct typography but are widely mis-rendered by
 * mail clients, and a misread expiry time is a support ticket.
 */
function formatExpiry(expiresAt: Date, locale: EmailLocale): string {
  const formatted = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(expiresAt);
  return `${formatted} UTC`;
}

function stripTags(html: string): string {
  return unescapeHtml(html.replace(/<[^>]*>/g, ''));
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
