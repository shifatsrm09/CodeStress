import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Assessment } from '../src/pipeline/assessment.js';
import { planAuthentication } from '../src/auth/authenticationPlanner.js';
import { verifyAuthentication } from '../src/auth/verifyAuthentication.js';
import { redactMemory, sourceFingerprint } from '../src/memory/projectMemory.js';

const guard = "app.get('/dashboard', requireAuth, dashboard);";
const repository = {
  source: { type: 'local', location: '/fixture' },
  coverage: { complete: true, filesRead: 1, bytesRead: 100, excludedEntries: 0, skippedFiles: 0, failedEntries: 0 },
  inventory: [{ path: 'app.js', status: 'read', bytes: 100, sha256: 'one' }],
  files: [{ path: 'app.js', sha256: 'one', content: `${guard}\nconst template = '<h1>Your private workspace</h1>';` }]
};
const plan = { kind: 'oauth', reason: 'Protected app session', checks: [{ path: '/dashboard', format: 'html', marker: 'Your private workspace', loginPath: '/login', evidence: [{ file: 'app.js', line: 1, quote: guard }] }] };
function fakeHttp(calls, publicPage = false) {
  return { get: async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://example.test/') return { status: 200 };
    const cookie = options.headers?.Cookie;
    if (!publicPage && (!cookie || cookie.includes('codestress-invalid-'))) return { status: 302, headers: { location: '/login' }, data: '' };
    return { status: 200, headers: { 'content-type': 'text/html' }, data: '<h1>Your private workspace</h1>' };
  } };
}

test('OAuth app cookies verify source-backed HTML, without following redirects', async () => {
  const calls = [];
  const result = await verifyAuthentication({ target: 'https://example.test', cookie: 'app_session=valid', authPlan: plan }, fakeHttp(calls));
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.verificationKind, 'protected-page');
  assert.equal(result.user, undefined);
  assert.deepEqual(result.evidence.map(item => item.httpStatus), [302, 302, 200]);
  assert.ok(calls.every(call => call.options.maxRedirects === 0));
});

test('a public HTML shell cannot validate a cookie', async () => {
  const calls = [];
  const result = await verifyAuthentication({ target: 'https://example.test', cookie: 'app_session=valid', authPlan: plan }, fakeHttp(calls, true));
  assert.equal(result.status, 'UNVERIFIED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Cookie, undefined);
});

test('planner discards fabricated citations and outside-origin routes', async () => {
  for (const check of [
    { ...plan.checks[0], path: '//another.test/me' },
    { ...plan.checks[0], evidence: [{ file: 'missing.js', line: 1, quote: guard }] },
    { ...plan.checks[0], marker: 'Fabricated marker' }
  ]) {
    const result = await planAuthentication({ repository, report: { chunkNotes: [] }, mode: 'cookie', ai: { analyzeSource: async () => JSON.stringify({ ...plan, checks: [check] }) } });
    assert.equal(result.checks.length, 0);
  }
});

test('planner can request a specific source range before choosing its route', async () => {
  let requests = 0;
  const result = await planAuthentication({ repository, report: { chunkNotes: [] }, mode: 'cookie', ai: { analyzeSource: async (_instruction, source) => {
    requests++;
    if (requests === 1) return JSON.stringify({ read: [{ file: 'app.js', startLine: 1, endLine: 2 }, { file: '../../outside', startLine: 1, endLine: 20 }] });
    const context = JSON.parse(source);
    assert.ok(context.excerpts.some(item => item.path === 'app.js' && item.content.includes(guard)));
    assert.ok(context.excerpts.every(item => item.path !== '../../outside'));
    return JSON.stringify(plan);
  } } });
  assert.equal(requests, 2);
  assert.equal(result.checks[0].path, '/dashboard');
});

test('OAuth password input never triggers a guessed POST', async () => {
  const result = await verifyAuthentication({ target: 'https://example.test', email: 'person@example.test', password: 'secret', authPlan: plan }, { post: async () => { throw new Error('Must not POST'); } });
  assert.equal(result.status, 'UNVERIFIED');
  assert.match(result.detail, /interactive OAuth/);
  assert.equal(result.evidence.length, 0);
});

test('memory invalidates source changes and redacts values without corrupting JSON', () => {
  assert.notEqual(sourceFingerprint(repository, 'model'), sourceFingerprint({ ...repository, files: [{ ...repository.files[0], sha256: 'changed' }] }, 'model'));
  assert.notEqual(sourceFingerprint(repository, 'model'), sourceFingerprint(repository, 'other-model'));
  const redacted = redactMemory({ nested: ['cookie=secret', 12345], note: 'quoted "secret"' }, ['secret', '12345']);
  assert.deepEqual(JSON.parse(JSON.stringify(redacted)).nested, ['cookie=[redacted]', '[redacted]']);
});

test('unified assessment runs browser automation pipeline and generates test report', async () => {
  const calls = [], phases = [], writes = [];
  let sourceRequests = 0;
  const ai = { model: 'fixture', analyzeSource: async instruction => {
    if (instruction.startsWith('Explain this source')) sourceRequests++;
    return 'app.js:1 uses requireAuth to protect the dashboard and its session.';
  } };
  const memory = { state: { notes: [] }, async load() { return this.state; }, async save(update) { this.state = { ...this.state, ...update }; writes.push(update); } };
  const mockSelenium = {
    on: () => {},
    launch: async () => ({ browser: 'MockBrowser', target: 'https://example.test' }),
    getSession: async () => ({ cookies: [{ name: 'app_session', value: 'valid', httpOnly: true, secure: true }], cookie_count: 1, storage: {} }),
    runTests: async () => ({ total: 5, passed: 5, vulnerable: 0, warnings: 0 }),
    close: () => {},
    setIndicators: () => {},
    checkAuth: async () => ({ authenticated: true, status: 'SIGNED_IN', cookies: [{ name: 'app_session', value: 'valid' }] })
  };
  const options = {
    target: 'https://example.test', repo: '.', repository, memory, ai,
    selenium: mockSelenium,
    http: fakeHttp(calls),
    onEvent: event => {
      if (event.type === 'assessment_phase') phases.push(event.phase);
    }
  };
  const result = await new Assessment(options).execute();
  assert.equal(result.status, 'complete');
  assert.deepEqual(phases, ['reachability', 'browser_launch', 'reading', 'understanding', 'waiting_auth', 'generating_tests', 'running_tests', 'complete']);
  assert.equal(sourceRequests, 1);
  assert.ok(result.report?.aiUnderstanding);
  assert.equal(result.testSummary?.passed, 5);
  await new Assessment(options).execute();
  assert.equal(sourceRequests, 1, 'unchanged source notes should be reused');
});


test('unreachable target does not overwrite existing project memory or call AI', async () => {
  let wrote = false;
  const assessment = new Assessment({ target: 'https://example.test', repo: '.',
    http: { get: async () => { throw new Error('offline'); } },
    ai: { analyzeSource: async () => { throw new Error('Must not call AI'); } },
    memory: { save: async () => { wrote = true; }, load: async () => ({ notes: [] }) }
  });
  await assert.rejects(assessment.execute(), /could not be reached/);
  assert.equal(wrote, false);
});
