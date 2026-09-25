import axios from 'axios';
import { RepositoryReader, parseRepository } from '../repo/repositoryReader.js';
import { AIClient } from '../engine/aiClient.js';
import { Stage1Understand } from './stage1Understand.js';
import { RouteScanner } from '../repo/routeScanner.js';
import { ProjectMemory, projectKey, sourceFingerprint } from '../memory/projectMemory.js';
import { SeleniumBridge } from '../browser/seleniumBridge.js';
import { TestScenarioGenerator } from '../browser/testScenarioGenerator.js';

export class Assessment {
  constructor(options) {
    this.options = options;
    this.emit = options.onEvent || (() => {});
    this.http = options.http || axios;
    this.ai = options.ai || new AIClient();
    this.onUserPrompt = options.onUserPrompt || (() => Promise.resolve(true));
    this.selenium = options.selenium || new SeleniumBridge();
    this.scenarioGen = new TestScenarioGenerator(this.ai);
  }

  phase(name, text) { this.emit({ type: 'assessment_phase', phase: name, text }); }

  async execute() {
    try { return await this.run(); }
    catch (error) {
      if (this.memory) await this.memory.save({ status: 'incomplete' }).catch(() => {});
      if (this.selenium) this.selenium.close();
      throw error;
    }
  }

  async run() {
    const options = this.options;
    const target = new URL(options.target);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      throw new Error('Use an HTTP(S) target without embedded credentials.');
    const source = parseRepository(options.repo);
    const key = projectKey(source, target.href);
    const memory = options.memory || new ProjectMemory(key);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 1 — REACHABILITY & BROWSER INITIALIZATION
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    this.phase('reachability', 'Checking target reachability');
    let reachResponse;
    try {
      reachResponse = await this.http.get(target.href, {
        timeout: 8000, maxRedirects: 0,
        maxContentLength: 2 * 1024 * 1024, validateStatus: () => true
      });
    } catch {
      throw new Error('The target could not be reached. Ensure the server is online.');
    }
    this.emit({ type: 'target_reachable', status: reachResponse.status });

    // Launch visible Python Selenium browser
    this.phase('browser_launch', 'Launching interactive browser window for manual authentication');
    this.emit({ type: 'log', level: 'info', text: `Opening real browser pointing to ${target.href}...` });

    // Hook selenium events into assessment emitter
    this.selenium.on('event', event => {
      this.emit(event);
      if (event.type === 'test_start') {
        this.emit({ type: 'log', level: 'info', text: `[TEST ${event.data.index}/${event.data.total}] ${event.data.name} (${event.data.category})` });
      } else if (event.type === 'test_result') {
        const level = event.data.status === 'PASSED' ? 'success' : event.data.status === 'VULNERABLE' ? 'error' : 'warn';
        this.emit({ type: 'log', level, text: `  ↳ ${event.data.status}: ${event.data.details}` });
      }
    });

    let browserInfo;
    try {
      browserInfo = await this.selenium.launch(target.href);
      this.emit({ type: 'browser_ready', data: browserInfo });
      this.emit({ type: 'log', level: 'success', text: `Browser ready: ${browserInfo.browser}. Pointed to ${browserInfo.target}` });
    } catch (browserErr) {
      this.emit({ type: 'log', level: 'warn', text: `Selenium launch warning: ${browserErr.message}. Continuing with API analysis.` });
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 2 — READ CODEBASE & AI UNDERSTANDING
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    this.phase('reading', 'Reading and analyzing codebase structure');
    const previous = await memory.load();
    this.memory = memory;
    await memory.save({ status: 'reading', source, target: target.origin });
    this.emit({ type: 'memory_status', key, text: previous.updatedAt
      ? 'Project memory loaded; checking source changes.'
      : 'Created a private project memory workspace.' });

    const repository = options.repository || await new RepositoryReader({
      repo: options.repo, token: options.token,
      onProgress: progress => {
        if (progress.filesRead === 1 || progress.filesRead % 10 === 0)
          this.emit({ type: 'reading_progress', ...progress });
      }
    }).read();

    const fingerprint = sourceFingerprint(repository, this.ai.model || 'injected');
    const cachedNotes = previous.fingerprint === fingerprint ? previous.notes : [];

    // Static route & parameter scan
    const analysis = new RouteScanner().analyze(repository);
    const routeSnapshot = {
      source: repository.source, coverage: repository.coverage, inventory: repository.inventory,
      routes: analysis.routes.map(({ rawContext, ...route }) => route),
      endpointsCount: analysis.endpoints, routeGroupsCount: analysis.routeGroups,
      aiStatus: 'pending', aiUnderstanding: '', chunkNotes: cachedNotes, analysisGaps: [],
      reportSections: [], testCommands: [],
      execution: { supported: false, status: 'not_run', requiresApproval: true },
      aiCoverage: { totalChunks: 0, analyzedChunks: 0, attemptedChunks: 0, filesAnalyzed: 0, complete: false }
    };
    this.emit({ type: 'repository_read', data: routeSnapshot });

    // AI codebase understanding across all routes & logic
    this.phase('understanding', `AI analyzing application architecture & security attack surfaces`);
    let report;
    try {
      report = await new Stage1Understand({
        repository, ai: this.ai, cachedNotes, onEvent: this.emit,
        onCheckpoint: result => memory.save({ notes: result.chunkNotes, report: result, fingerprint, status: 'understanding' })
      }).execute();
      await memory.save({ report, notes: report.chunkNotes, fingerprint, status: 'understood' });
      this.emit({ type: 'understanding_ready', data: report });
    } catch (e) {
      report = routeSnapshot;
      this.emit({ type: 'log', level: 'warn', text: `AI understanding limited: ${e.message}. Using heuristic scanner routes.` });
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 3 — MANUAL AUTHENTICATION GATE
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    this.phase('waiting_auth', 'Browser open · please complete manual login/MFA');
    this.emit({
      type: 'authentication_result',
      data: {
        status: 'PENDING',
        authenticated: false,
        type: 'Interactive Browser Session',
        detail: 'Browser is open. Complete authentication (Google OAuth, SSO, MFA, or credentials) in the browser window, then click Start Running Tests.'
      }
    });

    const proceedWithTests = await this.onUserPrompt({
      type: 'user_prompt',
      prompt: 'Start Running Tests',
      detail: 'The browser is open with your target. Once you have logged in, click to run AI-generated security and functionality tests live in the browser.',
      browser: browserInfo?.browser || 'Browser',
      endpointsDiscovered: routeSnapshot.endpointsCount
    });

    if (!proceedWithTests) {
      this.emit({ type: 'log', level: 'info', text: 'Browser testing canceled by user.' });
      this.selenium.close();
      return { reachable: true, report, status: 'canceled' };
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 4 — DYNAMIC TEST SCENARIO GENERATION
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    this.phase('generating_tests', 'Generating dynamic test scenarios from codebase intelligence');
    this.emit({ type: 'log', level: 'info', text: 'Formulating security, session, and input boundary test scenarios...' });

    const scenarios = await this.scenarioGen.generateScenarios(report || routeSnapshot, target.href);
    this.emit({ type: 'log', level: 'info', text: `Formulated ${scenarios.length} test scenarios. Starting live execution in browser...` });

    // Inspect session cookies captured from browser
    const sessionData = await this.selenium.getSession();
    const hasCookies = sessionData.cookies && sessionData.cookies.length > 0;
    this.emit({
      type: 'authentication_result',
      data: {
        status: hasCookies ? 'SUCCESS' : 'PUBLIC',
        authenticated: hasCookies,
        type: 'Browser Session',
        detail: hasCookies
          ? `Authenticated session active (${sessionData.cookie_count} cookie(s) detected). Running tests with your live session.`
          : 'Testing under current browser state.',
        evidence: (sessionData.cookies || []).map(c => ({
          step: 'Cookie Detected',
          endpoint: `${c.name} (${c.httpOnly ? 'HttpOnly' : 'Accessible'}, ${c.secure ? 'Secure' : 'Insecure'})`,
          httpStatus: 200
        }))
      }
    });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 5 — LIVE SELENIUM TEST EXECUTION
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    this.phase('running_tests', `Running ${scenarios.length} tests live in browser window`);

    let testRunResult;
    try {
      testRunResult = await this.selenium.runTests(scenarios, {
        target: target.href,
        repo: options.repo,
        aiSummary: report?.aiUnderstanding || 'Codebase routes analyzed by CodeStress.'
      });
      this.emit({ type: 'log', level: 'success', text: `All ${scenarios.length} tests completed. Generated report.md successfully.` });
    } catch (testErr) {
      this.emit({ type: 'log', level: 'error', text: `Test execution error: ${testErr.message}` });
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 6 — REPORT GENERATION & WRAP-UP
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    this.phase('complete', 'Testing complete · report.md generated');

    const result = {
      reachable: true,
      report,
      testSummary: testRunResult || null,
      reportFile: 'report.md',
      status: 'complete'
    };

    this.emit({ type: 'assessment_complete', data: result });
    return result;
  }
}
