import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EventEmitter from 'node:events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class SeleniumBridge extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.browserReady = false;
    this.browserInfo = null;
  }

  /**
   * Spawns the Python Selenium bridge process and opens targetUrl in a visible browser.
   */
  launch(targetUrl) {
    return new Promise((resolve, reject) => {
      if (this.process) {
        this.close();
      }

      const scriptPath = path.join(__dirname, 'cli_bridge.py');
      // Use python executable from environment
      const py = spawn('python', [scriptPath, targetUrl], {
        cwd: path.resolve(__dirname, '../..'),
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.process = py;
      let initResolved = false;

      py.stdout.on('data', chunk => {
        const text = chunk.toString();
        const lines = text.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('__CODESTRESS_EVENT__')) {
            try {
              const event = JSON.parse(trimmed.replace('__CODESTRESS_EVENT__', ''));
              this.emit('event', event);

              if (event.type === 'browser_ready' && !initResolved) {
                initResolved = true;
                this.browserReady = true;
                this.browserInfo = event.data;
                resolve(event.data);
              } else if (event.type === 'browser_error' && !initResolved) {
                initResolved = true;
                reject(new Error(event.data.error || 'Failed to initialize browser'));
              }
            } catch (err) {
              // ignore parse errors
            }
          } else if (trimmed) {
            this.emit('log', { level: 'info', text: trimmed });
          }
        }
      });

      py.stderr.on('data', chunk => {
        const text = chunk.toString().trim();
        if (text) {
          this.emit('log', { level: 'warn', text });
        }
      });

      py.on('error', err => {
        if (!initResolved) {
          initResolved = true;
          reject(err);
        }
        this.emit('error', err);
      });

      py.on('close', code => {
        this.browserReady = false;
        this.process = null;
        this.emit('close', code);
      });

      // Timeout safety: 30 seconds for browser launch
      setTimeout(() => {
        if (!initResolved) {
          initResolved = true;
          reject(new Error('Browser initialization timed out after 30 seconds.'));
        }
      }, 30000);
    });
  }

  /**
   * Requests current session cookies and storage from the browser.
   */
  getSession() {
    return new Promise((resolve) => {
      if (!this.process || !this.browserReady) {
        return resolve({ cookies: [], storage: {} });
      }

      const handler = (event) => {
        if (event.type === 'session_status') {
          this.off('event', handler);
          resolve(event.data);
        }
      };

      this.on('event', handler);
      this.process.stdin.write(JSON.stringify({ cmd: 'get_session' }) + '\n');

      setTimeout(() => {
        this.off('event', handler);
        resolve({ cookies: [], storage: {} });
      }, 5000);
    });
  }

  /**
   * Executes test scenarios live in the opened browser window.
   */
  runTests(scenarios, { target, repo, aiSummary }) {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.browserReady) {
        return reject(new Error('Browser is not open. Launch the browser first.'));
      }

      const handler = (event) => {
        if (event.type === 'report_ready') {
          this.off('event', handler);
          resolve(event.data);
        }
      };

      this.on('event', handler);

      const msg = {
        cmd: 'run_tests',
        scenarios,
        target,
        repo,
        ai_summary: aiSummary
      };

      this.process.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  /**
   * Closes browser and kills python subprocess.
   */
  close() {
    if (this.process) {
      try {
        this.process.stdin.write(JSON.stringify({ cmd: 'close' }) + '\n');
      } catch (e) {}

      setTimeout(() => {
        if (this.process) {
          try {
            this.process.kill();
          } catch (e) {}
          this.process = null;
          this.browserReady = false;
        }
      }, 1000);
    }
  }
}
