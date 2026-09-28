import express from 'express';
export function createBehaviorFixture() {
  const app = express(); app.use(express.json());
  const authenticated = req => (req.headers.cookie || '').split(';').some(pair => pair.trim() === 'fixture_session=fixture-valid-session');
  app.get('/', (req, res) => res.type('html').send('<h1>Fixture home</h1><a href="/welcome">Welcome page</a><a href="/broken">Broken page</a>'));
  app.get('/welcome', (req, res) => res.type('html').send('<h1>Welcome fixture</h1>'));
  // Contract: public content pages /welcome and /broken must render Welcome fixture.
  // Intentional behavioral mismatch used only to prove FAIL + actual reproduction.
  app.get('/broken', (req, res) => res.status(500).type('html').send('<h1>Fixture failure</h1>'));
  app.get('/account', (req, res) => authenticated(req) ? res.type('html').send('<h1>Private fixture account</h1>') : res.redirect('/login'));
  app.get('/login', (req, res) => res.type('html').send('<h1>Sign in to fixture</h1>'));
  app.get('/session', (req, res) => authenticated(req) ? res.json({ user: { id: 'fixture-user', username: 'tester', role: 'user' } }) : res.status(401).json({ error: 'Authentication required' }));
  app.get('/form', (req, res) => res.type('html').send('<form><label>Email<input type="email" required></label><button>Submit</button></form>'));
  return app;
}
