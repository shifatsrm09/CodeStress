# Implementation audit — 2026-09-28

Read project-context.md and the tracked Node, browser/Python, GUI, demo and test sources before choosing changes. The context's claim of 37 passing tests is historical and not evidence of the current runtime state. No tests or target websites were run during this review.

## Reusable

- Bounded local/GitHub source snapshots, hashes and visible coverage gaps.
- Source chunking, output-limit recovery, cited notes and per-project checkpoints.
- Source-backed authentication planner and negative-control HTTP verification design.
- Express/SSE GUI, dark layout, source inventory and source-only CLI.

## Observed defects

- Assessment treats any cookie as authenticated; Python also trusts route names and DOM hints. Neither is authentication proof.
- HTTP verifier has reintroduced successful results for account lookups and unverified cookies.
- Python sends raw cookies and storage over events that are broadcast to all GUI clients.
- Scenario generator never invokes its AI and emits generic security checks. Navigation returns PASSED even after failed navigation; administrative access is called a vulnerability without knowing the user's role.
- No structured application model, expectation evaluation, bounded action agent or actual failure replay.
- Bridge splits IPC chunks without buffering, lacks request IDs, leaves timers/listeners and has an unbounded runTests wait. Concurrent Selenium threads share one driver.
- Tests can be reported complete after execution errors. Completion is emitted twice. Global report.md can refer to a previous run.
- Fast source analysis calls partial/unavailable analysis complete.
- GUI removed credential modes while legacy CLI still uses a separate unfinished pipeline.
- Provider coupling and absent structural JSON repair; memory writes are not serialized.
- Persistent shared browser profile, stealth scripts and source-specific cookie names conflict with the requested isolation and no-bypass behavior.

## Smallest viable refactor

Keep the source reader, source findings and auth planner. Restore fail-closed auth. Add a provider facade around Ollama, validated application/scenario models, a Playwright browser adapter, a bounded agent, deterministic expectations with evidence, reproduction and run-scoped artifacts. Replace the Python execution path rather than maintaining two independently unsafe browser engines. Keep source-only CLI paths, wire target CLI and GUI into the same assessment. Explicitly gate browser launch and test execution; manual authentication does not itself verify access. Do not retain stealth/bypass behavior.

## Validation boundary

Author mocked regression tests and a local browser fixture. Runtime validation, including dependency browser installation, launching the fixture/GUI and running unit or end-to-end tests, requires the user's permission. Acceptance cannot be claimed until that authorized validation occurs.
