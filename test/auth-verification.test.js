import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAuthentication, normalizeCookie } from '../src/auth/verifyAuthentication.js';
import { Stage0Confirm } from '../src/pipeline/stage0Confirm.js';

const json = (status, data, headers = {}) => ({ status, data, headers: { 'content-type': 'application/json', ...headers } });
function stub({ login = json(200, { token: 'real-session' }), anonymous = json(401, {}), invalid = json(401, {}), authenticated = json(200, { user: { studentId: '24101128' } }) } = {}) {
  const calls = [];
  return { calls, post: async (url, payload, options) => { calls.push({ method: 'POST', url, payload, options }); return login; },
    get: async (url, options) => {
      calls.push({ method: 'GET', url, options });
      if (options.headers.Authorization?.includes('codestress-invalid-') || options.headers.Cookie?.includes('codestress-invalid-')) return invalid;
      return options.headers.Authorization || options.headers.Cookie ? authenticated : anonymous;
    }
  };
}
const setup = { target: 'http://localhost:3000', authId: '24101128', authIdField: 'studentId', authVerifyPath: '/api/auth/me' };

test('CourseCompass onboarding response never authenticates a string or invents a user', async () => {
  const http = stub({ login: json(200, { firstLogin: true, user: null }) });
  const result = await verifyAuthentication({ ...setup, authId: 'not-an-integer' }, http);
  assert.equal(result.status, 'UNVERIFIED'); assert.equal(result.authenticated, false); assert.equal(result.user, undefined);
  assert.equal(http.calls.length, 1); assert.equal(http.calls[0].url, 'http://localhost:3000/api/auth/login');
});

test('HTML fallback, explicit rejection and user lookup do not prove a session', async () => {
  for (const login of [
    { status: 200, data: '<html>App</html>', headers: { 'content-type': 'text/html' } },
    json(200, { success: false, token: 'real-session' }),
    json(200, { firstLogin: false, user: { studentId: '24101128' } }),
    json(200, { success: true }), json(302, {}, { location: '/' })
  ]) assert.notEqual((await verifyAuthentication(setup, stub({ login }))).status, 'SUCCESS');
});

test('login rejection is final: no alternate fields, paths, or backend-port guessing', async () => {
  const http = stub({ login: json(400, { error: 'Invalid student ID' }) });
  const result = await verifyAuthentication({ ...setup, authId: 'abc' }, http);
  assert.equal(result.status, 'FAILED'); assert.equal(http.calls.length, 1);
  assert.deepEqual(http.calls[0].payload, { studentId: 'abc' });
});

test('verified requires negative controls and matching current-user identity', async () => {
  const http = stub(); const result = await verifyAuthentication(setup, http);
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.authenticated, true);
  assert.deepEqual(result.evidence.map(check => check.httpStatus), [200, 401, 401, 200]);
  assert.ok(http.calls.every(call => call.options.maxRedirects === 0));
  assert.ok(!JSON.stringify(result.evidence).includes('real-session'));
  const { session, ...publicResult } = result;
  assert.equal(session.bearer, 'real-session'); assert.ok(!JSON.stringify(publicResult).includes('real-session'));
});

test('public endpoints, invalid-token acceptance and wrong identities stay unverified', async () => {
  for (const responses of [
    { anonymous: json(200, { user: { studentId: '24101128' } }) },
    { invalid: json(200, { user: { studentId: '24101128' } }) },
    { authenticated: json(200, { user: { studentId: 'other' } }) },
    { authenticated: json(200, { success: true }) },
    { authenticated: { status: 200, data: '<html>Login</html>', headers: { 'content-type': 'text/html' } } }
  ]) assert.equal((await verifyAuthentication(setup, stub(responses))).status, 'UNVERIFIED');
});

test('bearer and cookie rejection and request failures never imply authentication', async () => {
  for (const credentials of [{ bearer: 'expired' }, { cookie: 'session=expired' }]) {
    const result = await verifyAuthentication({ target: setup.target, authVerifyPath: setup.authVerifyPath, ...credentials }, stub({ authenticated: json(401, { error: 'Invalid session' }) }));
    assert.equal(result.status, 'FAILED'); assert.equal(result.authenticated, false);
    const unavailable = await verifyAuthentication({ target: setup.target, authVerifyPath: setup.authVerifyPath, ...credentials }, { get: async () => { throw new Error('network'); } });
    assert.equal(unavailable.status, 'UNVERIFIED');
  }
});

test('automatic verification discovers common endpoints and rejects cross-origin overrides', async () => {
  assert.equal((await verifyAuthentication({ target: setup.target, bearer: 'token' }, stub())).status, 'SUCCESS');
  const http = stub();
  assert.equal((await verifyAuthentication({ ...setup, authVerifyPath: '//localhost:5000/api/me' }, http)).status, 'UNVERIFIED');
  assert.equal(http.calls.length, 0);
});

test('cookie verification respects cookie scope and strips cookie attributes', async () => {
  const http = stub({ login: json(200, {}, { 'set-cookie': ['session=real-session; Path=/; HttpOnly'] }) });
  assert.equal((await verifyAuthentication(setup, http)).status, 'SUCCESS');
  assert.equal(http.calls.at(-1).options.headers.Cookie, 'session=real-session');
  const outsideScope = stub({ login: json(200, {}, { 'set-cookie': ['session=value; Path=/other'] }) });
  assert.equal((await verifyAuthentication(setup, outsideScope)).status, 'UNVERIFIED');
  assert.equal(outsideScope.calls.length, 1);
});

test('Stage 0 does not analyze code or advance after unverified authentication', async () => {
  const stage = new Stage0Confirm({ target: setup.target, yes: true });
  stage.pingTarget = async () => ({ reachable: true });
  stage.testAuth = async () => ({ status: 'UNVERIFIED', authenticated: false, detail: 'No session proof' });
  stage.discoverRoutes = async () => { throw new Error('Must not run'); };
  stage.askUserConfirmation = async () => { throw new Error('Must not advance'); };
  assert.equal((await stage.execute()).confirmed, false);
});


test('pasted cookie header preserves encoded values and verifies without an endpoint input', async () => {
  const http = stub();
  const result = await verifyAuthentication({ target: setup.target, cookie: 'Cookie: session=abc%2Fdef==; preference=dark' }, http);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(http.calls.at(-1).options.headers.Cookie, 'session=abc%2Fdef==; preference=dark');
  assert.ok(!JSON.stringify(result.evidence).includes('abc%2Fdef'));
  assert.throws(() => normalizeCookie('session=x; HttpOnly'));
  assert.throws(() => normalizeCookie('session=x\r\nOther: injected'));
});

test('automatic discovery skips public routes without exposing the real cookie', async () => {
  const calls = [];
  const http = { get: async (url, options) => {
    calls.push({ url, headers: options.headers });
    if (!url.endsWith('/api/users/me')) return json(200, { page: 'public' });
    const cookie = options.headers.Cookie;
    return !cookie || cookie.includes('codestress-invalid-') ? json(401, {}) : json(200, { user: { id: 7 } });
  } };
  const result = await verifyAuthentication({ target: setup.target, cookie: 'session=real' }, http);
  assert.equal(result.status, 'SUCCESS');
  assert.ok(calls.filter(call => call.headers.Cookie === 'session=real').every(call => call.url.endsWith('/api/users/me')));
});


test('source discovery resolves mounted login fields without executing source', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { discoverAuthentication } = await import('../src/auth/discoverAuthentication.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codestress-auth-'));
  try {
    await fs.writeFile(path.join(root, 'app.js'), `const authRoutes = require('./auth'); app.use('/api/auth', requireDatabase, authRoutes);`);
    await fs.writeFile(path.join(root, 'auth.js'), `router.post('/login', (req, res) => { const { studentId, password } = req.body; }); router.get('/whoami', requireAuth, handler); throw new Error('Must never execute');`);
    const result = await discoverAuthentication({ repo: root });
    assert.equal(result.authIdField, 'studentId');
    assert.equal(result.loginPath, '/api/auth/login');
    assert.equal(result.verificationPaths[0], '/api/auth/whoami');
  } finally {
    await fs.unlink(path.join(root, 'app.js'));
    await fs.unlink(path.join(root, 'auth.js'));
    await fs.rmdir(root);
  }
});
