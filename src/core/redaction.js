const sensitiveKey = /^(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|storageState|privateKey)$/i;
export class Redactor {
  constructor(values = []) { this.values = new Set(); values.forEach(value => this.add(value)); }
  add(value) { if (typeof value === 'string' && value.length >= 3) this.values.add(value); }
  text(value) {
    let result = String(value);
    for (const secret of [...this.values].sort((a, b) => b.length - a.length)) result = result.split(secret).join('[redacted]');
    return result.replace(/\bBearer\s+[^\s"<>]+/gi, 'Bearer [redacted]')
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')
      .replace(/((?:password|api[_-]?key|access[_-]?token|secret)\s*[=:]\s*["']?)[^\s,"'<>]+/gi, '$1[redacted]');
  }
  clean(value) {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map(item => this.clean(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? '[redacted]' : this.clean(item)]));
    return value;
  }
  url(value) {
    try { const url = new URL(value); return this.text(url.origin + url.pathname); }
    catch { return '[invalid URL]'; }
  }
}
