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

/** The branded wait while the session probe is in flight. */
export function loadingScreen(state: AppState): HTMLElement {
  return h('div', { class: 'gate gate--loading' }, [
    h('div', { class: 'gate__loading', role: 'status', 'aria-live': 'polite' }, [
      brandLockup(),
      h('span', { class: 'spinner spinner--lg', 'aria-hidden': 'true' }),
      h('p', { class: 'gate__status' }, [t(state, 'جارٍ التحقق من الجلسة…', 'Checking your session…')]),
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
