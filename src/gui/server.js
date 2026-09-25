import express from 'express';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { Assessment } from '../pipeline/assessment.js';
import { ProjectMemory, projectKey } from '../memory/projectMemory.js';
import { Stage1Understand } from '../pipeline/stage1Understand.js';
import { parseRepository } from '../repo/repositoryReader.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.GUI_PORT || 9999;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active SSE clients
let activeClients = [];
let currentRun = null;

function broadcastLog(data) {
  if (currentRun) {
    if (data.type === 'stage_start') currentRun.started = data;
    if (data.type === 'authentication_result') currentRun.auth = data;
    if (['repository_read', 'understanding_ready'].includes(data.type)) currentRun.repository = data;
    if (data.type === 'memory_status') currentRun.memory = data;
    if (data.type === 'assessment_phase') currentRun.phase = data;
    if (data.type === 'target_reachable') currentRun.target = data;
    if (data.type === 'user_prompt') currentRun.userPrompt = data;
    if (data.type === 'browser_ready') currentRun.browser = data;
    if (data.type === 'report_ready') currentRun.report = data;
    if (['reading_progress', 'understanding_progress', 'test_start', 'test_result'].includes(data.type)) currentRun.progress = data;
    if (['stage_complete', 'stage_error', 'assessment_complete'].includes(data.type)) {
      currentRun.finished = data;
      currentRun.userPrompt = null;
    }
  }
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  activeClients.forEach(client => {
    try {
      client.res.write(payload);
    } catch (e) {
      // client disconnected
    }
  });
}

// SSE endpoint for live logs
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const clientId = Symbol();
  const newClient = { id: clientId, res };
  activeClients.push(newClient);

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', time: new Date().toISOString() })}\n\n`);

  if (currentRun?.active) {
    for (const event of [currentRun.started, currentRun.target, currentRun.browser, currentRun.repository, currentRun.auth, currentRun.memory, currentRun.phase, currentRun.userPrompt]) {
      if (event) res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } else if (currentRun?.finished) {
    for (const event of [currentRun.target, currentRun.repository, currentRun.memory]) {
      if (event) res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    if (currentRun.auth) res.write(`data: ${JSON.stringify(currentRun.auth)}\n\n`);
    res.write(`data: ${JSON.stringify(currentRun.finished)}\n\n`);
  }

  req.on('close', () => {
    activeClients = activeClients.filter(c => c.id !== clientId);
  });
});

// Status check endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    capabilities: ['source-understanding', 'selenium-browser-testing', 'interactive-authentication'],
    engine: `Ollama (${process.env.OLLAMA_MODEL || 'gpt-oss:120b'})`,
    model: process.env.OLLAMA_MODEL || 'gpt-oss:120b',
    running: Boolean(currentRun?.active),
    waitingForUser: Boolean(currentRun?.continueResolver),
    hasOllamaKey: Boolean(process.env.OLLAMA_API || process.env.OLLAMA_API_KEY),
    port: PORT
  });
});

// Main workflow: reachable -> browser launch -> code understanding -> manual auth -> live Selenium tests -> report.md
app.post('/api/run', async (req, res) => {
  if (currentRun?.active) return res.status(409).json({ error: 'An assessment is already running.' });
  const { target, repo } = req.body || {};
  try {
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    parseRepository(repo);
  } catch { return res.status(400).json({ error: 'Enter a valid HTTP(S) target and repository path/URL.' }); }
  currentRun = { runId: Date.now(), active: true, continueResolver: null, userPrompt: null, assessment: null };
  res.json({ success: true, message: 'Assessment and browser automation initiated' });
  broadcastLog({ type: 'stage_start', name: 'Assessment & Browser Testing' });
  try {
    const assessment = new Assessment({
      target, repo,
      onEvent: broadcastLog,
      onUserPrompt: async (data) => {
        broadcastLog(data);
        return new Promise(resolve => {
          if (currentRun) currentRun.continueResolver = resolve;
          else resolve(false);
        });
      }
    });
    currentRun.assessment = assessment;
    const result = await assessment.execute();
    broadcastLog({ type: 'assessment_complete', data: result });
  } catch (error) {
    const known = /^(The target could not be reached\.|AI understanding is unavailable\.|AI authentication (plan|planning)|Local repository folder|The local repository path|GitHub (repository|access)|Repository not found\.|Project memory could not be read\.)/.test(error.message || '');
    broadcastLog({ type: 'stage_error', error: known ? error.message : 'Assessment could not finish: ' + error.message });
  } finally {
    if (currentRun) {
      currentRun.active = false;
      currentRun.continueResolver = null;
      currentRun.userPrompt = null;
    }
  }
});

// User response to manual authentication / start running tests prompt
app.post('/api/continue', (req, res) => {
  if (!currentRun?.continueResolver) {
    return res.status(409).json({ error: 'No assessment is waiting for user confirmation.' });
  }
  const proceed = req.body?.proceed !== false;
  const resolver = currentRun.continueResolver;
  currentRun.continueResolver = null;
  currentRun.userPrompt = null;
  resolver(proceed);
  res.json({ success: true, proceed });
});

// Retrieve generated report.md
app.get('/api/report', async (req, res) => {
  try {
    const reportPath = path.resolve('report.md');
    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ error: 'report.md has not been generated yet. Run an assessment to generate it.' });
    }
    const content = await fs.promises.readFile(reportPath, 'utf-8');
    res.type('text/markdown').send(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/memory', async (req, res) => {
  try {
    const source = parseRepository(req.query.repo);
    const target = new URL(req.query.target);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error();
    const key = projectKey(source, target.href);
    const memory = await new ProjectMemory(key).load();
    res.json({ key, exists: Boolean(memory.updatedAt), updatedAt: memory.updatedAt, status: memory.status, findings: memory.notes.length });
  } catch { res.status(400).json({ error: 'Project memory could not be loaded.' }); }
});

// Stage 1 reads source independently of the target and authentication.
app.post('/api/understand', async (req, res) => {
  if (currentRun?.active) return res.status(409).json({ error: 'An assessment is already running.' });
  const { repo, readOnly = false } = req.body || {};
  try { parseRepository(repo); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (typeof readOnly !== 'boolean') return res.status(400).json({ error: 'readOnly must be a boolean.' });
  currentRun = { runId: Date.now(), active: true, continueResolver: null, userPrompt: null };
  res.json({ success: true, message: 'Source reading initiated' });
  broadcastLog({ type: 'stage_start', stage: 1, name: readOnly ? 'Read source' : 'Understand codebase' });
  try {
    const result = await new Stage1Understand({ repo, readOnly, onEvent: event => {
      if (event.type !== 'reading_progress' || event.filesRead === 1 || event.filesRead % 10 === 0) broadcastLog(event);
    } }).execute();
    broadcastLog({ type: 'stage_complete', stage: 1, data: result });
  } catch (error) {
    broadcastLog({ type: 'stage_error', stage: 1, error: error.message });
  } finally {
    if (currentRun) {
      currentRun.active = false;
      currentRun.continueResolver = null;
      currentRun.userPrompt = null;
    }
  }
});

// API errors must remain JSON, including Express body-parser errors and 404s.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown CodeStress API endpoint. Restart the GUI server and refresh the page.' });
});
app.use((error, req, res, next) => {
  if (!req.path.startsWith('/api/')) return next(error);
  if (res.headersSent) return next(error);
  const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
  const message = status === 413 ? 'The request is too large.'
    : status === 400 ? 'Invalid JSON request body. Submit the repository path through the GUI form.'
    : 'CodeStress could not process the request. Check the server terminal.';
  res.status(status).json({ error: message });
});

export function startGuiServer(port = PORT) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log('');
      console.log(chalk.bold.green(`🖥️  CodeStress GUI Live Server running at:`));
      console.log(chalk.bold.cyan(`    👉 http://localhost:${port}`));
      console.log(chalk.gray(`    Engine: Ollama (${process.env.OLLAMA_MODEL || 'gpt-oss:120b'}) + Python Selenium`));
      console.log('');
      resolve(server);
    });
  });
}

// If run directly
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  startGuiServer();
}

export default app;
