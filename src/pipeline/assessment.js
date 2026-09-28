import axios from 'axios';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RepositoryReader, parseRepository } from '../repo/repositoryReader.js';
import { Stage1Understand } from './stage1Understand.js';
import { ProjectMemory, projectKey, sourceFingerprint } from '../memory/projectMemory.js';
import { createProvider } from '../engine/provider.js';
import { buildApplicationModel } from '../model/applicationModel.js';
import { planAuthentication } from '../auth/authenticationPlanner.js';
import { establishAuthentication, verifyBrowserAuthentication } from '../auth/browserAuthentication.js';
import { BrowserManager } from '../browser/browserManager.js';
import { generateScenarios, validateScenarios } from '../testing/scenarios.js';
import { EvidenceStore } from '../testing/evidenceStore.js';
import { runTestSuite } from '../testing/testSuite.js';
import { findingsFrom, renderReport } from '../testing/report.js';
import { Redactor } from '../core/redaction.js';
import { AppError, bounded, checkSignal, limits, publicError } from '../core/runtime.js';

export class Assessment {
  constructor(options = {}) {
    this.options = options; this.http = options.http || axios;
    this.controller = new AbortController(); this.signal = this.controller.signal;
    this.redactor = new Redactor([options.password, options.bearer, options.cookie, process.env.OLLAMA_API_KEY, process.env.OLLAMA_API, options.token, process.env.GITHUB_TOKEN]);
    this.emit = event => options.onEvent?.(this.redactor.clean(event));
    this.ai = createProvider({ ai: options.ai, signal: this.signal, redactor: this.redactor });
    this.runId = options.runId || randomUUID();
    if (!/^[a-f0-9-]{36}$/.test(this.runId)) throw new AppError('RUN_ID', 'Invalid run identifier.');
    this.directory = path.resolve('.codestress', 'runs', this.runId);
    this.artifact = { version: 1, runId: this.runId, target: this.redactor.url(options.target), startedAt: new Date().toISOString(), status: 'analyzing', results: [], findings: [] };
  }
  phase(phase, text) { checkSignal(this.signal); this.emit({ type: 'assessment_phase', phase, text }); }
  cancel() { this.controller.abort(); }
  async prompt(data) {
    if (!this.options.onUserPrompt) return { proceed: false };
    const answer = await bounded(() => this.options.onUserPrompt({ type: 'user_prompt', ...data }), limits.manualMs, this.signal);
    return typeof answer === 'boolean' ? { proceed: answer } : answer || { proceed: false };
  }
  async persist() {
    this.artifact.findings = findingsFrom(this.artifact.results);
    const safe = this.redactor.clean(this.artifact);
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(path.join(this.directory, 'report.json'), JSON.stringify(safe, null, 2), { mode: 0o600 });
    await fs.writeFile(path.join(this.directory, 'report.md'), renderReport(safe), { mode: 0o600 });
    await this.memory?.save({ lastRun: { runId: this.runId, status: safe.status }, applicationModel: safe.applicationModel, generatedTests: safe.scenarios || [], testResults: safe.results, knownFailures: safe.findings, authentication: safe.authentication });
  }
  async execute() {
    const timer = setTimeout(() => this.controller.abort(), 3600000);
    try { await this.run(); }
    catch (error) {
      this.artifact.status = this.signal.aborted ? 'canceled' : 'incomplete'; this.artifact.error = publicError(error);
      this.emit({ type: 'log', level: 'error', text: this.artifact.error.message });
    } finally {
      clearTimeout(timer); await this.manager?.close().catch(() => {});
      this.artifact.finishedAt = new Date().toISOString();
      await this.persist();
    }
    const result = this.redactor.clean({ ...this.artifact, report: this.artifact.sourceReport });
    this.emit({ type: 'report_ready', data: { runId: this.runId, total_tests: result.results.length, issues: result.findings.length } });
    return result;
  }
  async run() {
    const options = this.options, target = new URL(options.target);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new AppError('TARGET', 'Use an HTTP(S) target without embedded credentials.');
    const source = parseRepository(options.repo);
    const uploads = {};
    if (options.upload) {
      const fixture = path.resolve(options.upload);
      const stat = await fs.lstat(fixture);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) throw new AppError('UPLOAD', 'Choose a regular upload fixture smaller than 5 MB.');
      uploads.fixture = fixture;
    }
    this.phase('reachability', 'Checking target reachability');
    let response;
    try { response = await this.http.get(target.href, { timeout: 8000, maxRedirects: 0, signal: this.signal, maxContentLength: 2 * 1024 * 1024, validateStatus: () => true }); }
    catch { throw new AppError('REACHABILITY', 'The target could not be reached. No browser was opened.'); }
    this.artifact.reachable = true; this.emit({ type: 'target_reachable', status: response.status });
    const key = projectKey(source, target.href);
    this.memory = options.memory || new ProjectMemory(key, [], this.redactor);
    const previous = await this.memory.load();
    this.phase('reading', 'Reading the repository');
    const repository = options.repository || await new RepositoryReader({ repo: options.repo, token: options.token, onProgress: progress => { checkSignal(this.signal); if (progress.filesRead === 1 || progress.filesRead % 10 === 0) this.emit({ type: 'reading_progress', ...progress }); } }).read();
    checkSignal(this.signal);
    const fingerprint = sourceFingerprint(repository, this.ai.model);
    this.artifact.fingerprint = fingerprint;
    const cachedNotes = previous.fingerprint === fingerprint ? previous.notes : [];
    await this.memory.save({ fingerprint, status: 'understanding', source: repository.source, notes: cachedNotes, sourceSnapshot: { inventory: repository.inventory, coverage: repository.coverage } });
    this.emit({ type: 'memory_status', key, text: `${cachedNotes.length} compatible findings available; changed source is reanalyzed.` });
    this.phase('understanding', 'Understanding source and business rules');
    const sourceReport = await new Stage1Understand({ repository, ai: this.ai, cachedNotes, signal: this.signal, synthesizeReport: false, onEvent: this.emit, onCheckpoint: report => this.memory.save({ fingerprint, notes: report.chunkNotes, report }) }).execute();
    this.artifact.sourceReport = sourceReport;
    await this.memory.save({ fingerprint, notes: sourceReport.chunkNotes, report: sourceReport });
    this.emit({ type: 'understanding_ready', data: sourceReport });
    if (sourceReport.aiStatus === 'unavailable') throw new AppError('AI_UNAVAILABLE', 'AI understanding is unavailable. Completed source inventory was retained.');
    this.phase('model', 'Building the application model');
    const model = await buildApplicationModel(this.ai, repository, sourceReport);
    this.artifact.applicationModel = model; this.emit({ type: 'application_model', data: model });
    this.phase('authentication_plan', 'Discovering source-backed authentication');
    const authMode = options.authMode || (options.cookie ? 'cookie' : options.bearer ? 'bearer' : options.email || options.username || options.authId ? 'credentials' : 'manual');
    const plan = authMode === 'none' ? { kind: 'session', checks: [], reason: 'Public testing' } : await planAuthentication({ ai: this.ai, repository, report: sourceReport, mode: authMode });
    this.artifact.authenticationPlan = plan;
    this.phase('generation', 'Generating source-backed test scenarios');
    const saved = previous.regressions?.fingerprint === fingerprint ? previous.regressions.scenarios : [];
    if (options.replay && !saved?.length) throw new AppError('REGRESSION_STALE', 'No compatible saved tests exist for this source fingerprint. Generate a fresh assessment first.');
    const scenarios = options.replay ? validateScenarios(saved.slice(0, 5), repository) : await generateScenarios(this.ai, model, repository, saved || [], Object.keys(uploads));
    this.artifact.scenarios = scenarios; this.emit({ type: 'scenarios_ready', data: scenarios });
    this.artifact.status = 'ready'; await this.persist();
    const launch = await this.prompt({ kind: 'browser', prompt: 'Open the test browser?', detail: 'Source analysis and test planning are saved. Opening the browser contacts the target; test actions require a separate confirmation.' });
    if (!launch.proceed) { this.artifact.status = 'planned'; return; }
    this.phase('browser_launch', 'Opening an isolated browser session');
    this.manager = options.browserManager || new BrowserManager({ target: target.href, redactor: this.redactor, signal: this.signal });
    this.artifact.browser = await this.manager.launch(); this.emit({ type: 'browser_ready', data: this.artifact.browser });
    const session = await this.manager.session({ policy: {} });
    this.phase('authentication', 'Establishing and verifying the browser session');
    let authentication;
    try { authentication = await establishAuthentication({ options: { ...options, authMode }, session, plan, http: this.http, prompt: data => this.prompt(data), emit: this.emit }); }
    catch (error) { authentication = { status: 'UNVERIFIED', authenticated: false, type: 'Browser session', detail: publicError(error).message, evidence: [] }; }
    this.artifact.authentication = authentication; this.emit({ type: 'authentication_result', data: authentication });
    await this.persist();
    const decision = await this.prompt({ kind: 'execution', prompt: 'Run the reviewed test scenarios?', detail: 'Read-only actions are enabled by default. Form edits/submissions and dangerous actions require the separate permissions below.', scenarios });
    if (!decision.proceed) { this.artifact.status = 'planned'; return; }
    const policy = { allowMutations: decision.allowMutations === true, allowDangerous: decision.allowMutations === true && decision.allowDangerous === true };
    const state = authentication.authenticated ? await session.state() : undefined;
    const store = new EvidenceStore(this.directory, this.redactor);
    this.phase('execution', 'Executing browser scenarios');
    const results = await runTestSuite({ scenarios, manager: this.manager, state, bearer: session.bearer, authentication, provider: this.ai, store, signal: this.signal, policy, uploads, replay: Boolean(options.replay), onEvent: this.emit,
      checkpoint: async results => { this.artifact.results = results; this.artifact.status = 'running'; await this.persist(); },
      onManual: async active => {
        active.manual = true;
        const answer = await this.prompt({ kind: 'authentication', prompt: 'Browser interaction required', detail: 'Complete the security challenge manually and return to the target. CodeStress will verify access again.' });
        active.manual = false;
        if (!answer.proceed) return false;
        return (await verifyBrowserAuthentication(active, plan, this.http)).authenticated;
      }
    });
    this.artifact.results = results;
    this.artifact.status = this.signal.aborted ? 'canceled' : results.some(result => ['BLOCKED', 'UNCERTAIN', 'SKIPPED'].includes(result.status)) ? 'needs_attention' : 'complete';
    await this.memory.save({ regressions: { fingerprint, scenarios: results.filter(result => result.status === 'PASS').map(result => result.scenario) } });
    this.phase('report', 'Saving results, evidence and reproduction records');
  }
}
