import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBehaviorFixture } from './fixtures/behaviorApp.js';
import { Assessment } from '../src/pipeline/assessment.js';
import { modelFields } from '../src/model/applicationModel.js';

test('real browser: full assessment, cookie controls, observations, FAIL replay and reports', { skip: process.env.CODESTRESS_E2E !== '1', timeout: 180000 }, async () => {
  const server = createBehaviorFixture().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const target = `http://127.0.0.1:${server.address().port}`;
  const content = await fs.readFile(new URL('./fixtures/behaviorApp.js', import.meta.url), 'utf8');
  const quote = content.split('\n').find(line => line.includes('// Contract:')).trim();
  const ref = { file: 'fixture.js', line: content.split('\n').findIndex(line => line.includes('// Contract:')) + 1, quote };
  const authLine = content.split('\n').find(line => line.includes("app.get('/session'"));
  const authRef = { file: 'fixture.js', line: content.split('\n').indexOf(authLine) + 1, quote: authLine.trim() };
  const repository = { source: { type: 'local', location: '/fixture' }, files: [{ path: 'fixture.js', sha256: 'fixture', content }], inventory: [{ path: 'fixture.js', status: 'read', sha256: 'fixture', bytes: content.length }], coverage: { complete: true, filesRead: 1, bytesRead: content.length, excludedEntries: 0, skippedFiles: 0, failedEntries: 0 } };
  const scenario = (id, url, value) => ({ id, name: url, category: 'navigation', priority: 'high', risk: 'SAFE', session: 'authenticated', preconditions: [], steps: [{ action: 'navigate', url }], expected: [{ type: 'text', value }], sourceEvidence: [ref] });
  const ai = { model: 'deterministic-test-provider', analyzeSource: async instruction => {
    if (instruction.startsWith('Build an application model')) return JSON.stringify({ ...Object.fromEntries(modelFields.map(field => [field, []])), pages: [{ description: 'Welcome page', status: 'inferred', confidence: 0.9, sourceEvidence: [ref] }], unknowns: [] });
    if (instruction.startsWith('Plan authentication')) return JSON.stringify({ kind: 'session', reason: 'Fixture session', checks: [{ path: '/session', format: 'json', evidence: [authRef] }] });
    if (instruction.startsWith('Generate 3')) return JSON.stringify([scenario('TEST-001', '/welcome', 'Welcome fixture'), scenario('TEST-002', '/broken', 'Welcome fixture')]);
    if (instruction.startsWith('Explain this fixed')) return JSON.stringify({ summary: 'Explicit fixture expectation evaluated.', limitations: [] });
    return 'fixture.js:1 serves a welcome page with literal text Welcome fixture.';
  } };
  const memory = { state: { notes: [] }, async load() { return this.state; }, async save(update) { this.state = { ...this.state, ...update }; } };
  const assessment = new Assessment({ target, repo: '.', repository, memory, ai, authMode: 'cookie', cookie: 'fixture_session=fixture-valid-session', onUserPrompt: async () => ({ proceed: true }) });
  try {
    const report = await assessment.execute();
    assert.equal(report.authentication?.authenticated, true);
    assert.equal(report.results[0]?.status, 'PASS');
    assert.equal(report.results[1]?.status, 'FAIL');
    assert.equal(report.results[1]?.reproduction?.status, 'CONFIRMED');
    assert.ok(report.results[0].observations.some(item => item.screenshot));
    assert.ok(report.results[0].observations.some(item => item.network?.some(request => request.kind === 'response')));
    assert.ok(!JSON.stringify(report).includes('fixture-valid-session'));
  } finally { assessment.cancel(); await new Promise(resolve => server.close(resolve)); }
});
