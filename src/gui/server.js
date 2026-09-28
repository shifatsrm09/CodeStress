import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Assessment } from '../pipeline/assessment.js';
import { ProjectMemory, projectKey } from '../memory/projectMemory.js';
import { parseRepository } from '../repo/repositoryReader.js';
import { publicError } from '../core/runtime.js';

const app = express();
const PORT = Number(process.env.GUI_PORT || 9999);
const directory = path.dirname(fileURLToPath(import.meta.url));
const runsRoot = path.resolve('.codestress', 'runs');
const clients = new Set();
let currentRun = null;
const validId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
app.use(express.json({ limit: '128kb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'POST' && ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || !req.is('application/json'))) return res.status(403).json({ error: 'Use the local CodeStress interface with a JSON request.' });
  next();
});
app.use(express.static(path.join(directory, 'public')));
function broadcast(run, event) {
  if (run !== currentRun) return;
  run.events.push(event); if (run.events.length > 400) run.events.shift();
  const snapshots = { stage_start: 'started', target_reachable: 'target', browser_ready: 'browser', repository_read: 'repository', understanding_ready: 'repository', application_model: 'model', scenarios_ready: 'scenarios', authentication_result: 'auth', memory_status: 'memory', assessment_phase: 'phase', user_prompt: 'prompt', assessment_complete: 'finished', report_ready: 'report' };
  if (snapshots[event.type]) run[snapshots[event.type]] = event;
  if (event.type === 'test_result') run.results.set(event.data.id, event);
  for (const client of clients) client.write(`data: ${JSON.stringify(event)}\n\n`);
}
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.flushHeaders(); clients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  if (currentRun) {
    for (const key of ['started', 'target', 'browser', 'repository', 'model', 'scenarios', 'auth', 'memory', 'phase']) if (currentRun[key]) res.write(`data: ${JSON.stringify(currentRun[key])}\n\n`);
    for (const event of currentRun.results.values()) res.write(`data: ${JSON.stringify(event)}\n\n`);
    for (const key of ['prompt', 'report', 'finished']) if (currentRun[key]) res.write(`data: ${JSON.stringify(currentRun[key])}\n\n`);
  }
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 20000);
  req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
});
app.get('/api/status', (req, res) => res.json({ status: 'online', capabilities: ['source-aware-browser-agent'], model: process.env.OLLAMA_MODEL || 'gpt-oss:120b', provider: process.env.AI_PROVIDER || 'ollama', running: Boolean(currentRun?.active), runId: currentRun?.id, port: PORT }));
app.post('/api/run', async (req, res) => {
  if (currentRun?.active) return res.status(409).json({ error: 'An assessment is already running.' });
  const body = req.body || {};
  try {
    const target = new URL(body.target);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error();
    parseRepository(body.repo);
    if (!['none', 'manual', 'cookie', 'bearer', 'credentials', 'authId'].includes(body.authMode)) throw new Error();
    for (const name of ['cookie', 'bearer', 'email', 'username', 'password', 'authId', 'upload']) if (body[name] !== undefined && (typeof body[name] !== 'string' || body[name].length > 16000)) throw new Error();
  } catch { return res.status(400).json({ error: 'Enter a valid target, repository and authentication mode.' }); }
  const run = { id: randomUUID(), active: true, events: [], results: new Map() }; currentRun = run;
  const credentials = body.authMode === 'cookie' ? { cookie: body.cookie } : body.authMode === 'bearer' ? { bearer: body.bearer } : body.authMode === 'credentials' ? { username: body.username, password: body.password } : body.authMode === 'authId' ? { authId: body.authId, password: body.password } : {};
  if ((body.authMode === 'cookie' && !credentials.cookie?.trim()) || (body.authMode === 'bearer' && !credentials.bearer?.trim()) || (body.authMode === 'credentials' && (!credentials.username?.trim() || !credentials.password)) || (body.authMode === 'authId' && !credentials.authId?.trim())) { currentRun = null; return res.status(400).json({ error: 'Supply the credentials for the selected mode.' }); }
  res.json({ success: true, runId: run.id });
  broadcast(run, { type: 'stage_start', name: 'Source-aware assessment', runId: run.id });
  try {
  run.assessment = new Assessment({ target: body.target, repo: body.repo, upload: body.upload, authMode: body.authMode, replay: body.replay === true, ...credentials, runId: run.id, onEvent: event => broadcast(run, event), onUserPrompt: data => new Promise(resolve => {
    const promptId = randomUUID(); run.resolve = resolve; run.promptId = promptId;
    broadcast(run, { ...data, runId: run.id, promptId });
  }) });
  const result = await run.assessment.execute(); broadcast(run, { type: 'assessment_complete', data: result }); }
  catch (error) { broadcast(run, { type: 'assessment_complete', data: { runId: run.id, status: 'incomplete', results: [], error: publicError(error) } }); }
  finally { run.active = false; run.resolve?.({ proceed: false }); run.resolve = null; run.prompt = null; }
});
app.post('/api/continue', (req, res) => {
  const body = req.body || {};
  if (!currentRun?.resolve || body.runId !== currentRun.id || body.promptId !== currentRun.promptId) return res.status(409).json({ error: 'This prompt is stale or no longer pending.' });
  if (typeof body.proceed !== 'boolean') return res.status(400).json({ error: 'An explicit proceed decision is required.' });
  const resolve = currentRun.resolve; currentRun.resolve = null; currentRun.prompt = null;
  resolve({ proceed: body.proceed, allowMutations: body.allowMutations === true, allowDangerous: body.allowDangerous === true }); res.json({ success: true });
});
app.post('/api/cancel', (req, res) => {
  if (!currentRun?.active || req.body?.runId !== currentRun.id) return res.status(409).json({ error: 'No matching active assessment.' });
  currentRun.assessment?.cancel(); currentRun.resolve?.({ proceed: false }); currentRun.resolve = null; currentRun.prompt = null;
  res.json({ success: true });
});
app.get('/api/memory', async (req, res) => {
  try {
    const source = parseRepository(req.query.repo), key = projectKey(source, req.query.target);
    const memory = await new ProjectMemory(key).load();
    res.json({ key, exists: Boolean(memory.updatedAt), updatedAt: memory.updatedAt, status: memory.status, findings: memory.notes.length, regressions: memory.regressions?.scenarios?.length || 0 });
  } catch { res.status(400).json({ error: 'Project memory could not be loaded.' }); }
});
app.get('/api/runs', async (req, res) => {
  try {
    const entries = await fs.readdir(runsRoot, { withFileTypes: true });
    const runs = [];
    for (const entry of entries.filter(entry => entry.isDirectory() && validId(entry.name))) {
      try { const report = JSON.parse(await fs.readFile(path.join(runsRoot, entry.name, 'report.json'), 'utf8')); runs.push({ runId: entry.name, target: report.target, startedAt: report.startedAt, status: report.status }); } catch {}
    }
    res.json({ runs: runs.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')).slice(0, 30) });
  } catch { res.json({ runs: [] }); }
});
async function artifact(req, res, id, name) {
  if (!validId(id) || !/^(?:report\.(?:json|md)|[a-f0-9-]{36}\.(?:json|png))$/.test(name)) return res.status(400).json({ error: 'Invalid artifact reference.' });
  try {
    const file = path.join(runsRoot, id, name);
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error();
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(name.endsWith('.png') ? 'image/png' : name.endsWith('.json') ? 'application/json' : 'text/markdown').send(await fs.readFile(file));
  } catch { res.status(404).json({ error: 'Artifact is not available for this run.' }); }
}
app.get('/api/runs/:id/artifacts/:name', (req, res) => artifact(req, res, req.params.id, req.params.name));
app.get('/api/report', (req, res) => artifact(req, res, req.query.runId || currentRun?.id, 'report.md'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint. Refresh the updated CodeStress GUI.' }));
app.use((error, req, res, next) => { if (res.headersSent) return next(error); res.status(error.status === 413 ? 413 : 400).json({ error: 'Request could not be processed. Check the submitted data.' }); });
export function startGuiServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => { console.log(`CodeStress: http://localhost:${port}`); resolve(server); });
    server.on('error', reject);
    server.on('close', () => currentRun?.assessment?.cancel());
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startGuiServer().then(server => {
    const shutdown = () => { currentRun?.assessment?.cancel(); currentRun?.resolve?.({ proceed: false }); for (const client of clients) client.end(); server.close(); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  }).catch(error => { console.error(error.code === 'EADDRINUSE' ? 'Port 9999 is already in use.' : 'CodeStress could not start.'); process.exitCode = 1; });
}
export default app;
