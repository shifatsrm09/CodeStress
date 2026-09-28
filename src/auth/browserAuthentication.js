import { verifyAuthentication } from './verifyAuthentication.js';
import { AppError } from '../core/runtime.js';

export async function verifyBrowserAuthentication(session, plan, http) {
  const allEvidence = [];
  for (const check of plan.checks || []) {
    const url = session.safeURL(check.path);
    const cookies = await session.context.cookies(url);
    const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ');
    const result = await verifyAuthentication({ target: session.manager.target.href, authPlan: { ...plan, checks: [check] }, cookie, bearer: session.bearer }, http);
    allEvidence.push(...result.evidence);
    if (result.authenticated) { const { session: privateSession, ...safe } = result; return { ...safe, evidence: allEvidence }; }
  }
  // Browser-rendered pages may not expose authenticated markup in the initial HTTP response.
  for (const check of (plan.checks || []).filter(item => item.format === 'html').slice(0, 3)) {
    const state = await session.state();
    const invalidState = { cookies: state.cookies.map(item => ({ ...item, value: 'codestress-invalid-session' })), origins: state.origins.map(origin => ({ ...origin, localStorage: origin.localStorage.map(item => ({ ...item, value: 'codestress-invalid-session' })) })), sessionStorage: Object.fromEntries(Object.keys(state.sessionStorage || {}).map(key => [key, 'codestress-invalid-session'])) };
    const contexts = [];
    try {
      const views = [];
      for (const [label, stateValue, bearer] of [['Without credentials', undefined, ''], ['With invalid credentials', invalidState, session.bearer ? 'codestress-invalid-token' : ''], ['With credentials', state, session.bearer]]) {
        const isolated = await session.manager.session({ state: stateValue, bearer, policy: {} }); contexts.push(isolated);
        const response = await isolated.page.goto(isolated.safeURL(check.path), { waitUntil: 'domcontentloaded' });
        // Wait for the expected protected marker or source-derived login route without an arbitrary sleep.
        await isolated.page.waitForFunction(({ marker, loginPath }) => document.body?.innerText.includes(marker) || (loginPath && location.pathname === loginPath), { marker: check.marker, loginPath: check.loginPath }, { timeout: 5000 }).catch(() => {});
        const url = new URL(isolated.page.url());
        const hasMarker = await isolated.page.getByText(check.marker, { exact: false }).first().isVisible().catch(() => false);
        views.push({ status: response?.status() || 0, denied: [401, 403].includes(response?.status()) || Boolean(check.loginPath && url.origin === session.manager.target.origin && url.pathname === check.loginPath), hasMarker });
        allEvidence.push({ step: label + ' (browser)', endpoint: session.redactor.url(check.path.startsWith('/') ? new URL(check.path, session.manager.target).href : check.path), httpStatus: response?.status() || 0 });
      }
      if (views[0].denied && views[1].denied && !views[0].hasMarker && !views[1].hasMarker && views[2].hasMarker && !views[2].denied && views[2].status >= 200 && views[2].status < 300) return { status: 'SUCCESS', authenticated: true, type: 'Browser session', detail: 'Protected content appeared only in the authenticated browser; anonymous and invalid sessions were denied.', evidence: allEvidence };
    } catch { /* Continue to other supported checks; never infer success. */ }
    finally { await Promise.all(contexts.map(context => context.close().catch(() => {}))); }
  }
  return { status: 'UNVERIFIED', authenticated: false, type: 'Browser session', detail: 'The browser session could not be verified with source-backed negative controls.', evidence: allEvidence };
}

export async function establishAuthentication({ options, session, plan, http, prompt, emit }) {
  if (options.authMode === 'none') return { status: 'PUBLIC', authenticated: false, type: 'unauthenticated', detail: 'Public testing selected. Protected scenarios will be skipped.', evidence: [] };
  await session.setCredentials(options);
  if (options.email || options.username || options.authId) {
    const result = await verifyAuthentication({ ...options, authPlan: plan }, http);
    if (result.session) await session.setCredentials(result.session);
    const { session: privateSession, ...safe } = result;
    emit({ type: 'authentication_result', data: safe });
    if (result.authenticated) return safe;
  }
  let verification = await verifyBrowserAuthentication(session, plan, http);
  if (verification.authenticated) return verification;
  emit({ type: 'authentication_result', data: verification });
  session.manual = true;
  await session.page.goto(session.safeURL(plan.loginPath || options.target), { waitUntil: 'domcontentloaded' });
  const answer = await prompt({ kind: 'authentication', prompt: 'Complete sign-in in the browser', detail: 'Use your normal login, OAuth consent or MFA. Return to the target website, then continue. Cookie presence is not proof of authentication.' });
  session.manual = false;
  if (!answer?.proceed) throw new AppError('AUTH_BLOCKED', 'Manual authentication was skipped or timed out.');
  if (!session.inScope(session.page.url())) throw new AppError('AUTH_BLOCKED', 'Return to the target website after completing authentication.');
  await session.learnSecrets();
  verification = await verifyBrowserAuthentication(session, plan, http);
  return verification;
}
