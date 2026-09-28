export function findingsFrom(results) {
  return results.filter(result => result.status === 'FAIL').map((result, i) => ({
    id: `FINDING-${String(i + 1).padStart(3, '0')}`, testId: result.id, summary: result.name,
    severity: 'UNASSESSED', severityBasis: 'Behavioral contradiction observed; business impact has not been established.',
    preconditions: result.scenario.preconditions, steps: result.history.filter(item => item.status === 'EXECUTED').map(item => item.action),
    expected: result.scenario.expected, observed: result.checks, evidence: result.observations.map(item => item.evidenceId),
    sourceEvidence: result.scenario.sourceEvidence, reproduction: result.reproduction || { status: 'NOT_ATTEMPTED' }, timestamp: result.finishedAt
  }));
}
export function renderReport(report) {
  const lines = ['# CodeStress application behavior report', '', `Run: ${report.runId}`, `Target: ${report.target}`, `Source fingerprint: ${report.fingerprint}`, `Status: ${report.status}`, `Browser: ${report.browser?.browser || 'Not started'} ${report.browser?.version || ''}`, '', '## Results', ''];
  for (const result of report.results || []) {
    lines.push(`### ${result.id}: ${result.name} — ${result.status}`, '', `Preconditions: ${(result.scenario?.preconditions || []).join('; ')}`, `Expected: ${JSON.stringify(result.scenario?.expected || [])}`, `Observed: ${JSON.stringify(result.checks || result.error || [])}`, `Reproduction: ${result.reproduction?.status || 'Not applicable'}`, '', 'Actions:', ...result.history.map(item => `- ${item.status}: ${JSON.stringify(item.action)}`), '', 'Evidence:', ...result.observations.map(item => `- ${item.evidenceId} — ${item.url} — ${item.timestamp}`), '', 'Source:', ...(result.scenario?.sourceEvidence || []).map(ref => `- ${ref.file}:${ref.line} — ${ref.quote}`), '');
  }
  lines.push('## Findings', '', ...report.findings.map(finding => `- ${finding.id}: ${finding.summary}. Severity: ${finding.severity}. Reproduction: ${finding.reproduction.status}.`), '', '## Limits', '', 'Results apply only to executed scenarios and observed evidence. UNCERTAIN/BLOCKED/SKIPPED are not passes. Browser isolation resets client state, not server data. No general security guarantee is implied.');
  return lines.join('\n');
}
