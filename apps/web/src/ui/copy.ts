import type { ApiError } from '../api/client.js';
import type { AppState } from '../state.js';

/**
 * The words the product uses for the things the server names.
 *
 * One table per vocabulary, shared by every screen, so a channel or a state is
 * called the same thing wherever it appears. A key this build does not know is
 * shown as itself rather than hidden: a newer server naming something new is
 * information, not noise.
 */

export type Phrase = { readonly ar: string; readonly en: string };

export function t(state: AppState, ar: string, en: string): string {
  return state.lang === 'ar' ? ar : en;
}

export function phrase(state: AppState, table: Readonly<Record<string, Phrase>>, key: string): string {
  const entry = table[key];
  return entry === undefined ? key : t(state, entry.ar, entry.en);
}

export const CHANNEL_NAMES: Readonly<Record<string, Phrase>> = {
  whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  messenger: { ar: 'ماسنجر', en: 'Messenger' },
  instagram: { ar: 'إنستغرام', en: 'Instagram' },
  web_chat: { ar: 'دردشة الموقع', en: 'Website chat' },
  custom: { ar: 'قناة API مخصّصة', en: 'Custom API channel' },
  telegram: { ar: 'تيليجرام', en: 'Telegram' },
};

export const READINESS: Readonly<Record<string, Phrase>> = {
  not_configured: { ar: 'غير مهيّأة', en: 'Not configured' },
  authorization_needed: { ar: 'بانتظار التحقق', en: 'Verification needed' },
  webhook_pending: { ar: 'بانتظار أول حدث', en: 'Waiting for first event' },
  healthy: { ar: 'متصلة', en: 'Connected' },
  degraded: { ar: 'تحتاج مراجعة', en: 'Needs attention' },
  disconnected: { ar: 'مفصولة', en: 'Disconnected' },
};

export const EVIDENCE: Readonly<Record<string, Phrase>> = {
  asset_verified: { ar: 'الأصل مسجّل', en: 'Asset registered' },
  credential_verified: { ar: 'تم قبول بيانات الاعتماد', en: 'Credential accepted' },
  webhook_subscribed: { ar: 'الاشتراك في الأحداث', en: 'Webhook subscribed' },
  first_inbound: { ar: 'وصلت أول رسالة واردة', en: 'First inbound message' },
  first_outbound: { ar: 'قُبلت أول رسالة صادرة', en: 'First outbound message' },
};

export const CAMPAIGN_STATES: Readonly<Record<string, Phrase>> = {
  draft: { ar: 'مسودة', en: 'Draft' },
  validating: { ar: 'قيد التحقق', en: 'Validating' },
  ready: { ar: 'جاهزة', en: 'Ready' },
  scheduled: { ar: 'مجدولة', en: 'Scheduled' },
  running: { ar: 'قيد الإرسال', en: 'Sending' },
  pausing: { ar: 'جارٍ الإيقاف', en: 'Pausing' },
  paused: { ar: 'متوقفة', en: 'Paused' },
  dispatch_completed: { ar: 'اكتمل الإرسال', en: 'Sent' },
  cancelling: { ar: 'جارٍ الإلغاء', en: 'Cancelling' },
  cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  failed: { ar: 'فشلت', en: 'Failed' },
};

export const RECIPIENT_STATES: Readonly<Record<string, Phrase>> = {
  planned: { ar: 'مخطط', en: 'Planned' },
  queued: { ar: 'في الطابور', en: 'Queued' },
  in_flight: { ar: 'قيد الإرسال', en: 'In flight' },
  accepted: { ar: 'أُرسلت', en: 'Sent' },
  delivered: { ar: 'سُلّمت', en: 'Delivered' },
  read: { ar: 'قُرئت', en: 'Read' },
  failed: { ar: 'فشلت', en: 'Failed' },
  skipped: { ar: 'تم تخطيها', en: 'Skipped' },
  cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  outcome_unknown: { ar: 'النتيجة غير معروفة', en: 'Outcome unknown' },
};

export const ERROR_CODES: Readonly<Record<string, Phrase>> = {
  instagram_page_required: { ar: 'صفحة فيسبوك المرتبطة بإنستجرام غير محددة أو لم تُتحقق.', en: 'The Facebook Page linked to Instagram is missing or unverified.' },
  provider_rejected: { ar: 'رفض المزوّد الرسالة', en: 'Rejected by provider' },
  provider_not_connected: { ar: 'المزوّد غير متصل', en: 'Provider not connected' },
  provider_error_3: { ar: 'تطبيق Meta لا يملك الصلاحية أو القدرة المطلوبة لهذا الأصل. راجع صلاحيات التطبيق وربط الأصل.', en: 'The Meta app lacks the capability required for this asset. Review app permissions and asset access.' },
  marketing_consent_missing: { ar: 'لا توجد موافقة تسويقية', en: 'No marketing consent' },
  attempt_never_completed: { ar: 'لم تكتمل المحاولة', en: 'Attempt never completed' },
  channel_not_ready: { ar: 'القناة غير جاهزة', en: 'Channel not ready' },
  suppressed: { ar: 'العميل ألغى الاشتراك', en: 'Recipient opted out' },
  window_closed: { ar: 'نافذة الرد مغلقة', en: 'Reply window closed' },
  unspecified: { ar: 'سبب غير محدد', en: 'Unspecified' },
  custom_endpoint_missing: { ar: 'لم يُحدَّد رابط استقبال الردود في نظامك.', en: 'No reply URL is set for your system.' },
  provider_unreachable: { ar: 'تعذّر الوصول إلى النظام المستقبِل.', en: 'The receiving system could not be reached.' },
  provider_timeout: { ar: 'لم يردّ النظام المستقبِل في الوقت المحدد.', en: 'The receiving system did not answer in time.' },
};

export interface ErrorCopy {
  readonly title: string;
  readonly body: string;
  /** Present for failures a person can take to support; absent for plain refusals. */
  readonly requestId: string | null;
}

/**
 * A failure described by what the operator can do next.
 *
 * The status decides the sentence rather than the server's message, because the
 * five kinds of failure call for five different next steps. The server's own
 * message is kept for validation and conflicts, where it names the field or the
 * state that got in the way.
 */
export function describeError(state: AppState, error: ApiError): ErrorCopy {
  const requestId = error.requestId;
  if (error.code === 'network' || error.status === null) {
    return {
      title: t(state, 'تعذّر الاتصال بالخادم', 'Can’t reach the server'),
      body: t(state, 'تحقق من اتصالك ثم أعد المحاولة.', 'Check your connection, then try again.'),
      requestId: null,
    };
  }
  if (error.status === 401) {
    return {
      title: t(state, 'انتهت الجلسة', 'Your session has ended'),
      body: t(state, 'سجّل الدخول مرة أخرى للمتابعة.', 'Sign in again to continue.'),
      requestId: null,
    };
  }
  if (error.status === 403) {
    // A refusal with its own reason (a delegation ceiling, say) keeps that
    // reason; a bare refusal gets the one next step there is.
    const specific = error.code !== 'permission_denied' && error.message !== '';
    return {
      title: t(state, 'لا تملك صلاحية لهذا الإجراء', 'You don’t have permission for this'),
      body: specific
        ? serverReason(error)
        : t(state, 'اطلب الصلاحية من مسؤول مساحة العمل.', 'Ask a workspace administrator for access.'),
      requestId,
    };
  }
  if (error.status === 404) {
    return {
      title: t(state, 'غير موجود أو غير متاح لك', 'Not found or not available to you'),
      body: t(state, 'ربما حُذف أو نُقل. حدّث الصفحة وحاول مجددًا.', 'It may have been removed or moved. Refresh and try again.'),
      requestId,
    };
  }
  if (error.status === 409) {
    return {
      title: t(state, 'يتعارض هذا مع الحالة الحالية', 'This conflicts with the current state'),
      body: serverReason(error),
      requestId,
    };
  }
  if (error.status === 429) {
    return {
      title: t(state, 'محاولات كثيرة', 'Too many attempts'),
      body: t(state, 'انتظر قليلًا ثم أعد المحاولة.', 'Wait a moment, then try again.'),
      requestId,
    };
  }
  if (error.status >= 500) {
    return {
      title: t(state, 'تعذّر إكمال الطلب', 'The server couldn’t complete this'),
      body: t(state, 'أعد المحاولة. إن تكرر الخطأ، أرسل رقم الطلب إلى الدعم.', 'Try again. If it keeps happening, share the request ID with support.'),
      requestId,
    };
  }
  return {
    title: t(state, 'راجع البيانات المدخلة', 'Check what you entered'),
    body: serverReason(error),
    requestId,
  };
}

/** The server's own sentence, followed by what it said about each field. */
function serverReason(error: ApiError): string {
  const details = error.details.map((detail) => detail.message).filter((message) => message !== '');
  return [error.message, ...details].filter((part) => part !== '').join(' · ');
}
