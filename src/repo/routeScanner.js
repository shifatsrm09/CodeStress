import { RepositoryReader } from './repositoryReader.js';

export class RouteScanner {
  constructor(options = {}) {
    this.options = { ...options, repo: options.repo || process.cwd() };
  }

  async scan() {
    const repository = await new RepositoryReader(this.options).read();
    return this.analyze(repository);
  }

  analyze(repository) {
    const routes = [], middlewares = new Set(), dbQueries = [];
    for (const file of repository.files) {
      const extracted = this.extractFromCode(file.content, file.path);
      routes.push(...extracted.routes);
      extracted.middlewares.forEach(item => middlewares.add(item));
      dbQueries.push(...extracted.dbQueries);
    }
    const groups = this.groupRoutes(routes);
    return {
      repoType: repository.source.type, repoPath: repository.source.location,
      totalFilesScanned: repository.files.length, coverage: repository.coverage,
      routeGroups: Object.keys(groups).length, routeGroupsList: Object.keys(groups),
      endpoints: routes.length, routes, middlewares: [...middlewares], dbQueries
    };
  }

  /**
   * Regex extraction of endpoints, parameters, middlewares, and db patterns
   */
  extractFromCode(content, relativePath) {
    const routes = [];
    const middlewares = [];
    const dbQueries = [];

    const lines = content.split('\n');

    // 1. Detect routes: app.get('/api/users', ...), router.post('/login', ...)
    const routeRegex = /(?:app|router)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const endpoint = match[2];

      // Find line number
      const upToMatch = content.substring(0, match.index);
      const lineNumber = upToMatch.split('\n').length;

      // Detect parameters
      const params = [];
      const paramMatches = endpoint.match(/:[a-zA-Z0-9_]+/g);
      if (paramMatches) {
        paramMatches.forEach(p => params.push({ name: p.replace(':', ''), in: 'path' }));
      }

      // Check nearby code block for req.body and req.query
      const blockEnd = Math.min(content.length, match.index + 1200);
      const surroundingCode = content.substring(match.index, blockEnd);

      const bodyMatches = surroundingCode.match(/req\.body(?:\.([a-zA-Z0-9_]+)|\[['"]([a-zA-Z0-9_]+)['"]\])/g);
      if (bodyMatches) {
        bodyMatches.forEach(b => {
          const name = b.replace(/^req\.body(\.|\[['"])/, '').replace(/['"]\]$/, '');
          if (name && !params.find(p => p.name === name)) {
            params.push({ name, in: 'body' });
          }
        });
      }

      const queryMatches = surroundingCode.match(/req\.query(?:\.([a-zA-Z0-9_]+)|\[['"]([a-zA-Z0-9_]+)['"]\])/g);
      if (queryMatches) {
        queryMatches.forEach(q => {
          const name = q.replace(/^req\.query(\.|\[['"])/, '').replace(/['"]\]$/, '');
          if (name && !params.find(p => p.name === name)) {
            params.push({ name, in: 'query' });
          }
        });
      }

      // Destructuring form: const { a, b } = req.body (very common; the
      // req.body.x / req.body['x'] matches above miss this entirely)
      for (const destructure of surroundingCode.matchAll(/\{([^{}]+)\}\s*=\s*req\.body/g)) {
        for (const field of destructure[1].split(',')) {
          const name = field.trim().split(/[:=]/)[0].trim();
          if (/^[a-zA-Z_$][\w$]*$/.test(name) && !params.find(p => p.name === name)) {
            params.push({ name, in: 'body' });
          }
        }
      }
      for (const destructure of surroundingCode.matchAll(/\{([^{}]+)\}\s*=\s*req\.query/g)) {
        for (const field of destructure[1].split(',')) {
          const name = field.trim().split(/[:=]/)[0].trim();
          if (/^[a-zA-Z_$][\w$]*$/.test(name) && !params.find(p => p.name === name)) {
            params.push({ name, in: 'query' });
          }
        }
      }

      routes.push({
        method,
        path: endpoint,
        file: relativePath,
        line: lineNumber,
        parameters: params,
        rawContext: surroundingCode.slice(0, 300)
      });
    }

    // 2. Detect middleware usage: app.use(authMiddleware), verifyToken, etc.
    const mwRegex = /(?:verifyToken|authenticate|authMiddleware|requireAuth|checkAuth|isAdmin|rateLimit|limiter)/gi;
    let mwMatch;
    while ((mwMatch = mwRegex.exec(content)) !== null) {
      middlewares.push(mwMatch[0]);
    }

    // 3. Detect raw DB queries (SQL injection points)
    const sqlRegex = /(?:SELECT|INSERT|UPDATE|DELETE)\s+[^;]{4,100}/gi;
    let sqlMatch;
    while ((sqlMatch = sqlRegex.exec(content)) !== null) {
      const upToMatch = content.substring(0, sqlMatch.index);
      const lineNumber = upToMatch.split('\n').length;
      dbQueries.push({
        file: relativePath,
        line: lineNumber,
        snippet: sqlMatch[0].trim()
      });
    }

    return { routes, middlewares, dbQueries };
  }

  groupRoutes(routes) {
    const groups = {};
    for (const r of routes) {
      // Group by first path segment, e.g. /api/users -> /api/users or /api
      const parts = r.path.split('/').filter(Boolean);
      const groupKey = parts.length > 1 ? `/${parts[0]}/${parts[1]}` : `/${parts[0] || 'root'}`;
      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(r);
    }
    return groups;
  }
}
