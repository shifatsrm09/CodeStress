import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttackEngine } from '../src/attack/attackEngine.js';
import { normalizeAttackPlan } from '../src/attack/attackPlanner.js';
import { buildReport } from '../src/report/reportGenerator.js';

const repository = {
  source: { type: 'local', location: '/demo' },
  coverage: { filesRead: 1 },
  files: [{ path: 'server.js', content: '' }]
};

const routes = {
  routes: [
    { method: 'POST', path: '/api/login', file: 'server.js', line: 1, parameters: [{ name: 'email', in: 'body' }, { name: 'password', in: 'body' }] },
    { method: 'POST', path: '/api/transfer', file: 'server.js', line: 2, parameters: [{ name: 'recipient', in: 'body' }, { name: 'amount', in: 'body' }] },
    { method: 'GET', path: '/api/users/:id', file: 'server.js', line: 3, parameters: [{ name: 'id', in: 'path' }] },
    { method: 'POST', path: '/api/comments', file: 'server.js', line: 4, parameters: [{ name: 'comment', in: 'body' }] },
    { method: 'GET', path: '/api/dashboard', file: 'server.js', line: 5, parameters: [] }
  ],
  routeGroups: 3, endpoints: 5, dbQueries: []
};

test('heuristic planner produces demo-relevant security tests', () => {
  const plan = normalizeAttackPlan(repository, routes);
  const types = new Set(plan.tests.map(t => t.type));
  assert.ok(types.has('rate_limit'));
  assert.ok(types.has('idor'));
  assert.ok(types.has('auth_bypass'));
  assert.ok(types.has('xss'));
  assert.ok(types.has('null_input'));
  assert.equal(plan.tests.some(t => t.type === 'auth_bypass' && t.path === '/api/login'), false);
});

test('attack engine classifies bounded demo responses', async () => {
  const http = {
    async request(url, options = {}) {
      const u = new URL(url);
      if (u.pathname === '/api/users/1') return { status: 200, data: { user: { id: 1, email: 'other@example.com' } } };
      if (u.pathname === '/api/users/2') return { status: 200, data: { user: { id: 2, email: 'me@example.com' } } };
      if (u.pathname === '/api/comments') return { status: 200, data: { comment: JSON.parse(options.body).comment } };
      if (u.pathname === '/api/transfer') return { status: 200, data: { executedQuery: `UPDATE accounts SET balance = ${JSON.parse(options.body).amount}` } };
      if (u.pathname === '/api/login') return { status: 401, data: { error: 'Invalid email or password' } };
      if (u.pathname === '/api/dashboard' || u.pathname === '/api/users/3') return { status: 401, data: { error: 'Unauthorized' } };
      return { status: 404, data: { error: 'not found' } };
    },
    async burst(url, options, count) {
      return Array.from({ length: count }, () => ({ status: 401, data: { error: 'Invalid email or password' } }));
    }
  };
  const plan = { tests: [
    { type: 'sql_injection', method: 'POST', path: '/api/transfer', file: 'server.js', parameter: 'amount' },
    { type: 'xss', method: 'POST', path: '/api/comments', file: 'server.js', parameter: 'comment' },
    { type: 'idor', method: 'GET', path: '/api/users/:id', file: 'server.js', parameter: 'id' },
    { type: 'rate_limit', method: 'POST', path: '/api/login', file: 'server.js' },
    { type: 'auth_bypass', method: 'GET', path: '/api/dashboard', file: 'server.js' }
  ] };
  const engine = new AttackEngine({
    target: 'http://demo.test', repository, routeAnalysis: routes, plan,
    authentication: { bearer: 'demo', user: { id: 2 } }, http
  });
  const result = await engine.execute();
  assert.equal(result.failed, 4);
  assert.ok(result.results.some(r => r.type === 'sql_injection' && r.status === 'FAILED'));
  assert.ok(result.results.some(r => r.type === 'xss' && r.status === 'FAILED'));
  assert.ok(result.results.some(r => r.type === 'idor' && r.status === 'FAILED'));
  assert.ok(result.results.some(r => r.type === 'rate_limit' && r.status === 'FAILED'));
  assert.ok(result.results.some(r => r.type === 'auth_bypass' && r.status === 'PASSED'));
});

test('report generator includes score, findings and fixes', () => {
  const markdown = buildReport({ target: 'http://demo.test', repository, routeAnalysis: routes,
    authentication: { status: 'SUCCESS' }, attackPlan: { tests: [] },
    attackSummary: { testsRun: 1, passed: 0, failed: 1, warnings: 0, score: 70, rating: 'Needs Attention', results: [{ type: 'idor', method: 'GET', path: '/api/users/:id', status: 'FAILED', severity: 'HIGH', detail: 'Cross-object access', recommendation: 'Enforce ownership.' }] }
  });
  assert.match(markdown, /Security Score/);
  assert.match(markdown, /IDOR/i);
  assert.match(markdown, /Enforce ownership/);
});
