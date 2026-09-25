# CodeStress Architecture

```text
CLI / GUI
   │
   ▼
Assessment orchestrator
   │
   ├── RepositoryReader ──> source snapshot
   ├── RouteScanner ──────> routes + input surfaces
   ├── Stage1Understand ──> AI source notes
   ├── Authentication ────> verified session evidence
   ├── AttackPlanner ─────> structured test plan
   ├── AttackEngine ──────> bounded HTTP probes
   └── ReportGenerator ──> CODESTRESS.md
```

## AI boundary

The AI may propose a declarative test plan. The plan is parsed and validated. Only the supported test types and same-origin paths are allowed. The engine, not the model, constructs the HTTP requests.

## Authentication boundary

Authentication can use a supplied bearer token, cookie, login ID, or test-account credentials. A credential is not treated as proof of authentication until a protected endpoint provides supporting evidence. The session is passed in memory to the attack engine but is not persisted in the report.

## Attack boundary

The deterministic attack engine supports a bounded set of probes. It does not execute arbitrary commands, load target code, follow arbitrary redirects, or use an AI-generated shell command. Findings are classified as PASS, FAIL, or WARNING.

## Report boundary

The report generator is deterministic. AI may explain source context, but the live test result and security score are generated from observed HTTP responses.
