"""
CodeStress Browser Manager
Launches and manages interactive, visible browser sessions using Selenium.
Automatically detects Microsoft Edge or Google Chrome on Windows/Linux/macOS.
"""

import sys
import os
import time
from typing import Optional, Dict, Any, List

from selenium import webdriver
from selenium.webdriver.edge.options import Options as EdgeOptions
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import WebDriverException


class BrowserManager:
    def __init__(self):
        self.driver: Optional[webdriver.Remote] = None
        self.browser_name: str = "unknown"

    def launch(self, target_url: Optional[str] = None) -> bool:
        """
        Launches a visible browser window (Edge or Chrome) and opens target_url
        with stealth options to enable OAuth/SSO logins without bot detection.
        """
        errors = []
        profile_dir = os.path.abspath(os.path.join(".codestress", "browser_profile"))
        os.makedirs(profile_dir, exist_ok=True)
        user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"

        # 1. Try Microsoft Edge (standard on Windows)
        try:
            edge_opts = EdgeOptions()
            edge_opts.add_argument("--start-maximized")
            edge_opts.add_argument("--disable-infobars")
            edge_opts.add_argument("--disable-extensions")
            edge_opts.add_argument(f"--user-data-dir={profile_dir}")
            edge_opts.add_argument("--disable-blink-features=AutomationControlled")
            edge_opts.add_argument("--no-first-run")
            edge_opts.add_argument("--no-default-browser-check")
            edge_opts.add_argument(f"user-agent={user_agent}")
            edge_opts.add_argument("--lang=en-US,en")
            edge_opts.add_experimental_option("excludeSwitches", ["enable-automation"])
            edge_opts.add_experimental_option("useAutomationExtension", False)
            edge_opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})

            self.driver = webdriver.Edge(options=edge_opts)
            self.browser_name = "Microsoft Edge"
            self._apply_stealth_scripts()
        except Exception as e:
            errors.append(f"Edge launch failed: {e}")

        # 2. Try Google Chrome if Edge failed
        if not self.driver:
            try:
                chrome_opts = ChromeOptions()
                chrome_opts.add_argument("--start-maximized")
                chrome_opts.add_argument("--disable-infobars")
                chrome_opts.add_argument("--disable-extensions")
                chrome_opts.add_argument(f"--user-data-dir={profile_dir}")
                chrome_opts.add_argument("--disable-blink-features=AutomationControlled")
                chrome_opts.add_argument("--no-first-run")
                chrome_opts.add_argument("--no-default-browser-check")
                chrome_opts.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
                chrome_opts.add_argument("--lang=en-US,en")
                chrome_opts.add_experimental_option("excludeSwitches", ["enable-automation"])
                chrome_opts.add_experimental_option("useAutomationExtension", False)
                chrome_opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})

                self.driver = webdriver.Chrome(options=chrome_opts)
                self.browser_name = "Google Chrome"
                self._apply_stealth_scripts()
            except Exception as e:
                errors.append(f"Chrome launch failed: {e}")

        if not self.driver:
            raise RuntimeError(f"Could not launch Edge or Chrome: {'; '.join(errors)}")

        self.driver.set_page_load_timeout(30)
        self.driver.implicitly_wait(5)

        if target_url:
            self.navigate(target_url)

        return True

    def _apply_stealth_scripts(self):
        """Injects CDP scripts on every document load to neutralize automation signals."""
        if not self.driver:
            return
        try:
            stealth_js = """
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
            window.navigator.chrome = {
                runtime: {},
                loadTimes: function() {},
                csi: function() {},
                app: {}
            };
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5]
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en']
            });
            """
            self.driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
                "source": stealth_js
            })
        except Exception as e:
            print(f"[WARN] Failed to inject stealth CDP scripts: {e}", file=sys.stderr)

    def navigate(self, url: str) -> bool:
        """Navigates to a specific URL."""
        if not self.driver:
            raise RuntimeError("Browser is not running.")
        try:
            self.driver.get(url)
            time.sleep(1)
            return True
        except Exception as e:
            print(f"[WARN] Failed to navigate to {url}: {e}", file=sys.stderr)
            return False

    def get_current_url(self) -> str:
        """Returns the current URL."""
        if not self.driver:
            return ""
        try:
            return self.driver.current_url
        except Exception:
            return ""

    def get_cookies(self) -> List[Dict[str, Any]]:
        """Returns all cookies from current session."""
        if not self.driver:
            return []
        try:
            return self.driver.get_cookies()
        except Exception:
            return []

    def get_cookie_header(self) -> str:
        """Returns cookies formatted as a standard Cookie header."""
        cookies = self.get_cookies()
        return "; ".join([f"{c['name']}={c['value']}" for c in cookies if 'name' in c and 'value' in c])

    def get_storage_data(self) -> Dict[str, Any]:
        """Extracts localStorage and sessionStorage keys/values."""
        if not self.driver:
            return {"localStorage": {}, "sessionStorage": {}}
        try:
            local = self.driver.execute_script("return Object.assign({}, window.localStorage);") or {}
            session = self.driver.execute_script("return Object.assign({}, window.sessionStorage);") or {}
            return {"localStorage": local, "sessionStorage": session}
        except Exception:
            return {"localStorage": {}, "sessionStorage": {}}

    def get_console_logs(self) -> List[Dict[str, Any]]:
        """Extracts browser console logs if available."""
        if not self.driver:
            return []
        try:
            return self.driver.get_log("browser")
        except Exception:
            return []

    def check_auth_state(self, candidate_indicators: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Actively inspects current browser state for reliable authentication indicators.
        Returns dict with:
          authenticated: bool
          status: "SIGNED_IN" | "PENDING"
          url: str
          indicators: List[str]
          cookie_count: int
          cookies: List[Dict[str, Any]]
          storage: Dict[str, Any]
        """
        if not self.driver:
            return {
                "authenticated": False,
                "status": "PENDING",
                "url": "",
                "indicators": [],
                "cookie_count": 0,
                "cookies": [],
                "storage": {}
            }

        url = self.get_current_url()
        cookies = self.get_cookies()
        storage = self.get_storage_data()
        indicators = []

        # 1. Cookie Heuristics
        auth_cookie_patterns = (
            "session", "token", "auth", "sid", "jwt", "login", "user",
            "logged_in", "connect.sid", "phpsessid", "jsessionid",
            "laravel_session", "excela_session", "app_session", "__secure-",
            "_session", "remember_web", "user_session", "cfat_session"
        )
        detected_auth_cookies = []
        for c in cookies:
            name_lower = c.get("name", "").lower()
            val = str(c.get("value", ""))
            # Must be a substantial value not equal to common empty indicators
            if any(pat in name_lower for pat in auth_cookie_patterns):
                if len(val) >= 6 and val.lower() not in ("deleted", "null", "false", "0", "undefined", "none"):
                    detected_auth_cookies.append(c["name"])

        if detected_auth_cookies:
            indicators.append(f"Active session cookie(s) detected: {', '.join(detected_auth_cookies[:3])}")

        # 2. Local/Session Storage Heuristics
        storage_auth_keys = []
        for store_name in ("localStorage", "sessionStorage"):
            store = storage.get(store_name, {})
            if isinstance(store, dict):
                for k, v in store.items():
                    k_lower = k.lower()
                    if any(pat in k_lower for pat in ("token", "auth", "user", "jwt", "profile", "session", "access_token", "id_token")):
                        if v and str(v).lower() not in ("null", "undefined", "", "{}"):
                            storage_auth_keys.append(f"{store_name}.{k}")

        if storage_auth_keys:
            indicators.append(f"Client storage credential(s): {', '.join(storage_auth_keys[:2])}")

        # 3. DOM Heuristics via JavaScript
        dom_signals = {}
        try:
            dom_script = """
            return (function() {
                var signals = [];
                var hasLogout = false;
                var hasProfile = false;
                var hasPassword = false;

                // Logout/sign-out buttons or links
                var logoutSelectors = [
                    "a[href*='logout']", "a[href*='signout']", "a[href*='log-out']", "a[href*='sign-out']",
                    "button[id*='logout']", "button[name*='logout']", "button[id*='signout']",
                    "[aria-label*='logout' i]", "[aria-label*='sign out' i]", "[data-testid*='logout' i]"
                ];
                for (var i = 0; i < logoutSelectors.length; i++) {
                    if (document.querySelector(logoutSelectors[i])) {
                        hasLogout = true;
                        signals.push("Logout control found in page");
                        break;
                    }
                }
                if (!hasLogout) {
                    var clickables = document.querySelectorAll("button, a, [role='button'], span");
                    for (var j = 0; j < clickables.length; j++) {
                        var txt = (clickables[j].textContent || '').trim().toLowerCase();
                        if (txt === 'log out' || txt === 'sign out' || txt === 'logout' || txt === 'signout') {
                            hasLogout = true;
                            signals.push("Sign-out button text ('" + txt + "') detected");
                            break;
                        }
                    }
                }

                // Profile / Avatar elements
                var profileSelectors = [
                    "[class*='avatar']", "[class*='profile']", "[id*='profile']",
                    "[aria-label*='account' i]", "[aria-label*='user menu' i]", "[data-testid*='user-avatar']"
                ];
                for (var k = 0; k < profileSelectors.length; k++) {
                    if (document.querySelector(profileSelectors[k])) {
                        hasProfile = true;
                        signals.push("Profile/avatar element found in page");
                        break;
                    }
                }

                if (document.querySelector("input[type='password']")) {
                    hasPassword = true;
                }

                return {
                    hasLogout: hasLogout,
                    hasProfile: hasProfile,
                    hasPassword: hasPassword,
                    signals: signals
                };
            })();
            """
            dom_signals = self.driver.execute_script(dom_script) or {}
            indicators.extend(dom_signals.get("signals", []))
        except Exception:
            pass

        # 4. URL / Route Heuristics
        url_lower = url.lower()
        is_login_url = any(x in url_lower for x in ("/login", "/signin", "/auth/login", "/users/sign_in", "oauth/authorize"))
        is_app_url = any(x in url_lower for x in ("/dashboard", "/home", "/app", "/admin", "/workspace", "/profile", "/settings", "/overview", "/courses"))

        if is_app_url and not dom_signals.get("hasPassword", False):
            indicators.append(f"Navigated to application view: {url}")

        # Check candidate indicators from codebase (if provided)
        if candidate_indicators and isinstance(candidate_indicators, dict):
            protected_routes = candidate_indicators.get("protected_routes", [])
            for pr in protected_routes:
                if pr and pr != "/" and pr.lower() in url_lower:
                    indicators.append(f"Current route matches codebase protected endpoint: {pr}")
                    break

        # Authentication evaluation:
        # True if:
        # - Has logout/signout button or link, OR
        # - Has active auth cookie and NOT currently on an unauthenticated login page with password field, OR
        # - Has client storage token, OR
        # - Navigated to dashboard/app URL without password field
        is_authenticated = False
        if dom_signals.get("hasLogout", False):
            is_authenticated = True
        elif detected_auth_cookies and not (is_login_url and dom_signals.get("hasPassword", False)):
            is_authenticated = True
        elif storage_auth_keys and not (is_login_url and dom_signals.get("hasPassword", False)):
            is_authenticated = True
        elif is_app_url and not dom_signals.get("hasPassword", False):
            is_authenticated = True

        status = "SIGNED_IN" if is_authenticated else "PENDING"

        return {
            "authenticated": is_authenticated,
            "status": status,
            "url": url,
            "indicators": indicators,
            "cookie_count": len(cookies),
            "cookies": cookies,
            "storage": storage
        }

    def take_screenshot(self, filepath: str) -> bool:
        """Saves a screenshot to the specified path."""
        if not self.driver:
            return False
        try:
            os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
            return self.driver.save_screenshot(filepath)
        except Exception as e:
            print(f"[WARN] Screenshot failed: {e}", file=sys.stderr)
            return False

    def close(self):
        """Closes the browser window."""
        if self.driver:
            try:
                self.driver.quit()
            except Exception:
                pass
            finally:
                self.driver = None
