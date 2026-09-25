# CodeStress Report

**Target:** http://127.0.0.1:3001/
**Repository:** C:\Users\neama\Downloads\CodeStress-complete\CodeStress\demo-app
**Generated:** 2026-09-25T12:37:14.349Z
**Engine:** CodeStress adversarial pipeline

## App Summary

- Route groups: 7
- Endpoints discovered: 7
- Source files read: 1
- Authentication: PUBLIC

## Results

| Tests | Passed | Failed | Warnings | Security Score |
|---:|---:|---:|---:|---:|
| 15 | 11 | 2 | 2 | 66 / 100 |
| Rating | Needs Attention | | | |

## Attack Plan

- **auth_bypass** — GET /api/dashboard — Protected-looking endpoint should reject anonymous access.
- **auth_bypass** — POST /api/transfer — Protected-looking endpoint should reject anonymous access.
- **auth_bypass** — GET /api/users/:id — Protected-looking endpoint should reject anonymous access.
- **idor** — GET /api/users/:id · parameter: id — Path identifier controls access to an object and should enforce ownership.
- **sql_injection** — POST /api/transfer · parameter: amount — User-controlled request data appears near database access.
- **xss** — POST /api/comments · parameter: comment — User-controlled text is a likely reflection/storage surface.
- **rate_limit** — POST /api/login — Authentication endpoints should throttle repeated attempts.
- **csrf** — POST /api/transfer — State-changing routes should be checked for CSRF protections when cookie authentication is used.
- **error_exposure** — POST /api/login — Authentication errors should not expose internals or stack traces.
- **null_input** — POST /api/login · parameter: email — Missing/null validation should be verified with malformed input.
- **null_input** — POST /api/comments · parameter: comment — Missing/null validation should be verified with malformed input.
- **null_input** — POST /api/transfer · parameter: amount — Missing/null validation should be verified with malformed input.
- **oversized_payload** — POST /api/login · parameter: email — Large input should be bounded and handled without a server error.
- **oversized_payload** — POST /api/comments · parameter: comment — Large input should be bounded and handled without a server error.
- **oversized_payload** — POST /api/transfer · parameter: amount — Large input should be bounded and handled without a server error.

## Findings

### HIGH — xss
- Endpoint: **POST /api/comments**
- File: server.js:73
- Parameter: comment
- Result: The test payload was reflected in the HTTP response.
- Evidence:
  - {"payload":"<script>codestress-xss</script>","status":200,"response":"{\"success\":true,\"comment\":\"<script>codestress-xss</script>\"}"}
- Fix: Encode output for the target context and sanitize/validate rich text where HTML is intentionally allowed.

### MEDIUM — rate_limit
- Endpoint: **POST /api/login**
- File: server.js:43
- Result: All 12 repeated authentication attempts were accepted without a 429/503 response.
- Evidence:
  - {"requests":12,"accepted":12,"statuses":[401,401,401,401,401,401,401,401,401,401,401,401]}
- Fix: Add server-side rate limiting and account-aware throttling to authentication endpoints.


## Warnings

### REVIEW — idor
- Endpoint: **GET /api/users/:id**
- File: server.js:61
- Parameter: id
- Result: Alternate identifier returned HTTP 401; manual review may be needed.
- Evidence:
  - {"request":"/api/users/1","status":401}
- Fix: Authorize the requested object against the authenticated principal before returning or mutating it.

### REVIEW — csrf
- Endpoint: **POST /api/transfer**
- File: server.js:52
- Result: CSRF runtime probe skipped because no cookie-based session was supplied.
- Fix: Require a CSRF token or another origin-bound anti-CSRF control for cookie-authenticated state changes.


## Passed Tests

- ✅ auth_bypass — GET /api/dashboard — Anonymous access was rejected.
- ✅ auth_bypass — POST /api/transfer — Anonymous access was rejected.
- ✅ auth_bypass — GET /api/users/:id — Anonymous access was rejected.
- ✅ sql_injection — POST /api/transfer — Common injection payloads were rejected or did not reach a database-sensitive response.
- ✅ error_exposure — POST /api/login — No obvious stack-trace or framework error details were observed.
- ✅ null_input — POST /api/login — Null input was handled without a server error (HTTP 401).
- ✅ null_input — POST /api/comments — Null input was handled without a server error (HTTP 200).
- ✅ null_input — POST /api/transfer — Null input was handled without a server error (HTTP 401).
- ✅ oversized_payload — POST /api/login — Oversized input was handled without a 5xx response (HTTP 401).
- ✅ oversized_payload — POST /api/comments — Oversized input was handled without a 5xx response (HTTP 200).
- ✅ oversized_payload — POST /api/transfer — Oversized input was handled without a 5xx response (HTTP 401).

## Hardened Code Guidance

### xss — server.js:73
Encode output for the target context and sanitize/validate rich text where HTML is intentionally allowed.

### rate_limit — server.js:43
Add server-side rate limiting and account-aware throttling to authentication endpoints.

### idor — server.js:61
Authorize the requested object against the authenticated principal before returning or mutating it.

### csrf — server.js:52
Require a CSRF token or another origin-bound anti-CSRF control for cookie-authenticated state changes.

## Scope and Safety

CodeStress only performs tests against the user-supplied target during an authorized assessment. Requests are bounded, do not follow redirects, and do not execute repository code. Review findings before applying changes.
