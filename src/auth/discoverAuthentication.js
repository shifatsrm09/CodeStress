import path from 'node:path';
import { RepositoryReader } from '../repo/repositoryReader.js';

// Source is data: discovery never imports or executes repository code.
export async function discoverAuthentication(options) {
  const verificationPaths = [];
  const idFields = new Set();
  let files = [];
  if (options.repo) {
    try { files = (await new RepositoryReader({ repo: options.repo, token: options.token }).read()).files; }
    catch { /* Common same-origin session routes remain available. */ }
  }
  const mounts = new Map();
  for (const file of files) {
    const imports = new Map();
    for (const match of file.content.matchAll(/(?:import\s+(\w+)\s+from\s*|(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*)['"]([^'"]+)['"]/g)) {
      if (match[3].startsWith('.')) imports.set(match[1] || match[2], path.posix.normalize(path.posix.join(path.posix.dirname(file.path), match[3])).replace(/\.[cm]?[jt]s$/, ''));
    }
    for (const match of file.content.matchAll(/\bapp\.use\s*\(\s*['"]([^'"]+)['"]\s*,\s*([\w\s,]+)\)/g)) {
      for (const handler of match[2].split(',')) {
        const module = imports.get(handler.trim());
        if (module) mounts.set(module, match[1].replace(/\/$/, ''));
      }
    }
  }
  const loginCandidates = [];
  for (const file of files) {
    const routes = [...file.content.matchAll(/\b(app|router)\.(get|post)\s*\(\s*['"]([^'"]+)['"]/g)];
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      const prefix = route[1] === 'app' ? '' : mounts.get(file.path.replace(/\.[cm]?[jt]s$/, ''));
      if (prefix === undefined) continue;
      const routePath = prefix + route[3];
      if (route[2] === 'get' && /\/(?:me|whoami|profile|session|current-user|current_user)$/i.test(routePath)) verificationPaths.push(routePath);
      if (route[2] !== 'post') continue;
      const body = file.content.slice(route.index, routes[i + 1]?.index ?? file.content.length);
      const routeFields = new Set();
      for (const match of body.matchAll(/\breq\.body\.([\w]+)|\breq\.body\[['"](\w+)['"]\]/g)) routeFields.add(match[1] || match[2]);
      for (const match of body.matchAll(/\{([^{}]+)\}\s*=\s*req\.body/g)) {
        for (const field of match[1].split(',')) {
          const name = field.trim().split(/[:=]/)[0].trim();
          if (/^[a-zA-Z]\w*$/.test(name)) routeFields.add(name);
        }
      }
      const hasPassword = [...routeFields].some(f => /pass(word)?$/i.test(f));
      const hasIdentifier = [...routeFields].some(f => /^(email|username|login|user(id)?|identifier)$/i.test(f));
      const pathHints = /login|signin|sign-in|auth/i.test(routePath);
      if (hasPassword && (hasIdentifier || pathHints)) {
        loginCandidates.push({ path: routePath, strength: (pathHints ? 1 : 0) + (hasIdentifier ? 1 : 0) });
      }
      if (routePath === (options.authLoginPath || '/api/auth/login')) for (const field of routeFields) idFields.add(field);
    }
  }
  loginCandidates.sort((a, b) => b.strength - a.strength);
  const candidates = [...idFields].filter(field => /^(?:studentId|loginId|userId|username|email|identifier|id)$/i.test(field));
  return {
    authIdField: candidates.length === 1 ? candidates[0] : idFields.size === 1 ? [...idFields][0] : undefined,
    loginPath: loginCandidates[0]?.path,
    verificationPaths: [...new Set([...verificationPaths, '/api/auth/me', '/api/auth/session', '/api/users/me', '/api/me', '/auth/me', '/api/session', '/api/user', '/me'])].slice(0, 16)
  };
}
