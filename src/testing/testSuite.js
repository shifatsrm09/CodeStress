import { limits, checkSignal, publicError } from '../core/runtime.js';
import { TestAgent } from './testAgent.js';
import { actionRisk } from '../browser/actionSchema.js';

export async function runTestSuite({ scenarios, manager, state, bearer, authentication, provider, store, signal, policy, onEvent, checkpoint, onManual, uploads = {}, replay = false }) {
  const results = [];
  for (const scenario of scenarios.slice(0, limits.scenarios)) {
    if (signal?.aborted) break;
    onEvent({ type: 'test_start', data: { id: scenario.id, name: scenario.name, category: scenario.category } });
    let result, session;
    const unavailable = scenario.session === 'authenticated' && (!authentication.authenticated || (scenario.requiredRole && authentication.user?.role !== scenario.requiredRole));
    const riskBlocked = scenario.risk === 'DANGEROUS' ? !policy.allowDangerous : scenario.risk === 'CAUTION' && !policy.allowMutations;
    if (unavailable || riskBlocked || scenario.preconditions.some(item => /unknown|unavailable|second account|fixture required/i.test(item))) {
      result = { id: scenario.id, name: scenario.name, scenario, status: 'SKIPPED', summary: unavailable ? 'Verified authentication is unavailable.' : riskBlocked ? 'Scenario risk is not authorized.' : 'A required role or fixture is unavailable.', history: [], observations: [], finishedAt: new Date().toISOString() };
    } else {
      try {
        checkSignal(signal);
        session = await manager.session({ state: scenario.session === 'authenticated' ? state : undefined, bearer: scenario.session === 'authenticated' ? bearer : '', policy });
        await session.page.goto(session.safeURL('/'), { waitUntil: 'domcontentloaded' });
        const agent = new TestAgent({ provider, store, signal, onEvent, uploads });
        result = await agent.run(scenario, session, { replay });
        if (result.error?.code === 'MANUAL_REQUIRED' && onManual) {
          const allowed = await onManual(session);
          if (allowed && scenario.risk === 'SAFE') result = await agent.run(scenario, session, { replay: true });
          else result.summary = 'Manual interaction did not establish a safe scenario replay.';
        }
        if (result.status === 'FAIL') {
          const executed = result.history.filter(item => item.status === 'EXECUTED').map(item => item.action);
          // A new browser context resets client state only. Never repeat writes automatically.
          if (scenario.risk === 'SAFE' && executed.every(action => actionRisk(action) === 'SAFE')) {
            onEvent({ type: 'assessment_phase', phase: 'reproducing', text: `Reproducing ${scenario.id} in a fresh browser context` });
            await session.close();
            session = await manager.session({ state: scenario.session === 'authenticated' ? state : undefined, bearer: scenario.session === 'authenticated' ? bearer : '', policy });
            await session.page.goto(session.safeURL('/'), { waitUntil: 'domcontentloaded' });
            const replayResult = await agent.run({ ...scenario, steps: executed }, session, { replay: true });
            const sameFailure = result.checks.some((check, i) => check.matched === false && replayResult.checks?.[i]?.matched === false);
            result.reproduction = { status: replayResult.status === 'FAIL' && sameFailure ? 'CONFIRMED' : replayResult.status === 'PASS' ? 'NOT_REPRODUCED' : 'INCONCLUSIVE', steps: executed, reset: 'Fresh browser context; server state unchanged', result: replayResult };
          } else result.reproduction = { status: 'NOT_ATTEMPTED', reason: 'Mutation replay needs a known server reset/cleanup strategy and separate authorization.' };
        }
      } catch (error) { result = { id: scenario.id, name: scenario.name, scenario, status: signal?.aborted ? 'BLOCKED' : 'UNCERTAIN', error: publicError(error), history: [], observations: [], finishedAt: new Date().toISOString() }; }
      finally { await session?.close().catch(() => {}); }
    }
    results.push(result); await checkpoint(results);
    onEvent({ type: 'test_result', data: result });
  }
  return results;
}
