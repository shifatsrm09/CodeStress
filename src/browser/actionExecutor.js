import { validateAction, actionRisk } from './actionSchema.js';
import { AppError, checkSignal } from '../core/runtime.js';
export function locate(page, target) {
  if (target.role) return page.getByRole(target.role, { name: target.name, exact: true });
  if (target.label) return page.getByLabel(target.label, { exact: true });
  if (target.text) return page.getByText(target.text, { exact: true });
  if (target.placeholder) return page.getByPlaceholder(target.placeholder, { exact: true });
  if (target.testId) return page.getByTestId(target.testId);
  return page.locator(target.css);
}
export class ActionExecutor {
  constructor(session, { signal, uploads = {}, allowedRisk = 'SAFE' } = {}) { this.session = session; this.signal = signal; this.uploads = uploads; this.allowedRisk = allowedRisk; }
  async execute(input) {
    const action = validateAction(input); checkSignal(this.signal);
    const session = this.session, page = session.page;
    if (!session.inScope(page.url()) && page.url() !== 'about:blank') throw new AppError('MANUAL_REQUIRED', 'The browser left the target. Complete the security challenge manually.');
    let element, descriptor = {};
    if (action.target) {
      element = locate(page, action.target);
      if (await element.count() !== 1) throw new AppError('ELEMENT', 'Element was missing or ambiguous. Use the available candidates to select a unique element.');
      descriptor = await element.evaluate(el => ({ tag: el.tagName.toLowerCase(), name: el.getAttribute('aria-label') || el.innerText || '', href: el.getAttribute('href'), formAction: el.form?.action || '' }));
    }
    const risk = actionRisk(action, descriptor);
    if (['SAFE', 'CAUTION', 'DANGEROUS'].indexOf(risk) > ['SAFE', 'CAUTION', 'DANGEROUS'].indexOf(this.allowedRisk)) throw new AppError('POLICY', 'Action risk exceeds the reviewed scenario.');
    if ((risk === 'DANGEROUS' && !session.policy.allowDangerous) || (risk === 'CAUTION' && !session.policy.allowMutations)) throw new AppError('POLICY', `${risk} action requires explicit execution authorization.`);
    if (descriptor.href) session.safeURL(descriptor.href);
    const startedAt = new Date().toISOString();
    switch (action.action) {
      case 'navigate': await page.goto(session.safeURL(action.url), { waitUntil: 'domcontentloaded' }); break;
      case 'goBack': await page.goBack({ waitUntil: 'domcontentloaded' }); break;
      case 'reload': await page.reload({ waitUntil: 'domcontentloaded' }); break;
      case 'click': await element.click(); break;
      case 'fill': await element.fill(action.value); break;
      case 'select': await element.selectOption(action.value); break;
      case 'check': await element.check(); break;
      case 'uncheck': await element.uncheck(); break;
      case 'press': await element.press(action.key); break;
      case 'upload': {
        if (!this.uploads[action.fileId]) throw new AppError('UPLOAD', 'Upload fixture was not explicitly supplied by the user.');
        await element.setInputFiles(this.uploads[action.fileId]); break;
      }
      case 'wait': await page.waitForTimeout(action.ms); break;
      // Read tools are represented by the structured observation returned below.
      default: break;
    }
    return { action: session.redactor.clean(action), risk, startedAt, finishedAt: new Date().toISOString(), observation: await session.snapshot() };
  }
}
