import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RepositoryReader, parseRepository } from '../src/repo/repositoryReader.js';
import { RouteScanner } from '../src/repo/routeScanner.js';
import { Stage1Understand, sourceChunks } from '../src/pipeline/stage1Understand.js';

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codestress-reader-'));
  try { await run(root); } finally {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('codestress-reader-')) throw new Error('Unexpected fixture cleanup path');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

test('local reading includes deep source, tests, configuration and docs; excludes credentials and dependencies', async () => fixture(async root => {
  for (const [name, content] of Object.entries({
    'a/b/c/d/e/f/g/deep.ts': 'export const businessRule = 42;', 'test/example.test.js': 'test code',
    'package.json': '{"name":"fixture"}', 'README.md': '# Architecture', '.env': 'SECRET=value',
    'node_modules/dependency/index.js': 'not source', 'binary.py': 'abc\0def'
  })) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), content); }
  const result = await new RepositoryReader({ repo: root }).read();
  assert.equal(result.files.length, 4);
  assert.ok(result.files.some(file => file.content.includes('businessRule')));
  assert.ok(result.inventory.some(file => file.path === '.env' && file.status === 'excluded'));
  assert.ok(result.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.equal(result.coverage.complete, true);
}));

test('limits are visible and missing local paths fail', async () => fixture(async root => {
  await fs.writeFile(path.join(root, 'a.js'), 'first'); await fs.writeFile(path.join(root, 'b.js'), 'second');
  const result = await new RepositoryReader({ repo: root, limits: { maxFiles: 1 } }).read();
  assert.equal(result.coverage.filesRead, 1); assert.equal(result.coverage.skippedFiles, 1); assert.equal(result.coverage.complete, false);
  await assert.rejects(new RepositoryReader({ repo: path.join(root, 'missing') }).read(), /does not exist/);
}));

test('repository input accepts public roots and rejects non-GitHub and file URLs', () => {
  assert.equal(parseRepository('https://github.com/acme/project.git/').repo, 'project');
  assert.equal(parseRepository('github.com/acme/project').owner, 'acme');
  for (const repo of ['https://example.com/acme/project', 'https://github.com/acme/project/blob/main/app.js', '']) assert.throws(() => parseRepository(repo));
});

function fakeGithub(count = 35, { truncated = false, failBlob = false } = {}) {
  const calls = [];
  const blobs = Array.from({ length: count }, (_, index) => ({ type: 'blob', mode: '100644', path: `file${index}.js`, sha: `blob-${index}`, size: 16 }));
  return { calls, rest: {
    repos: { getCommit: async () => ({ data: { sha: 'fixed-commit', commit: { tree: { sha: 'root-tree' } } } }) },
    git: {
      getTree: async options => { calls.push(options); return { data: { truncated: Boolean(options.recursive && truncated), tree: blobs } }; },
      getBlob: async options => { calls.push(options); if (failBlob) throw Object.assign(new Error('rate limit'), { status: 403 }); return { data: { encoding: 'base64', content: Buffer.from(`export const id = '${options.file_sha}';`).toString('base64') } }; }
    }
  } };
}

test('GitHub reader reads beyond 30 files by immutable blob SHA', async () => {
  const github = fakeGithub(); const result = await new RepositoryReader({ repo: 'https://github.com/acme/project', github }).read();
  assert.equal(result.files.length, 35); assert.equal(result.source.commit, 'fixed-commit');
  assert.equal(github.calls.filter(call => call.file_sha).length, 35);
  assert.ok(result.files.some(file => file.content.includes('blob-34')));
});

test('truncated GitHub tree is re-enumerated and failed blobs cannot imply full coverage', async () => {
  const github = fakeGithub(2, { truncated: true });
  const result = await new RepositoryReader({ repo: 'https://github.com/acme/project', github }).read();
  assert.equal(result.files.length, 2); assert.ok(github.calls.some(call => call.tree_sha && !call.recursive));
  const failed = await new RepositoryReader({ repo: 'https://github.com/acme/project', github: fakeGithub(2, { failBlob: true }) }).read();
  assert.equal(failed.coverage.failedEntries, 2); assert.equal(failed.coverage.complete, false);
});

test('source chunks preserve the end of large files and original line references', () => {
  const chunks = sourceChunks([{ path: 'large.js', content: 'x'.repeat(50000) + '\nEND_OF_SOURCE' }]);
  assert.ok(chunks.length > 1); assert.ok(chunks.at(-1).content.includes('2: END_OF_SOURCE'));
  assert.equal(chunks.reduce((sum, chunk) => sum + (chunk.content.match(/x/g) || []).length, 0), 50000);
});

test('route scanning includes destructured request body fields', () => {
  const content = `app.post('/api/transfer', (req, res) => {
    const { recipient, amount } = req.body || {};
    res.json({ recipient, amount });
  });`;
  const route = new RouteScanner().extractFromCode(content, 'server.js').routes[0];
  assert.deepEqual(route.parameters, [
    { name: 'recipient', in: 'body' },
    { name: 'amount', in: 'body' }
  ]);
});

test('route scanning includes destructured request query fields', () => {
  const content = `app.get('/api/transfer', (req, res) => {
    const { recipient, amount } = req.query;
    res.json({ recipient, amount });
  });`;
  const route = new RouteScanner().extractFromCode(content, 'server.js').routes[0];
  assert.deepEqual(route.parameters, [
    { name: 'recipient', in: 'query' },
    { name: 'amount', in: 'query' }
  ]);
});

test('read-only stage never calls AI; understanding sends actual source with file/line context', async () => fixture(async root => {
  await fs.writeFile(path.join(root, 'app.js'), 'const uniqueBusinessRule = 123;');
  const calls = []; const ai = { analyzeSource: async (...args) => { calls.push(args); return 'Observed rule at app.js:1'; } };
  const read = await new Stage1Understand({ repo: root, readOnly: true, ai }).execute();
  assert.equal(calls.length, 0); assert.equal(read.aiStatus, 'not_requested');
  const result = await new Stage1Understand({ repo: root, ai }).execute();
  assert.ok(calls[0][1].includes('uniqueBusinessRule')); assert.ok(calls[0][1].includes('app.js'));
  assert.equal(result.aiStatus, 'complete'); assert.equal(result.aiCoverage.filesAnalyzed, 1);
}));

test('AI failure and source chunk caps preserve inventory without claiming complete analysis', async () => fixture(async root => {
  await fs.writeFile(path.join(root, 'app.js'), 'x'.repeat(50000));
  const failed = await new Stage1Understand({ repo: root, ai: { analyzeSource: async () => { throw new Error('offline'); } } }).execute();
  assert.equal(failed.aiStatus, 'unavailable'); assert.equal(failed.inventory.length, 1); assert.equal(failed.aiCoverage.complete, false);
  const partial = await new Stage1Understand({ repo: root, maxChunks: 1, ai: { analyzeSource: async () => 'Partial findings' } }).execute();
  assert.equal(partial.aiStatus, 'partial'); assert.equal(partial.aiCoverage.filesAnalyzed, 0); assert.equal(partial.inventory[0].aiAnalyzed, false);
}));

test('truncated excerpts are subdivided, preserving content and coverage', async () => fixture(async root => {
  const content = Array.from({ length: 100 }, (_, i) => `const value${i} = '${'x'.repeat(40)}';`).join('\n');
  await fs.writeFile(path.join(root, 'app.js'), content);
  const accepted = [];
  const ai = { analyzeSource: async (instruction, source) => {
    if (instruction.startsWith('Explain this source excerpt')) {
      const chunk = JSON.parse(source);
      if (chunk.content.length > 3300) throw Object.assign(new Error('truncated'), { code: 'AI_OUTPUT_LIMIT', partialText: 'not complete' });
      accepted.push(chunk.content); return 'Source finding at app.js:1';
    }
    return 'Report section';
  } };
  const result = await new Stage1Understand({ repo: root, ai }).execute();
  assert.equal(result.aiStatus, 'complete');
  assert.equal(result.aiCoverage.filesAnalyzed, 1);
  assert.ok(accepted.length > 1);
  assert.ok(accepted.join('').includes('value99'));
  assert.ok(result.chunkNotes.every(note => note.complete));
}));

test('a permanently truncated file does not discard findings from later files', async () => fixture(async root => {
  await fs.writeFile(path.join(root, 'a.js'), 'const first = true;');
  await fs.writeFile(path.join(root, 'b.js'), 'const later = true;');
  const ai = { analyzeSource: async (instruction, source) => {
    if (instruction.startsWith('Explain this source excerpt') && JSON.parse(source).path === 'a.js') throw Object.assign(new Error('truncated'), { code: 'AI_OUTPUT_LIMIT', partialText: 'Partial a.js finding' });
    return 'Complete finding';
  } };
  const result = await new Stage1Understand({ repo: root, ai }).execute();
  assert.equal(result.aiStatus, 'partial');
  assert.equal(result.aiCoverage.filesAnalyzed, 1);
  assert.ok(result.chunkNotes.some(note => note.path === 'a.js' && !note.complete));
  assert.ok(result.chunkNotes.some(note => note.path === 'b.js' && note.complete));
  assert.equal(result.analysisGaps.length, 1);
}));

test('one failed report section preserves earlier sections and source findings', async () => fixture(async root => {
  await fs.writeFile(path.join(root, 'app.js'), 'const rule = true;');
  let calls = 0;
  const ai = { analyzeSource: async () => {
    calls++;
    if (calls === 3) throw Object.assign(new Error('truncated'), { code: 'AI_OUTPUT_LIMIT', partialText: 'Partial rules' });
    return 'Complete finding';
  } };
  const result = await new Stage1Understand({ repo: root, ai }).execute();
  assert.equal(result.aiStatus, 'partial');
  assert.equal(result.chunkNotes[0].complete, true);
  assert.equal(result.reportSections.length, 4);
  assert.equal(result.reportSections[0].complete, true);
  assert.equal(result.reportSections[1].complete, false);
  assert.ok(result.aiUnderstanding.includes('Partial rules'));
}));

test('test-script discovery produces review-only proposals and never executes lifecycle hooks', async () => fixture(async root => {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node tests.js', pretest: 'node setup.js', start: 'node server.js' } }));
  const result = await new Stage1Understand({ repo: root, readOnly: true }).execute();
  assert.equal(result.testCommands.length, 1);
  assert.deepEqual(result.testCommands[0].args, ['run', 'test']);
  assert.equal(result.testCommands[0].before, 'node setup.js');
  assert.equal(result.testCommands[0].requiresApproval, true);
  assert.equal(result.execution.supported, false);
  assert.equal(result.execution.status, 'not_run');
}));
