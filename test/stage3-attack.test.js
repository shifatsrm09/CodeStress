import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RouteScanner } from '../src/repo/routeScanner.js';
import { runAttack } from '../src/pipeline/stage3Attack.js';

test('Stage 3 probes destructured body fields for SQL injection', async () => {
  const content = `app.post('/api/transfer', (req, res) => {
    const { recipient, amount } = req.body || {};
    res.json({ recipient, amount });
  });`;
  const route = new RouteScanner().extractFromCode(content, 'server.js').routes[0];
  const calls = [];
  const results = await runAttack({
    target: 'https://example.test',
    routes: [route],
    session: { bearer: 'token' },
    http: { request: async options => {
      calls.push(options);
      if (String(options.data?.amount).includes('OR 1=1')) return { status: 200, data: { error: 'SQL syntax error' } };
      return { status: 200, data: { success: true } };
    } }
  });
  const finding = results.find(result => result.testType === 'SQL Injection');
  assert.equal(finding.status, 'FAILED');
  assert.equal(finding.field, 'amount');
  assert.ok(calls.some(call => String(call.data?.amount).includes('OR 1=1')));
});