const session   = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt    = require('bcryptjs');
const { pool }  = require('./db');

// ── Session middleware ──
function sessionMiddleware() {
  return session({
    store: new pgSession({
      pool,
      tableName: 'sessions',
      createTableIfMissing: false, // we create it in initSchema
    }),
    secret: process.env.SESSION_SECRET || 'jdw-field-ops-fallback-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production' },
  });
}

// ── Auth middleware ──
function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  pool.query('SELECT id, name, email, role, status, permissions FROM users WHERE id = $1', [req.session.userId])
    .then(({ rows }) => {
      const user = rows[0];
      if (!user || user.status !== 'active') {
        req.session.destroy(() => {});
        return res.status(401).json({ error: 'Not authenticated' });
      }
      req.user = user;
      next();
    })
    .catch(() => res.status(500).json({ error: 'Auth check failed' }));
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// ── Permission middleware ──
function requirePermission(perm) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (req.user.role === 'admin') return next();
      const perms = (req.user.permissions || 'time_ticket').split(',').map(p => p.trim());
      if (!perms.includes(perm)) return res.status(403).json({ error: 'You do not have permission to access this feature' });
      next();
    });
  };
}

// ── Audit logger (fire-and-forget) ──
function logAction(req, action, ticketId = null, ticketNumber = null, details = null) {
  const userName = req.user?.name || 'System';
  const userId   = req.user?.id   || null;
  pool.query(
    'INSERT INTO audit_log (user_id, user_name, action, ticket_id, ticket_number, details, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [userId, userName, action, ticketId, ticketNumber, details, new Date().toISOString()]
  ).catch(err => console.error('Audit log error:', err.message));
}

// ── Password helpers ──
const hashPassword  = (pw)       => bcrypt.hashSync(pw, 12);
const checkPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

// ── Ensure default admin exists ──
async function ensureDefaultAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*) AS c FROM users');
  if (parseInt(rows[0].c) === 0) {
    await pool.query(
      'INSERT INTO users (name, email, password_hash, role, status, permissions, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      ['Admin', 'admin@jdwesternelectric.ca', hashPassword('JDAdmin2026!'), 'admin', 'active', 'time_ticket,get_po,office_dashboard', new Date().toISOString()]
    );
    console.log('\n  ── Default admin created ──');
    console.log('  Email:    admin@jdwesternelectric.ca');
    console.log('  Password: JDAdmin2026!');
    console.log('  Change this after first login!\n');
  }
}

module.exports = { sessionMiddleware, requireAuth, requireAdmin, requirePermission, logAction, hashPassword, checkPassword, ensureDefaultAdmin };
