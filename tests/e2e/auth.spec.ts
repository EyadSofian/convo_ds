import { expect, test } from '@playwright/test';
import { EMAIL, installApi, PASSWORD } from './support/api';
import { fontsReady, freezeClock, openInbox, openSignedOut } from './support/workspace';

/**
 * The authentication boundary, in the shipped bundle.
 *
 * The unit suite proves the renderer draws nothing protected without a session.
 * These prove the same of the built page in a real browser: what a visitor
 * without a session can see, what they can ask the server for, and what stays
 * behind in the browser once they leave.
 */

/** Everything that belongs to an open workspace. None of it may exist at the gate. */
const PROTECTED = '.app:not(.app--pending), .nav, .header, .inbox, .page, [data-act="nav"], .header__tenant';

test.describe('without a session', () => {
  test('keeps DS Omnichannel sign-in legible from desktop through phone widths', async ({ page }) => {
    await openSignedOut(page, '#/inbox?lang=en');
    for (const width of [1440, 1024, 768, 430, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.locator('.auth-panel')).toBeVisible();
      if (width > 760) await expect(page.locator('.auth-visual__logo')).toBeVisible();
      else await expect(page.locator('.auth-visual')).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });

  test('sets route, theme and language before the application bundle runs', async ({ page }) => {
    await freezeClock(page);
    await installApi(page, { signedIn: false });
    await page.addInitScript(() => {
      window.localStorage.setItem('convo.theme', 'dark');
      window.localStorage.setItem('convo.lang', 'en');
    });
    let releaseBundle: () => void = () => undefined;
    const bundleGate = new Promise<void>((resolve) => { releaseBundle = resolve; });
    await page.route('**/assets/index-*.js', async (route) => {
      await bundleGate;
      await route.continue();
    });
    await page.goto('/#/channels', { waitUntil: 'commit' });
    await expect(page.locator('#app.app-boot')).toBeVisible();
    // Non-Inbox routes use their own compact skeleton. The status label is
    // intentionally reserved for the Inbox/auth first-paint composition.
    await expect(page.locator('.app-boot__rows .app-boot__row').first()).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('html')).toHaveAttribute('data-boot-screen', 'channels');
    releaseBundle();
    await expect(page.locator('#signin-email')).toBeVisible();
  });

  test('shows only the sign-in page at /#/inbox, and asks the server for nothing else', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/')) requests.push(new URL(request.url()).pathname);
    });
    await openSignedOut(page, '#/inbox');

    await expect(page.locator(PROTECTED)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Digital School');
    await expect(page.locator('form.auth-form')).toBeVisible();
    await expect(page.locator('#signin-email')).toHaveAttribute('autocomplete', 'username');
    await expect(page.locator('#signin-password')).toHaveAttribute('type', 'password');
    // The address is kept, so signing in lands on the screen that was asked for.
    expect(page.url()).toContain('#/inbox');
    expect(requests).toEqual(['/api/v1/auth/session']);
  });

  test('draws a data-free app-shell skeleton, and nothing protected, while checking the session', async ({ page }) => {
    await freezeClock(page);
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    await installApi(page);
    await page.route('**/api/v1/auth/session', async (route) => {
      await answered;
      await route.fallback();
    });
    await page.goto('/#/channels');
    await expect(page.locator('.app--pending')).toBeVisible();
    await expect(page.locator('.app--pending[role="status"]')).toContainText('جارٍ التحقق من الجلسة');
    await expect(page.locator('.app-pending__identity')).toContainText('نجهّز مساحة عملك');
    await expect(page.locator(PROTECTED)).toHaveCount(0);
    release();
    await expect(page.locator('.page--channels')).toBeVisible();
  });

  test('never offers to view the workspace as another role', async ({ page }) => {
    await openSignedOut(page, '#/analytics?as=owner');
    await expect(page.locator('body')).not.toContainText('اعرض كـ');
    await expect(page.locator('[data-act="role"]')).toHaveCount(0);
  });
});

test.describe('signing in', () => {
  test('retains the session after reload in a phone-sized standalone app shell', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query: string) => query === '(display-mode: standalone)'
        ? { ...original(query), matches: true }
        : original(query);
    });
    await openSignedOut(page, '#/inbox?lang=en');
    const manifest = await page.request.get('/manifest.webmanifest');
    expect(manifest.ok()).toBe(true);
    expect((await manifest.json() as { display: string; start_url: string })).toMatchObject({ display: 'standalone', start_url: '/#/inbox' });
    await page.locator('#signin-email').fill(EMAIL);
    await page.locator('#signin-password').fill(PASSWORD);
    await page.locator('.auth-form__submit').click();
    await expect(page.locator('.inbox')).toBeVisible();
    await page.reload();
    await expect(page.locator('.inbox')).toBeVisible();
    await expect(page.locator('#signin-email')).toHaveCount(0);
  });

  test('uses phone password-manager values even when autofill emits no input event', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSignedOut(page, '#/inbox?lang=en');
    await page.locator('#signin-email').evaluate((element, value) => { (element as HTMLInputElement).value = value; }, EMAIL);
    await page.locator('#signin-password').evaluate((element, value) => { (element as HTMLInputElement).value = value; }, PASSWORD);
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(page.locator('#signin-password')).toHaveValue(PASSWORD);
    await expect(page.locator('#signin-password')).toHaveAttribute('type', 'text');
    await page.locator('.auth-form__submit').click();
    await expect(page.locator('.inbox')).toBeVisible();
  });

  test('accepts the same account on a phone viewport through the normal sign-in form', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSignedOut(page, '#/inbox?lang=en');
    await page.locator('#signin-email').fill(EMAIL);
    await page.locator('#signin-password').fill(PASSWORD);
    await page.locator('.auth-form__submit').click();

    await expect(page.locator('.inbox')).toBeVisible();
    await expect(page.locator('.header__tenant')).toHaveText('Digital School');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('stays on the sign-in page with one sentence for a wrong address or password', async ({ page }) => {
    await openSignedOut(page, '#/inbox');
    await page.locator('#signin-email').fill(EMAIL);
    await page.locator('#signin-password').fill('not the password');
    await page.locator('#signin-password').press('Enter');

    const alert = page.locator('.auth-card [role="alert"]');
    await expect(alert).toContainText('البريد الإلكتروني أو كلمة المرور غير صحيحة');
    await expect(page.locator(PROTECTED)).toHaveCount(0);
    // The password is not kept for another try.
    await expect(page.locator('#signin-password')).toHaveValue('');
    await expect(page.locator('#signin-email')).toHaveValue(EMAIL);
  });

  test('checks the form in place before sending anything', async ({ page }) => {
    const logins: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/auth/login')) logins.push(request.url());
    });
    await openSignedOut(page, '#/inbox');
    await page.locator('.auth-form__submit').click();
    await expect(page.locator('#signin-email')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#signin-email-error')).toBeVisible();
    await expect(page.locator('#signin-password-error')).toBeVisible();
    expect(logins).toEqual([]);
  });

  test('opens the screen that was asked for, with the roles the server granted', async ({ page }) => {
    await openSignedOut(page, '#/channels');
    await page.locator('#signin-email').fill(EMAIL);
    await page.locator('#signin-password').fill(PASSWORD);
    await page.locator('.auth-form__submit').click();

    await expect(page.locator('.page--channels')).toBeVisible();
    await expect(page.locator('.nav__item[aria-current="page"]')).toHaveAttribute('data-arg', 'channels');
    await expect(page.locator('.header__tenant')).toHaveText('Digital School');
    await fontsReady(page);

    // Nothing that identifies the person, their password or their session is
    // written to the browser's storage: the session is an HttpOnly cookie.
    const stored = await page.evaluate(() => JSON.stringify({ ...window.localStorage, ...window.sessionStorage }));
    expect(stored).not.toContain(EMAIL);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toMatch(/session|token|csrf/i);
  });
});

test.describe('leaving', () => {
  test('signs out from the user menu through the server and returns to the sign-in page', async ({ page }) => {
    const logouts: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/auth/logout')) logouts.push(request.method());
    });
    await openInbox(page);
    await page.locator('.user-button').click();
    await expect(page.locator('#user-menu')).toBeVisible();
    await page.locator('#user-menu [data-act="live-signout"]').click();

    await expect(page.locator('#signin-email')).toBeVisible();
    await expect(page.locator(PROTECTED)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('مساء الخير');
    expect(logouts).toEqual(['POST']);
  });

  test('closes the workspace when a later request says the session has ended', async ({ page }) => {
    await openInbox(page);
    await page.route('**/api/v1/tenants/*/people', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unauthenticated', message: 'Sign in.' } }) }),
    );
    await page.locator('.nav__item[data-arg="people"]').click();

    await expect(page.locator('#signin-email')).toBeVisible();
    await expect(page.locator('.auth-card [role="status"]')).toContainText('انتهت جلستك');
    await expect(page.locator(PROTECTED)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('مساء الخير');
  });
});

test.describe('links delivered by email', () => {
  const TOKEN = `e2eEmailedToken_${'a'.repeat(27)}`;

  for (const [route, submitPath] of [
    ['accept-invitation', `/api/v1/invitations/${TOKEN}/accept`],
    ['reset-password', '/api/v1/auth/recovery/complete'],
  ] as const) {
    test(`${route}: the emailed token survives the first render and reaches the server`, async ({ page }) => {
      await freezeClock(page);
      await installApi(page, { signedIn: false });
      const submitted: string[] = [];
      await page.route(`**${submitPath}`, async (fulfil) => {
        submitted.push(new URL(fulfil.request().url()).pathname);
        const body = fulfil.request().postDataJSON() as Record<string, unknown>;
        if (route === 'reset-password') expect(body['token']).toBe(TOKEN);
        await fulfil.fulfill(route === 'reset-password'
          ? { status: 204 }
          : { status: 200, contentType: 'application/json', body: JSON.stringify({ data: { tenant_id: 't', membership_id: 'm' } }) });
      });
      await page.goto(`/#/${route}?token=${TOKEN}&lang=en`);
      const passwords = page.locator('input[type="password"]');
      await expect(passwords.first()).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`token=${TOKEN}`));
      await expect(page.locator('.auth-card [role="alert"]')).toHaveCount(0);
      for (let index = 0; index < await passwords.count(); index += 1) await passwords.nth(index).fill('correct horse battery staple');
      await page.locator('button[type="submit"]').first().click();
      await expect.poll(() => submitted.length).toBe(1);
      // Done: straight to sign-in, which says what just happened.
      await expect(page.locator('#signin-email')).toBeVisible();
      await expect(page.locator('.auth-notice')).toContainText(route === 'reset-password' ? 'Password changed' : 'Invitation accepted');
      await expect(page).not.toHaveURL(/token=/);
    });
  }

  test('asking for a reset link returns to sign-in with the address typed', async ({ page }) => {
    await freezeClock(page);
    await installApi(page, { signedIn: false });
    await page.route('**/api/v1/auth/recovery', (fulfil) => fulfil.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ data: { status: 'accepted', message: 'ok' } }) }));
    await page.goto('/#/reset-password?lang=en');
    await page.locator('#recovery-email').fill('person@example.test');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#signin-email')).toHaveValue('person@example.test');
    await expect(page.locator('.auth-notice')).toContainText('Check your email');
    await expect(page).toHaveURL(/#\/inbox/);
  });
});
