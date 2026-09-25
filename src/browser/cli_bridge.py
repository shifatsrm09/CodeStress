"""
CodeStress Python-Selenium CLI Bridge
Provides bidirectional IPC communication between the Node.js GUI server
and the interactive Selenium browser session with continuous background auth monitoring.
"""

import sys
import os
import json
import time
import threading
from typing import Dict, Any

from browser_manager import BrowserManager
from test_runner import TestRunner
from reporter import Reporter


def emit_json(event_type: str, data: Dict[str, Any]):
    payload = {"type": event_type, "data": data, "timestamp": time.time()}
    print(f"__CODESTRESS_EVENT__{json.dumps(payload)}", flush=True)


class AuthMonitor(threading.Thread):
    def __init__(self, browser_manager: BrowserManager, poll_interval: float = 1.0):
        super().__init__(daemon=True)
        self.bm = browser_manager
        self.poll_interval = poll_interval
        self.running = True
        self.paused = False
        self.candidate_indicators: Dict[str, Any] = {}
        self.last_auth_status = None

    def set_indicators(self, indicators: Dict[str, Any]):
        self.candidate_indicators = indicators or {}

    def run(self):
        while self.running:
            if not self.paused:
                try:
                    if self.bm and self.bm.driver:
                        auth_state = self.bm.check_auth_state(self.candidate_indicators)
                        current_status = auth_state.get("authenticated", False)
                        if self.last_auth_status is None or current_status != self.last_auth_status:
                            self.last_auth_status = current_status
                            emit_json("auth_state_changed", auth_state)
                except Exception:
                    pass
            time.sleep(self.poll_interval)

    def stop(self):
        self.running = False


def main():
    bm = BrowserManager()
    tr = None
    target_url = None
    repo_path = ""
    ai_summary = ""
    auth_monitor = None

    # Parse initial argument if passed
    if len(sys.argv) > 1:
        target_url = sys.argv[1]
        try:
            bm.launch(target_url)
            tr = TestRunner(bm)
            auth_monitor = AuthMonitor(bm)
            auth_monitor.start()
            emit_json("browser_ready", {
                "browser": bm.browser_name,
                "target": target_url,
                "url": bm.get_current_url()
            })
            # Immediate initial auth evaluation
            init_state = bm.check_auth_state()
            emit_json("auth_state_changed", init_state)
        except Exception as e:
            emit_json("browser_error", {"error": str(e)})
            sys.exit(1)

    # Listen on stdin for commands from Node.js
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except Exception:
            cmd = line.split()[0].lower()
            msg = {"cmd": cmd}

        cmd = msg.get("cmd", "").lower()

        if cmd == "init":
            target = msg.get("target") or target_url
            if target:
                target_url = target
                try:
                    if not bm.driver:
                        bm.launch(target_url)
                        tr = TestRunner(bm)
                        if not auth_monitor or not auth_monitor.is_alive():
                            auth_monitor = AuthMonitor(bm)
                            auth_monitor.start()
                    else:
                        bm.navigate(target_url)
                    emit_json("browser_ready", {
                        "browser": bm.browser_name,
                        "target": target_url,
                        "url": bm.get_current_url()
                    })
                    init_state = bm.check_auth_state()
                    emit_json("auth_state_changed", init_state)
                except Exception as e:
                    emit_json("browser_error", {"error": str(e)})

        elif cmd == "set_indicators":
            indicators = msg.get("indicators", {})
            if auth_monitor:
                auth_monitor.set_indicators(indicators)
            # Recheck immediately with new indicators
            current_state = bm.check_auth_state(indicators)
            emit_json("auth_state_changed", current_state)

        elif cmd == "check_auth":
            indicators = auth_monitor.candidate_indicators if auth_monitor else {}
            state = bm.check_auth_state(indicators)
            emit_json("auth_state_changed", state)

        elif cmd == "get_session":
            cookies = bm.get_cookies()
            storage = bm.get_storage_data()
            auth_state = bm.check_auth_state(auth_monitor.candidate_indicators if auth_monitor else {})
            emit_json("session_status", {
                "cookies": cookies,
                "cookie_count": len(cookies),
                "url": bm.get_current_url(),
                "storage": storage,
                "authenticated": auth_state.get("authenticated", False),
                "indicators": auth_state.get("indicators", [])
            })

        elif cmd == "run_tests":
            scenarios = msg.get("scenarios", [])
            target = msg.get("target") or target_url
            repo_path = msg.get("repo", repo_path)
            ai_summary = msg.get("ai_summary", ai_summary)

            if auth_monitor:
                auth_monitor.paused = True

            if not tr:
                tr = TestRunner(bm)

            try:
                # Execute tests live in open browser
                results = tr.run_suite(target, scenarios)

                # Generate final comprehensive report.md
                reporter = Reporter(target, repo_path=repo_path)
                report_path = os.path.abspath("report.md")
                markdown = reporter.generate_markdown(results, ai_summary=ai_summary, output_path=report_path)

                emit_json("report_ready", {
                    "report_path": report_path,
                    "total_tests": len(results),
                    "passed": len([r for r in results if r["status"] == "PASSED"]),
                    "issues": len([r for r in results if r["status"] in ("VULNERABLE", "WARNING", "FAILED")]),
                    "markdown_preview": markdown[:1500]
                })
            finally:
                if auth_monitor:
                    auth_monitor.paused = False

        elif cmd in ("quit", "close", "exit"):
            if auth_monitor:
                auth_monitor.stop()
            bm.close()
            emit_json("browser_closed", {})
            break

    if auth_monitor:
        auth_monitor.stop()
    bm.close()


if __name__ == "__main__":
    main()
