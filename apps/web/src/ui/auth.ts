import type { ApiError } from '../api/client.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import type { AppState } from '../state.js';
import { brandLockup } from './brand.js';
import { t } from './copy.js';
import { button, requestIdLine } from './parts.js';

/**
 * Everything a person sees before the server has said who they are.
 *
 * Nothing in this file reads a protected resource, a tenant or a role — it
 * cannot, because none of those exist yet. The shell, the navigation and every
 * screen are only ever rendered once the session is `signed_in`, so a visitor
 * without one is shown this and nothing else.
 */

export function renderGate(state: AppState): HTMLElement {
  const session = state.live.session;
  if (session.status === 'unknown') {
    return loadingScreen(state);
  }
  if (session.status === 'signed_in') {
    return noWorkspace(state);
  }
  if (session.probeError !== undefined) {
    return unavailable(state, session.probeError);
  }
  return signIn(state, session.error, session.expired === true);
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Public credential flows. They deliberately use the existing gate shell. */
export function renderPublicAuth(state: AppState): HTMLElement {
  return state.route.screen === 'accept-invitation'
    ? invitationScreen(state)
    : recoveryScreen(state);
}

function invitationScreen(state: AppState): HTMLElement {
  const token = state.route.params['token'] ?? '';
  if (state.authFlowComplete === 'invitation') {
    return successScreen(
      state,
      t(state, 'تم قبول الدعوة', 'Invitation accepted'),
      t(state, 'يمكنك الآن تسجيل الدخول إلى مساحة العمل.', 'You can now sign in to your workspace.'),
    );
  }
  return credentialForm(
    state,
    t(state, 'قبول الدعوة', 'Accept invitation'),
    token,
    'live-accept-invitation',
    t(state, 'اختر كلمة مرور لحسابك. إذا كان لديك حساب بالفعل، أدخل كلمة مروره الحالية.', 'Choose a password for your account. If you already have an account, enter its current password.'),
  );
}

function recoveryScreen(state: AppState): HTMLElement {
  const token = state.route.params['token'] ?? '';
  if (state.authFlowComplete === 'recovery-request') {
    return successScreen(
      state,
      t(state, 'تحقق من بريدك', 'Check your email'),
      t(state, 'إذا كان هناك حساب بهذا البريد، أرسلنا رابط إعادة التعيين.', 'If an account exists for that address, a reset link has been sent.'),
    );
  }
  if (state.authFlowComplete === 'recovery') {
    return successScreen(
      state,
      t(state, 'تم تغيير كلمة المرور', 'Password changed'),
      t(state, 'تم إنهاء جميع الجلسات السابقة. سجّل الدخول بكلمة المرور الجديدة.', 'All previous sessions were ended. Sign in with your new password.'),
    );
  }
  if (token === '') return recoveryRequestForm(state);
  return credentialForm(
    state,
    t(state, 'إعادة تعيين كلمة المرور', 'Reset password'),
    token,
    'live-complete-recovery',
    t(state, 'اختر كلمة مرور جديدة. سيؤدي ذلك إلى إنهاء جميع جلساتك المفتوحة.', 'Choose a new password. This will end all your open sessions.'),
  );
}

function recoveryRequestForm(state: AppState): HTMLElement {
  const error = state.live.error;
  return frame(state, [
    h('section', { class: 'auth-card', 'aria-labelledby': 'auth-title' }, [
      brandLockup(),
      h('div', { class: 'auth-card__intro' }, [
        h('h1', { class: 'auth-card__title', id: 'auth-title' }, [t(state, 'استعادة الوصول', 'Recover access')]),
        h('p', { class: 'auth-card__lede' }, [t(state, 'أدخل بريد العمل وسنرسل رابطًا إذا كان الحساب موجودًا.', 'Enter your work email and we will send a link if the account exists.')]),
      ]),
      error === null ? null : publicFailure(state, error),
      h('form', { class: 'auth-form', 'data-submit': 'live-request-recovery', novalidate: true }, [
        h('div', { class: 'field' }, [
          h('label', { class: 'field__label', for: 'recovery-email' }, [t(state, 'البريد الإلكتروني', 'Email')]),
          h('input', { id: 'recovery-email', class: state.formErrors['recoveryEmail'] === undefined ? 'input' : 'input input--invalid', type: 'email', autocomplete: 'email', dir: 'ltr', required: true, value: state.dialogForm['recoveryEmail'] ?? '', 'data-act': 'form', 'data-form': 'recoveryEmail' }),
          fieldError('recovery-email-error', state.formErrors['recoveryEmail']),
        ]),
        button({ label: t(state, 'إرسال رابط إعادة التعيين', 'Send reset link'), act: 'live-request-recovery', type: 'submit', variant: 'primary', busy: state.live.busy === 'recovery-request', extraClass: 'auth-form__submit' }),
      ]),
    ]),
  ]);
}

function credentialForm(state: AppState, title: string, token: string, action: string, lede: string): HTMLElement {
  const malformed = token !== '' && !TOKEN.test(token);
  const error = state.live.error;
  const busy = state.live.busy === action;
  return frame(state, [
    h('section', { class: 'auth-card', 'aria-labelledby': 'auth-title' }, [
      brandLockup(),
      h('div', { class: 'auth-card__intro' }, [h('h1', { class: 'auth-card__title', id: 'auth-title' }, [title]), h('p', { class: 'auth-card__lede' }, [lede])]),
      token === '' || malformed
        ? h('div', { class: 'inline-error', role: 'alert' }, [icon('alert', 16), h('p', { class: 'inline-error__title' }, [t(state, 'هذا الرابط غير صالح. اطلب رابطًا جديدًا.', 'This link is invalid. Request a new one.')])])
        : error === null ? null : publicFailure(state, error),
      token === '' || malformed ? null : h('form', { class: 'auth-form', 'data-submit': action, novalidate: true }, [
        passwordField(state, 'authPassword', 'new-password', t(state, 'كلمة المرور', 'Password')),
        passwordField(state, 'authPasswordConfirm', 'new-password', t(state, 'تأكيد كلمة المرور', 'Confirm password')),
        h('p', { class: 'field__hint' }, [t(state, 'استخدم 12 حرفًا على الأقل.', 'Use at least 12 characters.')]),
        button({ label: title, act: action, type: 'submit', variant: 'primary', busy, extraClass: 'auth-form__submit' }),
      ]),
    ]),
  ]);
}

function passwordField(state: AppState, key: string, autocomplete: string, label: string): HTMLElement {
  return h('div', { class: 'field' }, [
    h('label', { class: 'field__label', for: key }, [label]),
    h('input', { id: key, class: state.formErrors[key] === undefined ? 'input' : 'input input--invalid', type: 'password', autocomplete, dir: 'ltr', required: true, value: state.dialogForm[key] ?? '', 'data-act': 'form', 'data-form': key }),
    fieldError(`${key}-error`, state.formErrors[key]),
  ]);
}

function publicFailure(state: AppState, error: ApiError): HTMLElement {
  const invalid = error.details.some((detail) => detail.code === 'invalid_or_expired');
  const message = invalid
    ? t(state, 'انتهت صلاحية الرابط أو استُخدم بالفعل. اطلب رابطًا جديدًا.', 'This link expired or was already used. Request a new one.')
    : error.status === 429
      ? t(state, 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.', 'Too many attempts. Wait a moment, then try again.')
      : error.code === 'network'
        ? t(state, 'تعذّر الاتصال بالخادم.', 'Could not reach the server.')
        : t(state, 'تعذّر إكمال الطلب. أعد المحاولة.', 'The request could not be completed. Try again.');
  return h('div', { class: 'inline-error', role: 'alert' }, [icon('alert', 16), h('div', {}, [h('p', { class: 'inline-error__title' }, [message]), requestIdLine(state, error.requestId)])]);
}

function successScreen(state: AppState, title: string, body: string): HTMLElement {
  return frame(state, [h('section', { class: 'auth-card auth-card--status', 'aria-labelledby': 'auth-title' }, [
    brandLockup(),
    h('div', { class: 'auth-card__intro' }, [h('h1', { class: 'auth-card__title', id: 'auth-title' }, [title]), h('p', { class: 'auth-card__lede' }, [body])]),
    h('a', { class: 'button button--primary auth-form__submit', href: '#/inbox' }, [t(state, 'تسجيل الدخول', 'Sign in')]),
  ])]);
}

/** A data-free shell while the session is checked; no protected nav is built. */
export function loadingScreen(state: AppState): HTMLElement {
  const inbox = state.route.screen === 'inbox';
  return h('div', { class: 'app app--pending', 'data-nav': 'collapsed', role: 'status', 'aria-live': 'polite' }, [
    h('div', { class: 'app-pending__nav', 'aria-hidden': 'true' }, [
      h('span', { class: 'app-pending__brand' }, ['D']),
      ...Array.from({ length: 5 }, () => h('span', { class: 'app-pending__nav-item' })),
    ]),
    h('div', { class: 'app__main' }, [
      h('div', { class: 'app-pending__header', 'aria-hidden': 'true' }, [
        h('span', { class: 'app-pending__line app-pending__line--title' }),
        h('span', { class: 'app-pending__line app-pending__line--short' }),
      ]),
      h('main', { class: inbox ? 'app-pending__screen app-pending__screen--inbox' : 'app-pending__screen' }, [
        inbox ? h('div', { class: 'app-pending__list', 'aria-hidden': 'true' },
          Array.from({ length: 6 }, () => h('span', { class: 'app-pending__row' }))) : null,
        h('div', { class: 'app-pending__content' }, [
          h('span', { class: 'app-pending__line app-pending__line--wide', 'aria-hidden': 'true' }),
          h('span', { class: 'app-pending__line', 'aria-hidden': 'true' }),
          h('p', { class: 'app-pending__status' }, [t(state, 'جارٍ التحقق من الجلسة…', 'Checking your session…')]),
        ]),
      ]),
    ]),
  ]);
}

function frame(state: AppState, children: readonly HTMLElement[]): HTMLElement {
  return h('div', { class: 'gate' }, [
    h('div', { class: 'gate__top' }, [
      button({
        label: state.lang === 'ar' ? 'English' : 'العربية',
        icon: 'language',
        act: 'lang',
        arg: state.lang === 'ar' ? 'en' : 'ar',
        variant: 'ghost',
        small: true,
        extraClass: 'lang-toggle',
      }),
      button({
        icon: state.theme === 'light' ? 'moon' : 'sun',
        act: 'theme',
        variant: 'ghost',
        small: true,
        title: state.theme === 'light' ? t(state, 'الوضع الداكن', 'Dark theme') : t(state, 'الوضع الفاتح', 'Light theme'),
        extraClass: 'theme-toggle',
      }),
    ]),
    h('main', { class: 'gate__main', id: 'main', tabindex: '-1' }, children),
  ]);
}

/**
 * The sign-in form.
 *
 * A real `<form>` so Enter submits and password managers recognise it. A wrong
 * email and a wrong password get the same sentence, because the server gives
 * the same answer and guessing which one was wrong would disclose that an
 * address has an account.
 */
function signIn(state: AppState, error: ApiError | null, expired: boolean): HTMLElement {
  const busy = state.live.busy === 'sign-in';
  const errors = state.formErrors;
  const alert = error === null ? null : signInFailure(state, error);
  return frame(state, [
    h('section', { class: 'auth-card', 'aria-labelledby': 'auth-title' }, [
      brandLockup(),
      h('div', { class: 'auth-card__intro' }, [
        h('h1', { class: 'auth-card__title', id: 'auth-title' }, [t(state, 'تسجيل الدخول', 'Sign in')]),
        h('p', { class: 'auth-card__lede' }, [
          t(state, 'استخدم بريد العمل للدخول إلى مساحة عملك.', 'Use your work email to open your workspace.'),
        ]),
      ]),
      expired && error === null
        ? h('div', { class: 'notice notice--info', role: 'status' }, [
            h('span', { class: 'notice__icon', 'aria-hidden': 'true' }, [icon('clock', 16)]),
            h('div', { class: 'notice__text' }, [
              t(state, 'انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة.', 'Your session ended. Sign in again to continue.'),
            ]),
          ])
        : null,
      alert,
      h('form', { class: 'auth-form', 'data-submit': 'live-signin', novalidate: true }, [
        h('div', { class: 'field' }, [
          h('label', { class: 'field__label', for: 'signin-email' }, [t(state, 'البريد الإلكتروني', 'Email')]),
          h('input', {
            id: 'signin-email',
            class: errors['signinEmail'] === undefined ? 'input' : 'input input--invalid',
            type: 'email',
            name: 'email',
            autocomplete: 'username',
            inputmode: 'email',
            dir: 'ltr',
            required: true,
            'aria-invalid': errors['signinEmail'] === undefined ? undefined : 'true',
            'aria-describedby': errors['signinEmail'] === undefined ? undefined : 'signin-email-error',
            value: state.dialogForm['signinEmail'] ?? '',
            'data-act': 'form',
            'data-form': 'signinEmail',
          }),
          fieldError('signin-email-error', errors['signinEmail']),
        ]),
        h('div', { class: 'field' }, [
          h('label', { class: 'field__label', for: 'signin-password' }, [t(state, 'كلمة المرور', 'Password')]),
          h('div', { class: 'input-affix' }, [
            h('input', {
              id: 'signin-password',
              class: errors['signinPassword'] === undefined ? 'input' : 'input input--invalid',
              type: state.passwordVisible ? 'text' : 'password',
              name: 'password',
              autocomplete: 'current-password',
              dir: 'ltr',
              required: true,
              'aria-invalid': errors['signinPassword'] === undefined ? undefined : 'true',
              'aria-describedby': errors['signinPassword'] === undefined ? undefined : 'signin-password-error',
              value: state.dialogForm['signinPassword'] ?? '',
              'data-act': 'form',
              'data-form': 'signinPassword',
            }),
            button({
              icon: state.passwordVisible ? 'eyeOff' : 'eye',
              act: 'password-visibility',
              variant: 'ghost',
              small: true,
              pressed: state.passwordVisible,
              title: t(state, 'إظهار كلمة المرور', 'Show password'),
              extraClass: 'input-affix__button',
            }),
          ]),
          fieldError('signin-password-error', errors['signinPassword']),
        ]),
        button({
          label: busy ? t(state, 'جارٍ الدخول…', 'Signing in…') : t(state, 'دخول', 'Sign in'),
          act: 'live-signin',
          type: 'submit',
          variant: 'primary',
          busy,
          extraClass: 'auth-form__submit',
        }),
      ]),
    ]),
    h('p', { class: 'gate__foot' }, [
      t(state, 'يدير مسؤول مساحة العمل الدعوات واستعادة الوصول.', 'Your workspace administrator manages invitations and access recovery.'),
    ]),
  ]);
}

function fieldError(id: string, message: string | undefined): HTMLElement | null {
  return message === undefined ? null : h('p', { class: 'field__error', id }, [message]);
}

/**
 * Why the attempt failed, without saying which half of the credentials it was.
 */
function signInFailure(state: AppState, error: ApiError): HTMLElement {
  const title =
    error.status === 401
      ? t(state, 'البريد الإلكتروني أو كلمة المرور غير صحيحة.', 'The email or password is incorrect.')
      : error.status === 429
        ? t(state, 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.', 'Too many attempts. Wait a moment, then try again.')
        : error.code === 'network' || error.status === null
          ? t(state, 'تعذّر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.', 'Can’t reach the server. Check your connection, then try again.')
          : error.status >= 500
            ? t(state, 'تعذّر تسجيل الدخول الآن. أعد المحاولة بعد قليل.', 'Sign-in isn’t available right now. Try again shortly.')
            : t(state, 'راجع البريد الإلكتروني وكلمة المرور.', 'Check the email and password you entered.');
  return h('div', { class: 'inline-error', role: 'alert' }, [
    icon('alert', 16),
    h('div', {}, [
      h('p', { class: 'inline-error__title' }, [title]),
      error.status !== null && error.status >= 500 ? requestIdLine(state, error.requestId) : null,
    ]),
  ]);
}

/** The session probe itself failed: nobody can say yet whether you are signed in. */
function unavailable(state: AppState, error: ApiError): HTMLElement {
  return frame(state, [
    h('section', { class: 'auth-card auth-card--status', 'aria-labelledby': 'auth-title' }, [
      brandLockup(),
      h('div', { class: 'auth-card__intro' }, [
        h('h1', { class: 'auth-card__title', id: 'auth-title' }, [
          error.code === 'network'
            ? t(state, 'تعذّر الاتصال بالخادم', 'Can’t reach the server')
            : t(state, 'الخدمة غير متاحة مؤقتًا', 'The service is temporarily unavailable'),
        ]),
        h('p', { class: 'auth-card__lede' }, [
          t(state, 'لم نتمكن من التحقق من جلستك. أعد المحاولة بعد قليل.', 'We couldn’t check your session. Try again in a moment.'),
        ]),
        requestIdLine(state, error.requestId),
      ]),
      button({
        label: t(state, 'إعادة المحاولة', 'Try again'),
        icon: 'refresh',
        act: 'live-session-retry',
        variant: 'primary',
        busy: state.live.busy === 'session-retry',
        extraClass: 'auth-form__submit',
      }),
    ]),
  ]);
}

/** Signed in, but a member of no active company: there is no workspace to open. */
function noWorkspace(state: AppState): HTMLElement {
  return frame(state, [
    h('section', { class: 'auth-card auth-card--status', 'aria-labelledby': 'auth-title' }, [
      brandLockup(),
      h('div', { class: 'auth-card__intro' }, [
        h('h1', { class: 'auth-card__title', id: 'auth-title' }, [
          t(state, 'لا توجد مساحة عمل نشطة', 'No active workspace'),
        ]),
        h('p', { class: 'auth-card__lede' }, [
          t(
            state,
            'حسابك لا ينتمي إلى مساحة عمل نشطة حاليًا. اطلب دعوة من مسؤول مساحة العمل.',
            'Your account isn’t an active member of any workspace. Ask a workspace administrator for an invitation.',
          ),
        ]),
      ]),
      button({
        label: t(state, 'تسجيل الخروج', 'Sign out'),
        icon: 'logout',
        act: 'live-signout',
        busy: state.live.busy === 'sign-out',
        extraClass: 'auth-form__submit',
      }),
    ]),
  ]);
}
