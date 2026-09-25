import axios from 'axios';
import { randomBytes } from 'node:crypto';

// Stage 3 sends bounded probes to routes already discovered and authenticated.
const SQLI_PAYLOADS = ["' OR '1'='1", '1 OR 1=1', "1; DROP TABLE users;--", "' UNION SELECT NULL--"];
const XSS_PAYLOADS = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>'];
const OVERSIZED_LENGTH = 200000;
const PUBLIC_PATH_HINTS = /(^\/$|health|status|login|signin|sign-in|register|signup|public)/i;

function endpoint(target, relativePath) {
  const base = new URL(target);
  const url = new URL(relativePath, base.origin);
  if (url.origin !== base.origin) throw new Error('Attack requests must stay on the target origin.');
  return url;
}

function fillPath(path, values) {
  return path.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => encodeURIComponent(values[name] ?? '1'));
}

function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }

function looksLikeDbError(data) {
  const raw = typeof data === 'string' ? data : JSON.stringify(data ?? '');
  return /sql syntax|sqlite_error|pg::|postgres(ql)? error|mysql|ORA-\d{4,5}|unclosed quotation|ECMAScript/i.test(raw);
}

function payloadReflectedUnescaped(data, payload) {
  const raw = typeof data === 'string' ? data : JSON.stringify(data ?? '');
  return raw.includes(payload) && (raw.includes('<script>') || raw.includes('onerror='));
}

function identityOf(data) {
  const candidates = [data?.user, data?.account, data?.profile, data?.data?.user, data];
  const fields = ['id', '_id', 'studentId', 'email', 'username', 'sub'];
  for (const candidate of candidates) {
    if (!isObject(candidate)) continue;
    for (const key of fields) {
      if (['string', 'number'].includes(typeof candidate[key])) return { field: key, value: String(candidate[key]) };
    }
  }
  return null;
}

function result(status, testType, route, detail, extra = {}) {
  return { status, testType, endpoint: `${route.method} ${route.path}`, file: route.file, line: route.line, ...detail, ...extra };
}
const pass = (route, testType) => result('PASSED', testType, route, {});
const warn = (route, testType, detail) => result('WARNING', testType, route, detail);
const fail = (route, testType, detail) => result('FAILED', testType, route, detail);

export class Stage3Attack {
  constructor(options = {}) {
    this.target = options.target;
    this.routes = options.routes || [];
    this.session = options.session || {};
    this.user = options.user || null;
    this.http = options.http || axios;
    this.emit = options.onEvent || (() => {});
    this.includeDestructive = Boolean(options.includeDestructive);
    this.rateLimitAttempts = Math.min(Math.max(options.rateLimitAttempts ?? 20, 1), 50);
  }

  authedHeaders() {
    const headers = { Accept: 'application/json' };
    if (this.session.bearer) headers.Authorization = `Bearer ${this.session.bearer}`;
    if (this.session.cookie) headers.Cookie = this.session.cookie;
    return headers;
  }

  async request(method, path, { headers, body } = {}) {
    const url = endpoint(this.target, path);
    return this.http.request({
      method, url: url.href, data: body, headers,
      timeout: 8000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024, validateStatus: () => true
    });
  }

  ownValueFor(paramName) {
    if (this.user && this.user[paramName] !== undefined) return this.user[paramName];
    if (this.user?.id !== undefined) return this.user.id;
    return '1';
  }

  altValueFor(ownValue) {
    const numeric = Number(ownValue);
    return Number.isInteger(numeric) ? String(numeric + 1) : `${ownValue}-alt`;
  }

  async run() {
    const results = [];
    for (const route of this.routes) {
      if (!this.includeDestructive && route.method === 'DELETE') continue;
      this.emit({ type: 'attack_progress', endpoint: `${route.method} ${route.path}` });

      const bodyParams = route.parameters.filter(p => p.in === 'body');
      const pathParams = route.parameters.filter(p => p.in === 'path');
      const queryParams = route.parameters.filter(p => p.in === 'query');

      if (bodyParams.length || queryParams.length) {
        results.push(await this.testInjection(route, 'SQL Injection', SQLI_PAYLOADS, bodyParams, queryParams, looksLikeDbError));
        results.push(await this.testInjection(route, 'XSS', XSS_PAYLOADS, bodyParams, queryParams, (data, payload) => payloadReflectedUnescaped(data, payload)));
      }

      if (pathParams.length) results.push(await this.testIdor(route, pathParams[0]));

      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)) {
        results.push(await this.testAuthBypass(route, pathParams));
      }

      results.push(await this.testNullInputs(route, bodyParams, pathParams));
      if (bodyParams.length) results.push(await this.testOversizedPayload(route, bodyParams, pathParams));

      if (route.method === 'POST' && /login|signin|sign-in|auth/i.test(route.path)) {
        results.push(await this.testRateLimiting(route));
      }

      if (this.session.cookie && !this.session.bearer && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)) {
        results.push(await this.testCsrf(route, bodyParams, pathParams));
      }
    }
    return results;
  }

  buildBody(params, overrides = {}) {
    const body = {};
    for (const p of params) body[p.name] = overrides[p.name] ?? 'test';
    return { ...body, ...overrides };
  }

  buildPathValues(pathParams, overrides = {}) {
    const values = {};
    for (const p of pathParams) values[p.name] = overrides[p.name] ?? this.ownValueFor(p.name);
    return values;
  }

  async testInjection(route, testType, payloads, bodyParams, queryParams, isExploited) {
    const pathValues = this.buildPathValues(route.parameters.filter(p => p.in === 'path'));
    for (const payload of payloads) {
      for (const field of [...bodyParams, ...queryParams]) {
        const body = this.buildBody(bodyParams, bodyParams.includes(field) ? { [field.name]: payload } : {});
        let path = fillPath(route.path, pathValues);
        if (queryParams.includes(field)) path += (path.includes('?') ? '&' : '?') + `${encodeURIComponent(field.name)}=${encodeURIComponent(payload)}`;
        let res;
        try { res = await this.request(route.method, path, { headers: this.authedHeaders(), body }); }
        catch { continue; }
        if (res.status < 500 && isExploited(res.data, payload)) {
          return fail(route, testType, {
            payload, field: field.name, httpStatus: res.status,
            evidence: testType === 'SQL Injection' ? 'Response contained a database error signature.' : 'Payload was reflected without escaping.',
            fix: testType === 'SQL Injection' ? 'Use parameterized queries / an ORM; never interpolate user input into SQL.' : 'Encode output before rendering, and sanitize/validate input server-side.'
          });
        }
      }
    }
    return pass(route, testType);
  }

  async testIdor(route, pathParam) {
    const ownValue = this.ownValueFor(pathParam.name);
    const altValue = this.altValueFor(ownValue);
    const headers = this.authedHeaders();
    let ownRes, altRes;
    try {
      ownRes = await this.request(route.method, fillPath(route.path, { [pathParam.name]: ownValue }), { headers, body: {} });
      altRes = await this.request(route.method, fillPath(route.path, { [pathParam.name]: altValue }), { headers, body: {} });
    } catch { return pass(route, 'IDOR'); }
    if (altRes.status < 200 || altRes.status >= 300) return pass(route, 'IDOR');
    const identity = identityOf(altRes.data);
    if (identity && identity.value === String(altValue) && identity.value !== String(ownValue)) {
      return fail(route, 'IDOR', {
        payload: `${pathParam.name}=${altValue}`, httpStatus: altRes.status,
        evidence: `Authenticated as ${ownValue}, but requesting ${pathParam.name}=${altValue} returned a record identified as ${altValue}.`,
        fix: 'Validate that the authenticated user owns the requested resource before returning it (e.g. compare req.user.id to the resource owner).'
      });
    }
    if (JSON.stringify(altRes.data) !== JSON.stringify(ownRes.data)) {
      return warn(route, 'IDOR', {
        payload: `${pathParam.name}=${altValue}`, httpStatus: altRes.status,
        note: `Request with ${pathParam.name}=${altValue} returned HTTP ${altRes.status} with a different body than the request for your own id. Review manually — this may be legitimate (e.g. a public listing) or an ownership check gap.`
      });
    }
    return pass(route, 'IDOR');
  }

  async testAuthBypass(route, pathParams) {
    if (!this.session.bearer && !this.session.cookie) return pass(route, 'Auth Bypass');
    if (PUBLIC_PATH_HINTS.test(route.path)) return pass(route, 'Auth Bypass');
    const path = fillPath(route.path, this.buildPathValues(pathParams));
    let res;
    try { res = await this.request(route.method, path, { headers: { Accept: 'application/json' }, body: this.buildBody(route.parameters.filter(p => p.in === 'body')) }); }
    catch { return pass(route, 'Auth Bypass'); }
    if (res.status >= 200 && res.status < 300) {
      return fail(route, 'Auth Bypass', {
        payload: '(no credentials sent)', httpStatus: res.status,
        evidence: 'Request with no Authorization/Cookie header still succeeded.',
        fix: 'Confirm this route is meant to be public. If not, add auth middleware in front of it.'
      });
    }
    return pass(route, 'Auth Bypass');
  }

  async testNullInputs(route, bodyParams, pathParams) {
    if (!bodyParams.length) return pass(route, 'Null/Empty Input');
    const path = fillPath(route.path, this.buildPathValues(pathParams));
    let res;
    try { res = await this.request(route.method, path, { headers: this.authedHeaders(), body: {} }); }
    catch { return pass(route, 'Null/Empty Input'); }
    if (res.status >= 500) {
      return warn(route, 'Null/Empty Input', { payload: '{}', httpStatus: res.status, note: 'An empty body produced a server error (5xx) instead of a validation error (4xx). Add input validation.' });
    }
    return pass(route, 'Null/Empty Input');
  }

  async testOversizedPayload(route, bodyParams, pathParams) {
    const path = fillPath(route.path, this.buildPathValues(pathParams));
    const body = this.buildBody(bodyParams, { [bodyParams[0].name]: 'x'.repeat(OVERSIZED_LENGTH) });
    let res;
    try { res = await this.request(route.method, path, { headers: this.authedHeaders(), body }); }
    catch { return pass(route, 'Oversized Payload'); }
    if (res.status >= 500) {
      return warn(route, 'Oversized Payload', { payload: `${bodyParams[0].name}: ${OVERSIZED_LENGTH}-char string`, httpStatus: res.status, note: 'An oversized field crashed the server instead of being rejected. Enforce request/body size limits.' });
    }
    return pass(route, 'Oversized Payload');
  }

  async testRateLimiting(route) {
    let accepted = 0;
    for (let i = 0; i < this.rateLimitAttempts; i++) {
      let res;
      try { res = await this.request(route.method, route.path, { headers: { Accept: 'application/json' }, body: { probe: randomBytes(4).toString('hex') } }); }
      catch { break; }
      if (res.status < 400) accepted++;
      else break;
    }
    if (accepted === this.rateLimitAttempts) {
      return fail(route, 'Rate Limiting', {
        payload: `${this.rateLimitAttempts} rapid requests`, httpStatus: 200,
        evidence: `All ${this.rateLimitAttempts} rapid requests were accepted with no 429/backoff.`,
        fix: 'Add rate-limiting middleware (e.g. express-rate-limit) to this endpoint.'
      });
    }
    return pass(route, 'Rate Limiting');
  }

  async testCsrf(route, bodyParams, pathParams) {
    const path = fillPath(route.path, this.buildPathValues(pathParams));
    const headers = { ...this.authedHeaders(), Origin: 'https://codestress-csrf-check.invalid' };
    let res;
    try { res = await this.request(route.method, path, { headers, body: this.buildBody(bodyParams) }); }
    catch { return pass(route, 'CSRF'); }
    if (res.status >= 200 && res.status < 300) {
      return warn(route, 'CSRF', {
        payload: 'forged Origin header, cookie session, no CSRF token', httpStatus: res.status,
        note: 'A state-changing request with a mismatched Origin and no CSRF token still succeeded. If this route relies on cookie auth, verify Origin/Referer or require a CSRF token.'
      });
    }
    return pass(route, 'CSRF');
  }
}

export async function runAttack(options) {
  return new Stage3Attack(options).run();
}
