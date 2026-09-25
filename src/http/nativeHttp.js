export function createNativeHttp({ timeoutMs = 10000 } = {}) {
  async function request(method, url, options = {}, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || timeoutMs);
    try {
      const headers = { ...(options.headers || {}) };
      const init = { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'manual', signal: controller.signal };
      if (body !== undefined && !headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
      const response = await fetch(url, init);
      const buffer = await response.arrayBuffer();
      const max = options.maxContentLength || 2 * 1024 * 1024;
      const text = new TextDecoder().decode(buffer.slice(0, max));
      const responseHeaders = Object.fromEntries(response.headers.entries());
      let data = text;
      if (/application\/json/i.test(responseHeaders['content-type'] || '')) {
        try { data = JSON.parse(text); } catch {}
      }
      return { status: response.status, statusText: response.statusText, data, headers: responseHeaders };
    } finally { clearTimeout(timer); }
  }
  return {
    get: (url, options = {}) => request('GET', url, options),
    post: (url, body, options = {}) => request('POST', url, options, body),
    put: (url, body, options = {}) => request('PUT', url, options, body),
    patch: (url, body, options = {}) => request('PATCH', url, options, body),
    delete: (url, options = {}) => request('DELETE', url, options)
  };
}
