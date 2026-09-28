const $ = id => document.getElementById(id);
let routes = [], eventCount = 0, running = false, streamReady = false, toastTimer;
let sourceReport = null;
let lastAuthResult = null;
const tabs = ['Activity', 'Routes', 'Summary', 'Files', 'Model', 'Tests', 'Report'];
let currentRunId = null, pendingPrompt = null;
const testResults = new Map();

async function apiRequest(endpoint, options = {}) {
  let response;
  try { response = await fetch(endpoint, { cache: 'no-store', ...options }); }
  catch { throw new Error('Cannot reach the CodeStress server. Start it with npm run gui, then refresh this page.'); }
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const hint = response.status === 404
      ? 'This server does not support the requested action. Restart CodeStress with npm run gui and refresh the page.'
      : 'The server returned a page instead of an API response. Open the CodeStress GUI on its configured port and restart it if needed.';
    throw new Error(`${hint} (${endpoint}, HTTP ${response.status})`);
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`The CodeStress server returned invalid JSON (${endpoint}, HTTP ${response.status}). Check the server terminal for errors.`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Unexpected response from ${endpoint}. Restart CodeStress and refresh the page.`);
  if (!response.ok) throw new Error(data.error || `Request failed (${endpoint}, HTTP ${response.status}).`);
  return data;
}

function selectTab(name) {
  tabs.forEach(tab => {
    const active = tab === name;
    $('tab' + tab).classList.toggle('active', active);
    $('tab' + tab).setAttribute('aria-selected', String(active));
    $('tab' + tab).tabIndex = active ? 0 : -1;
    $(tab.toLowerCase() + 'Panel').hidden = !active;
  });
}

tabs.forEach((name, index) => {
  $('tab' + name).addEventListener('click', () => selectTab(name));
  $('tab' + name).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next]); $('tab' + tabs[next]).focus();
  });
});

$('navRoutes').addEventListener('click', () => selectTab('Routes'));
$('navActivity').addEventListener('click', () => selectTab('Activity'));



function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
}

function appendLog(text, level = 'info') {
  $('termBody').querySelector('.console-welcome')?.remove();
  const row = document.createElement('div');
  row.className = 'log-line log-' + (['info','success','error','warn'].includes(level) ? level : 'info');
  const time = document.createElement('span'); time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString([], {hour12:false});
  const content = document.createElement('span'); content.textContent = text;
  row.append(time, content); $('termBody').append(row);
  eventCount++; $('logCount').textContent = `${eventCount} event${eventCount === 1 ? '' : 's'}`;
  $('termBody').scrollTop = $('termBody').scrollHeight;
}

function setRunning(value, state = 'Idle') {
  running = value; $('configFields').disabled = value; $('btnRun').disabled = value || !streamReady;
  $('btnRun').firstElementChild.textContent = value ? 'Working…' : 'Start assessment';
  $('runState').textContent = state;
  $('btnCancel').hidden = !value; $('btnLoadRun').disabled = value;
}

function renderRoutes() {
  const query = $('routeSearch').value.toLowerCase(); $('routesList').replaceChildren();
  const filtered = routes.filter(route => `${route.method} ${route.path}`.toLowerCase().includes(query));
  if (!filtered.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.textContent = query ? 'No routes match your search.' : 'No routes discovered yet. Run an assessment to map your application.';
    $('routesList').append(empty);
  }
  filtered.forEach(route => {
    const row = document.createElement('div'); row.className = 'route-item';
    const method = document.createElement('span'); const name = String(route.method || 'GET').toUpperCase();
    method.className = 'method-badge method-' + name.toLowerCase().replace(/[^a-z]/g,'');
    method.textContent = name;
    const path = document.createElement('span'); path.textContent = route.path || '/';
    row.append(method, path); $('routesList').append(row);
  });
}
$('routeSearch').addEventListener('input', renderRoutes);

function resetResults() {
  lastAuthResult = null; $('authEvidence').hidden = true; pendingPrompt = null; testResults.clear();
  $('testResults').replaceChildren(); $('scenarioList').replaceChildren(); $('applicationModel').textContent = 'Waiting for source analysis.';
  $('userPromptBox').hidden = true;
  $('reportBadge').hidden = true;
  $('reportContent').textContent = 'Run testing to generate your security assessment report.';
  sourceReport = null; $('aiFindings').replaceChildren(); $('testCommands').replaceChildren();
  $('fileInventory').replaceChildren(); $('coverageText').textContent = 'Waiting for source reading…';
  $('btnDownload').disabled = true;
  $('phaseStatus').textContent = 'Starting assessment';
  routes = []; $('routeSearch').value = ''; $('fileSearch').value = ''; renderRoutes();
  $('routeCountLabel').textContent = $('navCount').textContent = '0';
  $('statStatus').textContent = 'Checking…'; $('statStatus').className = ''; $('statStatusDetails').textContent = 'Confirming your target';
  $('statAuth').textContent = 'Pending'; $('statAuth').className = ''; $('statAuthDetails').textContent = 'Waiting for verification';
  $('statEndpoints').textContent = '—'; $('statGroups').textContent = 'Discovering routes';
  $('aiText').textContent = 'The AI summary will appear when the assessment completes.'; $('aiText').className = 'summary-text empty-state';
  $('formError').hidden = true;
}

function fail(message) {
  setRunning(false, 'Failed');
  $('userPromptBox').hidden = true;
  $('statStatus').textContent = 'Incomplete'; $('statStatus').className = 'error-text';
  $('statStatusDetails').textContent = 'See activity for details';
  if (!lastAuthResult) { $('statAuth').textContent = 'Unverified'; $('statAuthDetails').textContent = 'Assessment did not complete'; }
  $('phaseStatus').textContent = 'Assessment incomplete · completed findings retained';
  $('formError').textContent = message; $('formError').hidden = false; appendLog(message, 'error');
}

function renderModel(model) {
  $('applicationModel').replaceChildren();
  for (const [field, facts] of Object.entries(model || {})) {
    if (!Array.isArray(facts) || !facts.length) continue;
    const section = document.createElement('section'); const heading = document.createElement('h3'); heading.textContent = field; section.append(heading);
    for (const fact of facts) {
      const item = document.createElement('details'); item.className = 'file-entry';
      const summary = document.createElement('summary'); summary.textContent = typeof fact === 'string' ? fact : `${fact.description} · ${fact.status} (${Math.round(fact.confidence * 100)}%)`;
      const refs = document.createElement('pre'); refs.textContent = (fact.sourceEvidence || []).map(ref => `${ref.file}:${ref.line} ${ref.quote}`).join('\n');
      item.append(summary, refs); section.append(item);
    }
    $('applicationModel').append(section);
  }
}
function renderScenarios(scenarios, container = $('scenarioList')) {
  container.replaceChildren();
  for (const scenario of scenarios || []) {
    const details = document.createElement('details'); details.className = 'file-entry';
    const summary = document.createElement('summary'); summary.textContent = `${scenario.id} · ${scenario.name} · ${scenario.risk}`;
    const body = document.createElement('pre'); body.textContent = JSON.stringify({ category: scenario.category, session: scenario.session, preconditions: scenario.preconditions, steps: scenario.steps, expected: scenario.expected, sourceEvidence: scenario.sourceEvidence }, null, 2);
    details.append(summary, body); container.append(details);
  }
}
function renderTestResult(result) {
  testResults.set(result.id, result); $('testResults').replaceChildren();
  for (const test of testResults.values()) {
    const details = document.createElement('details'); details.className = 'file-entry test-result';
    const title = document.createElement('summary'); title.textContent = `${test.status} · ${test.id} · ${test.name}`;
    const body = document.createElement('pre'); body.textContent = JSON.stringify({ summary: test.explanation || test.summary, expected: test.scenario?.expected, observed: test.checks, error: test.error, actions: test.history, reproduction: test.reproduction, sourceEvidence: test.scenario?.sourceEvidence }, null, 2);
    details.append(title, body);
    for (const observation of [...(test.observations || []), ...(test.reproduction?.result?.observations || [])]) {
      if (!observation.evidenceId || !currentRunId) continue;
      const row = document.createElement('p'); const link = document.createElement('a');
      const base = `/api/runs/${encodeURIComponent(currentRunId)}/artifacts/`;
      link.textContent = `Observation · ${observation.url || ''} · ${observation.timestamp || ''}`;
      link.href = base + encodeURIComponent(observation.evidenceId + '.json'); link.target = '_blank'; link.rel = 'noopener'; row.append(link); details.append(row);
      if (observation.screenshot) {
        const image = document.createElement('img'); image.src = base + encodeURIComponent(observation.screenshot); image.alt = 'Masked browser evidence'; image.loading = 'lazy'; image.className = 'evidence-image'; details.append(image);
      }
    }
    $('testResults').append(details);
  }
}
async function loadReport(runId) {
  if (!runId) return;
  $('btnDownloadReport').href = `/api/report?runId=${encodeURIComponent(runId)}`;
  const response = await fetch($('btnDownloadReport').href);
  if (!response.ok) throw new Error('Report is not available for this run.');
  $('reportContent').textContent = await response.text(); $('reportBadge').hidden = false;
}
async function refreshRuns() {
  try {
    const data = await apiRequest('/api/runs'); $('savedRuns').replaceChildren(new Option('Select a saved run', ''));
    for (const run of data.runs) $('savedRuns').append(new Option(`${run.startedAt} · ${run.target} · ${run.status}`, run.runId));
  } catch {}
}
function handleStreamEvent(event) {
  if (event.type === 'stage_start') { currentRunId = event.runId; resetResults(); setRunning(true, 'Starting'); appendLog(event.name); }
  if (event.type === 'authentication_result') renderAuthentication(event.data);
  if (event.type === 'target_reachable') { $('statStatus').textContent = 'Reachable'; $('statStatus').className = 'success'; $('statStatusDetails').textContent = `HTTP ${event.status}`; }
  if (event.type === 'browser_ready') appendLog(`Browser opened: ${event.data.browser}`, 'info');
  if (event.type === 'application_model') renderModel(event.data);
  if (event.type === 'scenarios_ready') renderScenarios(event.data);
  if (event.type === 'test_start') { $('phaseStatus').textContent = `Running ${event.data.id} · ${event.data.name}`; appendLog($('phaseStatus').textContent); }
  if (event.type === 'agent_step') appendLog(`${event.data.testId} · step ${event.data.step}: ${event.data.action}`);
  if (event.type === 'test_result') { renderTestResult(event.data); appendLog(`${event.data.id}: ${event.data.status}`, event.data.status === 'PASS' ? 'success' : 'warn'); }
  if (event.type === 'report_ready') { loadReport(event.data.runId).catch(error => appendLog(error.message, 'warn')); refreshRuns(); }
  if (event.type === 'memory_status') $('memoryStatus').textContent = event.text;
  if (event.type === 'assessment_phase') { $('phaseStatus').textContent = event.text; setRunning(true, event.text); appendLog(event.text); }
  if (event.type === 'user_prompt') {
    pendingPrompt = event; $('userPromptBox').hidden = false;
    $('promptTitle').textContent = event.prompt; $('promptDetail').textContent = event.detail;
    $('btnPromptProceed').firstElementChild.textContent = event.kind === 'execution' ? 'Run reviewed tests' : event.kind === 'browser' ? 'Open browser' : 'Verify sign-in';
    $('executionPermissions').hidden = event.kind !== 'execution'; $('allowMutations').checked = false; $('allowDangerous').checked = false;
    renderScenarios(event.scenarios, $('promptScenarios')); $('runState').textContent = 'Waiting for you';
  }
  if (event.type === 'understanding_coverage' && sourceReport) { sourceReport.aiCoverage = event.data; updateCoverageText(sourceReport); }
  if (event.type === 'understanding_note' && sourceReport) { sourceReport.chunkNotes.push(event.data); appendSourceFinding(event.data); }
  if (['repository_read', 'understanding_ready'].includes(event.type)) renderSourceReport(event.data, true);
  if (event.type === 'reading_progress') appendLog(`Read ${event.filesRead} files · ${event.path}`);
  if (event.type === 'understanding_progress') appendLog(`Understanding ${event.current}/${event.total} · ${event.path}`);
  if (event.type === 'log') appendLog(event.text, event.level);
  if (event.type === 'assessment_complete') {
    const data = event.data; currentRunId = data.runId || currentRunId; pendingPrompt = null; $('userPromptBox').hidden = true;
    if (data.report || data.sourceReport) renderSourceReport(data.report || data.sourceReport, true);
    if (data.applicationModel) renderModel(data.applicationModel);
    if (data.scenarios) renderScenarios(data.scenarios);
    if (data.authentication) renderAuthentication(data.authentication);
    for (const result of data.results || []) renderTestResult(result);
    setRunning(false, data.status); $('statStatusDetails').textContent = `Assessment: ${data.status}`; $('phaseStatus').textContent = `${data.status} · ${(data.results || []).length} test results saved`;
    if (data.error) appendLog(data.error.message, 'error');
    loadReport(currentRunId).catch(() => {}); refreshRuns();
  }
}
async function answerPrompt(proceed) {
  if (!pendingPrompt) return;
  $('btnPromptProceed').disabled = $('btnPromptSkip').disabled = true;
  try {
    await apiRequest('/api/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: pendingPrompt.runId, promptId: pendingPrompt.promptId, proceed, allowMutations: $('allowMutations').checked, allowDangerous: $('allowDangerous').checked }) });
    pendingPrompt = null; $('userPromptBox').hidden = true;
  } catch (error) { appendLog(error.message, 'error'); }
  finally { $('btnPromptProceed').disabled = $('btnPromptSkip').disabled = false; }
}
$('btnPromptProceed').addEventListener('click', () => answerPrompt(true));
$('btnPromptSkip').addEventListener('click', () => answerPrompt(false));
$('allowMutations').addEventListener('change', () => { if (!$('allowMutations').checked) $('allowDangerous').checked = false; });
$('btnCancel').addEventListener('click', async () => {
  try { await apiRequest('/api/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: currentRunId }) }); $('phaseStatus').textContent = 'Canceling and saving completed evidence…'; } catch (error) { appendLog(error.message, 'error'); }
});
$('authMode').addEventListener('change', () => {
  document.querySelectorAll('.credential').forEach(group => { group.hidden = !group.dataset.mode.split(' ').includes($('authMode').value); group.querySelectorAll('input').forEach(input => { input.disabled = group.hidden; input.required = !group.hidden && !(input.id === 'passwordInput' && $('authMode').value === 'authId'); }); });
});
$('authMode').dispatchEvent(new Event('change'));
$('attackForm').addEventListener('submit', async event => {
  event.preventDefault(); if (running || !streamReady) return;
  const payload = { target: $('targetUrl').value.trim(), repo: $('repoPath').value.trim(), upload: $('uploadFixture').value.trim(), authMode: $('authMode').value, replay: $('replayTests').checked };
  if (payload.authMode === 'cookie') payload.cookie = $('cookieInput').value.trim();
  if (payload.authMode === 'bearer') payload.bearer = $('bearerInput').value.trim();
  if (payload.authMode === 'credentials') { payload.username = $('usernameInput').value.trim(); payload.password = $('passwordInput').value; }
  if (payload.authMode === 'authId') { payload.authId = $('authIdInput').value.trim(); payload.password = $('passwordInput').value; }
  resetResults(); setRunning(true, 'Starting'); selectTab('Activity');
  try {
    const status = await apiRequest('/api/status');
    if (!status.capabilities.includes('source-aware-browser-agent')) throw new Error('Restart CodeStress to load the new workflow.');
    const result = await apiRequest('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); currentRunId = result.runId;
    for (const id of ['passwordInput', 'cookieInput', 'bearerInput']) $(id).value = '';
  } catch (error) { fail(error.message); }
});
$('btnLoadRun').addEventListener('click', async () => {
  if (running || !$('savedRuns').value) return;
  try { const data = await apiRequest(`/api/runs/${encodeURIComponent($('savedRuns').value)}/artifacts/report.json`); resetResults(); handleStreamEvent({ type: 'assessment_complete', data }); selectTab('Tests'); }
  catch (error) { toast(error.message); }
});
refreshRuns();

$('btnClearLogs').addEventListener('click', () => { $('termBody').replaceChildren(); eventCount = 0; $('logCount').textContent = '0 events'; });
$('btnCopyLogs').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('termBody').innerText); toast('Activity copied to clipboard'); } catch { toast('Clipboard unavailable. Select and copy the activity text.'); } });

const stream = new EventSource('/api/stream');
stream.onopen = () => { streamReady = true; $('btnRun').disabled = running; $('connection').classList.remove('offline'); $('connectionText').textContent = 'Connected'; $('streamLabel').textContent = 'Live stream connected'; $('streamDot').style.background = ''; };
stream.onmessage = event => { try { handleStreamEvent(JSON.parse(event.data)); } catch { appendLog('Unable to read a stream event.', 'warn'); } };
stream.onerror = () => { streamReady = false; $('btnRun').disabled = true; $('connection').classList.add('offline'); $('connectionText').textContent = 'Reconnecting'; $('streamLabel').textContent = 'Connection lost · reconnecting'; $('streamDot').style.background = '#daae72'; };
$('btnRun').disabled = true;

apiRequest('/api/status').then(data => {
  $('engineModel').textContent = data.model || String(data.engine || 'Configured model').replace(/^.*\((.*)\)$/, '$1'); $('portLabel').textContent = `PORT ${data.port || 9999}`;
}).catch(() => { $('engineModel').textContent = 'Model status unavailable'; });

let memoryTimer;
function inspectMemory() {
  clearTimeout(memoryTimer);
  memoryTimer = setTimeout(async () => {
    if (running || !$('repoPath').value.trim() || !$('targetUrl').value.trim()) return;
    const query = new URLSearchParams({ repo: $('repoPath').value.trim(), target: $('targetUrl').value.trim() });
    try {
      const data = await apiRequest('/api/memory?' + query);
      if (!running) $('memoryStatus').textContent = data.exists ? `${data.findings} saved findings · ${new Date(data.updatedAt).toLocaleString()}. Source changes will be checked before reuse.` : 'New project · findings will be saved locally.';
    } catch { if (!running) $('memoryStatus').textContent = 'Memory will be checked when the assessment starts.'; }
  }, 400);
}
$('repoPath').addEventListener('input', inspectMemory);
$('targetUrl').addEventListener('input', inspectMemory);

function renderInventory() {
  const query = $('fileSearch').value.toLowerCase(); $('fileInventory').replaceChildren();
  for (const file of (sourceReport?.inventory || []).filter(file => `${file.path} ${file.status}`.toLowerCase().includes(query))) {
    const row = document.createElement('details'); row.className = 'file-entry';
    const title = document.createElement('summary'); title.textContent = `${file.status.toUpperCase()} · ${file.path}`;
    const detail = document.createElement('p'); detail.textContent = [file.reason, `${file.bytes} bytes`, file.lines ? `${file.lines} lines` : '', file.sha256 ? `SHA-256: ${file.sha256}` : '', file.aiAnalyzed ? 'All source chunks analyzed by AI' : 'Not fully analyzed by AI'].filter(Boolean).join(' · ');
    row.append(title, detail); $('fileInventory').append(row);
  }
}
$('fileSearch').addEventListener('input', renderInventory);

function renderSourceReport(data, reading = false) {
  sourceReport = data; const coverage = data.coverage;
  $('statEndpoints').textContent = data.endpointsCount; $('statGroups').textContent = 'Heuristic route matches';
  routes = data.routes || []; $('routeCountLabel').textContent = $('navCount').textContent = routes.length; renderRoutes();
  const ai = data.aiCoverage;
  updateCoverageText(data);
  $('aiText').textContent = [data.error, data.aiUnderstanding || (data.aiStatus === 'not_requested' ? 'Source reading completed. AI analysis has not been requested. Review Files, then choose Understand codebase.' : reading ? 'Source reading completed. AI analysis is pending…' : data.chunkNotes?.length ? 'The overall report is incomplete. Source findings collected so far are available below.' : 'No AI findings have been completed yet. Source inventory remains available.')].filter(Boolean).join('\n\n');
  $('aiText').className = 'summary-text'; $('btnDownload').disabled = false; renderInventory(); renderFindings(data);
  if (!reading) {
    const state = data.aiStatus === 'not_requested' ? (coverage.complete && coverage.filesRead ? 'Source read' : 'Partial read') : data.aiStatus === 'complete' ? 'Complete' : data.aiStatus === 'partial' ? 'Partial' : 'AI unavailable';
    setRunning(false, state); appendLog(`${state} · ${coverage.filesRead} files read, ${ai.analyzedChunks}/${ai.totalChunks} AI chunks`, data.error ? 'warn' : 'success');
    if (data.error) appendLog(data.error, 'warn');
    selectTab(data.aiStatus === 'not_requested' ? 'Files' : 'Summary');
  }
}

$('btnDownload').addEventListener('click', () => {
  if (!sourceReport) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(sourceReport, null, 2)], {type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'codestress-understanding.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function updateCoverageText(data) {
  const { coverage, aiCoverage: ai } = data;
  $('coverageText').textContent = `${coverage.filesRead} files read · ${coverage.bytesRead.toLocaleString()} bytes · ${coverage.excludedEntries} excluded entries · ${coverage.skippedFiles} skipped · ${coverage.failedEntries} failed. AI: ${ai.filesAnalyzed} files, ${ai.analyzedChunks}/${ai.totalChunks} source chunks. ${data.source.commit ? `Commit: ${data.source.commit}` : 'Local snapshot: file hashes recorded at read time.'}`;
}

function appendSourceFinding(finding) {
  const item = document.createElement('details'); item.className = 'file-entry';
  const title = document.createElement('summary');
  title.textContent = `${finding.complete === false ? 'INCOMPLETE · ' : ''}${finding.path}:${finding.startLine}-${finding.endLine}`;
  const body = document.createElement('div'); body.className = 'summary-text'; body.textContent = finding.note;
  item.append(title, body); $('aiFindings').append(item);
}

function renderFindings(data) {
  $('aiFindings').replaceChildren(); $('testCommands').replaceChildren();
  for (const finding of data.chunkNotes || []) appendSourceFinding(finding);
  for (const gap of data.analysisGaps || []) {
    const message = document.createElement('p'); message.className = 'error-text';
    message.textContent = `Incomplete: ${gap.path}:${gap.startLine}-${gap.endLine} · ${gap.reason}`;
    $('aiFindings').append(message);
  }
  if (data.testCommands?.length) {
    const title = document.createElement('h3'); title.textContent = 'Declared checks · not run';
    const note = document.createElement('p'); note.textContent = 'These scripts were found in the repository. Execution is not implemented; review the scripts and approve a separate run before testing.';
    $('testCommands').append(title, note);
    for (const command of data.testCommands) {
      const item = document.createElement('details'); item.className = 'file-entry';
      const label = document.createElement('summary'); label.textContent = `${command.executable} ${command.args.join(' ')} · ${command.directory}`;
      const body = document.createElement('pre'); body.textContent = `${command.manifest}\nScript: ${command.script}\nPre-script: ${command.before || '(none)'}\nPost-script: ${command.after || '(none)'}`;
      item.append(label, body); $('testCommands').append(item);
    }
  }
}

function renderAuthentication(result) {
  lastAuthResult = result;
  const verified = result.status === 'SUCCESS' && result.authenticated === true;
  $('statAuth').textContent = verified ? 'Verified' : result.status === 'PUBLIC' ? 'Public' : result.status === 'FAILED' ? 'Rejected' : 'Unverified';
  $('statAuth').className = verified ? 'success' : '';
  $('statAuthDetails').textContent = result.detail || 'No authentication evidence';
  $('authEvidence').hidden = false; $('authEvidenceDetail').textContent = result.detail || '';
  $('authEvidenceList').replaceChildren();
  for (const check of result.evidence || []) { const row = document.createElement('li'); row.textContent = `${check.step}: ${check.endpoint} → HTTP ${check.httpStatus}`; $('authEvidenceList').append(row); }
}
