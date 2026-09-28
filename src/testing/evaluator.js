import { locate } from '../browser/actionExecutor.js';
export async function evaluateExpectations(scenario, session, observations, actionFailed = false) {
  const final = observations.at(-1);
  if (!final || final.blocked || actionFailed) return { status: final?.blocked ? 'BLOCKED' : 'UNCERTAIN', checks: [], summary: 'Execution did not reach a reliable evaluation point.' };
  const checks = [];
  for (const expected of scenario.expected) {
    let observed = null, matched = null;
    try {
      switch (expected.type) {
        case 'url': observed = new URL(final.url).pathname; matched = observed === expected.value; break;
        case 'text': observed = final.visibleText.includes(expected.value); matched = observed; break;
        case 'visible': case 'hidden': {
          const locator = locate(session.page, expected.target); const count = await locator.count();
          if (count > 1) break;
          observed = count === 1 && await locator.isVisible(); matched = expected.type === 'visible' ? observed : !observed; break;
        }
        case 'inputValidity': {
          const locator = locate(session.page, expected.target);
          if (await locator.count() !== 1) break;
          observed = await locator.evaluate(element => element.validity ? element.validity.valid : null); matched = observed === null ? null : observed === expected.valid; break;
        }
        case 'httpStatus': {
          const responses = observations.flatMap(item => item.network || []).filter(item => item.kind === 'response' && new URL(item.url).pathname === expected.path);
          if (!responses.length) break;
          observed = responses.at(-1).status; matched = expected.statuses.includes(observed); break;
        }
        case 'noPageErrors': observed = observations.flatMap(item => item.pageErrors || []).length; matched = observed === 0; break;
      }
    } catch { matched = null; }
    checks.push({ expected, observed, matched, evidenceIds: observations.map(item => item.evidenceId).filter(Boolean) });
  }
  const policyBlocked = observations.some(item => item.failedRequests?.some(request => /policy|scope/i.test(request.error)));
  const status = policyBlocked ? 'BLOCKED' : checks.some(check => check.matched === null) ? 'UNCERTAIN' : checks.some(check => check.matched === false) ? 'FAIL' : 'PASS';
  return { status, checks, summary: status === 'PASS' ? 'All explicit expectations were observed.' : status === 'FAIL' ? 'Observed behavior contradicted at least one source-derived expectation.' : 'Evidence was incomplete or execution was blocked.' };
}
export async function explainEvaluation(provider, scenario, evaluation, observations, options) {
  // The model cannot override the evidence-derived status or claim absent evidence.
  return provider.structuredGenerate('Explain this fixed test judgment in JSON {summary:string,limitations:string[]}. Do not change the judgment, infer severity, or claim facts absent from the observations. Return a concise explanation of expected versus observed.', { scenario, evaluation, observations: observations.map(item => ({ id: item.evidenceId, url: item.url, title: item.title, visibleText: item.visibleText?.slice(0, 3000), network: item.network, pageErrors: item.pageErrors })) }, value => {
    if (typeof value?.summary !== 'string' || value.summary.length > 1200 || !Array.isArray(value.limitations) || value.limitations.some(x => typeof x !== 'string')) throw new Error('Invalid explanation');
    return { summary: value.summary, limitations: value.limitations.slice(0, 10) };
  }, options);
}
