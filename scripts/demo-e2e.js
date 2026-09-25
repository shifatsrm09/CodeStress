import { Assessment } from '../src/pipeline/assessment.js';
import demoServer from '../demo-app/server.js';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';

automaticConfirmationPrompt();

function automaticConfirmationPrompt() {
  // The demo harness intentionally bypasses the interactive confirmation because
  // the target is the bundled local vulnerable demo application.
  process.env.CODESTRESS_AUTO_CONFIRM = '1';
}

const listen = () => new Promise((resolve, reject) => {
  const onError = error => {
    demoServer.off('listening', onListening);
    reject(error);
  };
  const onListening = () => {
    demoServer.off('error', onError);
    resolve(demoServer.address().port);
  };
  demoServer.once('error', onError);
  demoServer.once('listening', onListening);
  demoServer.listen(0, host);
});

try {
  const port = await listen();
  const assessment = new Assessment({
    target: `http://${host}:${port}`,
    repo: fileURLToPath(new URL('../demo-app/', import.meta.url)),
    email: 'testuser@myapp.com',
    password: 'test123',
    output: fileURLToPath(new URL('../CODESTRESS-DEMO.md', import.meta.url)),
    rateLimitRequests: 12,
    oversizedBytes: 128 * 1024,
    logger: () => {},
    prompt: async () => true
  });
  const result = await assessment.run({ consent: true });
  console.log(`Target: http://${host}:${port}`);
  console.log(`Tests: ${result.attackSummary?.testsRun ?? 0}`);
  console.log(`Passed: ${result.attackSummary?.passed ?? 0}`);
  console.log(`Failed: ${result.attackSummary?.failed ?? 0}`);
  console.log(`Warnings: ${result.attackSummary?.warnings ?? 0}`);
  console.log(`Security Score: ${result.attackSummary?.score ?? 'n/a'}`);
  console.log(`Report: ${result.reportPath}`);
} finally {
  if (demoServer.listening) {
    await new Promise(resolve => demoServer.close(resolve));
  }
}
