#!/usr/bin/env node
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import fs from 'node:fs/promises';
import { Assessment } from '../src/pipeline/assessment.js';
import { Stage1Understand } from '../src/pipeline/stage1Understand.js';
import { renderReport } from '../src/testing/report.js';
const program = new Command();
program.name('cstress').description('Source-aware application behavior testing').version('1.1.0')
  .argument('[target]', 'Target application URL')
  .option('--gui', 'Start the local GUI on port 9999')
  .option('--port <port>', 'GUI port', '9999')
  .option('-r, --repo <path>', 'Local folder or public GitHub root', process.cwd())
  .option('-t, --token <token>', 'GitHub token (prefer GITHUB_TOKEN in the environment)')
  .option('--upload <path>', 'Explicitly supplied upload fixture, available as fixture')
  .option('--read-source', 'Read source inventory without AI, browser or target requests')
  .option('--understand', 'Understand source without opening a browser')
  .option('--cookie <header>', 'Application session cookie')
  .option('--bearer <token>', 'Bearer token')
  .option('--email <email>', 'Account email')
  .option('--username <name>', 'Account username')
  .option('--auth-id <id>', 'Login ID')
  .option('--password <password>', 'Test account password')
  .option('--public', 'Test only public access')
  .option('--replay', 'Replay successful tests with a matching source fingerprint')
  .option('--run-browser', 'Explicitly authorize opening the browser')
  .option('--execute-tests', 'Explicitly authorize read-only scenario execution')
  .option('--allow-mutations', 'Authorize reviewed create/update/form actions')
  .option('--allow-dangerous', 'Also authorize reviewed destructive/payment/messaging actions')
  .option('-o, --output <file>', 'Write the final Markdown report to this path')
  .action(async (target, options) => {
    try {
      if (options.readSource || options.understand) {
        const report = await new Stage1Understand({ repo: options.repo, token: options.token, readOnly: Boolean(options.readSource) }).execute();
        console.log(JSON.stringify(report, null, 2)); return;
      }
      if (options.gui || !target) {
        const { startGuiServer } = await import('../src/gui/server.js'); await startGuiServer(Number(options.port)); return;
      }
      const assessment = new Assessment({ ...options, target, authMode: options.public ? 'none' : options.cookie ? 'cookie' : options.bearer ? 'bearer' : options.authId ? 'authId' : options.username || options.email ? 'credentials' : 'manual', onEvent: event => {
        if (event.type === 'assessment_phase') console.log(event.text);
        if (event.type === 'test_result') console.log(`${event.data.id}: ${event.data.status}`);
      }, onUserPrompt: async prompt => {
        if ((prompt.kind === 'browser' && options.runBrowser) || (prompt.kind === 'execution' && options.executeTests)) return { proceed: true, allowMutations: Boolean(options.allowMutations), allowDangerous: Boolean(options.allowDangerous) };
        if (!process.stdin.isTTY) return { proceed: false };
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const timeout = AbortSignal.timeout(600000);
        try { const answer = await rl.question(`${prompt.prompt} ${prompt.detail} [y/N] `, { signal: AbortSignal.any([assessment.signal, timeout]) }); return { proceed: /^y(?:es)?$/i.test(answer.trim()), allowMutations: Boolean(options.allowMutations), allowDangerous: Boolean(options.allowDangerous) }; }
        finally { rl.close(); }
      } });
      const cancel = () => assessment.cancel(); process.once('SIGINT', cancel);
      try {
        const result = await assessment.execute();
        console.log(`Run ${result.runId}: ${result.status}`);
        if (options.output) await fs.writeFile(options.output, renderReport(result), { mode: 0o600 });
        if (result.status === 'incomplete' || result.results.some(item => item.status === 'FAIL')) process.exitCode = 1;
      } finally { process.removeListener('SIGINT', cancel); }
    } catch { console.error('CodeStress could not complete the requested operation. Check configuration and saved run evidence.'); process.exitCode = 1; }
  });
program.parseAsync(process.argv);
