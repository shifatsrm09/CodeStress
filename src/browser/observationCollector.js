import { randomUUID } from 'node:crypto';
export class ObservationCollector {
  constructor(session) {
    this.session = session; this.network = []; this.consoleErrors = []; this.pageErrors = []; this.failedRequests = [];
  }
  attach(page) {
    const push = (list, value) => { list.push(this.session.redactor.clean(value)); if (list.length > 200) list.shift(); };
    page.on('request', request => {
      if (!this.session.manual && this.session.inScope(request.url())) push(this.network, { kind: 'request', url: this.session.redactor.url(request.url()), method: request.method(), timestamp: new Date().toISOString() });
    });
    page.on('response', response => {
      if (!this.session.manual && this.session.inScope(response.url())) push(this.network, { kind: 'response', url: this.session.redactor.url(response.url()), status: response.status(), method: response.request().method(), headers: { 'content-type': response.headers()['content-type'] || '' }, timestamp: new Date().toISOString() });
    });
    // Arbitrary console text can contain previously unknown credentials; record type only.
    page.on('console', message => { if (!this.session.manual && message.type() === 'error') push(this.consoleErrors, { type: 'console.error', message: 'Console error observed (payload omitted)', timestamp: new Date().toISOString() }); });
    page.on('pageerror', () => { if (!this.session.manual) push(this.pageErrors, { message: 'Unhandled page exception (payload omitted)', timestamp: new Date().toISOString() }); });
    page.on('requestfailed', request => { if (!this.session.manual) push(this.failedRequests, { url: this.session.redactor.url(request.url()), method: request.method(), error: 'Network request failed or was blocked by scope policy' }); });
  }
  async collect() {
    const { page, redactor } = this.session;
    if (!this.session.inScope(page.url())) return { id: randomUUID(), timestamp: new Date().toISOString(), blocked: true, reason: 'Browser is outside the target origin. Manual interaction required.', url: redactor.url(page.url()), elements: [] };
    await this.session.learnSecrets();
    const snapshot = await page.evaluate(() => {
      const visible = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
      const describe = element => ({
        tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || ({ BUTTON: 'button', A: 'link', SELECT: 'combobox', TEXTAREA: 'textbox' }[element.tagName]) || (element.tagName === 'INPUT' ? ['checkbox', 'radio'].includes(element.type) ? element.type : 'textbox' : ''),
        name: element.getAttribute('aria-label') || (element.labels?.[0]?.innerText || '') || (element.tagName === 'INPUT' ? element.getAttribute('placeholder') || '' : element.innerText?.trim().slice(0, 180)) || '',
        label: element.labels?.[0]?.innerText?.trim() || '', placeholder: element.getAttribute('placeholder') || '', testId: element.getAttribute('data-testid') || '',
        type: element.getAttribute('type') || '', required: Boolean(element.required), disabled: Boolean(element.disabled), href: element.tagName === 'A' ? element.href : '',
        validity: typeof element.checkValidity === 'function' ? { valid: element.validity.valid, valueMissing: element.validity.valueMissing, typeMismatch: element.validity.typeMismatch, patternMismatch: element.validity.patternMismatch } : null
      });
      const elements = [...document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]')].filter(visible).slice(0, 150).map(describe);
      const clone = document.body?.cloneNode(true);
      clone?.querySelectorAll('script,style,noscript,iframe,svg').forEach(element => element.remove());
      clone?.querySelectorAll('*').forEach(element => { for (const attr of [...element.attributes]) if (!['role', 'aria-label', 'type', 'name', 'placeholder', 'data-testid'].includes(attr.name)) element.removeAttribute(attr.name); if (['INPUT', 'TEXTAREA'].includes(element.tagName)) element.textContent = ''; });
      return { title: document.title, visibleText: (document.body?.innerText || '').slice(0, 20000), dom: (clone?.outerHTML || '').slice(0, 40000), elements };
    });
    for (const element of snapshot.elements) if (element.href) element.href = redactor.url(element.href);
    return redactor.clean({ id: randomUUID(), timestamp: new Date().toISOString(), url: redactor.url(page.url()), ...snapshot, network: this.network.splice(0), consoleErrors: this.consoleErrors.splice(0), pageErrors: this.pageErrors.splice(0), failedRequests: this.failedRequests.splice(0) });
  }
}
