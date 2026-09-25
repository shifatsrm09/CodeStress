import fs from 'node:fs/promises';
import path from 'node:path';

export function buildReport({ target, repository, routeAnalysis, attackSummary, attackPlan, authentication, hardened = [] }) {
  const summary = attackSummary || { testsRun: 0, passed: 0, failed: 0, warnings: 0, score: null, rating: 'Not run', results: [] };
  const lines = [];
  lines.push('# CodeStress Report', '');
  lines.push(`**Target:** ${target}`);
  lines.push(`**Repository:** ${repository.source.location}`);
  if (repository.source.commit) lines.push(`**Commit:** ${repository.source.commit}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push('**Engine:** CodeStress adversarial pipeline', '');

  lines.push('## App Summary', '');
  lines.push(`- Route groups: ${routeAnalysis.routeGroups}`);
  lines.push(`- Endpoints discovered: ${routeAnalysis.endpoints}`);
  lines.push(`- Source files read: ${repository.coverage.filesRead}`);
  lines.push(`- Authentication: ${authentication?.status || 'NOT RUN'}`);
  lines.push('');

  lines.push('## Results', '');
  lines.push('| Tests | Passed | Failed | Warnings | Security Score |');
  lines.push('|---:|---:|---:|---:|---:|');
  lines.push(`| ${summary.testsRun} | ${summary.passed} | ${summary.failed} | ${summary.warnings} | ${summary.score ?? 'n/a'} / 100 |`);
  lines.push(`| Rating | ${summary.rating} | | | |`);
  lines.push('');

  lines.push('## Attack Plan', '');
  for (const test of attackPlan?.tests || []) lines.push(`- **${test.type}** — ${test.method} ${test.path}${test.parameter ? ` · parameter: ${test.parameter}` : ''} — ${test.reason || 'context-aware test'}`);
  if (!(attackPlan?.tests || []).length) lines.push('- No attack tests were generated.');
  lines.push('');

  lines.push('## Findings', '');
  const failures = summary.results.filter(r => r.status === 'FAILED');
  if (!failures.length) lines.push('No failed adversarial tests were observed.');
  for (const finding of failures) appendFinding(lines, finding);
  lines.push('');

  lines.push('## Warnings', '');
  const warnings = summary.results.filter(r => r.status === 'WARNING');
  if (!warnings.length) lines.push('No warnings.');
  for (const finding of warnings) appendFinding(lines, finding);
  lines.push('');

  lines.push('## Passed Tests', '');
  for (const finding of summary.results.filter(r => r.status === 'PASSED')) lines.push(`- ✅ ${finding.type} — ${finding.method} ${finding.path} — ${finding.detail}`);
  if (!summary.results.some(r => r.status === 'PASSED')) lines.push('- None.');
  lines.push('');

  lines.push('## Hardened Code Guidance', '');
  const guidance = [...hardened];
  for (const finding of [...failures, ...warnings]) {
    guidance.push({ type: finding.type, file: finding.file, line: finding.line, recommendation: finding.recommendation });
  }
  const seen = new Set();
  for (const item of guidance) {
    const key = `${item.type}:${item.file}:${item.line}:${item.recommendation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`### ${item.type}${item.file ? ` — ${item.file}${item.line ? `:${item.line}` : ''}` : ''}`);
    lines.push(item.recommendation || 'Review and harden the affected endpoint.');
    lines.push('');
  }
  if (!guidance.length) lines.push('No automated fix guidance was generated.');

  lines.push('## Scope and Safety', '');
  lines.push('CodeStress only performs tests against the user-supplied target during an authorized assessment. Requests are bounded, do not follow redirects, and do not execute repository code. Review findings before applying changes.');
  lines.push('');
  return lines.join('\n');
}

function appendFinding(lines, finding) {
  lines.push(`### ${finding.severity || 'REVIEW'} — ${finding.type}`);
  lines.push(`- Endpoint: **${finding.method} ${finding.path}**`);
  if (finding.file) lines.push(`- File: ${finding.file}${finding.line ? `:${finding.line}` : ''}`);
  if (finding.parameter) lines.push(`- Parameter: ${finding.parameter}`);
  lines.push(`- Result: ${finding.detail}`);
  if (finding.evidence?.length) {
    lines.push('- Evidence:');
    for (const item of finding.evidence.slice(0, 4)) lines.push(`  - ${JSON.stringify(item).slice(0, 1200)}`);
  }
  lines.push(`- Fix: ${finding.recommendation || 'Review the endpoint and apply an appropriate server-side control.'}`);
  lines.push('');
}

export async function writeReport(report, outputPath = 'CODESTRESS.md') {
  const absolute = path.resolve(outputPath);

  await fs.mkdir(path.dirname(absolute), {
    recursive: true
  });

  await fs.writeFile(
    absolute,
    report,
    'utf8'
  );

  return absolute;
}
