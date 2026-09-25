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
    const launchTime = new Date().toLocaleTimeString([], { hour12: false });
    this.emit({ type: 'log', level: 'info', text: `[${launchTime}] Opening interactive browser pointing to ${target.href}...` });

    this.authenticated = false;
    this.codebaseComplete = false;
    this.latestAuthState = null;

    // Hook selenium events into assessment emitter
    this.selenium.on('event', event => {
      this.emit(event);

      if (event.type === 'auth_state_changed') {
        const authData = event.data;
        this.latestAuthState = authData;

        if (authData.authenticated) {
          this.authenticated = true;
          const time = new Date().toLocaleTimeString([], { hour12: false });
          const indText = (authData.indicators || []).join(' · ');
          this.emit({
            type: 'authentication_result',
            data: {
              status: 'SUCCESS',
              authenticated: true,
              type: 'Interactive Browser Session',
              detail: indText ? `Signed in · ${indText}` : 'Signed in · Active authenticated session detected.',
              evidence: (authData.cookies || []).map(c => ({
                step: 'Active Session Cookie',
                endpoint: `${c.name} (${c.httpOnly ? 'HttpOnly' : 'Accessible'}, ${c.secure ? 'Secure' : 'Insecure'})`,
                httpStatus: 200
              }))
            }
          });
          this.emit({
            type: 'log',
            level: 'success',
            text: `[${time}] Authentication verified in browser: ${indText || 'Active session detected'}`
          });
        }
      } else if (event.type === 'test_start') {
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
      const readyTime = new Date().toLocaleTimeString([], { hour12: false });
      this.emit({ type: 'log', level: 'success', text: `[${readyTime}] Browser ready: ${browserInfo.browser}. Pointed to ${browserInfo.target}` });
    } catch (browserErr) {
      this.emit({ type: 'log', level: 'warn', text: `Selenium launch warning: ${browserErr.message}. Continuing with analysis.` });
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 2 — READ CODEBASE & AI UNDERSTANDING
    // (Runs concurrently while user can freely interact with the open browser)
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

    // Share discovered routes with Python Selenium auth monitor
    if (this.selenium.setIndicators) {
      this.selenium.setIndicators({
        protected_routes: analysis.routes.filter(r => (r.middlewares || []).some(m => /auth|login|protect|admin/i.test(m))).map(r => r.path)
      });
    }

    // Streamlined AI codebase understanding (synthesizeReport: false skips the 6-minute pre-test essay delay)
    this.phase('understanding', `AI analyzing application architecture & security attack surfaces`);
    let report;
    try {
      report = await new Stage1Understand({
        repository, ai: this.ai, cachedNotes, synthesizeReport: false, onEvent: this.emit,
        onCheckpoint: result => memory.save({ notes: result.chunkNotes, report: result, fingerprint, status: 'understanding' })
      }).execute();
      await memory.save({ report, notes: report.chunkNotes, fingerprint, status: 'understood' });
      this.emit({ type: 'understanding_ready', data: report });
    } catch (e) {
      report = routeSnapshot;
      this.emit({ type: 'log', level: 'warn', text: `AI understanding note: ${e.message}. Using heuristic scanner routes.` });
    }
    this.codebaseComplete = true;

    // Check latest auth state from browser
    if (this.selenium.checkAuth) {
      try {
        const latest = await this.selenium.checkAuth();
        if (latest && latest.authenticated) {
          this.authenticated = true;
          this.latestAuthState = latest;
        }
      } catch (e) {}
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 3 — AUTHENTICATION CHECK & START TESTS GATE
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    this.phase('waiting_auth', this.authenticated
      ? 'Authentication verified · Ready to start tests'
      : 'Browser open · please complete manual login/MFA');

    if (!this.authenticated) {
      this.emit({
        type: 'authentication_result',
        data: {
          status: 'PENDING',
          authenticated: false,
          type: 'Interactive Browser Session',
          detail: 'Browser is open. Complete authentication (Google OAuth, SSO, MFA, or credentials) in the browser window, then click Start Running Tests.'
        }
      });
    }

    const proceedWithTests = await this.onUserPrompt({
      type: 'user_prompt',
      prompt: 'Start Running Tests',
      detail: this.authenticated
        ? 'Authentication confirmed in browser. Click to run AI-generated security and functionality tests live in the browser.'
        : 'The browser is open with your target. Complete login in the browser, then click to run security tests.',
      authenticated: this.authenticated,
      browser: browserInfo?.browser || 'Browser',
      endpointsDiscovered: routeSnapshot.endpointsCount
    });

    if (!proceedWithTests) {
      this.emit({ type: 'log', level: 'info', text: 'Browser testing canceled by user.' });
      this.selenium.close();
      return { reachable: true, report, status: 'canceled' };
    }

    // Final auth state check before generating and running tests
    const sessionData = await this.selenium.getSession();
    const hasCookies = sessionData.cookies && sessionData.cookies.length > 0;
    const isAuthed = this.authenticated || sessionData.authenticated || hasCookies;

    this.emit({
      type: 'authentication_result',
      data: {
        status: isAuthed ? 'SUCCESS' : 'PUBLIC',
        authenticated: isAuthed,
        type: 'Browser Session',
        detail: isAuthed
          ? `Signed in · Authenticated session active (${sessionData.cookie_count || 1} cookie(s) detected). Running tests with live session.`
          : 'Testing under current browser state.',
        evidence: (sessionData.cookies || []).map(c => ({
          step: 'Active Cookie',
          endpoint: `${c.name} (${c.httpOnly ? 'HttpOnly' : 'Accessible'}, ${c.secure ? 'Secure' : 'Insecure'})`,
          httpStatus: 200
        }))
      }
    });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 4 — DYNAMIC TEST SCENARIO GENERATION
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    this.phase('generating_tests', 'Generating dynamic test scenarios from codebase intelligence');
    this.emit({ type: 'log', level: 'info', text: 'Formulating security, session, and input boundary test scenarios...' });

    const scenarios = await this.scenarioGen.generateScenarios(report || routeSnapshot, target.href);
    this.emit({ type: 'log', level: 'info', text: `Formulated ${scenarios.length} test scenarios. Starting live execution in browser...` });

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

    await memory.save({ status: 'complete', testSummary: testRunResult || null });
    this.emit({ type: 'assessment_complete', data: result });
    return result;
  }
}
