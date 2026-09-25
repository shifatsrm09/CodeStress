/**
 * Generates dynamic, application-tailored Selenium test scenarios
 * using codebase intelligence and Ollama AI analysis.
 */

export class TestScenarioGenerator {
  constructor(aiClient = null) {
    this.ai = aiClient;
  }

  /**
   * Generates a complete test scenario suite based on codebase report and routes.
   */
  async generateScenarios(codebaseReport = {}, targetUrl = "") {
    const routes = codebaseReport.routes || [];
    const forms = [];
    const protectedRoutes = [];
    const publicRoutes = [];

    // Analyze routes from RouteScanner
    for (const r of routes) {
      const path = r.path || "";
      const isAuthProtected = (r.middlewares || []).some(m => /auth|login|token|protect|admin/i.test(m)) ||
                             /dashboard|admin|account|profile|setting|edit|create|delete/i.test(path);

      if (isAuthProtected) {
        protectedRoutes.push(path);
      } else {
        publicRoutes.push(path);
      }

      if (r.parameters && r.parameters.some(p => p.in === "body" || p.in === "query")) {
        forms.push({ path, method: r.method, params: r.parameters });
      }
    }

    const scenarios = [];

    // 1. Core Session & Cookie Security Audit
    scenarios.push({
      id: "sec_cookie_audit",
      name: "Session Cookie Security Flags (HttpOnly, Secure, SameSite)",
      type: "cookie_security",
      category: "Session Management",
      description: "Audits authenticated session cookies for protective security attributes preventing theft via XSS or CSRF."
    });

    // 2. Client Web Storage Audit (localStorage / sessionStorage secrets)
    scenarios.push({
      id: "sec_storage_audit",
      name: "HTML5 Web Storage Credential Audit",
      type: "storage_security",
      category: "Client-Side Storage",
      description: "Scans localStorage and sessionStorage for exposed JWTs, API keys, or raw authentication credentials."
    });

    // 3. Security Headers & Anti-Framing (Clickjacking & CSP)
    scenarios.push({
      id: "sec_headers_csp",
      name: "Client Security Headers & Framing Defense",
      type: "security_headers",
      category: "Browser Hardening",
      description: "Checks for Content-Security-Policy and anti-clickjacking frame restrictions."
    });

    // 4. Client Console & Sensitive Log Leakage
    scenarios.push({
      id: "sec_console_leakage",
      name: "Browser Console & Uncaught Error Trace Audit",
      type: "console_audit",
      category: "Information Disclosure",
      description: "Audits client console for unhandled stack traces, exceptions, or sensitive internal endpoint leaks."
    });

    // 5. DOM XSS Source/Sink Analysis
    scenarios.push({
      id: "sec_dom_xss",
      name: "Client-Side DOM Sink & Reflection Analysis",
      type: "dom_xss_check",
      category: "Client-Side Injection",
      description: "Analyzes client DOM and script tags for dangerous reflection of window.location into executable sinks."
    });

    // 6. Form Input Validation Scenarios on Discovered Endpoints
    const formCandidates = forms.slice(0, 3);
    if (formCandidates.length > 0) {
      for (let i = 0; i < formCandidates.length; i++) {
        const f = formCandidates[i];
        scenarios.push({
          id: `form_val_${i + 1}`,
          name: `Input Boundary Validation on ${f.path}`,
          type: "form_validation",
          category: "Input Validation",
          path: f.path,
          description: `Tests form fields on ${f.path} with boundary payloads and verifies contextual encoding.`
        });
      }
    } else {
      // Default to root page form validation
      scenarios.push({
        id: "form_val_root",
        name: "Interactive Input Fields Boundary Validation",
        type: "form_validation",
        category: "Input Validation",
        path: "/",
        description: "Tests visible inputs on the current page with boundary and special-character payloads."
      });
    }

    // 7. Route Authorization & Privilege Boundaries on Discovered Routes
    const candidateRoutes = [...new Set([...protectedRoutes, ...publicRoutes])].filter(p => p && p !== "/").slice(0, 4);
    for (let i = 0; i < candidateRoutes.length; i++) {
      const p = candidateRoutes[i];
      scenarios.push({
        id: `route_auth_${i + 1}`,
        name: `Authorization Boundary & Stability: ${p}`,
        type: "route_authorization",
        category: "Access Control",
        path: p,
        description: `Visibly loads ${p} with authenticated session to confirm proper access control and server stability.`
      });
    }

    return scenarios;
  }
}
