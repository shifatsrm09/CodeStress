// The model proposes a declarative plan. Only validated operations are executable.
export async function planAuthentication({ ai, repository, report, previousEvidence = [], mode }) {
  const notes = report.chunkNotes.filter(note => /auth|session|cookie|login|oauth|passport|middleware|protect/i.test(note.note + note.path));
  const paths = new Set(notes.map(note => note.path));
  const excerpts = repository.files.filter(file => paths.has(file.path) || /auth|session|middleware|login|app\.|server\./i.test(file.path));
  const collected = [];
  let length = 0;
  for (const file of excerpts) {
    const lines = file.content.split('\n');
    const selected = new Set();
    lines.forEach((line, i) => {
      if (/auth|session|cookie|login|oauth|passport|protect|redirect|\.use\(|\.get\(|\.post\(/i.test(line)) {
        for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 12); j++) selected.add(j);
      }
    });
    const content = [...selected].sort((a, b) => a - b).map(i => `${i + 1}: ${lines[i]}`).join('\n');
    if (length + content.length > 42000) continue;
    collected.push({ path: file.path, content }); length += content.length;
  }
  const instruction = `Plan authentication from source for mode ${mode}. Return ONLY JSON:
{"kind":"session|json-login|oauth|unsupported","loginPath":null,"idField":null,"emailField":null,"passwordField":null,"loginEvidence":[{"file":"exact path","line":1,"quote":"exact source line for login handler"}],"reason":"short explanation","checks":[{"path":"/actual/read-only/route","format":"json|html","marker":"literal protected HTML text or null","loginPath":"/login or /auth/google or null","evidence":[{"file":"exact path","line":1,"quote":"exact source line proving this route is protected"}]}]}.
Resolve full mounted paths and framework file routes. Only read-only current-user or protected page checks. No logout, mutations, OAuth callback, redirects to external sites, commands or guessed endpoints. For HTML pick a source-backed literal marker rendered only after successful authentication. Evidence must show the access guard, not just a UI label. At most 6 checks. Never treat an account lookup as login. If OAuth requires interactive consent/MFA and no session credential exists, identify that. Do not invent a password login for OAuth. Previous HTTP evidence may identify a bad route; propose an alternative only supported by source.
If you need more context, return ONLY {"read":[{"file":"exact repository path","startLine":1,"endLine":120}]} instead. You can request up to 6 ranges per round for 3 rounds. Use this to trace imports, middleware, router mounts, templates and framework conventions. These reads do not execute source. Then return the final plan schema.`;
  let plan;
  const context = { notes: notes.map(({ path, startLine, note }) => `${path}:${startLine} ${note}`).join('\n').slice(0, 12000), files: repository.files.map(file => file.path).join('\n').slice(0, 18000), excerpts: collected, previousEvidence, coverage: repository.coverage, aiCoverage: report.aiCoverage };
  for (let round = 0; round < 4; round++) {
    const prompt = instruction + (round === 3 ? '\nReading budget exhausted; return the final plan with explicit unknowns.' : '');
    if (ai.structuredGenerate) plan = await ai.structuredGenerate(prompt, context, value => {
      if (!value || typeof value !== 'object' || (!Array.isArray(value.read) && !['session', 'json-login', 'oauth', 'unsupported'].includes(value.kind))) throw new Error('Invalid plan');
      return value;
    });
    else {
      const answer = await ai.analyzeSource(prompt, JSON.stringify(context));
      try { plan = JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
      catch { throw new Error('AI authentication plan was not valid JSON. No login actions were taken.'); }
    }
    if (!Array.isArray(plan?.read)) break;
    if (round === 3) throw new Error('AI authentication planning reached its source-reading budget. No login actions were taken.');
    const retrieved = [];
    let budget = 20000;
    for (const request of plan.read.slice(0, 6)) {
      const file = repository.files.find(file => file.path === request?.file);
      if (!file || !Number.isInteger(request.startLine) || !Number.isInteger(request.endLine) || request.startLine < 1 || request.endLine < request.startLine) continue;
      const content = file.content.split('\n').slice(request.startLine - 1, Math.min(request.endLine, request.startLine + 199)).map((line, index) => `${request.startLine + index}: ${line}`).join('\n').slice(0, budget);
      retrieved.push({ path: file.path, content }); budget -= content.length;
      if (budget <= 0) break;
    }
    // Keep bounded relevant context; all source remains available through these reads.
    const combined = [];
    let remaining = 42000;
    for (const excerpt of [...retrieved, ...context.excerpts]) {
      if (excerpt.content.length > remaining || combined.some(item => item.path === excerpt.path && item.content === excerpt.content)) continue;
      combined.push(excerpt); remaining -= excerpt.content.length;
    }
    context.excerpts = combined;
    context.readStatus = retrieved.length ? 'Requested source ranges returned. Truncated ranges can be requested again with narrower line bounds.' : 'Requested files or line ranges were not available in the source snapshot.';
  }
  const safePath = value => typeof value === 'string' && /^\/(?!\/)[a-zA-Z0-9_./%-]*$/.test(value) && !/logout|signout|delete|remove|callback/i.test(value) && !value.includes('..');
  const safeField = value => typeof value === 'string' && /^[a-zA-Z][\w]{0,63}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
  if (!['session', 'json-login', 'oauth', 'unsupported'].includes(plan?.kind)) throw new Error('AI authentication plan has an unsupported format.');
  const hasEvidence = evidence => Array.isArray(evidence) && evidence.length > 0 && evidence.length <= 12 && evidence.every(ref => {
    if (!ref || typeof ref.file !== 'string') return false;
    const file = repository.files.find(file => file.path === ref.file);
    const line = file?.content.split('\n')[ref.line - 1];
    return Number.isInteger(ref.line) && typeof ref.quote === 'string' && ref.quote.trim().length >= 8 && line?.includes(ref.quote);
  });
  const checks = (Array.isArray(plan.checks) ? plan.checks : []).slice(0, 6).filter(check => {
    if (!check || !safePath(check.path) || !['json', 'html'].includes(check.format)) return false;
    const grounded = hasEvidence(check.evidence);
    if (!grounded) return false;
    if (check.format === 'html') {
      if (typeof check.marker !== 'string' || check.marker.length < 8 || check.marker.length > 160 || !repository.files.some(file => file.content.includes(check.marker))) return false;
      if (check.loginPath && !safePath(check.loginPath)) return false;
    }
    return true;
  }).map(check => ({ path: check.path, format: check.format, marker: check.marker || null, loginPath: check.loginPath || null, evidence: check.evidence }));
  return { kind: plan.kind, reason: String(plan.reason || '').slice(0, 600), checks,
    loginPath: safePath(plan.loginPath) && hasEvidence(plan.loginEvidence) ? plan.loginPath : null,
    idField: safeField(plan.idField) ? plan.idField : null,
    emailField: safeField(plan.emailField) ? plan.emailField : null,
    passwordField: safeField(plan.passwordField) ? plan.passwordField : null };
}
