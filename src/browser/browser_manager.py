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
        Launches a visible browser window (Edge or Chrome) and opens target_url.
        """
        errors = []

        # 1. Try Microsoft Edge (standard on Windows)
        try:
            edge_opts = EdgeOptions()
            edge_opts.add_argument("--start-maximized")
            edge_opts.add_argument("--disable-infobars")
            edge_opts.add_argument("--disable-extensions")
            edge_opts.add_experimental_option("excludeSwitches", ["enable-automation"])
            edge_opts.add_experimental_option("useAutomationExtension", False)
            # Enable logging of browser console
            edge_opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})

            self.driver = webdriver.Edge(options=edge_opts)
            self.browser_name = "Microsoft Edge"
        except Exception as e:
            errors.append(f"Edge launch failed: {e}")

        # 2. Try Google Chrome if Edge failed
        if not self.driver:
            try:
                chrome_opts = ChromeOptions()
                chrome_opts.add_argument("--start-maximized")
                chrome_opts.add_argument("--disable-infobars")
                chrome_opts.add_argument("--disable-extensions")
                chrome_opts.add_experimental_option("excludeSwitches", ["enable-automation"])
                chrome_opts.add_experimental_option("useAutomationExtension", False)
                chrome_opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})

                self.driver = webdriver.Chrome(options=chrome_opts)
                self.browser_name = "Google Chrome"
            except Exception as e:
                errors.append(f"Chrome launch failed: {e}")

        if not self.driver:
            raise RuntimeError(f"Could not launch Edge or Chrome: {'; '.join(errors)}")

        self.driver.set_page_load_timeout(30)
        self.driver.implicitly_wait(5)

        if target_url:
            self.navigate(target_url)

        return True

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
