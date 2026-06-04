const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');

// ── SQLite-backed session store ──
class SQLiteStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data, expires FROM sessions WHERE id = ?').get(sid);
      if (!row) return cb(null, null);
      if (new Date(row.expires) < new Date()) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    const maxAge = sess.cookie?.maxAge || 2592000000; // 30 days
    const expires = new Date(Date.now() + maxAge).toISOString();
    try {
      db.prepare('INSERT OR REPLACE INTO sessions (id, data, expires) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try { db.prepare('DELETE FROM sessions WHERE id = ?').run(sid); cb(null); } catch (e) { cb(e); }
  }
  // Cleanup expired sessions
  cleanup() {
    try { db.prepare('DELETE FROM sessions WHERE expires < ?').run(new Date().toISOString()); } catch {}
  }
}

// ── Session middleware config ──
function sessionMiddleware() {
  const store = new SQLiteStore();
  // Prune expired sessions every hour
  setInterval(() => store.cleanup(), 3600000);
  return session({
    store,
    secret: 'jdw-field-ops-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 }
  });
}

// ── Auth middleware ──
function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT id, name, email, role, status FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.status !== 'active') {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// ── Audit logger ──
function logAction(req, action, ticketId = null, ticketNumber = null, details = null) {
  const userName = req.user?.name || 'System';
  const userId   = req.user?.id   || null;
  db.prepare('INSERT INTO audit_log (user_id, user_name, action, ticket_id, ticket_number, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, userName, action, ticketId, ticketNumber, details, new Date().toISOString());
}

// ── Password helpers ──
const hashPassword   = (pw)       => bcrypt.hashSync(pw, 12);
const checkPassword  = (pw, hash) => bcrypt.compareSync(pw, hash);

// ── Ensure default admin exists on first run ──
function ensureDefaultAdmin() {
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (count === 0) {
    db.prepare('INSERT INTO users (name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('Admin', 'admin@jdwesternelectric.ca', hashPassword('JDAdmin2026!'), 'admin', 'active', new Date().toISOString());
    console.log('\n  ── Default admin created ──');
    console.log('  Email:    admin@jdwesternelectric.ca');
    console.log('  Password: JDAdmin2026!');
    console.log('  Change this after first login!\n');
  }
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

module.exports = { sessionMiddleware, requireAuth, requireAdmin, requirePermission, logAction, hashPassword, checkPassword, ensureDefaultAdmin };
