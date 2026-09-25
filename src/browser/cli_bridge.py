"""
CodeStress Python-Selenium CLI Bridge
Provides bidirectional IPC communication between the Node.js GUI server
and the interactive Selenium browser session.
"""

import sys
import os
import json
import time
from typing import Dict, Any

from browser_manager import BrowserManager
from test_runner import TestRunner
from reporter import Reporter


def emit_json(event_type: str, data: Dict[str, Any]):
    payload = {"type": event_type, "data": data, "timestamp": time.time()}
    print(f"__CODESTRESS_EVENT__{json.dumps(payload)}", flush=True)


def main():
    bm = BrowserManager()
    tr = None
    target_url = None
    repo_path = ""
    ai_summary = ""

    # Parse initial argument if passed
    if len(sys.argv) > 1:
        target_url = sys.argv[1]
        try:
            bm.launch(target_url)
            tr = TestRunner(bm)
            emit_json("browser_ready", {
                "browser": bm.browser_name,
                "target": target_url,
                "url": bm.get_current_url()
            })
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
            # Handle plain text commands
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
                    else:
                        bm.navigate(target_url)
                    emit_json("browser_ready", {
                        "browser": bm.browser_name,
                        "target": target_url,
                        "url": bm.get_current_url()
                    })
                except Exception as e:
                    emit_json("browser_error", {"error": str(e)})

        elif cmd == "get_session":
            cookies = bm.get_cookies()
            storage = bm.get_storage_data()
            emit_json("session_status", {
                "cookies": cookies,
                "cookie_count": len(cookies),
                "url": bm.get_current_url(),
                "storage": storage
            })

        elif cmd == "run_tests":
            scenarios = msg.get("scenarios", [])
            target = msg.get("target") or target_url
            repo_path = msg.get("repo", repo_path)
            ai_summary = msg.get("ai_summary", ai_summary)

            if not tr:
                tr = TestRunner(bm)

            # Execute tests live in open browser
            results = tr.run_suite(target, scenarios)

            # Generate report.md
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

        elif cmd in ("quit", "close", "exit"):
            bm.close()
            emit_json("browser_closed", {})
            break

    bm.close()


if __name__ == "__main__":
    main()
