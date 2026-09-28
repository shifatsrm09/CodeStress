import { chromium } from 'playwright';
import { ObservationCollector } from './observationCollector.js';
import { AppError, limits, checkSignal } from '../core/runtime.js';
import { dangerousText } from './actionSchema.js';
import { normalizeCookie } from '../auth/verifyAuthentication.js';

export class BrowserManager {
  constructor({ target, redactor, signal, channel = process.env.BROWSER_CHANNEL || 'msedge' }) {
    this.target = new URL(target); this.redactor = redactor; this.signal = signal; this.channel = channel; this.sessions = new Set();
  }
  async launch() {
    checkSignal(this.signal);
    try { this.browser = await chromium.launch({ headless: false, ...(this.channel !== 'chromium' ? { channel: this.channel } : {}), timeout: 30000 }); }
    catch { throw new AppError('BROWSER_LAUNCH', 'Browser could not start. Install Microsoft Edge, or install Playwright Chromium and set BROWSER_CHANNEL=chromium.'); }
    this.abort = () => { void this.close(); }; this.signal?.addEventListener('abort', this.abort, { once: true });
    if (this.signal?.aborted) { await this.close(); checkSignal(this.signal); }
    return { browser: this.channel, version: this.browser.version(), target: this.redactor.url(this.target.href) };
  }
  async session({ state, manual = false, bearer = '', policy = {} } = {}) {
    checkSignal(this.signal);
    if (!this.browser?.isConnected()) throw new AppError('BROWSER_CLOSED', 'The browser is closed. Start a new assessment.');
    const context = await this.browser.newContext({ storageState: state ? { cookies: state.cookies, origins: state.origins } : undefined, viewport: { width: 1440, height: 900 }, acceptDownloads: false, serviceWorkers: 'block' });
    if (state?.sessionStorage) await context.addInitScript(({ origin, values }) => {
      if (location.origin === origin) for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value);
    }, { origin: this.target.origin, values: state.sessionStorage });
    const session = new BrowserSession(this, context, { manual, bearer, policy });
    this.sessions.add(session);
    await session.initialize();
    return session;
  }
  async close() {
    this.signal?.removeEventListener('abort', this.abort);
    for (const session of this.sessions) await session.close().catch(() => {});
    this.sessions.clear();
    await this.browser?.close().catch(() => {}); this.browser = null;
  }
}
export class BrowserSession {
  constructor(manager, context, { manual, bearer, policy }) {
    this.manager = manager; this.context = context; this.manual = manual; this.bearer = bearer; this.policy = policy; this.redactor = manager.redactor;
    this.observer = new ObservationCollector(this);
  }
  inScope(value) { try { return new URL(value, this.manager.target).origin === this.manager.target.origin; } catch { return false; } }
  safeURL(value) {
    const url = new URL(value, this.manager.target);
    if (!this.inScope(url.href) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AppError('SCOPE', 'Automated navigation outside the target origin is blocked.');
    return url.href;
  }
  async initialize() {
    this.context.setDefaultTimeout(limits.actionMs); this.context.setDefaultNavigationTimeout(limits.navigationMs);
    await this.context.route('**/*', async route => {
      const request = route.request(), scoped = this.inScope(request.url());
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method());
      let danger = false; try { danger = dangerousText.test(decodeURIComponent(new URL(request.url()).pathname)); } catch { danger = true; }
      const asset = ['script', 'stylesheet', 'font', 'image'].includes(request.resourceType()) && request.method() === 'GET';
      if (!this.manual && ((!scoped && !asset) || (mutation && !this.policy.allowMutations) || (danger && !this.policy.allowDangerous))) {
        this.observer.failedRequests.push({ url: this.redactor.url(request.url()), method: request.method(), error: 'Blocked by execution policy' });
        return route.abort('blockedbyclient');
      }
      const headers = { ...request.headers() };
      if (scoped && this.bearer) headers.authorization = `Bearer ${this.bearer}`;
      if (!scoped && this.bearer && headers.authorization === `Bearer ${this.bearer}`) delete headers.authorization;
      await route.continue({ headers });
    });
    this.context.on('page', page => {
      this.observer.attach(page);
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      if (this.manual) this.page = page;
    });
    this.page = await this.context.newPage();
  }
  async setCredentials({ cookie, bearer }) {
    if (bearer) { this.bearer = bearer.replace(/^Bearer\s+/i, '').trim(); this.redactor.add(this.bearer); }
    if (cookie) {
      const pairs = normalizeCookie(cookie).split(';').map(pair => { const i = pair.indexOf('='); const value = pair.slice(i + 1); this.redactor.add(value); return { name: pair.slice(0, i).trim(), value, url: this.manager.target.origin }; });
      await this.context.addCookies(pairs);
    }
  }
  async learnSecrets() {
    for (const cookie of await this.context.cookies()) this.redactor.add(cookie.value);
    if (this.inScope(this.page.url())) {
      const values = await this.page.evaluate(() => {
        const all = []; for (const storage of [localStorage, sessionStorage]) for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (/token|session|auth|secret|key/i.test(key)) all.push(storage.getItem(key)); }
        return all;
      }).catch(() => []);
      values.forEach(value => this.redactor.add(value));
    }
  }
  async snapshot() { return this.observer.collect(); }
  async state() {
    await this.learnSecrets();
    const state = await this.context.storageState();
    const sessionStorage = this.inScope(this.page.url()) ? await this.page.evaluate(() => Object.fromEntries(Object.entries(window.sessionStorage))) : {};
    return { ...state, sessionStorage }; // in-memory only, never persisted in evidence
  }
  async screenshot(filename) {
    if (!this.inScope(this.page.url()) || this.manual) throw new AppError('SENSITIVE_PAGE', 'Screenshots are disabled during manual authentication or outside the target.');
    await this.learnSecrets();
    await this.page.evaluate(secrets => {
      for (const element of document.querySelectorAll('body *')) {
        const text = element.childElementCount ? '' : element.textContent || '';
        if (secrets.some(secret => text.includes(secret)) || /eyJ[\w-]+\.[\w-]+|(?:token|secret|password|api.?key)\s*[:=]/i.test(text)) element.setAttribute('data-codestress-mask', 'true');
      }
    }, [...this.redactor.values]);
    try { await this.page.screenshot({ path: filename, fullPage: false, mask: [this.page.locator('input,textarea,[contenteditable="true"],[data-codestress-mask],iframe')], timeout: limits.actionMs }); }
    finally { await this.page.locator('[data-codestress-mask]').evaluateAll(elements => elements.forEach(element => element.removeAttribute('data-codestress-mask'))).catch(() => {}); }
  }
  async close() { await this.context.close(); this.manager.sessions.delete(this); }
}
