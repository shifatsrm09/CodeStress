import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RepositoryReader } from '../src/repo/repositoryReader.js';
import { RouteScanner } from '../src/repo/routeScanner.js';
import { normalizeAttackPlan } from '../src/attack/attackPlanner.js';
import { discoverAuthentication } from '../src/auth/discoverAuthentication.js';

test('native Node demo routes are discovered with route-local parameters', async () => {
  const repository = await new RepositoryReader({ repo: fileURLToPath(new URL('../demo-app/', import.meta.url)) }).read();
  const analysis = new RouteScanner().analyze(repository);
  const transfer = analysis.routes.find(route => route.path === '/api/transfer');
  const comments = analysis.routes.find(route => route.path === '/api/comments');
  const root = analysis.routes.find(route => route.path === '/');
  assert.deepEqual(transfer.parameters.map(p => p.name), ['amount', 'recipient']);
  assert.deepEqual(comments.parameters.map(p => p.name), ['comment']);
  assert.deepEqual(root.parameters, []);

  const plan = normalizeAttackPlan(repository, analysis);
  assert.ok(plan.tests.some(test => test.type === 'sql_injection' && test.path === '/api/transfer'));
  assert.ok(plan.tests.some(test => test.type === 'xss' && test.path === '/api/comments'));
  assert.ok(!plan.tests.some(test => test.type === 'xss' && test.path === '/api/transfer'));
});

test('native demo authentication discovery finds the login path and credential fields', async () => {
  const discovery = await discoverAuthentication({ repo: fileURLToPath(new URL('../demo-app/', import.meta.url)) });
  assert.equal(discovery.loginPath, '/api/login');
  assert.equal(discovery.emailField, 'email');
  assert.equal(discovery.passwordField, 'password');
  assert.ok(discovery.verificationPaths.includes('/api/dashboard'));
});
