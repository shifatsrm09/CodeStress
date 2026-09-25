const TYPES = new Set([
  'sql_injection', 'xss', 'idor', 'auth_bypass', 'rate_limit',
  'csrf', 'access_control', 'error_exposure', 'null_input', 'oversized_payload'
]);

const protectedHints = /auth|protect|private|admin|user|profile|dashboard|account|transfer|delete|update/i;
const sqlHints = /sql|query|select|insert|update|delete|database|prisma|sequelize|knex|mongoose|mongo/i;
const xssHints = /comment|message|bio|content|name|description|html|render/i;

export function normalizeAttackPlan(repository, routeAnalysis) {
  const routes = routeAnalysis.routes || [];
  const sourceFiles = new Set(repository.files.map(f => f.path));
  const plan = { version: 1, generatedBy: 'heuristic', rationale: '', tests: [] };
  const add = test => {
    if (!test || !TYPES.has(test.type) || !test.method || !test.path) return;
    if (!sourceFiles.has(test.file)) return;
    const key = `${test.type}:${test.method}:${test.path}:${test.parameter || ''}`;
    if (plan.tests.some(existing => `${existing.type}:${existing.method}:${existing.path}:${existing.parameter || ''}` === key)) return;
    plan.tests.push({
      type: test.type,
      method: test.method.toUpperCase(),
      path: test.path,
      file: test.file,
      line: Number.isInteger(test.line) ? test.line : null,
      parameter: test.parameter || null,
      reason: String(test.reason || '').slice(0, 400),
      priority: ['auth_bypass', 'access_control', 'idor', 'sql_injection', 'xss', 'rate_limit', 'csrf', 'error_exposure', 'null_input', 'oversized_payload'].indexOf(test.type) + 1
    });
  };

  for (const route of routes) {
    const routeText = `${route.path} ${route.file} ${route.rawContext || ''}`;
    const hasDbTouchpoint = (routeAnalysis.dbQueries || []).some(query => query.file === route.file && Math.abs((query.line || route.line || 0) - (route.line || 0)) <= 12);
    const hasAuth = protectedHints.test(route.path) || /currentUser|auth\s*\(|verifyToken|authMiddleware|requireAuth|authenticate|isAdmin/i.test(route.rawContext || '');
    const hasBody = (route.parameters || []).some(p => p.in === 'body');
    const bodyParam = (route.parameters || []).find(p => p.in === 'body')?.name;
    const pathParam = (route.parameters || []).find(p => p.in === 'path')?.name;

    const isLoginRoute = /(?:^|\/)(?:login|signin|sign-in|register|signup)$/i.test(route.path);
    if (hasAuth && !isLoginRoute) {
      add({ ...route, type: 'auth_bypass', reason: 'Protected-looking endpoint should reject anonymous access.' });
    }
    if (pathParam && /user|account|profile|student|id/i.test(pathParam + route.path)) {
      add({ ...route, type: 'idor', parameter: pathParam, reason: 'Path identifier controls access to an object and should enforce ownership.' });
    }
    if (hasBody && /post|put|patch/i.test(route.method)) {
      if (sqlHints.test(routeText) || hasDbTouchpoint) add({ ...route, type: 'sql_injection', parameter: bodyParam, reason: 'User-controlled request data appears near database access.' });
      if (!isLoginRoute && bodyParam && xssHints.test(`${route.path} ${bodyParam}`)) add({ ...route, type: 'xss', parameter: bodyParam, reason: 'User-controlled text is a likely reflection/storage surface.' });
      add({ ...route, type: 'null_input', parameter: bodyParam, reason: 'Missing/null validation should be verified with malformed input.' });
      add({ ...route, type: 'oversized_payload', parameter: bodyParam, reason: 'Large input should be bounded and handled without a server error.' });
    }
    if (/login|signin|auth/i.test(route.path) && route.method === 'POST') {
      add({ ...route, type: 'rate_limit', reason: 'Authentication endpoints should throttle repeated attempts.' });
    }
    if (/login|signin|auth/i.test(route.path) && route.method === 'POST') {
      add({ ...route, type: 'error_exposure', reason: 'Authentication errors should not expose internals or stack traces.' });
    }
    if ((hasAuth || /delete|transfer|update|create/i.test(route.path)) && route.method !== 'GET' && !isLoginRoute) {
      add({ ...route, type: 'csrf', reason: 'State-changing routes should be checked for CSRF protections when cookie authentication is used.' });
    }
    if (/admin/i.test(route.path)) {
      add({ ...route, type: 'access_control', reason: 'Admin-looking endpoints should reject low-privilege users.' });
    }
  }
  plan.tests.sort((a, b) => a.priority - b.priority);
  plan.tests = plan.tests.slice(0, 40);
  plan.rationale = `Generated ${plan.tests.length} context-aware tests from ${routes.length} discovered routes.`;
  return plan;
}

export function parseJsonObject(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(cleaned); } catch { return null; }
}

export function validateAiPlan(candidate, repository) {
  if (!candidate || !Array.isArray(candidate.tests)) return null;
  const files = new Set(repository.files.map(file => file.path));
  const tests = [];
  for (const item of candidate.tests.slice(0, 50)) {
    if (!TYPES.has(item?.type) || !['GET','POST','PUT','PATCH','DELETE'].includes(item?.method?.toUpperCase())) continue;
    if (typeof item.path !== 'string' || !/^\/(?!\/)[a-zA-Z0-9_./:%{}-]*$/.test(item.path)) continue;
    if (item.file && !files.has(item.file)) continue;
    tests.push({
      type: item.type,
      method: item.method.toUpperCase(),
      path: item.path,
      file: item.file || null,
      line: Number.isInteger(item.line) ? item.line : null,
      parameter: typeof item.parameter === 'string' ? item.parameter : null,
      reason: String(item.reason || '').slice(0, 400),
      priority: Number.isFinite(item.priority) ? item.priority : 99
    });
  }
  if (!tests.length) return null;
  return { version: 1, generatedBy: 'ibm-bob-compatible-ai', rationale: String(candidate.rationale || '').slice(0, 500), tests };
}
