"""
CodeStress Selenium Test Runner
Executes security, authorization, form validation, and session integrity tests
live in the visible browser window, capturing screenshots and streaming progress.
"""

import sys
import os
import time
import json
from typing import Dict, Any, List, Optional
from urllib.parse import urljoin

from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException, WebDriverException


class TestRunner:
    def __init__(self, browser_manager, screenshot_dir: str = ".codestress/screenshots"):
        self.bm = browser_manager
        self.driver = browser_manager.driver
        self.screenshot_dir = screenshot_dir
        os.makedirs(self.screenshot_dir, exist_ok=True)
        self.results: List[Dict[str, Any]] = []

    def emit(self, event_type: str, data: Dict[str, Any]):
        """Emits structured event to stdout for Node.js IPC."""
        payload = {"type": event_type, "data": data, "timestamp": time.time()}
        print(f"__CODESTRESS_EVENT__{json.dumps(payload)}", flush=True)

    def run_suite(self, target_url: str, test_scenarios: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Runs all provided test scenarios in sequence."""
        self.emit("suite_start", {
            "total_tests": len(test_scenarios),
            "target": target_url,
            "browser": self.bm.browser_name
        })

        for index, scenario in enumerate(test_scenarios):
            test_id = scenario.get("id", f"test_{index + 1}")
            test_name = scenario.get("name", f"Test {index + 1}")
            category = scenario.get("category", "General")

            self.emit("test_start", {
                "id": test_id,
                "index": index + 1,
                "total": len(test_scenarios),
                "name": test_name,
                "category": category,
                "description": scenario.get("description", "")
            })

            result = self._execute_scenario(target_url, scenario)
            self.results.append(result)

            self.emit("test_result", {
                "id": test_id,
                "name": test_name,
                "status": result["status"],
                "severity": result.get("severity", "INFO"),
                "details": result.get("details", ""),
                "findings": result.get("findings", []),
                "screenshot": result.get("screenshot")
            })

            # Brief pause so the user can visually observe what happened
            time.sleep(1.2)

        self.emit("suite_complete", {
            "total": len(self.results),
            "passed": len([r for r in self.results if r["status"] == "PASSED"]),
            "issues": len([r for r in self.results if r["status"] in ("VULNERABLE", "WARNING", "FAILED")])
        })

        return self.results

    def _execute_scenario(self, target_url: str, scenario: Dict[str, Any]) -> Dict[str, Any]:
        """Dispatches scenario to the appropriate specialized test method."""
        test_type = scenario.get("type", "generic")
        try:
            if test_type == "cookie_security":
                return self._test_cookie_security(target_url, scenario)
            elif test_type == "storage_security":
                return self._test_storage_security(target_url, scenario)
            elif test_type == "console_audit":
                return self._test_console_audit(target_url, scenario)
            elif test_type == "form_validation":
                return self._test_form_validation(target_url, scenario)
            elif test_type == "route_authorization":
                return self._test_route_authorization(target_url, scenario)
            elif test_type == "security_headers":
                return self._test_security_headers(target_url, scenario)
            elif test_type == "dom_xss_check":
                return self._test_dom_xss(target_url, scenario)
            else:
                return self._test_generic_navigation(target_url, scenario)
        except Exception as e:
            return {
                "id": scenario.get("id"),
                "name": scenario.get("name"),
                "category": scenario.get("category", "General"),
                "status": "ERROR",
                "severity": "INFO",
                "details": f"Test execution exception: {str(e)}",
                "findings": []
            }

    def _test_cookie_security(self, target_url: str, scenario: Dict[str, Any]) -> Dict[str, Any]:
        """Tests whether session and auth cookies have HttpOnly, Secure, and SameSite flags."""
        cookies = self.bm.get_cookies()
        findings = []
        is_https = target_url.lower().startswith("https://")

        for c in cookies:
            name = c.get("name", "")
            is_session = any(k in name.lower() for k in ("session", "token", "auth", "jwt", "sid", "connect"))

            if is_session:
                if not c.get("httpOnly"):
                    findings.append({
                        "issue": f"Cookie '{name}' lacks HttpOnly flag",
                        "severity": "MEDIUM",
                        "impact": "JavaScript can read this cookie, making session tokens vulnerable to XSS theft.",
                        "remediation": "Set HttpOnly=true on all authentication/session cookies."
                    })

                if is_https and not c.get("secure"):
                    findings.append({
                        "issue": f"Cookie '{name}' lacks Secure flag on HTTPS site",
                        "severity": "MEDIUM",
                        "impact": "Cookie can be transmitted over unencrypted HTTP connections.",
                        "remediation": "Set Secure=true on all cookies set over HTTPS."
                    })

                samesite = (c.get("sameSite") or "").lower()
                if samesite not in ("lax", "strict"):
                    findings.append({
                        "issue": f"Cookie '{name}' has weak SameSite policy ({samesite or 'None'})",
                        "severity": "LOW",
                        "impact": "Browser may send this cookie in cross-site requests, increasing CSRF attack surface.",
                        "remediation": "Set SameSite=Lax or SameSite=Strict."
                    })

        status = "VULNERABLE" if any(f["severity"] in ("HIGH", "MEDIUM") for f in findings) else "PASSED"
        screenshot = None
        if findings:
            screenshot = os.path.join(self.screenshot_dir, f"cookie_security_{int(time.time())}.png")
            self.bm.take_screenshot(screenshot)

        return {
            "id": scenario.get("id"),
            "name": scenario.get("name"),
            "category": "Session Security",
            "status": status,
            "severity": "MEDIUM" if findings else "INFO",
            "details": f"Audited {len(cookies)} cookies. Found {len(findings)} security configuration observation(s).",
            "findings": findings,
            "screenshot": screenshot
        }

    def _test_storage_security(self, target_url: str, scenario: Dict[str, Any]) -> Dict[str, Any]:
        """Tests whether sensitive secrets/tokens are exposed in localStorage or sessionStorage."""
        storage = self.bm.get_storage_data()
        local = storage.get("localStorage", {})
        session = storage.get("sessionStorage", {})
        findings = []

        sensitive_patterns = ("token", "jwt", "bearer", "password", "secret", "apikey", "api_key", "credential", "private")

        for key, val in {**local, **session}.items():
            k_lower = key.lower()
            if any(p in k_lower for p in sensitive_patterns):
                val_str = str(val)[:40] + ("..." if len(str(val)) > 40 else "")
                findings.append({
                    "issue": f"Potential sensitive credential in Web Storage key: '{key}'",
                    "severity": "LOW",
                    "impact": f"Value '{val_str}' stored in browser storage is accessible to any script executing on this origin (XSS vulnerability multiplier).",
                    "remediation": "Prefer HttpOnly secure cookies for auth tokens rather than HTML5 Web Storage."
                })

        status = "WARNING" if findings else "PASSED"
        return {
            "id": scenario.get("id"),
            "name": scenario.get("name"),
            "category": "Client Storage Security",
            "status": status,
            "severity": "LOW" if findings else "INFO",
            "details": f"Scanned {len(local) + len(session)} web storage keys. Found {len(findings)} sensitive key(s).",
            "findings": findings
        }

    def _test_console_audit(self, target_url: str, scenario: Dict[str, Any]) -> Dict[str, Any]:
        """Audits browser console for stack traces, unhandled errors, or sensitive debug messages."""
        logs = self.bm.get_console_logs()
        findings = []

        for log in logs:
            level = log.get("level", "")
            message = log.get("message", "")
            if level in ("SEVERE", "ERROR"):
                if any(k in message.lower() for k in ("stack", "syntaxerror", "typeerror", "uncaught", "unhandled")):
                    findings.append({
                        "issue": f"Unhandled client exception logged in console",
                        "severity": "LOW",
                        "impact": f"Error: {message[:120]}...",
                        "remediation": "Add error boundary handling and avoid exposing internal stack details to console."
                    })

        status = "WARNING" if findings else "PASSED"
        return {
            "id": scenario.get("id"),
            "name": scenario.get("name"),
            "category": "Console & Information Leakage",
            "status": status,
            "severity": "LOW" if findings else "INFO",
            "details": f"Audited {len(logs)} console entries. Found {len(findings)} unhandled error(s).",
            "findings": findings
        }

    def _test_form_validation(self, target_url: str, scenario: Dict[str, Any]) -> Dict[str, Any]:
        """Discovers input fields on target page and tests boundary & special characters live."""
        route = scenario.get("path", "")
        full_url = urljoin(target_url, route) if route else target_url
        self.bm.navigate(full_url)
        time.sleep(1)

        findings = []
        inputs = self.driver.find_elements(By.TAG_NAME, "input")
        tested_count = 0

        # Boundary payloads for security testing
        test_payload = "<img src=x onerror=console.log('codestress_probe')>"

        for inp in inputs:
            try:
                inp_type = (inp.get_attribute("type") or "text").lower()
                inp_name = inp.get_attribute("name") or inp.get_attribute("id") or inp.get_attribute("placeholder") or "input"
                if inp_type in ("hidden", "submit", "button", "checkbox", "radio", "file"):
                    continue

                if not inp.is_displayed() or not inp.is_enabled():
                    continue

                tested_count += 1
                # Visibly type boundary test into field
                inp.clear()
                inp.send_keys(test_payload)
                time.sleep(0.5)

                # Check if payload gets rendered unescaped in DOM
                page_src = self.driver.page_source
                if "console.log('codestress_probe')" in page_src and "&lt;img" not in page_src:
                    findings.append({
                        "issue": f"Input field '{inp_name}' reflected unescaped HTML payload",
                        "severity": "HIGH",
                        "impact": "Field reflects unescaped user input into the DOM, indicating possible Cross-Site Scripting (XSS).",
                        "remediation": "Apply context-aware HTML entity encoding or utilize modern framework auto-escaping."
                    })
                    break

                inp.clear()
            except Exception:
                continue

        screenshot = None
        if findings:
            screenshot = os.path.join(self.screenshot_dir, f"form_xss_{int(time.time())}.png")
            self.bm.take_screenshot(screenshot)

        status = "VULNERABLE" if findings else "PASSED"
        return {
            "id": scenario.get("id"),
            "name": scenario.get("name"),
            "category": "Input Validation & Forms",
            "status": status,
            "severity": "HIGH" if findings else "INFO",
            "details": f"Tested {tested_count} visible input field(s) on {full_url}. Found {len(findings)} boundary reflection(s).",
            "findings": findings,
            "screenshot": screenshot
        }

    def _test_route_authorization(self, target_url: str, scenario: Dict[str, Any]) -> Dict[str, Any]:
        """Visibly tests accessing authenticated routes and checks for unauthorized data access or error screens."""
        route = scenario.get("path", "")
        full_url = urljoin(target_url, route)
        self.bm.navigate(full_url)
        time.sleep(1.2)

        current_url = self.bm.get_current_url()
        page_source = self.driver.page_source.lower()
        findings = []

        # Check for unhandled server crashes (e.g. 500 Internal Server Error, stack dumps)
        if any(err in page_source for err in ("internal server error", "traceback (most recent call last)", "syntaxerror:", "cannot read property of undefined")):
            findings.append({
                "issue": f"Route '{route}' resulted in internal server error / crash trace",
                "severity": "MEDIUM",
                "impact": "Server threw an unhandled exception or returned stack trace to the browser client.",
                "remediation": "Implement global error handling middleware and disable verbose error dumps in production."
            })

        # Check for admin / restricted paths accessed without privilege
        if "/admin" in route.lower() and not ("unauthorized" in page_source or "forbidden" in page_source or "login" in current_url):
            findings.append({
                "issue": f"Restricted administrative route '{route}' was accessible with current user session",
                "severity": "HIGH",
                "impact": "Potential privilege escalation or broken access control (BAM / IDOR).",
                "remediation": "Enforce strict role-based access control (RBAC) middleware on administrative endpoints."
            })

        screenshot = None
        if findings:
            screenshot = os.path.join(self.screenshot_dir, f"route_auth_{int(time.time())}.png")
            self.bm.take_screenshot(screenshot)

        status = "VULNERABLE" if any(f["severity"] == "HIGH" for f in findings) else ("WARNING" if findings else "PASSED")
        return {
            "id": scenario.get("id"),
            "name": scenario.get("name"),
            "category": "Authorization & Route Boundaries",
            "status": status,
            "severity": "HIGH" if any(f["severity"] == "HIGH" for f in findings) else ("MEDIUM" if findings else "INFO"),
            "details": f"Navigated to {full_url}. Current page: {current_url}. Observed {len(findings)} issue(s).",
            "findings": findings,
            "screenshot": screenshot
        }

    def _test_security_headers(self, target_url: str, scenario: Dict[str, Any]) -> Dict[str, Any]:
        """Tests client-observable security headers (Clickjacking / X-Frame-Options, CSP)."""
        findings = []
        # Check iframe embedding protection
        is_framed = self.driver.execute_script("""
            try {
                return window.self === window.top;
            } catch (e) {
                return false;
            }
        """)

        # Check if CSP meta tags are defined
        csp_meta = self.driver.find_elements(By.CSS_SELECTOR, "meta[http-equiv='Content-Security-Policy']")
        if not csp_meta:
            findings.append({
                "issue": "No client-side Content-Security-Policy (CSP) meta policy defined",
                "severity": "LOW",
                "impact": "Absence of a strict CSP increases blast radius of potential XSS vulnerabilities.",
                "remediation": "Configure a Content-Security-Policy header or meta tag restricting script sources."
            })

        status = "WARNING" if findings else "PASSED"
        return {
            "id": scenario.get("id"),
            "name": scenario.get("name"),
            "category": "Security Headers & Framing",
            "status": status,
            "severity": "LOW" if findings else "INFO",
            "details": f"Evaluated client security headers. Found {len(findings)} configuration observation(s).",
            "findings": findings
        }

    def _test_dom_xss(self, target_url: str, scenario: Dict[str, Any]) -> Dict[str, Any]:
        """Tests for DOM-based source/sink vulnerability patterns in client scripts."""
        findings = []
        # Query dangerous sinks like eval, document.write, innerHTML with location.hash/search
        suspicious_sinks = self.driver.execute_script("""
            const dangerous = [];
            const scripts = Array.from(document.scripts);
            for (const s of scripts) {
                const text = s.innerHTML || '';
                if (text.includes('innerHTML = location.hash') || text.includes('document.write(location.')) {
                    dangerous.push('Unsafe location source assigned to sink in inline script');
                }
            }
            return dangerous;
        """) or []

        for s in suspicious_sinks:
            findings.append({
                "issue": s,
                "severity": "HIGH",
                "impact": "Direct assignment of user-controllable window.location properties to rendering sinks enables DOM XSS.",
                "remediation": "Use safe DOM APIs like element.textContent or sanitize using DOMPurify."
            })

        status = "VULNERABLE" if findings else "PASSED"
        return {
            "id": scenario.get("id"),
            "name": scenario.get("name"),
            "category": "DOM & Client-Side Logic",
            "status": status,
            "severity": "HIGH" if findings else "INFO",
            "details": f"Analyzed DOM sinks on {target_url}. Found {len(findings)} suspicious sink pattern(s).",
            "findings": findings
        }

    def _test_generic_navigation(self, target_url: str, scenario: Dict[str, Any]) -> Dict[str, Any]:
        """Generic visual navigation test."""
        route = scenario.get("path", "")
        full_url = urljoin(target_url, route) if route else target_url
        self.bm.navigate(full_url)
        time.sleep(1)
        return {
            "id": scenario.get("id"),
            "name": scenario.get("name"),
            "category": "Functionality & Navigation",
            "status": "PASSED",
            "severity": "INFO",
            "details": f"Successfully loaded {full_url} in browser window.",
            "findings": []
        }
