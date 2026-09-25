import { SafeHttpClient } from './httpClient.js';
import { randomUUID } from 'node:crypto';

const severityByType = {
  sql_injection: 'CRITICAL', xss: 'HIGH', idor: 'HIGH', auth_bypass: 'CRITICAL',
  rate_limit: 'MEDIUM', csrf: 'MEDIUM', access_control: 'HIGH', error_exposure: 'MEDIUM',
  null_input: 'LOW', oversized_payload: 'MEDIUM'
};

const scorePenalty = { CRITICAL: 30, HIGH: 20, MEDIUM: 10, LOW: 5 };
const safeString = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const hasJson = response => typeof response?.data === 'object' && response?.data !== null;
const bodyText = response => typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data ?? '');
const substitutePath = (path, parameter, value) => path.replace(new RegExp(`\\{${parameter}\\}|:${parameter}\\b`, 'g'), encodeURIComponent(String(value)));
const routeBase = (target, path) => new URL(path, target).href;

export class AttackEngine {
  constructor({ target, repository, routeAnalysis, plan, authentication, http, onEvent = () => {}, options = {} }) {
    this.target = new URL(target);
    this.repository = repository;
    this.routeAnalysis = routeAnalysis;
    this.plan = plan;
    this.authentication = authentication || {};
    this.http = http || new SafeHttpClient({ timeoutMs: options.timeoutMs || 10000 });
    this.emit = onEvent;
    this.options = {
      rateLimitRequests: 12,
      oversizedBytes: 128 * 1024,
      ...options
    };
  }

  headers(extra = {}, authenticated = true) {
    const headers = { 'User-Agent': 'CodeStress/1.0 authorized-security-test', Accept: 'application/json,text/html;q=0.9,*/*;q=0.1', ...extra };
    if (authenticated && this.authentication.bearer) headers.Authorization = `Bearer ${this.authentication.bearer}`;
    if (authenticated && this.authentication.cookie) headers.Cookie = this.authentication.cookie;
    return headers;
  }

  async execute() {
    const results = [];
    const tests = this.plan.tests || [];
    for (let index = 0; index < tests.length; index++) {
      const test = tests[index];
      this.emit({ type: 'attack_progress', index: index + 1, total: tests.length, test });
      let result;
      try {
        result = await this.runTest(test);
      } catch (error) {
        result = this.baseResult(test, 'WARNING', `Test could not be completed: ${error.message}`);
      }
      results.push(result);
      this.emit({ type: 'attack_result', data: result });
    }
    return this.summarize(results);
  }

  baseResult(test, status, detail, extra = {}) {
    return {
      id: randomUUID(), status, type: test.type, method: test.method, path: test.path,
      file: test.file || null, line: test.line || null, parameter: test.parameter || null,
      severity: status === 'FAILED' ? (severityByType[test.type] || 'MEDIUM') : null,
      detail: String(detail).slice(0, 2000), evidence: [], recommendation: recommendation(test.type), ...extra
    };
  }

  async runTest(test) {
    switch (test.type) {
      case 'auth_bypass': return this.testAuthBypass(test);
      case 'idor': return this.testIdor(test);
      case 'sql_injection': return this.testSqlInjection(test);
      case 'xss': return this.testXss(test);
      case 'rate_limit': return this.testRateLimit(test);
      case 'null_input': return this.testNullInput(test);
      case 'oversized_payload': return this.testOversized(test);
      case 'error_exposure': return this.testErrorExposure(test);
      case 'access_control': return this.testAccessControl(test);
      case 'csrf': return this.testCsrf(test);
      default: return this.baseResult(test, 'WARNING', 'Unsupported test type in this build.');
    }
  }

  async testAuthBypass(test) {
    const url = routeBase(this.target, test.path.replace(/\{[^}]+\}|:[^/]+/g, '1'));
    const anonymous = await this.http.request(url, { method: test.method, headers: this.headers({}, false) });
    if ([401, 403].includes(anonymous.status) || [301,302,303,307,308].includes(anonymous.status)) {
      return this.baseResult(test, 'PASSED', 'Anonymous access was rejected.', { evidence: [{ request: 'anonymous', status: anonymous.status }] });
    }
    if (anonymous.status >= 200 && anonymous.status < 300) {
      return this.baseResult(test, 'FAILED', `Protected-looking endpoint accepted anonymous access with HTTP ${anonymous.status}.`, { evidence: [{ request: 'anonymous', status: anonymous.status, response: bodyText(anonymous).slice(0, 800) }] });
    }
    return this.baseResult(test, 'WARNING', `Anonymous request returned HTTP ${anonymous.status}; review whether that is expected.`);
  }

  async testIdor(test) {
    const ownId = this.authentication.user?.id ?? this.authentication.user?.userId ?? this.authentication.user?.studentId ?? null;
    const parameter = test.parameter || test.path.match(/[:{]([^}:]+)[}:]/)?.[1] || 'id';
    const baselineValue = ownId ?? '2';
    const otherValue = String(baselineValue) === '1' ? '2' : '1';
    const ownPath = substitutePath(test.path, parameter, baselineValue);
    const otherPath = substitutePath(test.path, parameter, otherValue);
    const own = await this.http.request(routeBase(this.target, ownPath), { method: test.method, headers: this.headers() });
    const other = await this.http.request(routeBase(this.target, otherPath), { method: test.method, headers: this.headers() });
    if (other.status >= 200 && other.status < 300 && own.status >= 200 && own.status < 300) {
      const meaningful = hasJson(other) && JSON.stringify(other.data).length > 20;
      if (meaningful && JSON.stringify(other.data) !== JSON.stringify(own.data)) {
        return this.baseResult(test, 'FAILED', `Authenticated subject could access a different object by changing ${parameter}.`, {
          evidence: [
            { request: ownPath, status: own.status, response: bodyText(own).slice(0, 500) },
            { request: otherPath, status: other.status, response: bodyText(other).slice(0, 1000) }
          ]
        });
      }
    }
    if ([403, 404].includes(other.status)) return this.baseResult(test, 'PASSED', 'Alternate object identifier was rejected.', { evidence: [{ request: otherPath, status: other.status }] });
    return this.baseResult(test, 'WARNING', `Alternate identifier returned HTTP ${other.status}; manual review may be needed.`, { evidence: [{ request: otherPath, status: other.status }] });
  }

  async testSqlInjection(test) {
    const payloads = ["' OR '1'='1", '1 OR 1=1', '" OR "1"="1'];
    const payload = payloads[1];
    const request = await this.requestWithInjectedParameter(test, payload);
    const text = bodyText(request.response);
    if (request.response.status >= 200 && request.response.status < 300 && (/executedQuery|query|sql|transfer processed|database/i.test(text))) {
      return this.baseResult(test, 'FAILED', 'Injected input reached a database-like response without being rejected.', {
        evidence: [{ payload, status: request.response.status, response: text.slice(0, 1200) }]
      });
    }
    if (request.response.status >= 500 || /SQL syntax|database error|sequelize|prisma|mongodb/i.test(text)) {
      return this.baseResult(test, 'FAILED', 'Injected input triggered a database error or server failure.', { evidence: [{ payload, status: request.response.status, response: text.slice(0, 1200) }] });
    }
    return this.baseResult(test, 'PASSED', 'Common injection payloads were rejected or did not reach a database-sensitive response.', { evidence: [{ payload, status: request.response.status }] });
  }

  async testXss(test) {
    const payload = '<script>codestress-xss</script>';
    const request = await this.requestWithInjectedParameter(test, payload);
    const text = bodyText(request.response);
    if (text.includes(payload)) {
      return this.baseResult(test, 'FAILED', 'The test payload was reflected in the HTTP response.', { evidence: [{ payload, status: request.response.status, response: text.slice(0, 1200) }] });
    }
    if (request.response.status >= 500) return this.baseResult(test, 'WARNING', 'XSS test caused a server error; review input handling.', { evidence: [{ payload, status: request.response.status }] });
    return this.baseResult(test, 'PASSED', 'The probe was not reflected verbatim in the response.', { evidence: [{ payload, status: request.response.status }] });
  }

  async testRateLimit(test) {
    const count = this.options.rateLimitRequests;
    const body = { email: 'codestress-invalid@example.com', password: 'wrong-password' };
    const url = routeBase(this.target, test.path);
    const responses = await this.http.burst(url, { method: test.method, headers: this.headers({ 'Content-Type': 'application/json' }, false), body: JSON.stringify(body) }, count);
    const accepted = responses.filter(response => ![429, 503].includes(response.status)).length;
    const limited = responses.some(response => response.status === 429);
    if (limited) return this.baseResult(test, 'PASSED', `Rate limiting engaged after ${count - accepted || 1} attempts.`, { evidence: [{ requests: count, accepted, statuses: responses.map(r => r.status) }] });
    if (accepted === count) return this.baseResult(test, 'FAILED', `All ${count} repeated authentication attempts were accepted without a 429/503 response.`, { evidence: [{ requests: count, accepted, statuses: responses.map(r => r.status) }] });
    return this.baseResult(test, 'WARNING', `${accepted}/${count} attempts were accepted; no explicit rate-limit response was observed.`, { evidence: [{ requests: count, accepted, statuses: responses.map(r => r.status) }] });
  }

  async requestWithInjectedParameter(test, value) {
    const parameter = test.parameter || 'input';
    if (['GET','DELETE'].includes(test.method)) {
      const base = new URL(test.path, this.target);
      base.searchParams.set(parameter, value);
      return { response: await this.http.request(base.href, { method: test.method, headers: this.headers() }) };
    }
    const payload = { [parameter]: value };
    const routeBodyParams = this.routeAnalysis.routes.find(route => route.path === test.path && route.method === test.method)?.parameters || [];
    for (const candidate of routeBodyParams.filter(p => p.in === 'body').slice(0, 4)) payload[candidate.name] = candidate.name === parameter ? value : `codestress-${candidate.name}`;
    return { response: await this.http.request(routeBase(this.target, test.path.replace(/\{[^}]+\}|:[^/]+/g, '1')), { method: test.method, headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload) }) };
  }

  async testNullInput(test) {
    const parameter = test.parameter || this.routeAnalysis.routes.find(route => route.path === test.path && route.method === test.method)?.parameters?.find(p => p.in === 'body')?.name || 'input';
    const request = await this.http.request(routeBase(this.target, test.path.replace(/\{[^}]+\}|:[^/]+/g, '1')), {
      method: test.method,
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ [parameter]: null })
    });
    if (request.status >= 500) return this.baseResult(test, 'FAILED', 'A null input produced a server error.', { evidence: [{ status: request.status, response: bodyText(request).slice(0, 1000) }] });
    return this.baseResult(test, 'PASSED', `Null input was handled without a server error (HTTP ${request.status}).`, { evidence: [{ status: request.status }] });
  }

  async testOversized(test) {
    const parameter = test.parameter || 'input';
    const giant = 'A'.repeat(this.options.oversizedBytes);
    const response = await this.http.request(routeBase(this.target, test.path.replace(/\{[^}]+\}|:[^/]+/g, '1')), {
      method: test.method,
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ [parameter]: giant })
    });
    if (response.status >= 500) return this.baseResult(test, 'FAILED', 'Oversized input caused a server error.', { evidence: [{ status: response.status }] });
    return this.baseResult(test, 'PASSED', `Oversized input was handled without a 5xx response (HTTP ${response.status}).`, { evidence: [{ status: response.status }] });
  }

  async testErrorExposure(test) {
    const response = await this.http.request(routeBase(this.target, test.path.replace(/\{[^}]+\}|:[^/]+/g, '1')), {
      method: test.method,
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: test.method === 'GET' ? undefined : JSON.stringify({ invalid: '\\u0000' })
    });
    const text = bodyText(response);
    const exposed = /stack trace|node:internal|at [\w/.-]+:\d+:\d+|exception|sequelize|prisma/i.test(text);
    if (exposed) return this.baseResult(test, 'FAILED', 'Response appears to expose implementation details or a stack trace.', { evidence: [{ status: response.status, response: text.slice(0, 1200) }] });
    return this.baseResult(test, 'PASSED', 'No obvious stack-trace or framework error details were observed.', { evidence: [{ status: response.status }] });
  }

  async testAccessControl(test) {
    if (!/admin/i.test(test.path)) return this.baseResult(test, 'WARNING', 'Access-control test was not run because the endpoint is not clearly admin-scoped.');
    const response = await this.http.request(routeBase(this.target, test.path.replace(/\{[^}]+\}|:[^/]+/g, '1')), { method: test.method, headers: this.headers() });
    if (response.status >= 200 && response.status < 300) return this.baseResult(test, 'FAILED', 'The authenticated session was able to reach an admin-scoped endpoint.', { evidence: [{ status: response.status, response: bodyText(response).slice(0, 800) }] });
    return this.baseResult(test, 'PASSED', `Admin-scoped endpoint rejected the current session (HTTP ${response.status}).`, { evidence: [{ status: response.status }] });
  }

  async testCsrf(test) {
    if (!this.authentication.cookie) return this.baseResult(test, 'WARNING', 'CSRF runtime probe skipped because no cookie-based session was supplied.');
    const response = await this.http.request(routeBase(this.target, test.path.replace(/\{[^}]+\}|:[^/]+/g, '1')), {
      method: test.method,
      headers: this.headers({ 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' }),
      body: JSON.stringify({ codestress: true })
    });
    if (response.status >= 200 && response.status < 300) return this.baseResult(test, 'FAILED', 'A cross-origin-style state-changing request was accepted with the cookie session.', { evidence: [{ status: response.status, response: bodyText(response).slice(0, 800) }] });
    return this.baseResult(test, 'PASSED', `Cross-origin-style state-changing request was rejected (HTTP ${response.status}).`, { evidence: [{ status: response.status }] });
  }

  summarize(results) {
    const failed = results.filter(r => r.status === 'FAILED');
    const warnings = results.filter(r => r.status === 'WARNING');
    const passed = results.filter(r => r.status === 'PASSED');
    const deduction = failed.reduce((total, item) => total + (scorePenalty[item.severity] || 10), 0) + warnings.length * 2;
    return {
      testsRun: results.length,
      passed: passed.length,
      failed: failed.length,
      warnings: warnings.length,
      score: Math.max(0, 100 - deduction),
      rating: rating(Math.max(0, 100 - deduction)),
      results
    };
  }
}

function recommendation(type) {
  return {
    sql_injection: 'Use parameterized queries or a safe ORM query builder; never concatenate user input into SQL.',
    xss: 'Encode output for the target context and sanitize/validate rich text where HTML is intentionally allowed.',
    idor: 'Authorize the requested object against the authenticated principal before returning or mutating it.',
    auth_bypass: 'Require authentication middleware on protected routes and reject anonymous access with 401/403.',
    rate_limit: 'Add server-side rate limiting and account-aware throttling to authentication endpoints.',
    csrf: 'Require a CSRF token or another origin-bound anti-CSRF control for cookie-authenticated state changes.',
    access_control: 'Enforce role/permission checks server-side before admin operations.',
    error_exposure: 'Return generic client errors and log detailed exceptions server-side.',
    null_input: 'Validate required fields and reject null/missing values with a client-safe 4xx response.',
    oversized_payload: 'Enforce request/body size limits and field length validation.'
  }[type] || 'Review the endpoint behavior and add a targeted server-side control.';
}

function rating(score) {
  if (score >= 90) return 'Strong';
  if (score >= 75) return 'Good';
  if (score >= 60) return 'Needs Attention';
  return 'Critical Review Needed';
}
