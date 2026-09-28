import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIProvider } from '../src/engine/provider.js';
import { validateAction, actionRisk } from '../src/browser/actionSchema.js';
import { validateScenarios } from '../src/testing/scenarios.js';
import { evaluateExpectations } from '../src/testing/evaluator.js';
import { Redactor } from '../src/core/redaction.js';
import { AppError, bounded } from '../src/core/runtime.js';
import { TestAgent } from '../src/testing/testAgent.js';
import { ProjectMemory } from '../src/memory/projectMemory.js';

test('structured provider repairs malformed JSON once without accepting invalid shapes', async () => {
  const responses = ['not JSON', '{"value":1}'];
  const provider = new AIProvider({ analyzeSource: async () => responses.shift() });
  const result = await provider.structuredGenerate('JSON', {}, value => { if (!Number.isInteger(value.value)) throw new Error(); return value; });
  assert.equal(result.value, 1);
  let calls = 0;
  const broken = new AIProvider({ analyzeSource: async () => { calls++; return '{}'; } });
  await assert.rejects(broken.structuredGenerate('JSON', {}, () => { throw new Error(); }), error => error.code === 'AI_SCHEMA');
  assert.equal(calls, 2);
});

test('actions reject executable code, oversize waits and implicit file paths', () => {
  for (const action of [{ action: 'evaluate', code: 'process.exit()' }, { action: 'wait', ms: 999999 }, { action: 'upload', target: { label: 'File' }, fileId: '../secret' }, { action: 'click', target: { css: 'button' }, code: 'evil' }]) assert.throws(() => validateAction(action));
  assert.equal(actionRisk({ action: 'click', target: { role: 'button', name: 'Delete account' } }), 'DANGEROUS');
  assert.equal(actionRisk({ action: 'fill' }), 'CAUTION');
});

test('missing network evidence is uncertain, not a pass or a vulnerability', async () => {
  const result = await evaluateExpectations({ expected: [{ type: 'httpStatus', path: '/admin', statuses: [403] }] }, {}, [{ url: 'https://example.test/admin', network: [], evidenceId: 'e1' }]);
  assert.equal(result.status, 'UNCERTAIN');
  const observed = await evaluateExpectations({ expected: [{ type: 'httpStatus', path: '/admin', statuses: [403] }] }, {}, [{ url: 'https://example.test/admin', network: [{ kind: 'response', url: 'https://example.test/admin', status: 200 }], evidenceId: 'e1' }]);
  assert.equal(observed.status, 'FAIL');
});

test('scenario citations and role preconditions cannot be fabricated', () => {
  const repository = { files: [{ path: 'app.js', content: "app.get('/admin', requireAdmin, handler);" }] };
  const scenario = { id: 'TEST-001', name: 'Admin', category: 'authorization', priority: 'high', risk: 'SAFE', session: 'authenticated', preconditions: [], steps: [{ action: 'navigate', url: '/admin' }], expected: [{ type: 'httpStatus', path: '/admin', statuses: [403] }], sourceEvidence: [{ file: 'app.js', line: 1, quote: "app.get('/admin', requireAdmin, handler);" }] };
  assert.throws(() => validateScenarios([scenario], repository));
  assert.equal(validateScenarios([{ ...scenario, requiredRole: 'user' }], repository).length, 1);
  assert.throws(() => validateScenarios([{ ...scenario, requiredRole: 'user', sourceEvidence: [{ file: 'app.js', line: 999, quote: 'fictional' }] }], repository));
});

test('redactor strips known values, sensitive keys, JWTs and URL query credentials', () => {
  const redact = new Redactor(['private-session-value']);
  const safe = redact.clean({ password: 'unknown-password', text: 'value=private-session-value', nested: { authorization: 'Bearer xxx' } });
  assert.ok(!JSON.stringify(safe).includes('private-session-value'));
  assert.ok(!JSON.stringify(safe).includes('unknown-password'));
  assert.equal(redact.url('https://example.test/me?token=secret#secret'), 'https://example.test/me');
});

test('bounded operations respond to cancellation', async () => {
  const controller = new AbortController();
  const promise = bounded(() => new Promise(() => {}), 10000, controller.signal); controller.abort();
  await assert.rejects(promise, error => error.code === 'CANCELED');
});

test('memory serializes concurrent checkpoints', async () => {
  const memory = new ProjectMemory('a'.repeat(64)); const order = [];
  memory.write = async update => { order.push(update.step); };
  await Promise.all([memory.save({ step: 1 }), memory.save({ step: 2 })]);
  assert.deepEqual(order, [1, 2]);
});

test('browser action failure cannot become PASS; repeated failure recovery is bounded', async () => {
  let modelCalls = 0;
  const redactor = new Redactor();
  const session = { inScope: () => true, redactor, policy: {}, page: { url: () => 'https://example.test/', getByRole: () => ({ count: async () => 0 }) }, snapshot: async () => ({ url: 'https://example.test/', visibleText: '', elements: [] }) };
  const provider = new AIProvider({ analyzeSource: async () => { modelCalls++; return JSON.stringify({ action: { action: 'click', target: { role: 'button', name: 'Missing' } } }); } });
  const agent = new TestAgent({ provider, store: { save: async observation => ({ ...observation, evidenceId: 'e1' }) }, budget: { steps: 5, modelCalls: 4, retries: 1, scenarioMs: 1000 } });
  const result = await agent.run({ id: 'TEST-001', name: 'Missing', risk: 'CAUTION', steps: [{ action: 'click', target: { role: 'button', name: 'Missing' } }], expected: [{ type: 'text', value: 'Success' }] }, session);
  assert.equal(result.status, 'UNCERTAIN');
  assert.ok(result.history.some(item => item.status === 'ACTION_FAILED'));
  assert.ok(modelCalls <= 3);
});
