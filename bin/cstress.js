#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { printBanner } from '../src/cli/banner.js';
import { Stage0Confirm } from '../src/pipeline/stage0Confirm.js';
import { Stage1Understand } from '../src/pipeline/stage1Understand.js';

dotenv.config();

const program = new Command();

program
  .name('cstress')
  .description('AI-powered adversarial testing CLI tool — Stress test your logic, not just your server.')
  .version('1.0.0')
  .argument('[target]', 'Target application URL (e.g. http://localhost:3000 or https://myapp.com)')
  .option('--understand', 'Read repository source and produce an AI understanding report')
  .option('--read-source', 'Read repository inventory without AI or target requests')
  .option('-g, --gui', 'Launch interactive Web GUI dashboard on port 9999')
  .option('-p, --port <port>', 'Port for web GUI server', '9999')
  .option('-r, --repo <path_or_url>', 'Codebase path (local directory) or GitHub repo URL', process.cwd())
  .option('-t, --token <gh_token>', 'GitHub personal access token for private/rate-limited repos')
  .option('-c, --cookie <cookie>', 'Session cookie header (e.g. "session=abc123")')
  .option('-b, --bearer <jwt>', 'Bearer token / JWT')
  .option('--email <email>', 'Login email for credentialed testing')
  .option('--password <password>', 'Login password for credentialed testing')
  .option('--auth-id <code>', 'Single login ID, student ID, access code or username (e.g. 24101128)')
  .option('--auth-login-path <path>', 'Exact login endpoint on the target (auto-discovered from source if omitted)')
  .option('--auth-id-field <field>', 'Override the automatically discovered login ID JSON field')
  .option('--auth-verify-path <path>', 'Protected current-user GET endpoint for session verification')
  .option('-o, --output <file>', 'Output report path', 'CODESTRESS.md')
  .option('-y, --yes', 'Automatically answer yes to confirmation prompts', false)
  .action(async (target, options) => {
    try {
      if (options.understand || options.readSource) {
        const result = await new Stage1Understand({ repo: options.repo, token: options.token, readOnly: Boolean(options.readSource) }).execute();
        console.log(JSON.stringify(result, null, 2));
        if (result.error || !result.coverage.complete || !result.coverage.filesRead) process.exitCode = 1;
        return;
      }
      // If GUI flag is passed or no target provided, start web dashboard
      if (options.gui || !target) {
        const { startGuiServer } = await import('../src/gui/server.js');
        const port = parseInt(options.port || process.env.GUI_PORT || '9999', 10);
        await startGuiServer(port);
        // Try opening the browser automatically on Windows
        try {
          const { exec } = await import('child_process');
          exec(`start http://localhost:${port}`);
        } catch (e) {}
        return;
      }
      // Print visual banner
      printBanner({
        target,
        repo: options.repo,
        engine: `IBM Bob 2.0 (${process.env.OLLAMA_MODEL || 'gpt-oss:120b'})`
      });

      // Normalize target URL
      if (!/^https?:\/\//i.test(target)) {
        target = `http://${target}`;
      }

      // Execute Stage 0: Confirm Target
      const stage0 = new Stage0Confirm({
        target,
        repo: options.repo,
        token: options.token,
        cookie: options.cookie,
        bearer: options.bearer,
        email: options.email,
        password: options.password,
        authId: options.authId,
        authLoginPath: options.authLoginPath,
        authIdField: options.authIdField,
        authVerifyPath: options.authVerifyPath,
        yes: options.yes
      });

      const stage0Result = await stage0.execute();

      if (!stage0Result.confirmed) {
        process.exitCode = stage0Result.authResult?.status === 'PUBLIC' || stage0Result.authResult?.authenticated ? 0 : 1;
        return;
      }

      // Next stages hook in here
      console.log(chalk.cyan('Stage 0 completed successfully.'));

      if (!['SUCCESS', 'PUBLIC'].includes(stage0Result.authResult.status)) {
        console.log(chalk.yellow('Skipping attack: authentication was not verified.'));
        return;
      }

      const { runAttack } = await import('../src/pipeline/stage3Attack.js');
      const { writeReport } = await import('../src/pipeline/stage4Report.js');

      console.log(chalk.bold.blue('\n[STAGE 3] Running adversarial tests...'));
      const results = await runAttack({
        target: stage0Result.target,
        routes: stage0Result.codeAnalysis.routes,
        session: stage0Result.session,
        user: stage0Result.authResult.user,
        onEvent: (e) => console.log(chalk.gray(`  → ${e.endpoint}`))
      });

      console.log(chalk.bold.blue('\n[STAGE 4] Generating report...'));
      const path = await import('node:path');
      const outPath = path.resolve(process.cwd(), options.output);
      writeReport(outPath, {
        target: stage0Result.target,
        repo: options.repo,
        authentication: stage0Result.authResult,
        understanding: stage0Result.codeAnalysis,
        results
      });

      const passed = results.filter(r => r.status === 'PASSED').length;
      const failed = results.filter(r => r.status === 'FAILED').length;
      const warned = results.filter(r => r.status === 'WARNING').length;
      console.log(chalk.gray('━'.repeat(44)));
      console.log(`Tests Run: ${results.length} | Passed: ${passed} | Failed: ${failed} | Warnings: ${warned}`);
      console.log(chalk.green(`✓ Report saved → ${outPath}\n`));
    } catch (err) {
      console.error(chalk.bold.red('\n[FATAL ERROR]'), chalk.red(err.message));
      process.exit(1);
    }
      });

program.parse(process.argv);
