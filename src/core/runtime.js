export class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const limits = Object.freeze({ steps: 20, modelCalls: 12, retries: 2, scenarioMs: 180000, actionMs: 10000, navigationMs: 20000, scenarios: 5, manualMs: 600000 });
export function checkSignal(signal) { if (signal?.aborted) throw new AppError('CANCELED', 'Assessment canceled.'); }
export async function bounded(work, ms, signal) {
  checkSignal(signal);
  let timer, abort;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AppError('TIMEOUT', 'Operation timed out.')), ms);
      abort = () => reject(new AppError('CANCELED', 'Assessment canceled.'));
      signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export function publicError(error) {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'UNAVAILABLE', message: 'The operation could not complete. Check the current phase, provider configuration and target availability.' };
}
