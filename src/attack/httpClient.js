import { setTimeout as sleep } from 'node:timers/promises';

export class SafeHttpClient {
  constructor({ timeoutMs = 10000, maxBodyBytes = 2 * 1024 * 1024 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxBodyBytes = maxBodyBytes;
  }

  async request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: options.headers,
        body: options.body,
        redirect: 'manual',
        signal: controller.signal
      });
      const buffer = await response.arrayBuffer();
      const bytes = Buffer.byteLength(buffer);
      const truncated = bytes > this.maxBodyBytes;
      const sliced = truncated ? buffer.slice(0, this.maxBodyBytes) : buffer;
      const text = new TextDecoder().decode(sliced);
      const headers = Object.fromEntries(response.headers.entries());
      let data = text;
      const contentType = headers['content-type'] || '';
      if (/application\/json/i.test(contentType)) {
        try { data = JSON.parse(text); } catch { /* keep text */ }
      }
      return { status: response.status, statusText: response.statusText, headers, data, text, bytes, truncated, url };
    } finally {
      clearTimeout(timeout);
    }
  }

  async json(url, body, options = {}) {
    return this.request(url, {
      method: options.method || 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs
    });
  }

  async burst(url, options = {}, count = 10, spacingMs = 0) {
    const results = [];
    for (let i = 0; i < count; i++) {
      results.push(await this.request(url, options));
      if (spacingMs > 0 && i < count - 1) await sleep(spacingMs);
    }
    return results;
  }
}
