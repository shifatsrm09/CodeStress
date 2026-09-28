# CodeStress
Be the first to break your own code.

CodeStress reads a local repository or public GitHub repository, builds a cited application model, proposes behavior tests, and operates an isolated browser after your approval. It compares explicit expectations with observations and saves evidence and reusable tests.

## Current implementation

One workflow replaces the stage selector:

**Reachability → source → understanding → application model → scenarios → browser approval → authentication → execution approval → observations → comparison → reproduction → report → memory.**

The dark GUI uses larger text and includes source coverage, application facts, scenario review, authentication evidence, live progress, results, screenshots, and saved reports. There is no special PIN mode; a source-discovered login ID is handled like any other credential.

This implementation has received source review only. Automated tests and browser execution have not been run during this change, following the project's explicit permission requirement. The commands below are instructions, not claims of successful validation.

## Setup

Use Node.js 22 or later and install dependencies with `npm install`. Configure `.env` for Ollama, for example:

```dotenv
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=your-installed-model
```

For Ollama cloud, use `OLLAMA_BASE_URL=https://ollama.com`, an available cloud model, and `OLLAMA_API_KEY`. Source excerpts and sanitized browser observations are sent to the configured provider; cloud mode is not local-only processing. `OLLAMA_ANALYSIS_OUTPUT_TOKENS` controls source response size (1024–8192, default 4096), with one larger-output retry.

The browser uses installed Microsoft Edge by default. Set `BROWSER_CHANNEL=chromium` to use Playwright Chromium, which must first be installed with `npx playwright install chromium`. Installing the JavaScript dependency alone does not install or launch a browser in this workspace.

With permission to start the GUI:

```powershell
npm run gui
```

Open http://localhost:9999. The server binds to the local computer only. Enter the target URL, local repository path or public GitHub repository URL, and authentication mode. A run checks reachability and analyzes source immediately; browser launch and test execution each require an explicit decision. Form interactions default to disabled. Destructive, payment, messaging and integration actions require an additional permission.

An optional local file path supplies a regular upload fixture of at most 5 MB under the ID `fixture`. Only explicitly supplied fixtures can be uploaded, and upload scenarios require mutation permission.

## Authentication and scope

Supported inputs are a pasted session cookie, bearer token, username/email and password, login ID, public access, or manual browser sign-in. Protected endpoints and supported JSON login fields are discovered from source. There are no endpoint or raw login-request fields to fill in.

Verification compares authenticated access with anonymous and invalid-session controls. Source-backed browser checks provide a fallback for supported HTML-protected pages. A cookie existing, a redirect, a profile-looking element, or a successful credential POST alone does not prove access. Unsupported or inconclusive flows remain unverified and protected tests are skipped.

Google OAuth, MFA, CAPTCHA and similar challenges are completed manually in the visible browser. CodeStress does not bypass them. Credentials and browser state stay in memory; reports contain sanitized evidence. Browser actions stay within the target origin. Separate API origins are currently blocked rather than guessed or implicitly trusted.

## Results and memory

Each scenario receives PASS, FAIL, UNCERTAIN, BLOCKED or SKIPPED. PASS only means its explicit checks matched. FAIL means an observed behavior contradicted the specified expectation; source-derived expectations still need human review. Unknown network results, failed actions, missing roles and denied permissions must not become a pass.

Read-only failures can be replayed in a fresh browser context, with reproduction status recorded separately. This resets client state, not server state. Mutation failures are not automatically replayed without a safe reset strategy. Findings do not automatically claim a security vulnerability or severity.

Artifacts live in `.codestress/runs/<run-id>/`: JSON and Markdown reports, observation JSON and masked viewport screenshots. Project memory stores source fingerprints, completed source notes, the application model, tests, results and failures. Passing scenarios can be replayed only with a matching source/model fingerprint. Changed source requires fresh analysis. This is application-managed memory, not an assumption that Ollama remembers prior conversations.

Known credentials, cookie/storage tokens and sensitive fields are redacted or masked. Screenshots and application content may still contain personal or confidential information that cannot be recognized automatically; inspect artifacts before sharing them.

## Command line

```powershell
node bin/cstress.js --read-source --repo "C:\path\to\repository"
node bin/cstress.js --understand --repo https://github.com/owner/repository
node bin/cstress.js http://localhost:3000 --repo "C:\path\to\repository" --public
```

Target assessments prompt before browser launch and execution. Noninteractive runs decline unless `--run-browser` and `--execute-tests` are supplied. Mutation and dangerous actions require their respective flags. `--replay` uses compatible passing scenarios; `--upload <path>` supplies the fixture; `--output <file>` exports Markdown. Prefer environment configuration for secrets; command-line secrets may remain in shell history. `GITHUB_TOKEN` or `--token` is available for repository access.

## Architecture and limits

- `src/repo`, `src/pipeline/stage1Understand.js`: bounded repository reading, chunk analysis, coverage and resumable notes.
- `src/model`: cited, confidence-labelled application model. Source assertions remain inferred, not runtime-confirmed.
- `src/engine/provider.js`: common generation and validated JSON interface. Ollama is the installed transport; another provider requires an adapter. No IBM Bob integration is claimed.
- `src/browser`: Playwright contexts, validated action tools, scope/risk enforcement and observations. AI cannot submit arbitrary JavaScript or shell commands.
- `src/testing`: scenario planning, bounded execution/recovery, deterministic checks, safe reproduction and reports.
- `src/auth`, `src/memory`, `src/pipeline/assessment.js`: authentication, persistent state and unified orchestration shared by CLI and GUI.

The agent is limited to five scenarios, 20 action attempts and three minutes per scenario, 12 model requests per scenario, two action recoveries, and repeated-action/state limits. Manual prompts expire after ten minutes; the assessment has a one-hour cancellation limit. Partial evidence is checkpointed. Source/context limits are reported; reading a large repository does not imply complete understanding.

This is browser-context isolation, not an OS/container sandbox. It does not execute repository commands, install target dependencies, reset databases, automatically create test accounts or prove arbitrary business invariants. Browser observations include DOM/text, controls, URL, network status metadata and error occurrence; raw response bodies and console payloads are intentionally excluded. Risk classification is conservative heuristics, not a guarantee that an arbitrary application's GET routes have no side effects.

## Validation pending permission

Unit tests cover authentication controls, source handling, JSON repair, action validation, incomplete evidence, memory and agent limits. The opt-in browser integration fixture exercises the shared pipeline with a real browser, deterministic AI responses, verified cookie authentication, a passing route, an intentionally broken route, reproduction and artifacts. It does not validate live Ollama quality or an external OAuth provider.

After permission, run:

```powershell
npm test
$env:CODESTRESS_E2E='1'
node --test test/browser-e2e.test.js
Remove-Item Env:CODESTRESS_E2E
```

The second command starts the disposable fixture server and opens a browser. Keep it opt-in. Validate the GUI and a real Ollama assessment separately after approval. See `docs/implementation-audit.md` for the original issues and replacement rationale.
