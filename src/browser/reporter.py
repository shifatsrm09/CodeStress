"""
CodeStress Security & Functionality Test Reporter
Generates comprehensive report.md documenting tests performed, discovered vulnerabilities,
reproduction steps, severity, screenshots, and remediation guidance.
"""

import os
import time
from typing import Dict, Any, List


class Reporter:
    def __init__(self, target_url: str, repo_path: str = "", engine_name: str = "CodeStress AI"):
        self.target_url = target_url
        self.repo_path = repo_path
        self.engine_name = engine_name

    def generate_markdown(self, test_results: List[Dict[str, Any]], ai_summary: str = "", output_path: str = "report.md") -> str:
        """Compiles test results into report.md."""
        now = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())

        # Collect all findings across tests
        all_findings = []
        for r in test_results:
            findings = r.get("findings", [])
            for f in findings:
                all_findings.append({
                    **f,
                    "test_name": r.get("name", ""),
                    "category": r.get("category", ""),
                    "screenshot": r.get("screenshot")
                })

        # Statistics
        total_tests = len(test_results)
        passed_tests = len([r for r in test_results if r.get("status") == "PASSED"])
        vulnerable_tests = len([r for r in test_results if r.get("status") == "VULNERABLE"])
        warning_tests = len([r for r in test_results if r.get("status") == "WARNING"])
        failed_tests = len([r for r in test_results if r.get("status") in ("FAILED", "ERROR")])

        # Severity breakdown
        critical_count = len([f for f in all_findings if f.get("severity") == "CRITICAL"])
        high_count = len([f for f in all_findings if f.get("severity") == "HIGH"])
        medium_count = len([f for f in all_findings if f.get("severity") == "MEDIUM"])
        low_count = len([f for f in all_findings if f.get("severity") == "LOW"])
        info_count = len([f for f in all_findings if f.get("severity") == "INFO"])

        lines = [
            f"# CodeStress Security & Functionality Assessment Report",
            f"",
            f"**Target Application:** `{self.target_url}`  ",
            f"**Codebase Scope:** `{self.repo_path or 'Dynamic Remote Target'}`  ",
            f"**Assessment Engine:** {self.engine_name} + Python Selenium Browser Automation  ",
            f"**Date:** {now}  ",
            f"",
            f"---",
            f"",
            f"## 1. Executive Summary",
            f"",
            f"CodeStress performed an AI-assisted browser security and functionality test against **{self.target_url}**.",
            f"The evaluation combined static codebase intelligence with dynamic, visible browser automation using Python Selenium,",
            f"operating under an authenticated user session.",
            f"",
            f"### Key Metrics",
            f"",
            f"| Metric | Count |",
            f"| :--- | :--- |",
            f"| **Total Test Scenarios Executed** | **{total_tests}** |",
            f"| **Passed Cleanly** | {passed_tests} |",
            f"| **Security Vulnerabilities (High/Critical)** | **{high_count + critical_count}** |",
            f"| **Security Warnings / Misconfigurations (Medium/Low)** | **{medium_count + low_count}** |",
            f"| **Execution Errors / Timeouts** | {failed_tests} |",
            f"",
        ]

        if ai_summary:
            lines.extend([
                f"### Codebase Intelligence & Architecture Understanding",
                f"",
                f"> {ai_summary.strip()}",
                f"",
            ])

        lines.extend([
            f"---",
            f"",
            f"## 2. Discovered Security & Functionality Findings",
            f"",
        ])

        if not all_findings:
            lines.append("✓ **No vulnerabilities or security misconfigurations were identified during this test run.**\n")
        else:
            for idx, finding in enumerate(all_findings, start=1):
                severity = finding.get("severity", "LOW")
                badge = {
                    "CRITICAL": "🔴 **CRITICAL**",
                    "HIGH": "🟠 **HIGH**",
                    "MEDIUM": "🟡 **MEDIUM**",
                    "LOW": "🔵 **LOW**",
                    "INFO": "⚪ **INFO**"
                }.get(severity, f"**{severity}**")

                lines.extend([
                    f"### Finding {idx}: {finding.get('issue')}",
                    f"",
                    f"- **Severity:** {badge}",
                    f"- **Category:** {finding.get('category', 'General')}",
                    f"- **Test Suite:** `{finding.get('test_name', 'Dynamic')}`",
                    f"- **Impact:** {finding.get('impact', 'Potential security or logic degradation.')}",
                    f"",
                    f"#### Step-by-Step Reproduction",
                    f"1. Launch browser and establish session on `{self.target_url}`.",
                    f"2. Trigger automated test scenario `{finding.get('test_name')}`.",
                    f"3. Observe behavior: {finding.get('issue')}.",
                    f"",
                    f"#### Recommended Remediation",
                    f"{finding.get('remediation', 'Review security controls and input handling.')}",
                    f"",
                ])

                if finding.get("screenshot"):
                    rel_shot = os.path.relpath(finding.get("screenshot"), os.path.dirname(os.path.abspath(output_path)))
                    lines.extend([
                        f"#### Captured Evidence",
                        f"![Evidence Screenshot]({rel_shot})",
                        f"",
                    ])

        lines.extend([
            f"---",
            f"",
            f"## 3. Detailed Test Execution Log",
            f"",
            f"| # | Scenario | Category | Status | Details |",
            f"| :--- | :--- | :--- | :--- | :--- |",
        ])

        for idx, r in enumerate(test_results, start=1):
            status = r.get("status", "UNKNOWN")
            status_badge = {
                "PASSED": "✅ PASSED",
                "VULNERABLE": "❌ VULNERABLE",
                "WARNING": "⚠️ WARNING",
                "FAILED": "⛔ FAILED",
                "ERROR": "⚠️ ERROR"
            }.get(status, status)

            details = r.get("details", "").replace("|", "\\|")
            lines.append(f"| {idx} | {r.get('name')} | {r.get('category')} | {status_badge} | {details} |")

        lines.extend([
            f"",
            f"---",
            f"",
            f"## 4. Remediation Checklist & Best Practices",
            f"",
            f"1. **Cookie & Session Hardening:** Ensure `HttpOnly`, `Secure`, and `SameSite=Lax` or `Strict` are configured on all session identifiers.",
            f"2. **Content Security Policy:** Implement a robust `Content-Security-Policy` header to mitigate client-side script injection risks.",
            f"3. **Contextual Input Sanitization:** Validate and escape all dynamic user inputs before rendering into the DOM.",
            f"4. **Strict Role-Based Authorization:** Verify authorization server-side on every API and administrative route rather than relying on frontend navigation guards.",
            f"5. **Error Masking:** Disable verbose error traces in production environments to prevent sensitive internal path leakage.",
            f"",
            f"_Report automatically generated by CodeStress v1.0 — Stress test your logic, not just your server._",
            f""
        ])

        content = "\n".join(lines)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(content)

        return content
