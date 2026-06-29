require('dotenv').config(); // load .env in development
const express    = require('express');
const path       = require('path');
const crypto     = require('crypto');
const XLSX       = require('xlsx');
const multer     = require('multer');
const nodemailer = require('nodemailer');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { pool, connectWithRetry, initSchema } = require('./db');
const { sessionMiddleware, requireAuth, requireAdmin, requirePermission, logAction, hashPassword, checkPassword, ensureDefaultAdmin } = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Uploads storage ──
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const fs = require('fs');
      fs.mkdirSync(path.join(__dirname,'public','uploads'), {recursive:true});
      cb(null, path.join(__dirname,'public','uploads'));
    },
    filename: (req, file, cb) => { cb(null, file.fieldname + path.extname(file.originalname)); }
  }),
  limits: { fileSize: 5*1024*1024 },
  fileFilter: (req, file, cb) => { cb(null, /image\/(png|jpeg|jpg|gif|webp|svg)/.test(file.mimetype)); }
});

const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const fs = require('fs');
      fs.mkdirSync(path.join(__dirname,'public','uploads','receipts'), {recursive:true});
      cb(null, path.join(__dirname,'public','uploads','receipts'));
    },
    filename: (req, file, cb) => { cb(null, `receipt-${req.params.id}${path.extname(file.originalname).toLowerCase()}`); }
  }),
  limits: { fileSize: 15*1024*1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(png|jpeg|jpg|heic|heif)|application\/pdf/.test(file.mimetype)
             || /\.(png|jpg|jpeg|heic|heif|pdf)$/i.test(file.originalname);
    cb(null, ok);
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(sessionMiddleware());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

// ── Helpers ──
async function getSetting(key, def = null) {
  // Check environment variables first (e.g. SMTP_HOST, SMTP_PORT, etc.)
  const envKey = key.toUpperCase();
  if (process.env[envKey] !== undefined) return process.env[envKey];
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key=$1', [key]);
  return rows[0]?.value ?? def;
}
async function setSetting(key, value) {
  await pool.query('INSERT INTO app_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, value]);
}

function parseEmployeesRaw(raw) {
  if (!raw) return [];
  return raw.split('||').map(e => {
    const parts = e.split(':');
    return {
      name: parts[0],
      regular_hours:  parseFloat(parts[1])||0,
      overtime_hours: parseFloat(parts[2])||0,
      level:          parts[3]||'Journeyman',
      travel_hours:   parseFloat(parts[4])||0,
    };
  });
}
const EMP_SELECT = `e.employee_name||':'||e.regular_hours||':'||e.overtime_hours||':'||COALESCE(e.level,'Journeyman')||':'||COALESCE(e.travel_hours,0)`;

function generateTicketNumber() {
  return `JDW-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(1000+Math.random()*9000)}`;
}

async function generatePONumber(client) {
  const year = new Date().getFullYear();
  await client.query('INSERT INTO po_sequence (year, last_seq) VALUES ($1, 0) ON CONFLICT DO NOTHING', [year]);
  const { rows } = await client.query('UPDATE po_sequence SET last_seq=last_seq+1 WHERE year=$1 RETURNING last_seq', [year]);
  return `JD-PO-${year}-${String(rows[0].last_seq).padStart(4,'0')}`;
}

async function resolveProjectId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = parseInt(raw, 10);
  if (isNaN(id) || id <= 0) return null;
  const { rows } = await pool.query('SELECT id FROM projects WHERE id=$1', [id]);
  return rows.length > 0 ? id : null;
}

function normalizeJobNumbers(raw) {
  if (!raw) return null;
  return raw.split(',').map(s=>s.trim()).filter(Boolean).join(', ') || null;
}

function logPOAction(req, poId, poNumber, action, details = null) {
  pool.query(
    'INSERT INTO po_audit_log (po_id,po_number,user_name,action,details,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [poId, poNumber, req.user?.name||'System', action, details, new Date().toISOString()]
  ).catch(err => console.error('PO audit error:', err.message));
}

// ── Security middleware ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // disabled — inline scripts in HTML files would break
}));

// Rate limit login: max 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit password reset: max 5 requests per hour per IP
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many password reset requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────

app.get('/theme.css', async (req, res) => {
  const color = await getSetting('theme_color', '#F47920');
  res.setHeader('Content-Type','text/css');
  res.setHeader('Cache-Control','no-cache');
  res.send(`:root { --orange: ${color}; --orange-dark: color-mix(in srgb, ${color} 85%, black); --orange-light: color-mix(in srgb, ${color} 15%, white); }`);
});

app.get('/api/settings/public', async (req, res) => {
  res.json({
    theme_color: await getSetting('theme_color','#F47920'),
    logo_path:   await getSetting('logo_path', null),
    home_bg:     await getSetting('home_bg', null),
  });
});

app.get('/api/auth/setup-needed', async (req, res) => {
  const { rows } = await pool.query('SELECT COUNT(*) AS c FROM users');
  res.json({ needed: parseInt(rows[0].c) === 0 });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email)=$1', [email.toLowerCase().trim()]);
  const user = rows[0];
  if (!user || !user.password_hash || !checkPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid email or password' });
  if (user.status !== 'active')
    return res.status(403).json({ error: 'Account is not active. Check your invite email.' });
  req.session.userId = user.id;
  await pool.query('UPDATE users SET last_login=$1 WHERE id=$2', [new Date().toISOString(), user.id]);
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { rows } = await pool.query('SELECT id,name,email,role,status,permissions FROM users WHERE id=$1', [req.session.userId]);
  const user = rows[0];
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'Not authenticated' });
  if (user.role === 'admin') user.permissions = 'time_ticket,get_po,office_dashboard';
  else if (!user.permissions) user.permissions = 'time_ticket';
  res.json(user);
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/invite/:token', async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id,name,email FROM users WHERE invite_token=$1 AND status='invited' AND invite_expires>$2",
    [req.params.token, new Date().toISOString()]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Invalid or expired invite link' });
  res.json(rows[0]);
});

app.post('/api/auth/invite/:token/accept', async (req, res) => {
  const { name, password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const { rows } = await pool.query(
    "SELECT * FROM users WHERE invite_token=$1 AND status='invited' AND invite_expires>$2",
    [req.params.token, new Date().toISOString()]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'Invalid or expired invite link' });
  await pool.query('UPDATE users SET name=$1,password_hash=$2,status=$3,invite_token=NULL,invite_expires=NULL WHERE id=$4',
    [name||user.name, hashPassword(password), 'active', user.id]);
  req.session.userId = user.id;
  await pool.query('UPDATE users SET last_login=$1 WHERE id=$2', [new Date().toISOString(), user.id]);
  res.json({ ok: true, role: user.role });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
  if (!checkPassword(current_password, rows[0].password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
  if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword(new_password), req.user.id]);
  res.json({ ok: true });
});

app.get('/api/auth/reset/:token', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id,name,email FROM users WHERE reset_token=$1 AND reset_token_expires>$2',
    [req.params.token, new Date().toISOString()]
  );
  if (!rows[0]) return res.status(404).json({ error: 'This reset link is invalid or has expired.' });
  res.json(rows[0]);
});

app.post('/api/auth/reset/:token', resetLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE reset_token=$1 AND reset_token_expires>$2',
    [req.params.token, new Date().toISOString()]
  );
  if (!rows[0]) return res.status(404).json({ error: 'This reset link is invalid or has expired.' });
  await pool.query('UPDATE users SET password_hash=$1,status=$2,reset_token=NULL,reset_token_expires=NULL WHERE id=$3',
    [hashPassword(password), 'active', rows[0].id]);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────

// Lightweight team list for safety form worker pickers (any authenticated user)
app.get('/api/team-members', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM users WHERE status='active' ORDER BY name ASC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id,name,email,role,status,permissions,created_at,last_login,time_off_color FROM users ORDER BY created_at DESC');
  res.json(rows.map(u => ({
    ...u,
    permissions: u.role==='admin' ? 'time_ticket,get_po,office_dashboard' : (u.permissions||'time_ticket')
  })));
});

app.post('/api/users/invite', requireAdmin, async (req, res) => {
  const { name, email, role } = req.body;
  if (!name||!email||!role) return res.status(400).json({ error: 'Name, email and role required' });
  const existing = await pool.query('SELECT id FROM users WHERE LOWER(email)=$1', [email.toLowerCase()]);
  if (existing.rows[0]) return res.status(409).json({ error: 'A user with this email already exists' });
  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now()+7*24*3600000).toISOString();
  await pool.query('INSERT INTO users (name,email,role,status,invite_token,invite_expires,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [name, email.toLowerCase(), role, 'invited', token, expires, new Date().toISOString()]);
  const inviteUrl = `${req.protocol}://${req.get('host')}/accept-invite.html?token=${token}`;
  const smtpHost = await getSetting('smtp_host');
  let emailSent = false;
  if (smtpHost) {
    try {
      const t = nodemailer.createTransport({ host: smtpHost, port: parseInt(await getSetting('smtp_port','587')), auth: { user: await getSetting('smtp_user'), pass: await getSetting('smtp_pass') } });
      await t.sendMail({ from: await getSetting('smtp_from','noreply@jdwesternelectric.ca'), to: email, subject: "You've been invited to J&D Western Electric Field Hub",
        html: `<p>Hi ${name},</p><p>You have been invited. <a href="${inviteUrl}">Click here to activate your account</a>. Link expires in 7 days.</p>` });
      emailSent = true;
    } catch (err) { console.error('Invite email failed:', err.message); }
  }
  res.status(201).json({ ok: true, invite_url: inviteUrl, email_sent: emailSent });
});

app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  const { name, role, status } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (parseInt(req.params.id) === req.user.id && status === 'inactive')
    return res.status(400).json({ error: 'Cannot deactivate your own account' });
  if (role && role !== user.role) {
    const { rows: ac } = await pool.query("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND status='active'");
    if (user.role==='admin' && role!=='admin' && parseInt(ac[0].c) <= 1)
      return res.status(400).json({ error: 'Cannot change role — at least one Office Admin must exist at all times.' });
  }
  await pool.query('UPDATE users SET name=COALESCE($1,name),role=COALESCE($2,role),status=COALESCE($3,status) WHERE id=$4',
    [name||null, role||null, status||null, req.params.id]);
  if (role && role !== user.role) {
    const oldLabel = user.role==='admin'?'Office Admin':'Field User';
    const newLabel = role==='admin'?'Office Admin':'Field User';
    logAction(req,'role_changed',null,null,`Role changed from ${oldLabel} to ${newLabel} for ${user.name} by ${req.user.name}`);
    if (role==='admin') await pool.query('UPDATE users SET permissions=$1 WHERE id=$2',['time_ticket,get_po,office_dashboard',req.params.id]);
  }
  res.json({ ok: true });
});

app.patch('/api/users/:id/permissions', requireAdmin, async (req, res) => {
  const { permissions } = req.body;
  if (!Array.isArray(permissions)) return res.status(400).json({ error: 'permissions must be an array' });
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const valid = ['time_ticket','get_po','office_dashboard','timesheet_edit','time_off_approve','receive_emails'];
  if (user.role==='admin' && !permissions.includes('office_dashboard')) {
    const { rows: ac } = await pool.query("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND status='active'");
    if (parseInt(ac[0].c) <= 1) return res.status(400).json({ error: 'Cannot revoke Office Dashboard access — at least one Office Admin must keep this permission.' });
  }
  const cleaned = permissions.filter(p=>valid.includes(p)).join(',');
  await pool.query('UPDATE users SET permissions=$1 WHERE id=$2', [cleaned, req.params.id]);
  logAction(req,'permissions_changed',null,null,`Permissions updated for ${user.name}: ${cleaned||'none'} by ${req.user.name}`);
  res.json({ ok: true, permissions: cleaned });
});

app.patch('/api/users/:id/color', requireAdmin, async (req, res) => {
  try {
    const { color } = req.body;
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'color must be a 6-digit hex (e.g. #93c5fd)' });
    await pool.query('UPDATE users SET time_off_color=$1 WHERE id=$2', [color, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/:id/reset-password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password||password.length<8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const { rows } = await pool.query('SELECT id FROM users WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  await pool.query("UPDATE users SET password_hash=$1,status=CASE WHEN status='invited' THEN 'active' ELSE status END WHERE id=$2",
    [hashPassword(password), req.params.id]);
  res.json({ ok: true });
});

app.post('/api/users/:id/send-reset-link', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id,name,email,status FROM users WHERE id=$1', [req.params.id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now()+24*3600000).toISOString();
  await pool.query('UPDATE users SET reset_token=$1,reset_token_expires=$2 WHERE id=$3', [token, expires, user.id]);
  const resetUrl = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
  const smtpHost = await getSetting('smtp_host');
  let emailSent = false;
  if (smtpHost) {
    try {
      const t = nodemailer.createTransport({ host: smtpHost, port: parseInt(await getSetting('smtp_port','587')), auth:{ user: await getSetting('smtp_user'), pass: await getSetting('smtp_pass') } });
      await t.sendMail({ from: await getSetting('smtp_from','noreply@jdwesternelectric.ca'), to: user.email, subject: 'Reset your J&D Western Electric password',
        html: `<p>Hi ${user.name},</p><p><a href="${resetUrl}">Reset my password</a> — expires in 24 hours.</p>` });
      emailSent = true;
    } catch (err) { console.error('Reset email failed:', err.message); }
  }
  res.json({ ok: true, reset_url: resetUrl, email_sent: emailSent });
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// WORKER CERTIFICATIONS
// ─────────────────────────────────────────────

// Get own certs (any worker) or all certs for a user (admin)
app.get('/api/certifications', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const userId = req.query.user_id && isAdmin ? parseInt(req.query.user_id) : req.user.id;
    const { rows } = await pool.query(
      `SELECT id, user_id, cert_name, cert_type, issued_date, expiry_date, notes, created_at, updated_at
       FROM worker_certifications WHERE user_id=$1 ORDER BY expiry_date ASC NULLS LAST, cert_name ASC`,
      [userId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: get all workers' certs with user info + expiry status
app.get('/api/certifications/all', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT wc.id, wc.user_id, u.name AS user_name, wc.cert_name, wc.cert_type,
              wc.issued_date, wc.expiry_date, wc.notes, wc.created_at
       FROM worker_certifications wc
       JOIN users u ON u.id = wc.user_id
       WHERE u.status != 'deleted'
       ORDER BY wc.expiry_date ASC NULLS LAST, u.name ASC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get cert photo
app.get('/api/certifications/:id/photo', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT wc.photo_data, wc.photo_type, wc.user_id FROM worker_certifications wc WHERE wc.id=$1`,
      [parseInt(req.params.id)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && rows[0].user_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });
    const base64 = (rows[0].photo_data || '').split(',')[1] || rows[0].photo_data;
    res.set('Content-Type', rows[0].photo_type || 'image/jpeg');
    res.send(Buffer.from(base64, 'base64'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add cert (own)
app.post('/api/certifications', requireAuth, async (req, res) => {
  try {
    const { cert_name, cert_type, issued_date, expiry_date, photo_data, photo_type, notes } = req.body;
    if (!cert_name) return res.status(400).json({ error: 'cert_name required' });
    const now = new Date().toISOString();
    const { rows } = await pool.query(
      `INSERT INTO worker_certifications (user_id, cert_name, cert_type, issued_date, expiry_date, photo_data, photo_type, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, cert_name, cert_type, issued_date, expiry_date, notes, created_at`,
      [req.user.id, cert_name, cert_type || 'other', issued_date || null, expiry_date || null,
       photo_data || null, photo_type || null, notes || null, now]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update cert (own or admin)
app.patch('/api/certifications/:id', requireAuth, async (req, res) => {
  try {
    const { rows: existing } = await pool.query('SELECT user_id FROM worker_certifications WHERE id=$1', [parseInt(req.params.id)]);
    if (!existing[0]) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && existing[0].user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    const { cert_name, cert_type, issued_date, expiry_date, photo_data, photo_type, notes } = req.body;
    await pool.query(
      `UPDATE worker_certifications SET cert_name=COALESCE($1,cert_name), cert_type=COALESCE($2,cert_type),
       issued_date=$3, expiry_date=$4, notes=$5, photo_data=COALESCE($6,photo_data),
       photo_type=COALESCE($7,photo_type), updated_at=$8 WHERE id=$9`,
      [cert_name || null, cert_type || null, issued_date || null, expiry_date || null,
       notes || null, photo_data || null, photo_type || null, new Date().toISOString(), parseInt(req.params.id)]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete cert (own or admin)
app.delete('/api/certifications/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT user_id FROM worker_certifications WHERE id=$1', [parseInt(req.params.id)]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM worker_certifications WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────

app.get('/api/settings', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT key,value FROM app_settings');
  const s = {};
  rows.forEach(r => s[r.key]=r.value);
  if (s.smtp_pass) s.smtp_pass='••••••••';
  res.json(s);
});

app.post('/api/settings', requireAdmin, async (req, res) => {
  const allowed = ['theme_color','smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from'];
  for (const [key,val] of Object.entries(req.body)) {
    if (allowed.includes(key) && val !== '••••••••') await setSetting(key, val);
  }
  res.json({ ok: true });
});

app.post('/api/settings/logo', requireAdmin, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  await setSetting('logo_path', '/uploads/'+req.file.filename);
  res.json({ ok: true, path: '/uploads/'+req.file.filename });
});

app.post('/api/settings/home-bg', requireAdmin, upload.single('home_bg'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  await setSetting('home_bg', '/uploads/'+req.file.filename);
  res.json({ ok: true, path: '/uploads/'+req.file.filename });
});

app.delete('/api/settings/home-bg', requireAdmin, async (req, res) => {
  await setSetting('home_bg', null);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────

app.get('/api/tickets/:id/audit', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT user_name,action,details,created_at FROM audit_log WHERE ticket_id=$1 ORDER BY created_at ASC', [req.params.id]);
  res.json(rows);
});

// ─────────────────────────────────────────────
// DASHBOARD OVERVIEW
// ─────────────────────────────────────────────

app.get('/api/dashboard/overview', requireAdmin, async (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate()-weekStart.getDay());
  const ws = weekStart.toISOString().slice(0,10);

  const [ttToday,ttWeek,ttPending,ttReviewed,ttEntered,projActive,projOut,projOutRec,projDone,posOpen,posEntWk,posReimb,toPending,toUpcoming,toToday,activity] = await Promise.all([
    pool.query("SELECT COUNT(*) c FROM daily_tickets WHERE date=$1 AND archived=0",[today]),
    pool.query("SELECT COUNT(*) c FROM daily_tickets WHERE date>=$1 AND archived=0",[ws]),
    pool.query("SELECT COUNT(*) c FROM daily_tickets WHERE (ticket_status='Pending' OR ticket_status IS NULL) AND archived=0"),
    pool.query("SELECT COUNT(*) c FROM daily_tickets WHERE ticket_status='Reviewed' AND archived=0"),
    pool.query("SELECT COUNT(*) c FROM daily_tickets WHERE ticket_status='Entered' AND archived=0"),
    pool.query("SELECT COUNT(*) c FROM projects WHERE status='active'"),
    pool.query(`SELECT COUNT(*) c FROM projects p WHERE p.status='active' AND (
      (SELECT COUNT(*) FROM daily_tickets t WHERE t.project_id=p.id AND (t.ticket_status='Pending' OR t.ticket_status IS NULL OR t.ticket_status='Reviewed') AND (t.project_archived=0 OR t.project_archived IS NULL))
     +(SELECT COUNT(*) FROM purchase_orders o WHERE o.project_id=p.id AND o.status='Open' AND (o.project_archived=0 OR o.project_archived IS NULL))
    )>0`),
    pool.query(`SELECT (
      (SELECT COUNT(*) FROM daily_tickets t JOIN projects p ON p.id=t.project_id WHERE p.status='active' AND (t.ticket_status='Pending' OR t.ticket_status IS NULL OR t.ticket_status='Reviewed') AND (t.project_archived=0 OR t.project_archived IS NULL))
     +(SELECT COUNT(*) FROM purchase_orders o JOIN projects p ON p.id=o.project_id WHERE p.status='active' AND o.status='Open' AND (o.project_archived=0 OR o.project_archived IS NULL))
    ) AS c`),
    pool.query("SELECT COUNT(*) c FROM projects WHERE status IN ('complete','archived')"),
    pool.query("SELECT COUNT(*) c FROM purchase_orders WHERE status='Open'"),
    pool.query("SELECT COUNT(*) c FROM purchase_orders WHERE status='Entered' AND updated_at>=$1",[ws+'T00:00:00']),
    pool.query("SELECT COUNT(*) c FROM purchase_orders WHERE needs_reimbursement=1 AND status='Open'"),
    pool.query("SELECT COUNT(*) c FROM time_off_requests WHERE status='pending'"),
    pool.query("SELECT COUNT(*) c FROM time_off_requests WHERE status='approved' AND end_date >= $1",[today]),
    pool.query("SELECT COUNT(*) c FROM time_off_requests WHERE status='approved' AND start_date <= $1 AND end_date >= $1",[today]),
    pool.query(`(SELECT 'ticket' src,user_name,action,ticket_number ref,details,created_at FROM audit_log)
                UNION ALL
                (SELECT 'po' src,user_name,action,po_number ref,details,created_at FROM po_audit_log)
                ORDER BY created_at DESC LIMIT 15`),
  ]);

  res.json({
    tickets: { today: parseInt(ttToday.rows[0].c), week: parseInt(ttWeek.rows[0].c), pending: parseInt(ttPending.rows[0].c), reviewed: parseInt(ttReviewed.rows[0].c), entered: parseInt(ttEntered.rows[0].c) },
    projects: { active: parseInt(projActive.rows[0].c), outstanding: parseInt(projOut.rows[0].c), outstanding_records: parseInt(projOutRec.rows[0].c), done: parseInt(projDone.rows[0].c) },
    pos: { open: parseInt(posOpen.rows[0].c), entered_week: parseInt(posEntWk.rows[0].c), reimbursement: parseInt(posReimb.rows[0].c) },
    time_off: { pending: parseInt(toPending.rows[0].c), upcoming: parseInt(toUpcoming.rows[0].c), today: parseInt(toToday.rows[0].c) },
    activity: activity.rows,
  });
});

// ─────────────────────────────────────────────
// TICKETS
// ─────────────────────────────────────────────

app.post('/api/tickets', requireAuth, async (req, res) => {
  const { date, job_name, job_number, supervisor, work_description, equipment_used, notes, employees, project_id,
          ot_approved, ot_approved_by, submitted_with_duplicate, vendor_signoff } = req.body;
  if (!date||!job_name||!supervisor||!work_description) return res.status(400).json({ error: 'Missing required fields' });
  if (!employees?.length) return res.status(400).json({ error: 'At least one employee required' });
  const ticket_number = generateTicketNumber();
  const submitted_at  = new Date().toISOString();
  const resolvedPid   = await resolveProjectId(project_id);
  // Determine OT approval value
  const hasOT = employees.some(e => parseFloat(e.overtime_hours) > 0);
  const otApprovedVal  = hasOT ? (ot_approved ? 1 : 0)   : null;
  const otApprovedBy   = hasOT ? (ot_approved_by || null) : null;
  const otApprovalTs   = hasOT ? submitted_at              : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO daily_tickets (ticket_number,date,job_name,job_number,supervisor,work_description,equipment_used,notes,submitted_at,project_id,submitted_by_name,submitted_by_id,ot_approved,ot_approved_by,ot_approval_ts,vendor_signoff)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [ticket_number,date,job_name,job_number||null,supervisor,work_description,equipment_used||null,notes||null,submitted_at,resolvedPid,req.user?.name||null,req.user?.id||null,otApprovedVal,otApprovedBy,otApprovalTs,
       vendor_signoff ? JSON.stringify(vendor_signoff) : null]
    );
    const tid = rows[0].id;
    for (const e of employees) {
      if (e.name?.trim()) await client.query(
        'INSERT INTO ticket_employees (ticket_id,employee_name,regular_hours,overtime_hours,level,user_id,travel_hours) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [tid, e.name.trim(), parseFloat(e.regular_hours)||0, parseFloat(e.overtime_hours)||0, e.level||'Journeyman', e.user_id||null, parseFloat(e.travel_hours)||0]
      );
    }
    // ── Duplicate detection ──
    const empNames = employees.map(e => e.name?.trim()).filter(Boolean);
    if (empNames.length > 0) {
      const { rows: dupRows } = await client.query(`
        SELECT DISTINCT t.id FROM ticket_employees te
        JOIN daily_tickets t ON t.id = te.ticket_id
        WHERE t.date=$1 AND te.employee_name=ANY($2) AND COALESCE(t.archived,0)=0 AND t.id!=$3
      `, [date, empNames, tid]);
      if (dupRows.length > 0) {
        const conflictIds = dupRows.map(r => r.id);
        await client.query('UPDATE daily_tickets SET has_duplicate=1, duplicate_ticket_ids=$1 WHERE id=$2',
          [conflictIds.join(','), tid]);
        for (const cid of conflictIds) {
          await client.query(`UPDATE daily_tickets SET has_duplicate=1,
            duplicate_ticket_ids = CASE WHEN duplicate_ticket_ids IS NULL OR duplicate_ticket_ids=''
              THEN $1::text ELSE duplicate_ticket_ids||','||$1::text END WHERE id=$2`,
            [tid.toString(), cid]);
        }
      }
    }
    await client.query('COMMIT');
    logAction(req,'ticket_submitted',tid,ticket_number,
      `Submitted by ${req.user.name}${hasOT ? ` | OT: ${ot_approved?'approved':'UNAPPROVED'}${otApprovedBy?` by ${otApprovedBy}`:''}` : ''}${submitted_with_duplicate?' | submitted with duplicate warning':''}`);
    res.status(201).json({ id: tid, ticket_number, message: 'Ticket submitted successfully' });
  } catch (err) { await client.query('ROLLBACK'); console.error(err); res.status(500).json({ error: 'Failed to save ticket' }); }
  finally { client.release(); }
});

app.get('/api/tickets', requireAuth, async (req, res) => {
  const { job, date_from, date_to, supervisor, search, limit=50, offset=0, archived='0' } = req.query;
  const params = [archived==='1'?1:0];
  let where = ['t.archived=$1']; let p=1;
  if (job)        { p++; where.push(`(LOWER(t.job_name) LIKE $${p} OR LOWER(t.job_number) LIKE $${p})`); params.push(`%${job.toLowerCase()}%`); }
  if (date_from)  { p++; where.push(`t.date>=$${p}`); params.push(date_from); }
  if (date_to)    { p++; where.push(`t.date<=$${p}`); params.push(date_to); }
  if (supervisor) { p++; where.push(`LOWER(t.supervisor) LIKE $${p}`); params.push(`%${supervisor.toLowerCase()}%`); }
  if (search) {
    p++;
    where.push(`(LOWER(t.job_name) LIKE $${p} OR LOWER(t.supervisor) LIKE $${p} OR LOWER(t.ticket_number) LIKE $${p} OR LOWER(t.work_description) LIKE $${p})`);
    params.push(`%${search.toLowerCase()}%`);
  }
  const wc = `WHERE ${where.join(' AND ')}`;
  const { rows: countRows } = await pool.query(`SELECT COUNT(*) AS total FROM daily_tickets t ${wc}`, params);
  p++; params.push(parseInt(limit)); p++; params.push(parseInt(offset));
  const { rows } = await pool.query(
    `SELECT t.*, p.name AS project_name,
      STRING_AGG(${EMP_SELECT},'||' ORDER BY e.id) AS employees_raw
     FROM daily_tickets t
     LEFT JOIN ticket_employees e ON e.ticket_id=t.id
     LEFT JOIN projects p ON p.id=t.project_id
     ${wc} GROUP BY t.id, p.name ORDER BY t.date DESC, t.submitted_at DESC LIMIT $${p-1} OFFSET $${p}`, params);
  res.json({ total: parseInt(countRows[0].total), tickets: rows.map(t=>({...t, employees: parseEmployeesRaw(t.employees_raw), employees_raw: undefined})) });
});

app.get('/api/tickets/export/xlsx', requireAuth, async (req, res) => {
  const { ids, filename } = req.query;
  if (!ids) return res.status(400).json({ error: 'ids required' });
  const idList = ids.split(',').map(Number).filter(n=>!isNaN(n)&&n>0);
  if (!idList.length) return res.status(400).json({ error: 'no valid ids' });
  const { rows } = await pool.query(
    `SELECT t.*, STRING_AGG(${EMP_SELECT},'||' ORDER BY e.id) AS employees_raw
     FROM daily_tickets t LEFT JOIN ticket_employees e ON e.ticket_id=t.id
     WHERE t.id = ANY($1) GROUP BY t.id ORDER BY t.date DESC`,
    [idList]
  );
  const exportDate = new Date().toISOString().slice(0,10);
  const xlsxRows = [['J&D Western Electric Ltd — Time Tickets Export'],[`Exported: ${exportDate}`],[],
    ['Ticket #','Date','Job Name','Job #','Supervisor','Employee','Level','Reg Hrs','OT Hrs','Total Hrs','Work Description','Equipment','Notes','Status']];
  for (const t of rows) {
    for (const e of parseEmployeesRaw(t.employees_raw)) {
      xlsxRows.push([t.ticket_number,t.date,t.job_name,t.job_number||'',t.supervisor,e.name,e.level||'',e.regular_hours,e.overtime_hours,e.regular_hours+e.overtime_hours,t.work_description,t.equipment_used||'',t.notes||'',t.ticket_status||'Pending']);
    }
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(xlsxRows);
  XLSX.utils.book_append_sheet(wb, ws, 'Time Tickets');
  const safeName = filename ? decodeURIComponent(filename) : `JD-Tickets-${exportDate}.xlsx`;
  const buf = XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${safeName}"`);
  res.send(buf);
});

// ── Check for duplicate employee entries on the same date ──
app.get('/api/tickets/check-duplicates', requireAuth, async (req, res) => {
  try {
    const { date, names } = req.query;
    if (!date || !names) return res.json({ duplicates: [] });
    const nameList = names.split(',').map(n => n.trim()).filter(Boolean);
    if (!nameList.length) return res.json({ duplicates: [] });
    const { rows } = await pool.query(`
      SELECT te.employee_name, t.id, t.ticket_number, t.job_name
      FROM ticket_employees te
      JOIN daily_tickets t ON t.id = te.ticket_id
      WHERE t.date = $1 AND te.employee_name = ANY($2) AND COALESCE(t.archived, 0) = 0
      ORDER BY t.submitted_at
    `, [date, nameList]);
    res.json({ duplicates: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: update OT approval on a ticket ──
app.patch('/api/tickets/:id/ot-approval', requireAdmin, async (req, res) => {
  try {
    const { ot_approved, ot_approved_by } = req.body;
    if (ot_approved === undefined) return res.status(400).json({ error: 'ot_approved required' });
    const ts = new Date().toISOString();
    await pool.query(
      'UPDATE daily_tickets SET ot_approved=$1, ot_approved_by=$2, ot_approval_ts=$3 WHERE id=$4',
      [ot_approved ? 1 : 0, ot_approved_by || req.user.name, ts, req.params.id]
    );
    logAction(req, 'ot_approval_updated', parseInt(req.params.id), null,
      `OT ${ot_approved ? 'approved' : 'marked unapproved'} by ${req.user.name}${ot_approved_by ? ` — approver: ${ot_approved_by}` : ''}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tickets/my-today', requireAuth, async (req, res) => {
  const today = new Date().toLocaleDateString('en-CA');
  const { rows } = await pool.query(`
    SELECT t.id, t.ticket_number, t.job_name, t.job_number, t.date, t.ticket_status, t.submitted_at,
           COALESCE(SUM(te.regular_hours),0)  AS total_reg,
           COALESCE(SUM(te.overtime_hours),0) AS total_ot
    FROM daily_tickets t
    LEFT JOIN ticket_employees te ON te.ticket_id = t.id
    WHERE t.submitted_by_id = $1
      AND COALESCE(t.archived,0) = 0
      AND t.ticket_status NOT IN ('Reviewed','Entered')
    GROUP BY t.id
    ORDER BY t.submitted_at DESC
  `, [req.user.id]);
  const editable = rows.filter(r => new Date(r.submitted_at).toLocaleDateString('en-CA') === today);
  res.json(editable);
});

app.get('/api/tickets/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM daily_tickets WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Ticket not found' });
  const { rows: emps } = await pool.query(`SELECT employee_name,regular_hours,overtime_hours,COALESCE(level,'Journeyman') AS level,COALESCE(travel_hours,0) AS travel_hours FROM ticket_employees WHERE ticket_id=$1`, [req.params.id]);
  logAction(req,'ticket_viewed',rows[0].id,rows[0].ticket_number);
  res.json({ ...rows[0], employees: emps });
});

app.put('/api/tickets/:id', requireAdmin, async (req, res) => {
  const { date,job_name,job_number,supervisor,work_description,equipment_used,notes,employees,project_id,ticket_status } = req.body;
  const { rows } = await pool.query('SELECT * FROM daily_tickets WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Ticket not found' });
  const t = rows[0];
  const resolvedPid    = project_id !== undefined ? await resolveProjectId(project_id) : t.project_id;
  const resolvedStatus = ['Pending','Reviewed','Entered'].includes(ticket_status) ? ticket_status : t.ticket_status;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE daily_tickets SET date=$1,job_name=$2,job_number=$3,supervisor=$4,work_description=$5,equipment_used=$6,notes=$7,updated_at=$8,project_id=$9,ticket_status=$10 WHERE id=$11`,
      [date,job_name,job_number||null,supervisor,work_description,equipment_used||null,notes||null,new Date().toISOString(),resolvedPid,resolvedStatus,req.params.id]);
    await client.query('DELETE FROM ticket_employees WHERE ticket_id=$1',[req.params.id]);
    for (const e of employees) {
      if (e.name?.trim()) await client.query('INSERT INTO ticket_employees (ticket_id,employee_name,regular_hours,overtime_hours,level,user_id,travel_hours) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [req.params.id,e.name.trim(),parseFloat(e.regular_hours)||0,parseFloat(e.overtime_hours)||0,e.level||'Journeyman',e.user_id||null,parseFloat(e.travel_hours)||0]);
    }
    await client.query('COMMIT');
    logAction(req,'ticket_updated',t.id,t.ticket_number,`Edited by ${req.user?.name}`);
    res.json({ message: 'Updated' });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Failed to update' }); }
  finally { client.release(); }
});

// Self-edit: original submitter can edit their own ticket on the same calendar day,
// as long as the office hasn't reviewed or entered it yet.
app.patch('/api/tickets/:id/self-edit', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM daily_tickets WHERE id=$1', [parseInt(req.params.id)]);
  const t = rows[0];
  if (!t) return res.status(404).json({ error: 'Ticket not found' });

  // Must be the original submitter
  if (String(t.submitted_by_id) !== String(req.user.id))
    return res.status(403).json({ error: 'You can only edit tickets you submitted.' });

  // Must still be the same calendar day (server local time)
  const submittedDay = new Date(t.submitted_at).toLocaleDateString('en-CA'); // YYYY-MM-DD
  const todayDay     = new Date().toLocaleDateString('en-CA');
  if (submittedDay !== todayDay)
    return res.status(403).json({ error: 'The edit window has closed — tickets can only be edited on the day they were submitted.' });

  // Office must not have reviewed or entered it yet
  if (t.ticket_status === 'Reviewed' || t.ticket_status === 'Entered')
    return res.status(403).json({ error: 'This ticket has already been reviewed by the office and can no longer be edited.' });

  const { date, job_name, job_number, supervisor, work_description, equipment_used, notes, employees, project_id, vendor_signoff } = req.body;
  if (!date||!job_name||!supervisor||!work_description) return res.status(400).json({ error: 'Missing required fields' });
  if (!employees?.length) return res.status(400).json({ error: 'At least one employee required' });

  const resolvedPid = await resolveProjectId(project_id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE daily_tickets SET date=$1,job_name=$2,job_number=$3,supervisor=$4,work_description=$5,
       equipment_used=$6,notes=$7,updated_at=$8,project_id=$9,vendor_signoff=$10 WHERE id=$11`,
      [date,job_name,job_number||null,supervisor,work_description,equipment_used||null,notes||null,
       new Date().toISOString(),resolvedPid,vendor_signoff?JSON.stringify(vendor_signoff):null,t.id]
    );
    await client.query('DELETE FROM ticket_employees WHERE ticket_id=$1', [t.id]);
    for (const e of employees) {
      if (e.name?.trim()) await client.query(
        'INSERT INTO ticket_employees (ticket_id,employee_name,regular_hours,overtime_hours,level,user_id,travel_hours) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [t.id,e.name.trim(),parseFloat(e.regular_hours)||0,parseFloat(e.overtime_hours)||0,e.level||'Journeyman',e.user_id||null,parseFloat(e.travel_hours)||0]
      );
    }
    await client.query('COMMIT');
    logAction(req,'ticket_self_edited',t.id,t.ticket_number,`Self-edited by ${req.user?.name}`);
    res.json({ ok: true, ticket_number: t.ticket_number });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Failed to update ticket' }); }
  finally { client.release(); }
});

app.patch('/api/tickets/:id/status', requireAdmin, async (req, res) => {
  const { ticket_status } = req.body;
  if (!['Pending','Reviewed','Entered'].includes(ticket_status)) return res.status(400).json({ error: 'Invalid status' });
  const { rows } = await pool.query('SELECT * FROM daily_tickets WHERE id=$1', [req.params.id]);
  const t = rows[0];
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  const now = new Date().toISOString();
  const autoArchive = ticket_status==='Entered' && !t.archived;
  const autoProjectArchive = ticket_status==='Entered' && t.project_id && !t.project_archived;
  if (autoArchive) {
    await pool.query('UPDATE daily_tickets SET ticket_status=$1,archived=1,archived_at=$2 WHERE id=$3',[ticket_status,now,req.params.id]);
    logAction(req,'ticket_archived',t.id,t.ticket_number,`Auto-archived upon status change to Entered by ${req.user?.name}`);
  } else {
    await pool.query('UPDATE daily_tickets SET ticket_status=$1 WHERE id=$2',[ticket_status,req.params.id]);
  }
  if (autoProjectArchive) {
    await pool.query('UPDATE daily_tickets SET project_archived=1 WHERE id=$1',[req.params.id]);
    logAction(req,'ticket_project_archived',t.id,t.ticket_number,`Auto-archived within project upon status change to Entered by ${req.user?.name}`);
  }
  logAction(req,'ticket_status_changed',t.id,t.ticket_number,`Status: ${t.ticket_status||'Pending'} → ${ticket_status}`);
  res.json({ ok: true, auto_archived: autoArchive, auto_project_archived: autoProjectArchive });
});

app.patch('/api/tickets/:id/archive', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM daily_tickets WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await pool.query('UPDATE daily_tickets SET archived=1,archived_at=$1 WHERE id=$2',[new Date().toISOString(),req.params.id]);
  logAction(req,'ticket_archived',rows[0].id,rows[0].ticket_number);
  res.json({ message: 'Archived' });
});

app.patch('/api/tickets/:id/unarchive', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM daily_tickets WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await pool.query('UPDATE daily_tickets SET archived=0,archived_at=NULL WHERE id=$1',[req.params.id]);
  logAction(req,'ticket_unarchived',rows[0].id,rows[0].ticket_number);
  res.json({ message: 'Unarchived' });
});

app.patch('/api/tickets/:id/project-archive', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM daily_tickets WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await pool.query('UPDATE daily_tickets SET project_archived=1 WHERE id=$1',[req.params.id]);
  logAction(req,'ticket_project_archived',rows[0].id,rows[0].ticket_number);
  res.json({ ok: true });
});

app.patch('/api/tickets/:id/project-unarchive', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM daily_tickets WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await pool.query('UPDATE daily_tickets SET project_archived=0 WHERE id=$1',[req.params.id]);
  logAction(req,'ticket_project_unarchived',rows[0].id,rows[0].ticket_number);
  res.json({ ok: true });
});

app.delete('/api/tickets/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM daily_tickets WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  if (!rows[0].archived) return res.status(400).json({ error: 'A ticket must be archived before it can be permanently deleted.' });
  logAction(req,'ticket_deleted',rows[0].id,rows[0].ticket_number,`Permanently deleted by ${req.user?.name}`);
  await pool.query('DELETE FROM daily_tickets WHERE id=$1',[req.params.id]);
  res.json({ message: 'Deleted' });
});

app.get('/api/tickets/:id/export/xlsx', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM daily_tickets WHERE id=$1',[req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  const { rows: emps } = await pool.query(`SELECT employee_name,regular_hours,overtime_hours,COALESCE(level,'Journeyman') AS level,COALESCE(travel_hours,0) AS travel_hours FROM ticket_employees WHERE ticket_id=$1`,[req.params.id]);
  const t = rows[0];
  const totalReg=emps.reduce((s,e)=>s+e.regular_hours,0), totalOT=emps.reduce((s,e)=>s+e.overtime_hours,0);
  const xlsxRows=[['J&D Western Electric Ltd — Daily Time Ticket'],[],['Ticket #',t.ticket_number],['Date',t.date],['Job Name',t.job_name],['Job #',t.job_number||''],['Supervisor',t.supervisor],['Submitted',t.submitted_at],[],
    ['Employee','Level','Regular Hrs','OT Hrs','Total Hrs'],
    ...emps.map(e=>[e.employee_name,e.level,e.regular_hours,e.overtime_hours,e.regular_hours+e.overtime_hours]),
    ['TOTAL','',totalReg,totalOT,totalReg+totalOT],[],['Work Description',t.work_description],['Equipment',t.equipment_used||''],['Notes',t.notes||'']];
  const wb=XLSX.utils.book_new(); const ws=XLSX.utils.aoa_to_sheet(xlsxRows);
  ws['!cols']=[{wch:18},{wch:22},{wch:14},{wch:10},{wch:10}];
  XLSX.utils.book_append_sheet(wb,ws,'Time Ticket');
  logAction(req,'ticket_exported',t.id,t.ticket_number,'XLSX export');
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${t.ticket_number}.xlsx"`);
  res.send(buf);
});

// ─────────────────────────────────────────────
// STATS & CSV
// ─────────────────────────────────────────────

app.get('/api/stats', requireAuth, async (req, res) => {
  const today=new Date().toISOString().slice(0,10);
  const weekStart=new Date(); weekStart.setDate(weekStart.getDate()-weekStart.getDay());
  const ws=weekStart.toISOString().slice(0,10);
  const [t,a,td,wk,j] = await Promise.all([
    pool.query("SELECT COUNT(*) c FROM daily_tickets WHERE archived=0"),
    pool.query("SELECT COUNT(*) c FROM daily_tickets WHERE archived=1"),
    pool.query("SELECT COUNT(*) c FROM daily_tickets WHERE date=$1 AND archived=0",[today]),
    pool.query("SELECT COUNT(*) c FROM daily_tickets WHERE date>=$1 AND archived=0",[ws]),
    pool.query("SELECT COUNT(DISTINCT job_name) c FROM daily_tickets WHERE archived=0"),
  ]);
  res.json({ total:parseInt(t.rows[0].c), archived:parseInt(a.rows[0].c), today:parseInt(td.rows[0].c), this_week:parseInt(wk.rows[0].c), active_jobs:parseInt(j.rows[0].c) });
});

app.get('/api/export/csv', requireAuth, async (req, res) => {
  const { date_from, date_to, job } = req.query;
  const params = [0]; let where=['t.archived=$1']; let p=1;
  if (date_from) { p++; where.push(`t.date>=$${p}`); params.push(date_from); }
  if (date_to)   { p++; where.push(`t.date<=$${p}`); params.push(date_to); }
  if (job)       { p++; where.push(`(LOWER(t.job_name) LIKE $${p} OR LOWER(t.job_number) LIKE $${p})`); params.push(`%${job.toLowerCase()}%`); }
  const { rows } = await pool.query(
    `SELECT t.ticket_number,t.date,t.job_name,t.job_number,t.supervisor,e.employee_name,COALESCE(e.level,'Journeyman') AS level,e.regular_hours,e.overtime_hours,t.work_description,t.equipment_used,t.notes,t.submitted_at
     FROM daily_tickets t LEFT JOIN ticket_employees e ON e.ticket_id=t.id WHERE ${where.join(' AND ')} ORDER BY t.date DESC,t.id`, params);
  const h=['Ticket #','Date','Job Name','Job #','Supervisor','Employee','Level','Regular Hrs','OT Hrs','Work Description','Equipment','Notes','Submitted At'];
  const csv=[h.join(','),...rows.map(r=>[r.ticket_number,r.date,`"${(r.job_name||'').replace(/"/g,'""')}"`,r.job_number||'',`"${(r.supervisor||'').replace(/"/g,'""')}"`,`"${(r.employee_name||'').replace(/"/g,'""')}"`,`"${(r.level||'').replace(/"/g,'""')}"`,r.regular_hours,r.overtime_hours,`"${(r.work_description||'').replace(/"/g,'""')}"`,`"${(r.equipment_used||'').replace(/"/g,'""')}"`,`"${(r.notes||'').replace(/"/g,'""')}"`,r.submitted_at].join(','))].join('\n');
  logAction(req,'csv_exported',null,null,'CSV export');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="jdw-tickets-${Date.now()}.csv"`);
  res.send(csv);
});

// ─────────────────────────────────────────────
// PURCHASE ORDERS
// ─────────────────────────────────────────────

app.post('/api/po/:id/receipt', requirePermission('get_po'), receiptUpload.single('receipt'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { rows } = await pool.query('SELECT id FROM purchase_orders WHERE id=$1',[req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'PO not found' });
  const p = `/uploads/receipts/receipt-${req.params.id}${path.extname(req.file.originalname).toLowerCase()}`;
  await pool.query('UPDATE purchase_orders SET receipt_path=$1 WHERE id=$2',[p,req.params.id]);
  res.json({ ok: true, path: p });
});

app.post('/api/po', requirePermission('get_po'), async (req, res) => {
  const { jobber_job_number, job_name, supplier, description, estimated_amount, needs_reimbursement, project_id } = req.body;
  if (!jobber_job_number?.trim()||!description?.trim()||!job_name?.trim()) return res.status(400).json({ error: 'Jobber Job Number, Job Name, and Description are required' });
  const resolvedPid = await resolveProjectId(project_id);
  const date=new Date().toISOString().slice(0,10), created_at=new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const po_number = await generatePONumber(client);
    const { rows } = await client.query(
      `INSERT INTO purchase_orders (po_number,date,generated_by_id,generated_by_name,jobber_job_number,job_name,supplier,description,estimated_amount,needs_reimbursement,status,created_at,project_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Open',$11,$12) RETURNING id`,
      [po_number,date,req.user.id,req.user.name,jobber_job_number.trim(),job_name.trim(),supplier?.trim()||null,description.trim(),estimated_amount?parseFloat(estimated_amount):null,needs_reimbursement?1:0,created_at,resolvedPid]
    );
    const poId = rows[0].id;
    await client.query('COMMIT');
    logPOAction(req,poId,po_number,'po_created',`Created by ${req.user.name}`);
    // Notify admins
    const smtpHost = await getSetting('smtp_host');
    if (smtpHost) {
      try {
        const { rows: admins } = await pool.query("SELECT email, permissions FROM users WHERE status='active'");
        const to = admins.filter(u => (u.permissions||'').split(',').includes('receive_emails')).map(u=>u.email).join(',');
        if (to) {
          const t = nodemailer.createTransport({ host: smtpHost, port: parseInt(await getSetting('smtp_port','587')), auth:{ user: await getSetting('smtp_user'), pass: await getSetting('smtp_pass') } });
          await t.sendMail({ from: await getSetting('smtp_from','noreply@jdwesternelectric.ca'), to, subject: `New PO Generated: ${po_number}`,
            html: `<h2>New PO — ${po_number}</h2><p>Job: ${job_name} | Jobber #: ${jobber_job_number} | Supplier: ${supplier||'—'} | By: ${req.user.name}</p>` });
        }
      } catch (err) { console.error('PO notify failed:', err.message); }
    }
    res.status(201).json({ po_number, id: poId });
  } catch (err) { await client.query('ROLLBACK'); console.error(err); res.status(500).json({ error: 'Failed to create PO' }); }
  finally { client.release(); }
});

app.get('/api/po', requireAdmin, async (req, res) => {
  const { status, date_from, date_to, employee, job_name, reimbursement, limit=200, offset=0, ids } = req.query;
  const params = []; let where = []; let p = 0;
  if (ids) {
    const idList = ids.split(',').map(Number).filter(n=>!isNaN(n)&&n>0);
    if (idList.length) { p++; where.push(`id = ANY($${p})`); params.push(idList); }
  } else {
    if (status)        { p++; where.push(`status=$${p}`); params.push(status); }
    if (date_from)     { p++; where.push(`date>=$${p}`); params.push(date_from); }
    if (date_to)       { p++; where.push(`date<=$${p}`); params.push(date_to); }
    if (employee)      { p++; where.push(`LOWER(generated_by_name) LIKE $${p}`); params.push(`%${employee.toLowerCase()}%`); }
    if (job_name)      { p++; where.push(`LOWER(COALESCE(job_name,'')) LIKE $${p}`); params.push(`%${job_name.toLowerCase()}%`); }
    if (reimbursement==='1') { where.push('needs_reimbursement=1'); }
  }
  const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: cnt } = await pool.query(`SELECT COUNT(*) AS total FROM purchase_orders ${wc}`, params);
  p++; params.push(parseInt(limit)); p++; params.push(parseInt(offset));
  const { rows } = await pool.query(`SELECT * FROM purchase_orders ${wc} ORDER BY created_at DESC LIMIT $${p-1} OFFSET $${p}`, params);
  res.json({ total: parseInt(cnt[0].total), purchase_orders: rows });
});

app.get('/api/po/export/xlsx', requireAdmin, async (req, res) => {
  const { status, date_from, date_to, employee, job_name, reimbursement, ids } = req.query;
  const params = []; let where = []; let p = 0;
  if (ids) {
    const idList = ids.split(',').map(Number).filter(n=>!isNaN(n)&&n>0);
    if (idList.length) { p++; where.push(`id = ANY($${p})`); params.push(idList); }
  } else {
    if (status)        { p++; where.push(`status=$${p}`); params.push(status); }
    if (date_from)     { p++; where.push(`date>=$${p}`); params.push(date_from); }
    if (date_to)       { p++; where.push(`date<=$${p}`); params.push(date_to); }
    if (employee)      { p++; where.push(`LOWER(generated_by_name) LIKE $${p}`); params.push(`%${employee.toLowerCase()}%`); }
    if (job_name)      { p++; where.push(`LOWER(COALESCE(job_name,'')) LIKE $${p}`); params.push(`%${job_name.toLowerCase()}%`); }
    if (reimbursement==='1') { where.push('needs_reimbursement=1'); }
  }
  const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM purchase_orders ${wc} ORDER BY created_at DESC`, params);
  const exportDate = new Date().toISOString().slice(0,10);
  const xlsxRows=[['J&D Western Electric Ltd — Purchase Orders'],[`Exported: ${exportDate}`],[],
    ['PO Number','Date Generated','Generated By','Jobber Job #','Job Name','Supplier','Description','Estimated Amount','Needs Reimbursement','Status','Office Notes','Date Status Last Changed'],
    ...rows.map(p2=>[p2.po_number,p2.date,p2.generated_by_name,p2.jobber_job_number||'',p2.job_name||'',p2.supplier||'',p2.description,p2.estimated_amount!=null?parseFloat(p2.estimated_amount):'',p2.needs_reimbursement?'Yes':'No',p2.status,p2.office_note||'',p2.updated_at?new Date(p2.updated_at).toLocaleString('en-CA',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):''])];
  const wb=XLSX.utils.book_new(); const ws=XLSX.utils.aoa_to_sheet(xlsxRows);
  ws['!cols']=[{wch:18},{wch:14},{wch:18},{wch:16},{wch:24},{wch:18},{wch:36},{wch:16},{wch:12},{wch:12},{wch:30},{wch:22}];
  XLSX.utils.book_append_sheet(wb,ws,'Purchase Orders');
  logAction(req,'po_export',null,null,'PO XLSX export');
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="JD-POs-${exportDate}.xlsx"`);
  res.send(buf);
});

app.get('/api/po/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM purchase_orders WHERE id=$1',[req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'PO not found' });
  const { rows: audit } = await pool.query('SELECT user_name,action,details,created_at FROM po_audit_log WHERE po_id=$1 ORDER BY created_at ASC',[req.params.id]);
  logPOAction(req,rows[0].id,rows[0].po_number,'po_viewed');
  res.json({ ...rows[0], audit });
});

app.patch('/api/po/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM purchase_orders WHERE id=$1',[req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'PO not found' });
  const po = rows[0];
  const { status, office_note } = req.body;
  const updated_at = new Date().toISOString();
  await pool.query('UPDATE purchase_orders SET status=COALESCE($1,status),office_note=COALESCE($2,office_note),updated_at=$3 WHERE id=$4',
    [status||null, office_note!==undefined?office_note:null, updated_at, req.params.id]);
  if (status&&status!==po.status) logPOAction(req,po.id,po.po_number,'status_changed',`${po.status} → ${status}`);
  if (office_note!==undefined&&office_note!==po.office_note) logPOAction(req,po.id,po.po_number,'note_updated');
  const autoProjectArchive = status==='Entered' && po.status!=='Entered' && po.project_id && !po.project_archived;
  if (autoProjectArchive) {
    await pool.query('UPDATE purchase_orders SET project_archived=1 WHERE id=$1',[req.params.id]);
    logPOAction(req,po.id,po.po_number,'po_project_archived',`Auto-archived within project upon status change to Entered by ${req.user?.name}`);
  }
  res.json({ ok: true, auto_project_archived: autoProjectArchive });
});

app.put('/api/po/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM purchase_orders WHERE id=$1',[req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'PO not found' });
  const po = rows[0];
  const { date,generated_by_name,jobber_job_number,job_name,supplier,description,estimated_amount,needs_reimbursement,status,office_note,project_id } = req.body;
  const resolvedPid = project_id!==undefined ? await resolveProjectId(project_id) : po.project_id;
  await pool.query(`UPDATE purchase_orders SET date=COALESCE($1,date),generated_by_name=COALESCE($2,generated_by_name),
    jobber_job_number=COALESCE($3,jobber_job_number),job_name=COALESCE($4,job_name),supplier=$5,description=COALESCE($6,description),
    estimated_amount=$7,needs_reimbursement=COALESCE($8,needs_reimbursement),status=COALESCE($9,status),office_note=$10,project_id=$11,updated_at=$12 WHERE id=$13`,
    [date||null,generated_by_name||null,jobber_job_number||null,job_name||null,supplier||null,description||null,estimated_amount!=null?parseFloat(estimated_amount):null,needs_reimbursement!=null?(needs_reimbursement?1:0):null,status||null,office_note||null,resolvedPid,new Date().toISOString(),req.params.id]);
  logPOAction(req,po.id,po.po_number,'po_edited',`Edited by ${req.user.name}`);
  res.json({ ok: true });
});

app.patch('/api/po/:id/archive', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM purchase_orders WHERE id=$1',[req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await pool.query('UPDATE purchase_orders SET status=$1,updated_at=$2 WHERE id=$3',['Archived',new Date().toISOString(),req.params.id]);
  logPOAction(req,rows[0].id,rows[0].po_number,'po_archived');
  res.json({ ok: true });
});

app.patch('/api/po/:id/project-archive', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM purchase_orders WHERE id=$1',[req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await pool.query('UPDATE purchase_orders SET project_archived=1 WHERE id=$1',[req.params.id]);
  logPOAction(req,rows[0].id,rows[0].po_number,'po_project_archived');
  res.json({ ok: true });
});

app.patch('/api/po/:id/project-unarchive', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM purchase_orders WHERE id=$1',[req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await pool.query('UPDATE purchase_orders SET project_archived=0 WHERE id=$1',[req.params.id]);
  logPOAction(req,rows[0].id,rows[0].po_number,'po_project_unarchived');
  res.json({ ok: true });
});

app.delete('/api/po/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM purchase_orders WHERE id=$1',[req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'PO not found' });
  if (rows[0].status !== 'Archived') return res.status(400).json({ error: 'A PO must be archived before it can be permanently deleted.' });
  logPOAction(req,rows[0].id,rows[0].po_number,'po_deleted',`Permanently deleted by ${req.user.name}`);
  await pool.query('DELETE FROM purchase_orders WHERE id=$1',[req.params.id]);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// PROJECTS
// ─────────────────────────────────────────────

app.get('/api/project-folders', requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT id,name,job_numbers FROM projects WHERE status='active' ORDER BY name");
  res.json(rows);
});

app.get('/api/project-folders/all', requireAdmin, async (req, res) => {
  const allowed=['active','complete','archived'];
  const status = allowed.includes(req.query.status) ? req.query.status : 'active';
  const { rows } = await pool.query(`
    SELECT p.*,
      (SELECT COUNT(*) FROM daily_tickets t WHERE t.project_id=p.id) AS ticket_count,
      (SELECT COUNT(*) FROM purchase_orders o WHERE o.project_id=p.id) AS po_count,
      (SELECT COUNT(*) FROM daily_tickets t WHERE t.project_id=p.id AND (t.ticket_status='Pending' OR t.ticket_status IS NULL OR t.ticket_status='Reviewed') AND (t.project_archived=0 OR t.project_archived IS NULL)) AS pending_tickets,
      (SELECT COUNT(*) FROM purchase_orders o WHERE o.project_id=p.id AND o.status='Open' AND (o.project_archived=0 OR o.project_archived IS NULL)) AS open_pos
    FROM projects p WHERE p.status=$1 ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC`, [status]);
  res.json(rows);
});

app.post('/api/project-folders', requireAdmin, async (req, res) => {
  const { name, job_numbers } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Project name is required' });
  const jn = normalizeJobNumbers(job_numbers);
  const { rows } = await pool.query('INSERT INTO projects (name,job_numbers,status,created_at) VALUES ($1,$2,$3,$4) RETURNING id,name,job_numbers,status',
    [name.trim(),jn,'active',new Date().toISOString()]);
  res.status(201).json(rows[0]);
});

app.post('/api/project-folders/quick', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Project name is required' });
  const { rows: ex } = await pool.query("SELECT id,name,job_numbers,status FROM projects WHERE status='active' AND LOWER(name)=LOWER($1)",[name.trim()]);
  if (ex[0]) return res.json(ex[0]);
  const { rows } = await pool.query('INSERT INTO projects (name,job_numbers,status,created_at) VALUES ($1,$2,$3,$4) RETURNING id,name,job_numbers,status',
    [name.trim(),null,'active',new Date().toISOString()]);
  res.status(201).json(rows[0]);
});

app.patch('/api/project-folders/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1',[req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found' });
  const { name, job_numbers } = req.body;
  if (name!==undefined && !name.trim()) return res.status(400).json({ error: 'Project name cannot be empty' });
  await pool.query('UPDATE projects SET name=COALESCE($1,name),job_numbers=$2,updated_at=$3 WHERE id=$4',
    [name?.trim()||null, job_numbers!==undefined?normalizeJobNumbers(job_numbers):rows[0].job_numbers, new Date().toISOString(), req.params.id]);
  res.json({ ok: true });
});

app.patch('/api/project-folders/:id/status', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1',[req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found' });
  const allowed=['active','complete','archived'];
  const status = allowed.includes(req.body.status) ? req.body.status : 'active';
  const now = new Date().toISOString();
  await pool.query('UPDATE projects SET status=$1,completed_at=$2,updated_at=$3 WHERE id=$4',
    [status, (status==='complete'||status==='archived')?now:null, now, req.params.id]);
  res.json({ ok: true, status });
});

app.get('/api/project-folders/:id', requireAdmin, async (req, res) => {
  const { rows: pr } = await pool.query('SELECT * FROM projects WHERE id=$1',[req.params.id]);
  if (!pr[0]) return res.status(404).json({ error: 'Project not found' });
  const { rows: allT } = await pool.query(
    `SELECT t.*, STRING_AGG(${EMP_SELECT},'||' ORDER BY e.id) AS employees_raw FROM daily_tickets t LEFT JOIN ticket_employees e ON e.ticket_id=t.id WHERE t.project_id=$1 GROUP BY t.id ORDER BY t.date DESC, t.submitted_at DESC`,
    [pr[0].id]
  );
  const { rows: allP } = await pool.query('SELECT * FROM purchase_orders WHERE project_id=$1 ORDER BY date DESC,created_at DESC',[pr[0].id]);
  const { rows: allS } = await pool.query('SELECT id,form_type,form_number,submitted_by,submitted_at,date,status,project_archived,job_number FROM safety_forms WHERE project_id=$1 ORDER BY date DESC,submitted_at DESC',[pr[0].id]);
  const { rows: allPS } = await pool.query('SELECT id,schedule_number,panel_name,voltage,main_breaker,num_circuits,created_by,created_at,status,project_archived FROM panel_schedules WHERE project_id=$1 ORDER BY created_at DESC',[pr[0].id]);
  const mapT = t => ({ ...t, employees: parseEmployeesRaw(t.employees_raw), employees_raw: undefined });
  res.json({
    project: pr[0],
    tickets:          allT.filter(t=>!t.project_archived).map(mapT),
    purchase_orders:  allP.filter(p=>!p.project_archived),
    safety_forms:     allS.filter(s=>!s.project_archived),
    panel_schedules:  allPS.filter(ps=>!ps.project_archived),
    archived_tickets: allT.filter(t=> t.project_archived).map(mapT),
    archived_pos:     allP.filter(p=> p.project_archived),
    archived_safety:  allS.filter(s=> s.project_archived),
    archived_panels:  allPS.filter(ps=> ps.project_archived),
  });
});

app.get('/api/project-folders/:id/export/xlsx', requireAdmin, async (req, res) => {
  const { rows: pr } = await pool.query('SELECT * FROM projects WHERE id=$1',[req.params.id]);
  if (!pr[0]) return res.status(404).json({ error: 'Project not found' });
  const { rows: tickets } = await pool.query(
    `SELECT t.*, STRING_AGG(${EMP_SELECT},'||' ORDER BY e.id) AS employees_raw FROM daily_tickets t LEFT JOIN ticket_employees e ON e.ticket_id=t.id WHERE t.project_id=$1 GROUP BY t.id ORDER BY t.date DESC`,
    [pr[0].id]
  );
  const { rows: pos } = await pool.query('SELECT * FROM purchase_orders WHERE project_id=$1 ORDER BY date DESC',[pr[0].id]);
  const exportDate = new Date().toISOString().slice(0,10);
  const wb = XLSX.utils.book_new();
  // Tickets sheet
  const tRows=[['J&D Western Electric Ltd — Project Export'],[`Project: ${pr[0].name}`],[`Exported: ${exportDate}`],[],['Date','Ticket #','Supervisor','Employee','Level','Reg Hrs','OT Hrs','Total','Work Description','Equipment','Notes','Status']];
  for (const t of tickets) for (const e of parseEmployeesRaw(t.employees_raw)) tRows.push([t.date,t.ticket_number,t.supervisor,e.name,e.level,e.regular_hours,e.overtime_hours,e.regular_hours+e.overtime_hours,t.work_description,t.equipment_used||'',t.notes||'',t.ticket_status||'Pending']);
  const tws=XLSX.utils.aoa_to_sheet(tRows); tws['!cols']=[{wch:12},{wch:18},{wch:16},{wch:20},{wch:20},{wch:10},{wch:10},{wch:10},{wch:36},{wch:20},{wch:20},{wch:12}];
  XLSX.utils.book_append_sheet(wb,tws,'Time Tickets');
  // POs sheet
  const pRows=[['Date','PO Number','Generated By','Jobber Job #','Job Name','Supplier','Description','Est. Amount','Status','Office Note'],...pos.map(p2=>[p2.date,p2.po_number,p2.generated_by_name,p2.jobber_job_number,p2.job_name||'',p2.supplier||'',p2.description,p2.estimated_amount!=null?parseFloat(p2.estimated_amount):'',p2.status,p2.office_note||''])];
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(pRows),'Purchase Orders');
  logAction(req,'po_export',null,null,`Project export: ${pr[0].name}`);
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  const safeName=pr[0].name.replace(/[^a-z0-9]/gi,'_');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${safeName}_export.xlsx"`);
  res.send(buf);
});

app.delete('/api/project-folders/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1',[req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found' });
  if (rows[0].status !== 'archived') return res.status(400).json({ error: 'A project must be archived before it can be permanently deleted.' });
  await pool.query('UPDATE daily_tickets SET project_id=NULL WHERE project_id=$1',[req.params.id]);
  await pool.query('UPDATE purchase_orders SET project_id=NULL WHERE project_id=$1',[req.params.id]);
  await pool.query('DELETE FROM projects WHERE id=$1',[req.params.id]);
  logAction(req,'project_deleted',null,null,`Project "${rows[0].name}" permanently deleted by ${req.user.name}`);
  res.json({ ok: true });
});

app.get('/api/projects', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT t.job_name, t.job_number, COUNT(DISTINCT t.id) AS ticket_count, MIN(t.date) AS first_date, MAX(t.date) AS last_date,
      COALESCE(SUM(e.regular_hours+e.overtime_hours),0) AS total_hours
    FROM daily_tickets t LEFT JOIN ticket_employees e ON e.ticket_id=t.id WHERE t.archived=0
    GROUP BY t.job_name, t.job_number ORDER BY MAX(t.date) DESC`);
  res.json(rows);
});

// ─────────────────────────────────────────────
// PAYROLL & TIMESHEETS
// ─────────────────────────────────────────────

// ── Payroll helpers ──
async function getPayrollBase() {
  const { rows } = await pool.query('SELECT cycle_start_date, period_days FROM payroll_config WHERE id=1');
  return { base: rows[0]?.cycle_start_date || '2026-05-25', days: parseInt(rows[0]?.period_days || 14) };
}

function calcPayPeriod(base, periodDays, offset = 0) {
  const b = new Date(base + 'T00:00:00Z');
  const start = new Date(b); start.setUTCDate(start.getUTCDate() + offset * periodDays);
  const end   = new Date(start); end.setUTCDate(end.getUTCDate() + periodDays - 1);
  const payday = new Date(end); payday.setUTCDate(payday.getUTCDate() + 5);
  return {
    index: offset,
    start:  start.toISOString().slice(0,10),
    end:    end.toISOString().slice(0,10),
    cutoff: end.toISOString().slice(0,10),
    payday: payday.toISOString().slice(0,10),
  };
}

function getCurrentPeriodOffset(base, periodDays) {
  const b = new Date(base + 'T00:00:00Z');
  const now = new Date(); now.setUTCHours(0,0,0,0);
  return Math.floor((now - b) / (periodDays * 24*60*60*1000));
}

// ── Get payroll config + current period ──
app.get('/api/payroll/config', requireAuth, async (req, res) => {
  const { base, days } = await getPayrollBase();
  const offset = getCurrentPeriodOffset(base, days);
  const current = calcPayPeriod(base, days, offset);
  const prev    = calcPayPeriod(base, days, offset - 1);
  const next    = calcPayPeriod(base, days, offset + 1);
  res.json({ base, period_days: days, current, prev, next, current_offset: offset });
});

app.patch('/api/payroll/config', requireAdmin, async (req, res) => {
  const { cycle_start_date, period_days } = req.body;
  await pool.query('UPDATE payroll_config SET cycle_start_date=COALESCE($1,cycle_start_date), period_days=COALESCE($2,period_days) WHERE id=1',
    [cycle_start_date||null, period_days||null]);
  logAction(req, 'payroll_config_updated', null, null, `Payroll config updated by ${req.user.name}`);
  res.json({ ok: true });
});

// ── Active users list for employee dropdown ──
app.get('/api/users/employees', requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT id, name FROM users WHERE status='active' ORDER BY name");
  res.json(rows);
});

// ── Build timesheet for one employee + period ──
async function buildTimesheet(userId, periodStart, periodEnd) {
  const { rows: userRows } = await pool.query('SELECT id, name FROM users WHERE id=$1', [userId]);
  if (!userRows[0]) return null;

  // ── Ticket source of truth — one query, all the data ──
  // No aggregation: keep individual ticket entries so we preserve status, job, project per entry
  const { rows: ticketEntries } = await pool.query(`
    SELECT
      t.date,
      t.id              AS ticket_id,
      t.ticket_number,
      COALESCE(t.ticket_status, 'Pending') AS ticket_status,
      t.job_number,
      t.job_name,
      COALESCE(p.name, '') AS project_name,
      te.regular_hours,
      te.overtime_hours,
      COALESCE(te.travel_hours, 0) AS travel_hours,
      COALESCE(te.level, 'Journeyman') AS level,
      t.supervisor,
      t.updated_at,
      COALESCE(t.has_duplicate, 0) AS has_duplicate
    FROM ticket_employees te
    JOIN daily_tickets t ON t.id = te.ticket_id
    LEFT JOIN projects p ON p.id = t.project_id
    JOIN users u ON u.id = $1
    WHERE (te.user_id = $1 OR (te.user_id IS NULL AND LOWER(TRIM(te.employee_name)) = LOWER(TRIM(u.name))))
      AND t.date >= $2 AND t.date <= $3
    ORDER BY t.date, t.submitted_at`, [userId, periodStart, periodEnd]);

  // Manual overrides (applied on top of ticket data when present)
  const { rows: overrides } = await pool.query(
    'SELECT * FROM timesheet_overrides WHERE employee_user_id=$1 AND date>=$2 AND date<=$3 ORDER BY date',
    [userId, periodStart, periodEnd]);
  const overrideMap = {};
  overrides.forEach(o => { overrideMap[o.date] = o; });

  // Group ticket entries by date
  const entriesByDate = {};
  ticketEntries.forEach(e => {
    if (!entriesByDate[e.date]) entriesByDate[e.date] = [];
    entriesByDate[e.date].push(e);
  });

  // Build per-day rows
  const days = [];
  let enteredReg = 0, enteredOT = 0, enteredTravel = 0; // payroll totals — only Entered
  let pendingReg = 0, pendingOT  = 0, pendingTravel = 0; // pending display totals

  const start = new Date(periodStart + 'T00:00:00Z');
  const end   = new Date(periodEnd   + 'T00:00:00Z');

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
    const entries = entriesByDate[dateStr] || [];
    const override = overrideMap[dateStr];

    if (override) {
      // Special case: time-off day
      if (override.is_time_off) {
        days.push({ date: dateStr, dow,
          regular_hours: 0, overtime_hours: 0, travel_hours: 0, total_hours: 0,
          approval_status: 'time_off', source: 'time_off',
          job_name: 'Time Off', job_number: '', project_name: '', level: '',
          ticket_numbers: '', time_off_request_id: override.time_off_request_id, entries });
        continue;
      }
      const reg    = parseFloat(override.regular_hours)  || 0;
      const ot     = parseFloat(override.overtime_hours) || 0;
      const travel = 0; // overrides don't store travel separately (leave at ticket value)
      enteredReg += reg; enteredOT += ot; enteredTravel += travel;
      const first = entries[0] || {};
      const travelFromTickets = entries.reduce((s,e)=>s+(parseFloat(e.travel_hours)||0),0);
      days.push({ date: dateStr, dow,
        regular_hours: reg, overtime_hours: ot, travel_hours: travelFromTickets,
        total_hours: reg + ot + travelFromTickets,
        approval_status: 'entered', source: 'manual',
        job_number: first.job_number||'', job_name: first.job_name||'',
        project_name: first.project_name||'', level: first.level||'',
        ticket_numbers: entries.map(e=>e.ticket_number).join(', '),
        edited_by_name: override.edited_by_name, edited_at: override.created_at, entries });
    } else if (entries.length > 0) {
      // Push one row per ticket — hours always count, duplicate flag is informational only
      entries.forEach(e => {
        const reg    = parseFloat(e.regular_hours)  || 0;
        const ot     = parseFloat(e.overtime_hours) || 0;
        const travel = parseFloat(e.travel_hours)   || 0;
        const isEntered = e.ticket_status === 'Entered';
        if (isEntered) { enteredReg += reg; enteredOT += ot; enteredTravel += travel; }
        else           { pendingReg += reg; pendingOT += ot; pendingTravel += travel; }
        days.push({ date: dateStr, dow,
          regular_hours: reg, overtime_hours: ot, travel_hours: travel,
          total_hours: reg + ot + travel,
          approval_status: isEntered ? 'entered' : 'pending', source: 'ticket',
          has_duplicate: e.has_duplicate || 0,
          job_number:   e.job_number   || '',
          job_name:     e.job_name     || '',
          project_name: e.project_name || '',
          level: e.level,
          ticket_numbers: e.ticket_number,
          supervisor: e.supervisor, updated_at: e.updated_at, entries: [e] });
      });
    } else {
      days.push({ date: dateStr, dow,
        regular_hours: 0, overtime_hours: 0, travel_hours: 0, total_hours: 0,
        approval_status: 'none', source: 'none', entries: [] });
    }
  }

  return {
    user: userRows[0], days,
    totals:         { regular: enteredReg, ot: enteredOT, travel: enteredTravel, total: enteredReg + enteredOT + enteredTravel },
    pending_totals: { regular: pendingReg, ot: pendingOT, travel: pendingTravel, total: pendingReg + pendingOT + pendingTravel },
  };
}

// ── Admin: list all employees with current period summary ──
app.get('/api/timesheets', requireAdmin, async (req, res) => {
  const { base, days } = await getPayrollBase();
  const offset  = parseInt(req.query.offset ?? getCurrentPeriodOffset(base, days));
  const period  = calcPayPeriod(base, days, offset);
  const { rows: users } = await pool.query("SELECT id, name FROM users WHERE status='active' ORDER BY name");

  const summaries = await Promise.all(users.map(async u => {
    // Only count Entered tickets in payroll totals
    const { rows: hrs } = await pool.query(`
      SELECT COALESCE(SUM(te.regular_hours),0) AS reg, COALESCE(SUM(te.overtime_hours),0) AS ot,
             COALESCE(SUM(te.travel_hours),0) AS travel
      FROM ticket_employees te JOIN daily_tickets t ON t.id=te.ticket_id
      WHERE (te.user_id=$1 OR (te.user_id IS NULL AND LOWER(TRIM(te.employee_name))=LOWER(TRIM($4))))
        AND t.date>=$2 AND t.date<=$3 AND t.ticket_status='Entered'`,
      [u.id, period.start, period.end, u.name]);
    const { rows: pendHrs } = await pool.query(`
      SELECT COALESCE(SUM(te.regular_hours),0) AS reg, COALESCE(SUM(te.overtime_hours),0) AS ot,
             COALESCE(SUM(te.travel_hours),0) AS travel
      FROM ticket_employees te JOIN daily_tickets t ON t.id=te.ticket_id
      WHERE (te.user_id=$1 OR (te.user_id IS NULL AND LOWER(TRIM(te.employee_name))=LOWER(TRIM($4))))
        AND t.date>=$2 AND t.date<=$3 AND COALESCE(t.ticket_status,'Pending') != 'Entered'`,
      [u.id, period.start, period.end, u.name]);
    const reg=parseFloat(hrs[0].reg)||0, ot=parseFloat(hrs[0].ot)||0, travel=parseFloat(hrs[0].travel)||0;
    const pReg=parseFloat(pendHrs[0].reg)||0, pOt=parseFloat(pendHrs[0].ot)||0, pTravel=parseFloat(pendHrs[0].travel)||0;
    return { ...u, regular_hours: reg, overtime_hours: ot, travel_hours: travel, total_hours: reg+ot+travel,
             pending_regular: pReg, pending_ot: pOt, pending_travel: pTravel };
  }));

  res.json({ period, summaries, offset });
});

// ── Archive: list past periods grouped by month ── (MUST be before /:userId)
app.get('/api/timesheets/archive-periods', requireAdmin, async (req, res) => {
  const { base, days: pd } = await getPayrollBase();
  const curOffset = getCurrentPeriodOffset(base, pd);
  const periods = [];
  for (let i = 0; i < curOffset; i++) periods.push({ ...calcPayPeriod(base, pd, i), offset: i });
  const byMonth = {};
  periods.forEach(p => {
    const month = p.start.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { month, periods: [] };
    byMonth[month].periods.unshift(p);
  });
  res.json(Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month)));
});

app.delete('/api/timesheets/archive', requireAdmin, async (req, res) => {
  const { offsets, user_ids } = req.body;
  if (!offsets?.length) return res.status(400).json({ error: 'offsets required' });
  const { base, days: pd } = await getPayrollBase();
  let deleted = 0;
  for (const offset of offsets) {
    const period = calcPayPeriod(base, pd, parseInt(offset));
    let q = 'DELETE FROM timesheet_overrides WHERE date>=$1 AND date<=$2';
    const params = [period.start, period.end];
    if (user_ids?.length) { q += ` AND employee_user_id = ANY($3)`; params.push(user_ids); }
    const { rowCount } = await pool.query(q, params);
    deleted += rowCount;
  }
  logAction(req, 'timesheet_archive_deleted', null, null,
    `Deleted ${deleted} timesheet overrides for ${offsets.length} period(s) by ${req.user.name}`);
  res.json({ ok: true, deleted });
});

app.get('/api/timesheets/export/all', requireAdmin, async (req, res) => {
  const { base, days: pd } = await getPayrollBase();
  const offset = parseInt(req.query.offset ?? getCurrentPeriodOffset(base, pd));
  const period = calcPayPeriod(base, pd, offset);
  const { rows: users } = await pool.query("SELECT id FROM users WHERE status='active' ORDER BY name");
  const wb = XLSX.utils.book_new();
  for (const u of users) {
    const ts = await buildTimesheet(u.id, period.start, period.end);
    if (!ts) continue;
    const rows = [['J&D Western Electric Ltd — Employee Timesheet'],[`Employee: ${ts.user.name}`],[`Pay Period: ${period.start} to ${period.end}`,`Payday: ${period.payday}`],[],
      ['Date','Day','Regular Hours','OT Hours','Travel Hours','Source','Job #','Project'],
      ...ts.days.map(d=>[d.date,d.dow,d.regular_hours,d.overtime_hours,d.travel_hours||0,d.source==='manual'?'Manually Edited':d.source==='ticket'?'Auto from Time Ticket':'No Entry',d.job_number||'',d.project_name||'']),
      [['TOTALS','',ts.totals.regular,ts.totals.ot,ts.totals.travel||0]]];
    const ws=XLSX.utils.aoa_to_sheet(rows); ws['!cols']=[{wch:12},{wch:6},{wch:14},{wch:10},{wch:12},{wch:22},{wch:12},{wch:24}];
    XLSX.utils.book_append_sheet(wb,ws,ts.user.name.slice(0,31));
  }
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  const fn=`JD-Timesheets-${period.start}-to-${period.end}.xlsx`;
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${fn}"`);
  res.send(buf);
});

app.get('/api/timesheets/:userId', requireAdmin, async (req, res) => {
  try {
    const { base, days } = await getPayrollBase();
    const offset = parseInt(req.query.offset ?? getCurrentPeriodOffset(base, days));
    const period = calcPayPeriod(base, days, offset);
    const ts = await buildTimesheet(parseInt(req.params.userId), period.start, period.end);
    if (!ts) return res.status(404).json({ error: 'User not found' });
    res.json({ ...ts, period, offset });
  } catch (err) {
    console.error('buildTimesheet error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to load timesheet: ' + err.message });
  }
});

// ── Field user: own timesheet ──
app.get('/api/my-timesheet', requireAuth, async (req, res) => {
  const { base, days } = await getPayrollBase();
  const offset = parseInt(req.query.offset ?? getCurrentPeriodOffset(base, days));
  const period = calcPayPeriod(base, days, offset);
  const ts = await buildTimesheet(req.user.id, period.start, period.end);
  if (!ts) return res.status(404).json({ error: 'Not found' });
  // Past periods list (last 10)
  const periods = [];
  const curOffset = getCurrentPeriodOffset(base, days);
  for (let i = curOffset - 1; i >= Math.max(0, curOffset - 10); i--) {
    periods.push(calcPayPeriod(base, days, i));
  }
  res.json({ ...ts, period, offset, past_periods: periods, current_offset: curOffset });
});

// ── Manual timesheet edit (requires timesheet_edit permission) ──
app.patch('/api/timesheets/:userId/:date', requireAdmin, async (req, res) => {
  const perms = (req.user.permissions || '').split(',');
  if (!perms.includes('timesheet_edit')) return res.status(403).json({ error: 'Timesheet Edit Access required' });
  const { regular_hours, overtime_hours, travel_hours, reason } = req.body;
  const userId = parseInt(req.params.userId);
  const date   = req.params.date;
  const { rows: userRows } = await pool.query('SELECT name FROM users WHERE id=$1', [userId]);
  if (!userRows[0]) return res.status(404).json({ error: 'User not found' });

  // Get current hours for audit
  const { rows: current } = await pool.query(`
    SELECT COALESCE(SUM(te.regular_hours),0) AS reg, COALESCE(SUM(te.overtime_hours),0) AS ot, COALESCE(SUM(te.travel_hours),0) AS travel
    FROM ticket_employees te JOIN daily_tickets t ON t.id=te.ticket_id
    WHERE te.user_id=$1 AND t.date=$2`, [userId, date]);
  const origReg=parseFloat(regular_hours)||0, origOT=parseFloat(overtime_hours)||0, origTravel=parseFloat(travel_hours)||0;
  const oldReg=parseFloat(current[0].reg)||0, oldOT=parseFloat(current[0].ot)||0, oldTravel=parseFloat(current[0].travel)||0;

  await pool.query(`INSERT INTO timesheet_overrides (employee_user_id,date,regular_hours,overtime_hours,travel_hours,original_regular,original_ot,original_travel,edited_by_id,edited_by_name,edit_reason,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (employee_user_id,date) DO UPDATE SET regular_hours=$3,overtime_hours=$4,travel_hours=$5,edited_by_id=$9,edited_by_name=$10,edit_reason=$11,created_at=$12`,
    [userId,date,origReg,origOT,origTravel,oldReg,oldOT,oldTravel,req.user.id,req.user.name,reason||null,new Date().toISOString()]);

  logAction(req,'timesheet_edited',null,null,
    `Timesheet manually edited by ${req.user.name} — changed ${userRows[0].name} ${date} from ${oldReg}reg/${oldOT}OT/${oldTravel}travel to ${origReg}reg/${origOT}OT/${origTravel}travel`);
  res.json({ ok: true });
});

// (archive-periods and archive delete moved above /:userId route)

// ── Export single employee timesheet ──
app.get('/api/timesheets/:userId/export', requireAdmin, async (req, res) => {
  const { base, days: pd } = await getPayrollBase();
  const offset = parseInt(req.query.offset ?? getCurrentPeriodOffset(base, pd));
  const period = calcPayPeriod(base, pd, offset);
  const ts = await buildTimesheet(parseInt(req.params.userId), period.start, period.end);
  if (!ts) return res.status(404).json({ error: 'User not found' });

  const wb = XLSX.utils.book_new();
  const rows = [
    ['J&D Western Electric Ltd — Employee Timesheet'],
    [`Employee: ${ts.user.name}`],
    [`Pay Period: ${period.start} to ${period.end}`, `Payday: ${period.payday}`],
    [],
    ['Date','Day','Regular Hours','OT Hours','Travel Hours','Source','Job #','Project','Status'],
    ...ts.days.map(d => [d.date, d.dow, d.regular_hours, d.overtime_hours, d.travel_hours||0, d.source==='manual'?'Manually Edited':d.source==='ticket'?'Auto from Time Ticket':'No Entry', d.job_number||'', d.project_name||'', d.approval_status||'']),
    [],
    ['TOTALS','', ts.totals.regular, ts.totals.ot, ts.totals.travel||0],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:12},{wch:6},{wch:14},{wch:10},{wch:12},{wch:22}];
  XLSX.utils.book_append_sheet(wb, ws, ts.user.name.slice(0,31));
  const buf = XLSX.write(wb, {type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${ts.user.name.replace(/[^a-z0-9]/gi,'_')}-timesheet-${period.start}.xlsx"`);
  res.send(buf);
});

// (export/all moved above /:userId route)

// ─────────────────────────────────────────────
// TIME OFF REQUESTS
// ─────────────────────────────────────────────

// ── Alberta statutory holiday helpers ──
function calcEaster(year) {
  // Anonymous Gregorian algorithm
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 1-based
  const day   = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function nthMonday(year, month, n) { // month 0-based, n 1-based
  const d = new Date(Date.UTC(year, month, 1));
  const dow = d.getUTCDay(); // 0=Sun
  const delta = (1 - dow + 7) % 7; // days to first Monday
  d.setUTCDate(1 + delta + (n - 1) * 7);
  return d;
}

function mondayBefore(date) { // last Monday strictly before date
  const d = new Date(date);
  const dow = d.getUTCDay() || 7; // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() - dow); // go to prev Sun
  d.setUTCDate(d.getUTCDate() - 6);   // then back to Mon
  // Actually: find the Monday before May 25
  // Victoria Day = Monday before May 25 = last Monday on or before May 24
  const target = new Date(date);
  target.setUTCDate(target.getUTCDate() - 1); // May 24
  const dow2 = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() - (dow2 - 1));
  return target;
}

function iso(d) { return d.toISOString().slice(0, 10); }

function getAlbertaStatHolidays(year, cfg = {}) {
  const holidays = [];
  function add(date, name, observed = false) {
    let d = new Date(date);
    // Observed rule: if Sat→Mon, if Sun→Mon for the 4 applicable holidays
    if (observed) {
      const dow = d.getUTCDay();
      if (dow === 6) d.setUTCDate(d.getUTCDate() + 2); // Sat → Mon
      else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1); // Sun → Mon
    }
    holidays.push({ date: iso(d), name, year });
  }

  const easter = calcEaster(year);

  // 9 mandatory Alberta holidays
  add(new Date(Date.UTC(year, 0, 1)),  'New Year\'s Day', true);
  add(nthMonday(year, 1, 3),           'Alberta Family Day');
  const goodFriday = new Date(easter); goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  add(goodFriday,                      'Good Friday');
  add(mondayBefore(new Date(Date.UTC(year, 4, 25))), 'Victoria Day');
  add(new Date(Date.UTC(year, 6, 1)),  'Canada Day', true);
  add(nthMonday(year, 8, 1),           'Labour Day');
  add(nthMonday(year, 9, 2),           'Thanksgiving Day');
  add(new Date(Date.UTC(year, 10, 11)), 'Remembrance Day', true);
  add(new Date(Date.UTC(year, 11, 25)), 'Christmas Day', true);

  // Optional holidays (off by default — flip via time_off_config)
  if (cfg.optional_heritage_day) {
    add(nthMonday(year, 7, 1), 'Heritage Day (Optional)');
  }
  if (cfg.optional_boxing_day) {
    add(new Date(Date.UTC(year, 11, 26)), 'Boxing Day (Optional)');
  }
  if (cfg.optional_easter_monday) {
    const em = new Date(easter); em.setUTCDate(em.getUTCDate() + 1);
    add(em, 'Easter Monday (Optional)');
  }
  if (cfg.optional_truth_rec_day) {
    add(new Date(Date.UTC(year, 8, 30)), 'National Day for Truth & Reconciliation (Optional)', true);
  }

  return holidays;
}

// ── Time-off config ──
app.get('/api/time-off/config', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM time_off_config WHERE id=1');
  res.json(rows[0] || {});
});

app.patch('/api/time-off/config', requireAdmin, async (req, res) => {
  const { overlap_warning_count, optional_heritage_day, optional_boxing_day, optional_easter_monday, optional_truth_rec_day } = req.body;
  await pool.query(`UPDATE time_off_config SET
    overlap_warning_count = COALESCE($1, overlap_warning_count),
    optional_heritage_day = COALESCE($2, optional_heritage_day),
    optional_boxing_day   = COALESCE($3, optional_boxing_day),
    optional_easter_monday= COALESCE($4, optional_easter_monday),
    optional_truth_rec_day= COALESCE($5, optional_truth_rec_day)
    WHERE id=1`,
    [overlap_warning_count ?? null, optional_heritage_day ?? null, optional_boxing_day ?? null, optional_easter_monday ?? null, optional_truth_rec_day ?? null]);
  res.json({ ok: true });
});

// ── Stat holidays for a year range ──
app.get('/api/time-off/holidays', requireAuth, async (req, res) => {
  const from = parseInt(req.query.from_year) || new Date().getFullYear();
  const to   = parseInt(req.query.to_year)   || from + 1;
  const { rows: cfgRows } = await pool.query('SELECT * FROM time_off_config WHERE id=1');
  const cfg = cfgRows[0] || {};
  const holidays = [];
  for (let y = from; y <= to; y++) holidays.push(...getAlbertaStatHolidays(y, cfg));
  res.json(holidays);
});

// ── Submit a time-off request ──
app.post('/api/time-off', requireAuth, async (req, res) => {
  try {
    const { start_date, end_date, return_to_work_date, type, note, half_day } = req.body;
    if (!start_date || !end_date || !type) return res.status(400).json({ error: 'start_date, end_date, and type are required' });
    if (start_date > end_date) return res.status(400).json({ error: 'Start date must be on or before end date' });
    const validTypes = ['Vacation', 'Sick', 'Unpaid', 'Other'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid type' });
    const now = new Date().toISOString();
    const { rows } = await pool.query(
      `INSERT INTO time_off_requests (user_id,user_name,start_date,end_date,return_to_work_date,half_day,type,note,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$9) RETURNING id`,
      [req.user.id, req.user.name, start_date, end_date, return_to_work_date || null, half_day || null, type, note || null, now]
    );
    const id = rows[0].id;
    // Audit log is non-fatal — don't let a logging failure block the submission
    try {
      await pool.query('INSERT INTO time_off_audit (request_id,user_name,action,details,created_at) VALUES ($1,$2,$3,$4,$5)',
        [id, req.user.name, 'submitted', `${type} request: ${start_date} to ${end_date}, RTW: ${return_to_work_date||'not set'}`, now]);
    } catch (auditErr) {
      console.error('time_off_audit insert failed (non-fatal):', auditErr.message);
    }
    res.status(201).json({ ok: true, id });
  } catch (err) {
    console.error('POST time-off error:', err.message);
    res.status(500).json({ error: err.message || 'Server error submitting request' });
  }
});

// ── List time-off requests ──
app.get('/api/time-off', requireAuth, async (req, res) => {
  const { status, user_id, from_date, to_date, archived } = req.query;
  const params = []; let where = []; let p = 0;

  // archived=1 → show only archived; default → show only non-archived
  const showArchived = archived === '1';
  p++; where.push(`COALESCE(r.archived,0)=$${p}`); params.push(showArchived ? 1 : 0);

  if (canApproveTimeOff(req.user)) {
    // Admins and approvers see all requests (with optional filters)
    if (user_id) { p++; where.push(`r.user_id=$${p}`); params.push(parseInt(user_id)); }
    if (status)  { p++; where.push(`r.status=$${p}`);  params.push(status); }
  } else {
    // Regular field users: own requests only (private — don't expose others' pending/denied)
    p++; where.push(`r.user_id=$${p}`); params.push(req.user.id);
  }
  if (from_date) { p++; where.push(`r.end_date>=$${p}`);   params.push(from_date); }
  if (to_date)   { p++; where.push(`r.start_date<=$${p}`); params.push(to_date); }
  const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT r.*, u.name AS requester_name, u.time_off_color FROM time_off_requests r
     LEFT JOIN users u ON u.id=r.user_id ${wc} ORDER BY r.created_at DESC`, params);
  res.json(rows);
});

// ── Calendar data ──
// Admins: see all approved + pending
// Field users: see their OWN (any status) + OTHER PEOPLE'S approved only (not pending from others)
app.get('/api/time-off/calendar', requireAuth, async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    let params = []; let where = []; let p = 0;

    // Never show archived records on the calendar
    where.push(`COALESCE(r.archived,0)=0`);

    if (canApproveTimeOff(req.user)) {
      // Admins and time-off approvers see all pending + approved
      where.push(`r.status IN ('pending','approved')`);
    } else {
      // Regular field users: own requests (any non-cancelled status) + others' approved only
      // Pending requests from other people are PRIVATE
      p++; params.push(req.user.id);
      where.push(`(r.user_id=$${p} OR r.status='approved')`);
      where.push(`r.status != 'cancelled'`);
    }

    if (from_date) { p++; where.push(`r.end_date>=$${p}`);   params.push(from_date); }
    if (to_date)   { p++; where.push(`r.start_date<=$${p}`); params.push(to_date); }

    const { rows } = await pool.query(
      `SELECT r.id,r.user_id,r.user_name,r.start_date,r.end_date,r.return_to_work_date,r.half_day,r.type,r.note,r.status,u.time_off_color
       FROM time_off_requests r LEFT JOIN users u ON u.id=r.user_id WHERE ${where.join(' AND ')} ORDER BY r.start_date`, params);
    res.json(rows);
  } catch (err) {
    console.error('calendar endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Get single request ──
app.get('/api/time-off/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM time_off_requests WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (!canApproveTimeOff(req.user) && rows[0].user_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });
    const { rows: audit } = await pool.query('SELECT * FROM time_off_audit WHERE request_id=$1 ORDER BY created_at ASC', [req.params.id]);
    res.json({ ...rows[0], audit });
  } catch (err) {
    console.error('get time-off/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: create timesheet_override "Time Off" rows for each day in range ──
async function createTimeOffTimesheetRows(requestId, userId, startDate, endDate) {
  const s = new Date(startDate + 'T00:00:00Z');
  const e = new Date(endDate   + 'T00:00:00Z');
  const now = new Date().toISOString();
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    // Only insert if no existing non-time-off override for that day
    await pool.query(`
      INSERT INTO timesheet_overrides
        (employee_user_id,date,regular_hours,overtime_hours,travel_hours,
         original_regular,original_ot,original_travel,
         edited_by_name,edit_reason,is_time_off,time_off_request_id,created_at)
      VALUES ($1,$2,0,0,0,0,0,0,'System','Time Off Approved',1,$3,$4)
      ON CONFLICT (employee_user_id,date) DO NOTHING`,
      [userId, dateStr, requestId, now]);
  }
}

// ── Helper: remove timesheet_override "Time Off" rows for a request ──
async function removeTimeOffTimesheetRows(requestId) {
  await pool.query(
    `DELETE FROM timesheet_overrides WHERE time_off_request_id=$1 AND is_time_off=1`,
    [requestId]
  );
}

// ── Admin: approve or deny ──
// ── Helper: check if user can approve time off ──
function canApproveTimeOff(user) {
  if (user.role === 'admin') return true;
  const perms = (user.permissions || '').split(',').map(p => p.trim());
  return perms.includes('time_off_approve');
}

app.patch('/api/time-off/:id/review', requireAuth, async (req, res) => {
  if (!canApproveTimeOff(req.user)) return res.status(403).json({ error: 'You do not have permission to approve time off requests' });
  try {
    const { status, review_note } = req.body;
    if (!['approved', 'denied'].includes(status)) return res.status(400).json({ error: 'status must be approved or denied' });
    const { rows } = await pool.query('SELECT * FROM time_off_requests WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (rows[0].status !== 'pending') return res.status(400).json({ error: 'Can only review pending requests' });
    const req_data = rows[0];
    const now = new Date().toISOString();
    await pool.query(`UPDATE time_off_requests SET status=$1,reviewed_by_id=$2,reviewed_by=$3,reviewed_at=$4,review_note=$5,updated_at=$4 WHERE id=$6`,
      [status, req.user.id, req.user.name, now, review_note || null, req.params.id]);
    await pool.query('INSERT INTO time_off_audit (request_id,user_name,action,details,created_at) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, req.user.name, status, review_note ? `Note: ${review_note}` : null, now]);
    // On approval: write time-off rows to timesheet (non-fatal — don't block approval if this fails)
    if (status === 'approved') {
      try {
        await createTimeOffTimesheetRows(parseInt(req.params.id), req_data.user_id, req_data.start_date, req_data.end_date);
      } catch (tsErr) {
        console.error('createTimeOffTimesheetRows failed (non-fatal):', tsErr.message);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('review time-off error:', err.message);
    res.status(500).json({ error: err.message || 'Server error processing approval' });
  }
});

// ── Field user: cancel own pending request ──
app.patch('/api/time-off/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM time_off_requests WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });
    if (!['pending','approved'].includes(rows[0].status)) return res.status(400).json({ error: 'Can only cancel pending or approved requests' });
    const now = new Date().toISOString();
    await pool.query(`UPDATE time_off_requests SET status='cancelled',updated_at=$1 WHERE id=$2`, [now, req.params.id]);
    await pool.query('INSERT INTO time_off_audit (request_id,user_name,action,details,created_at) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, req.user.name, 'cancelled', 'Request cancelled', now]);
    await removeTimeOffTimesheetRows(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('cancel time-off error:', err.message);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// ── Bulk archive (MUST be before /:id to avoid route collision) ──
app.patch('/api/time-off/bulk-archive', requireAuth, async (req, res) => {
  if (!canApproveTimeOff(req.user)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { ids, archived } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    const safeIds = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!safeIds.length) return res.status(400).json({ error: 'No valid IDs' });
    const val = archived ? 1 : 0;
    await pool.query(`UPDATE time_off_requests SET archived=$1 WHERE id = ANY($2::int[])`, [val, safeIds]);
    res.json({ ok: true });
  } catch (err) {
    console.error('bulk-archive time-off error:', err.message);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// ── Field user: edit own pending or cancelled request ──
app.patch('/api/time-off/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM time_off_requests WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });
    if (!['pending','cancelled'].includes(rows[0].status))
      return res.status(400).json({ error: 'Only pending or cancelled requests can be edited' });
    const { type, start_date, end_date, return_to_work_date, half_day, note } = req.body;
    if (!type || !start_date || !end_date) return res.status(400).json({ error: 'type, start_date and end_date are required' });
    if (start_date > end_date) return res.status(400).json({ error: 'start_date must be on or before end_date' });
    const now = new Date().toISOString();
    const newStatus = 'pending';
    await pool.query(
      `UPDATE time_off_requests SET type=$1,start_date=$2,end_date=$3,return_to_work_date=$4,half_day=$5,note=$6,status=$7,updated_at=$8 WHERE id=$9`,
      [type, start_date, end_date, return_to_work_date || null, half_day || null, note || null, newStatus, now, req.params.id]
    );
    await pool.query('INSERT INTO time_off_audit (request_id,user_name,action,details,created_at) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, req.user.name, 'edited', `Edited and re-submitted as ${newStatus}`, now]);
    res.json({ ok: true });
  } catch (err) {
    console.error('edit time-off error:', err.message);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// ── Archive / un-archive a single request (admin/approver only) ──
app.patch('/api/time-off/:id/archive', requireAuth, async (req, res) => {
  if (!canApproveTimeOff(req.user)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { archived } = req.body;
    await pool.query(`UPDATE time_off_requests SET archived=$1 WHERE id=$2`, [archived ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('archive time-off error:', err.message);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// ── Delete a request ──
// Admin/approver: can delete any status; field user: can only delete own cancelled/denied
// ── Bulk delete (admin/approver only) — MUST be before /:id route ──
app.delete('/api/time-off/bulk-delete', requireAuth, async (req, res) => {
  if (!canApproveTimeOff(req.user)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    const safeIds = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!safeIds.length) return res.status(400).json({ error: 'No valid IDs' });
    for (const id of safeIds) await removeTimeOffTimesheetRows(id);
    const { rowCount } = await pool.query(
      `DELETE FROM time_off_requests WHERE id = ANY($1::int[])`, [safeIds]
    );
    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    console.error('bulk-delete time-off error:', err.message);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// ── Delete a single request ──
// Admin/approver: any status; field user: own cancelled/denied only
app.delete('/api/time-off/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM time_off_requests WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (!canApproveTimeOff(req.user)) {
      if (rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
      if (!['cancelled','denied'].includes(rows[0].status))
        return res.status(400).json({ error: 'Only cancelled or denied requests can be deleted' });
    }
    await removeTimeOffTimesheetRows(parseInt(req.params.id));
    await pool.query('DELETE FROM time_off_requests WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('delete time-off error:', err.message);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// ── My notifications: approved/denied requests the user hasn't acknowledged ──
app.get('/api/time-off/my-notifications', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id,type,start_date,end_date,status,reviewed_at,review_note
     FROM time_off_requests
     WHERE user_id=$1 AND status IN ('approved','denied') ORDER BY reviewed_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// ── Dashboard overview includes pending time-off count ──
// (Exposed via /api/time-off/pending-count for nav badge)
app.get('/api/time-off/pending-count', requireAuth, async (req, res) => {
  if (!canApproveTimeOff(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const { rows } = await pool.query("SELECT COUNT(*) AS c FROM time_off_requests WHERE status='pending'");
  res.json({ count: parseInt(rows[0].c) });
});

// ─────────────────────────────────────────────
// SAFETY
// ─────────────────────────────────────────────

// Generate safety form number
function generateSafetyNumber(type) {
  const prefix = { flha: 'FLHA', jsa: 'JSA', incident: 'INC', inspection: 'INSP' }[type] || 'SAFE';
  const now = new Date();
  const stamp = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '-' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `${prefix}-${stamp}-${rand}`;
}

// Forms where current user is listed as worker but hasn't signed
app.get('/api/safety/pending-signatures', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, form_type, form_number, date, submitted_by, project_name, form_data
       FROM safety_forms WHERE archived=0 AND status='Submitted'
       ORDER BY submitted_at DESC LIMIT 100`
    );
    const userId   = String(req.user.id);
    const userName = req.user.name.toLowerCase().trim();
    // Flexible name match: "jeremy" matches "jeremy williams" and vice versa
    const nameMatches = (wName) => {
      const w = (wName || '').toLowerCase().trim();
      return w === userName || userName.startsWith(w + ' ') || w.startsWith(userName + ' ');
    };
    const pending = rows.filter(f => {
      try {
        const d = typeof f.form_data === 'string' ? JSON.parse(f.form_data) : f.form_data;
        const workers = d.workers || [];
        const sigs    = d.worker_signatures || {};
        const listed = workers.some(w =>
          (w.user_id && String(w.user_id) === userId) ||
          (!w.user_id && nameMatches(w.name))
        );
        const signed = workers.some(w =>
          ((w.user_id && String(w.user_id) === userId) || (!w.user_id && nameMatches(w.name))) &&
          w.signed_at
        ) || Object.keys(sigs).some(k => nameMatches(k));
        return listed && !signed;
      } catch { return false; }
    }).map(({ form_data, ...rest }) => rest);
    res.json(pending);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List archived safety forms (admin only)
app.get('/api/safety/archived', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, form_type, form_number, project_name, job_number, submitted_by,
              submitted_at, date, status
       FROM safety_forms WHERE archived = 1 ORDER BY submitted_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List safety forms (admin sees all, field sees own)
// Form types restricted to admins only
const ADMIN_ONLY_FORM_TYPES = ['incident_report','near_miss','corrective_action','ojt_record','emergency_review'];

app.get('/api/safety', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    if (isAdmin) {
      const { rows } = await pool.query(
        `SELECT id, form_type, form_number, project_name, job_number, submitted_by,
                submitted_at, date, status, archived
         FROM safety_forms WHERE archived = 0
         ORDER BY submitted_at DESC LIMIT 500`
      );
      return res.json(rows);
    }
    // Non-admins: own forms only, admin-only types never visible
    const placeholders = ADMIN_ONLY_FORM_TYPES.map((_, i) => `$${i + 2}`).join(',');
    const { rows } = await pool.query(
      `SELECT id, form_type, form_number, project_name, job_number, submitted_by,
              submitted_at, date, status, archived
       FROM safety_forms
       WHERE archived = 0
         AND submitted_by_id = $1
         AND form_type NOT IN (${placeholders})
       ORDER BY submitted_at DESC LIMIT 200`,
      [req.user.id, ...ADMIN_ONLY_FORM_TYPES]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Submit a safety form
app.post('/api/safety', requireAuth, async (req, res) => {
  try {
    const { form_type, project_id, job_number, date, form_data } = req.body;
    if (!form_type || !date) return res.status(400).json({ error: 'form_type and date are required' });
    const form_number = generateSafetyNumber(form_type);
    // Resolve project name if project_id provided
    let project_name = req.body.project_name || null;
    if (project_id && !project_name) {
      const { rows } = await pool.query('SELECT name FROM projects WHERE id=$1', [project_id]);
      project_name = rows[0]?.name || null;
    }
    const { rows } = await pool.query(
      `INSERT INTO safety_forms (form_type, form_number, project_id, project_name, job_number,
         submitted_by_id, submitted_by, submitted_at, date, status, form_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Submitted',$10)
       RETURNING id, form_number`,
      [form_type, form_number, project_id || null, project_name, job_number || null,
       req.user.id, req.user.name, new Date().toISOString(), date,
       JSON.stringify(form_data || {})]
    );
    logAction(req, 'safety_form_submitted', rows[0].id, rows[0].form_number, `${form_type} submitted by ${req.user.name}`);
    const formId     = rows[0].id;
    const formNumber = rows[0].form_number;

    // Update vehicle record when truck inspection is submitted
    if (form_type === 'maint_vehicle' && form_data?.vehicle_id) {
      const vid = parseInt(form_data.vehicle_id);
      if (!isNaN(vid)) {
        const updates = [];
        const vals = [];
        let idx = 1;
        if (form_data.odometer) { updates.push(`current_odometer=$${idx++}`); vals.push(parseInt(form_data.odometer)); }
        if (form_data.oil_change_km) { updates.push(`next_oil_change_km=$${idx++}`); vals.push(parseInt(form_data.oil_change_km)); }
        updates.push(`last_inspection_date=$${idx++}`); vals.push(form_data.date || new Date().toISOString().slice(0,10));
        if (form_data.ins_expiry)  { updates.push(`insurance_expiry=$${idx++}`);     vals.push(form_data.ins_expiry); }
        if (form_data.reg_expiry)  { updates.push(`registration_expiry=$${idx++}`);  vals.push(form_data.reg_expiry); }
        if (updates.length) {
          vals.push(vid);
          await pool.query(`UPDATE vehicles SET ${updates.join(',')} WHERE id=$${idx}`, vals);
        }
      }
    }

    // Notify admins if inspection has failures, defects, corrective actions, or OOS result
    notifyAdminsOnSafetyAlert(form_type, formNumber, formId, form_data, req.user.name, project_name).catch(() => {});

    res.status(201).json({ id: formId, form_number: formNumber });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Safety alert notifications ────────────────────────────────────────────────
const FORM_LABELS = {
  fall_protection: 'Fall Protection Inspection',
  hazard_assessment: 'Hazard Assessment',
  aerial_ewp: 'Aerial / EWP Pre-Use',
  vehicle_inspection: 'Vehicle Inspection',
};

async function createNotification(userId, type, title, body, link) {
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, link, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, type, title, body || null, link || null, new Date().toISOString()]
  );
}

async function notifyAdminsOnSafetyAlert(form_type, formNumber, formId, form_data, submitterName, projectName) {
  if (!form_data) return;

  // Gather reasons to alert
  const alerts = [];
  const result = form_data.overall_result;
  if (result === 'oos') alerts.push('Equipment marked OUT OF SERVICE');
  if (result === 'replace') alerts.push('Equipment marked for replacement');

  // Any pass/fail section with a fail
  const pfSections = ['harness','lanyard','carabiner','aerial','vehicle'];
  for (const sec of pfSections) {
    const vals = form_data[sec];
    if (!vals) continue;
    const failItems = Object.entries(vals).filter(([,v]) => v && v.state === 'fail').map(([k]) => k);
    if (failItems.length) alerts.push(`Failures in ${sec}: ${failItems.join(', ')}`);
  }

  // Defective flag set to yes
  if (form_data.defect_flag === 'yes') alerts.push('Equipment was pre-tagged defective');

  // Corrective actions logged
  const cas = (form_data.corrective_actions || []).filter(c => c.action);
  if (cas.length) alerts.push(`${cas.length} corrective action(s) logged`);

  if (!alerts.length) return;

  const formLabel = FORM_LABELS[form_type] || form_type.replace(/_/g,' ');
  const title  = `⚠ Safety Alert — ${formLabel} ${formNumber}`;
  const body   = `Submitted by ${submitterName}${projectName ? ' · ' + projectName : ''}.\n${alerts.join('\n')}`;
  const link   = `/safety-form-${form_type.replace(/_/g,'-')}.html?id=${formId}`;

  const { rows: admins } = await pool.query(
    `SELECT id FROM users WHERE role='admin' AND status='active'`
  );
  for (const a of admins) {
    await createNotification(a.id, 'safety_alert', title, body, link);
  }
}

// Send in-app notifications to unsigned workers on a safety form
app.post('/api/safety/notify-workers', requireAuth, async (req, res) => {
  try {
    const { form_id, form_number, form_type } = req.body;
    if (!form_id) return res.status(400).json({ error: 'form_id required' });
    const { rows } = await pool.query('SELECT form_data FROM safety_forms WHERE id=$1', [parseInt(form_id)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const form_data = typeof rows[0].form_data === 'string' ? JSON.parse(rows[0].form_data) : rows[0].form_data;
    const workers = form_data?.workers || [];
    const sigs    = form_data?.worker_signatures || {};
    const unsigned = workers.filter(w => {
      if (!w.name) return false;
      const wn = w.name.toLowerCase().trim();
      return !Object.keys(sigs).some(k => {
        const kn = k.toLowerCase().trim();
        return kn === wn || wn.startsWith(kn + ' ') || kn.startsWith(wn + ' ');
      });
    });
    const formSlug = (form_type || 'hazard-assessment').replace(/_/g, '-');
    const link = `/safety-form-${formSlug}.html?id=${form_id}`;
    let count = 0;
    for (const w of unsigned) {
      const { rows: urows } = await pool.query(
        `SELECT id FROM users WHERE LOWER(TRIM(name))=LOWER(TRIM($1)) AND status='active' LIMIT 1`,
        [w.name]
      );
      if (!urows[0]?.id) continue;
      await createNotification(
        urows[0].id,
        'signature_request',
        `Please sign Safety Form ${form_number || form_id}`,
        `You have been added to a safety form that requires your signature.`,
        link
      );
      count++;
    }
    res.json({ ok: true, notified: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Notification API endpoints
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, type, title, body, link, read, created_at
       FROM notifications WHERE user_id=$1
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET read=1 WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE notifications SET read=1 WHERE user_id=$1`, [req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function sendSignatureRequestEmails(form_data, formId, formNumber, submitterName, form_type) {
  const workers = form_data?.workers || [];
  const sigs    = form_data?.worker_signatures || {};
  const unsigned = workers.filter(w => w.name && !Object.keys(sigs).some(k => k.toLowerCase() === w.name.toLowerCase()));
  if (!unsigned.length) return;

  const smtpHost = await getSetting('smtp_host');
  if (!smtpHost) return;

  const transport = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(await getSetting('smtp_port', '587')),
    auth: { user: await getSetting('smtp_user'), pass: await getSetting('smtp_pass') }
  });
  const fromAddr = await getSetting('smtp_from', 'noreply@jdwesternelectric.ca');
  const appUrl   = await getSetting('app_url', 'http://localhost:3000');

  const FORM_URLS = {
    hazard_assessment: 'safety-form-hazard.html',
    fall_protection:   'safety-form-fall.html',
    aerial_lift:       'safety-form-aerial-lift.html',
    erp:               'safety-form-erp.html',
    near_miss:         'safety-form-near-miss.html',
    incident_report:   'safety-form-incident-report.html',
    safety_meeting:    'safety-form-safety-meeting.html',
    maint_vehicle:     'safety-form-truck-inspection.html',
  };
  const formPage = FORM_URLS[form_type] || 'safety-form-hazard.html';

  for (const w of unsigned) {
    const { rows } = await pool.query(
      `SELECT email FROM users WHERE LOWER(TRIM(name))=LOWER(TRIM($1)) AND status='active' LIMIT 1`,
      [w.name]
    );
    if (!rows[0]?.email) continue;
    const link = `${appUrl}/${formPage}?id=${formId}`;
    await transport.sendMail({
      from: fromAddr,
      to: rows[0].email,
      subject: `Action Required — Please sign Safety Form ${formNumber}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
          <div style="background:#111827;padding:20px;border-radius:8px 8px 0 0;">
            <h2 style="color:#F47920;margin:0;">J&amp;D Western Electric</h2>
            <p style="color:rgba(255,255,255,.6);margin:4px 0 0;font-size:13px;">Field Operations Hub</p>
          </div>
          <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px;">
            <p style="margin:0 0 16px;">Hi <strong>${w.name}</strong>,</p>
            <p style="margin:0 0 16px;">
              <strong>${submitterName}</strong> has submitted a Safety Form that requires your signature:
            </p>
            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin:0 0 20px;">
              <div style="font-size:13px;color:#6b7280;">Form Number</div>
              <div style="font-size:18px;font-weight:700;color:#111827;">${formNumber}</div>
            </div>
            <p style="margin:0 0 20px;font-size:14px;color:#374151;">
              Please open the form on your phone, review the hazard assessment, and add your signature at the bottom.
            </p>
            <a href="${link}" style="display:block;background:#F47920;color:#fff;text-align:center;padding:14px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">
              ✍️ Open Form &amp; Sign
            </a>
            <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;text-align:center;">
              J&amp;D Western Electric Ltd &nbsp;·&nbsp; jdwesternelectric.ca
            </p>
          </div>
        </div>`
    });
  }
}

// Get single safety form
app.get('/api/safety/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM safety_forms WHERE id=$1', [parseInt(req.params.id)]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    // Admin-only form types are never accessible to non-admins
    if (req.user.role !== 'admin' && ADMIN_ONLY_FORM_TYPES.includes(rows[0].form_type))
      return res.status(403).json({ error: 'Access restricted to administrators' });
    const fd = JSON.parse(rows[0].form_data || '{}');
    const listedWorker = (fd.workers || []).some(w =>
      (w.user_id && String(w.user_id) === String(req.user.id)) ||
      (!w.user_id && w.name && w.name.toLowerCase() === req.user.name.toLowerCase())
    );
    if (req.user.role !== 'admin' && rows[0].submitted_by_id !== req.user.id && !listedWorker)
      return res.status(403).json({ error: 'Forbidden' });
    res.json({ ...rows[0], form_data: fd });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Archive a safety form globally (admin only)
app.patch('/api/safety/:id/archive', requireAdmin, async (req, res) => {
  try {
    const { unarchive } = req.body || {};
    if (unarchive) {
      await pool.query('UPDATE safety_forms SET archived=0, archived_at=NULL WHERE id=$1', [parseInt(req.params.id)]);
    } else {
      await pool.query('UPDATE safety_forms SET archived=1, archived_at=$1 WHERE id=$2',
        [new Date().toISOString(), parseInt(req.params.id)]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Archive/unarchive safety form within a project
app.patch('/api/safety/:id/project-archive', requireAdmin, async (req, res) => {
  try {
    const { archive } = req.body;
    await pool.query('UPDATE safety_forms SET project_archived=$1 WHERE id=$2',
      [archive ? 1 : 0, parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk-archive safety forms — must be before /:id route (admin only)
app.post('/api/safety/bulk-archive', requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    const safe = ids.map(Number).filter(n => n > 0);
    await pool.query(
      `UPDATE safety_forms SET archived=1, archived_at=$1 WHERE id = ANY($2::int[])`,
      [new Date().toISOString(), safe]
    );
    res.json({ ok: true, count: safe.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk-delete safety forms — must be before /:id route (admin only)
app.delete('/api/safety/bulk-delete', requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    const safe = ids.map(Number).filter(n => n > 0);
    await pool.query('DELETE FROM safety_forms WHERE id = ANY($1::int[])', [safe]);
    res.json({ ok: true, count: safe.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Hard-delete a single safety form (admin only)
app.delete('/api/safety/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM safety_forms WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update / save draft safety form
app.patch('/api/safety/:id', requireAuth, async (req, res) => {
  try {
    const { form_data, status, project_id, project_name, job_number } = req.body;
    const { rows } = await pool.query('SELECT * FROM safety_forms WHERE id=$1', [parseInt(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const f = rows[0];
    if (req.user.role !== 'admin' && ADMIN_ONLY_FORM_TYPES.includes(f.form_type))
      return res.status(403).json({ error: 'Access restricted to administrators' });
    const fd = typeof f.form_data === 'string' ? JSON.parse(f.form_data) : (f.form_data || {});
    const listedWorker = (fd.workers || []).some(w =>
      (w.user_id && String(w.user_id) === String(req.user.id)) ||
      (!w.user_id && w.name && w.name.toLowerCase() === req.user.name.toLowerCase())
    );
    if (req.user.role !== 'admin' && f.submitted_by_id !== req.user.id && !listedWorker)
      return res.status(403).json({ error: 'Forbidden' });
    await pool.query(
      `UPDATE safety_forms SET form_data=COALESCE($1,form_data), status=COALESCE($2,status),
       project_id=COALESCE($3,project_id), project_name=COALESCE($4,project_name),
       job_number=COALESCE($5,job_number) WHERE id=$6`,
      [form_data ? JSON.stringify(form_data) : null, status, project_id, project_name, job_number, parseInt(req.params.id)]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Set PSI / WCB flags (admin only)
app.patch('/api/safety/:id/flags', requireAdmin, async (req, res) => {
  try {
    const { psi_flag, wcb_flag, reviewed_by } = req.body;
    await pool.query(
      `UPDATE safety_forms SET psi_flag=COALESCE($1,psi_flag), wcb_flag=COALESCE($2,wcb_flag),
       reviewed_by=COALESCE($3,reviewed_by), reviewed_at=$4 WHERE id=$5`,
      [psi_flag, wcb_flag, reviewed_by || req.user.name, new Date().toISOString(), parseInt(req.params.id)]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// SAFETY PHOTO UPLOAD
// ─────────────────────────────────────────────

const safetyPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'uploads', 'safety')),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `sp-${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const safetyPhotoUpload = multer({
  storage: safetyPhotoStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

app.post('/api/uploads/safety-photo', requireAuth, safetyPhotoUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file' });
  const url = '/uploads/safety/' + req.file.filename;
  try {
    await pool.query(
      `INSERT INTO safety_attachments (attachment_type, field_key, file_path, uploaded_by_id, uploaded_at)
       VALUES ('photo', $1, $2, $3, $4)`,
      [req.body.field_key || null, url, req.user.id, new Date().toISOString()]
    );
  } catch {}
  res.json({ url, filename: req.file.filename });
});

// ─────────────────────────────────────────────
// VEHICLES
// ─────────────────────────────────────────────

// Fleet notification settings
app.get('/api/fleet-settings', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('fleet_notify_days_1','fleet_notify_days_2')`);
    const s = Object.fromEntries(rows.map(r => [r.key, parseInt(r.value)]));
    res.json({ notify_days_1: s.fleet_notify_days_1 ?? 30, notify_days_2: s.fleet_notify_days_2 ?? 7 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fleet-settings', requireAdmin, async (req, res) => {
  try {
    const { notify_days_1, notify_days_2 } = req.body;
    if (notify_days_1 != null) await pool.query(`INSERT INTO app_settings(key,value) VALUES('fleet_notify_days_1',$1) ON CONFLICT(key) DO UPDATE SET value=$1`, [String(parseInt(notify_days_1))]);
    if (notify_days_2 != null) await pool.query(`INSERT INTO app_settings(key,value) VALUES('fleet_notify_days_2',$1) ON CONFLICT(key) DO UPDATE SET value=$1`, [String(parseInt(notify_days_2))]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/vehicles', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM vehicles WHERE status != 'deleted' ORDER BY unit_number`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/vehicles', requireAdmin, async (req, res) => {
  try {
    const { unit_number, make, model, year, vin, license_plate, notes } = req.body;
    if (!unit_number) return res.status(400).json({ error: 'unit_number required' });
    const { rows } = await pool.query(
      `INSERT INTO vehicles (unit_number, make, model, year, vin, license_plate, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [unit_number, make||null, model||null, year||null, vin||null, license_plate||null, notes||null, new Date().toISOString()]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/vehicles/:id', requireAdmin, async (req, res) => {
  try {
    const { unit_number, make, model, year, vin, license_plate, status, notes,
            current_odometer, next_oil_change_km, last_oil_change_date,
            insurance_expiry, registration_expiry } = req.body;
    await pool.query(
      `UPDATE vehicles SET unit_number=COALESCE($1,unit_number), make=COALESCE($2,make), model=COALESCE($3,model),
       year=COALESCE($4,year), vin=COALESCE($5,vin), license_plate=COALESCE($6,license_plate),
       status=COALESCE($7,status), notes=COALESCE($8,notes),
       current_odometer=COALESCE($10,current_odometer),
       next_oil_change_km=COALESCE($11,next_oil_change_km),
       last_oil_change_date=COALESCE($12,last_oil_change_date),
       insurance_expiry=COALESCE($13,insurance_expiry),
       registration_expiry=COALESCE($14,registration_expiry)
       WHERE id=$9`,
      [unit_number, make, model, year, vin, license_plate, status, notes, parseInt(req.params.id),
       current_odometer || null, next_oil_change_km || null, last_oil_change_date || null,
       insurance_expiry || null, registration_expiry || null]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function _expiryStatus(dateStr, warn1Days, warn2Days) {
  if (!dateStr) return 'unknown';
  const today = new Date(); today.setHours(0,0,0,0);
  const exp = new Date(dateStr + 'T00:00:00');
  const daysLeft = Math.ceil((exp - today) / 86400000);
  if (daysLeft < 0)          return 'expired';
  if (daysLeft <= warn2Days) return 'critical';
  if (daysLeft <= warn1Days) return 'warning';
  return 'ok';
}

// Fleet expiry notifications — fires at most once per day per vehicle/doc type
const _fleetNotifyCache = new Map(); // key: `${vehicleId}-${type}` → date string
async function _checkFleetExpiryNotifications(vehicles, notify_days_1, notify_days_2) {
  try {
    const { rows: admins } = await pool.query(`SELECT id FROM users WHERE role='admin' AND status='active'`);
    if (!admins.length) return;
    const today = new Date().toISOString().slice(0, 10);
    for (const v of vehicles) {
      for (const [field, label] of [['insurance_expiry','Insurance'],['registration_expiry','Registration']]) {
        const dateStr = v[field];
        if (!dateStr) continue;
        const status = _expiryStatus(dateStr, notify_days_1, notify_days_2);
        if (status === 'ok' || status === 'unknown') continue;
        const cacheKey = `${v.id}-${field}`;
        if (_fleetNotifyCache.get(cacheKey) === today) continue; // already notified today
        _fleetNotifyCache.set(cacheKey, today);
        const exp = new Date(dateStr + 'T00:00:00');
        const daysLeft = Math.ceil((exp - new Date().setHours(0,0,0,0)) / 86400000);
        const unit = v.unit_number || `Vehicle #${v.id}`;
        const title = status === 'expired'
          ? `⚠ ${label} EXPIRED — ${unit}`
          : `⚠ ${label} expiring soon — ${unit}`;
        const body = status === 'expired'
          ? `${label} for ${unit} expired on ${dateStr}. Update the paperwork immediately.`
          : `${label} for ${unit} expires on ${dateStr} (${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining).`;
        for (const a of admins) {
          await createNotification(a.id, 'fleet_expiry', title, body, '/safety.html#fleet');
        }
      }
    }
  } catch (e) { console.error('Fleet expiry notify error:', e.message); }
}

// Vehicle maintenance status (for office dashboard)
app.get('/api/vehicles/maintenance-status', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM vehicles WHERE status != 'deleted' ORDER BY unit_number`);
    const { rows: settingRows } = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('fleet_notify_days_1','fleet_notify_days_2')`);
    const settings = Object.fromEntries(settingRows.map(r => [r.key, parseInt(r.value)]));
    const notify_days_1 = settings.fleet_notify_days_1 ?? 30;
    const notify_days_2 = settings.fleet_notify_days_2 ?? 7;
    const result = rows.map(v => {
      const kmUntil = (v.next_oil_change_km && v.current_odometer)
        ? v.next_oil_change_km - v.current_odometer : null;
      return {
        ...v,
        km_until_oil_change: kmUntil,
        oil_change_status: kmUntil === null ? 'unknown'
          : kmUntil <= 0 ? 'overdue'
          : kmUntil <= 500 ? 'due_soon'
          : 'ok',
        insurance_expiry_status: _expiryStatus(v.insurance_expiry, notify_days_1, notify_days_2),
        registration_expiry_status: _expiryStatus(v.registration_expiry, notify_days_1, notify_days_2),
      };
    });
    // Fire expiry notifications in background (non-blocking)
    _checkFleetExpiryNotifications(rows, notify_days_1, notify_days_2).catch(() => {});
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Vehicle documents
app.get('/api/vehicles/:id/documents', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, file_type, uploaded_by, uploaded_at, notes FROM vehicle_documents WHERE vehicle_id=$1 ORDER BY uploaded_at DESC`,
      [parseInt(req.params.id)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/vehicles/:id/documents/:docId/file', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT data_url, name, file_type FROM vehicle_documents WHERE id=$1 AND vehicle_id=$2`, [parseInt(req.params.docId), parseInt(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const doc = rows[0];
    const base64 = doc.data_url.split(',')[1] || doc.data_url;
    const buf = Buffer.from(base64, 'base64');
    res.set('Content-Type', doc.file_type || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${doc.name}"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/vehicles/:id/documents', requireAdmin, async (req, res) => {
  try {
    const { name, file_type, data_url, notes } = req.body;
    if (!name || !data_url) return res.status(400).json({ error: 'name and data_url required' });
    const { rows } = await pool.query(
      `INSERT INTO vehicle_documents (vehicle_id, name, file_type, data_url, uploaded_by, uploaded_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, file_type, uploaded_by, uploaded_at, notes`,
      [parseInt(req.params.id), name, file_type || null, data_url, req.user.name, new Date().toISOString(), notes || null]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/vehicles/:id/documents/:docId', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM vehicle_documents WHERE id=$1 AND vehicle_id=$2`, [parseInt(req.params.docId), parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// SCHEDULED MAINTENANCE
// ─────────────────────────────────────────────

// Scheduled maintenance
app.get('/api/scheduled-maintenance', requireAdmin, async (req, res) => {
  try {
    const vehicleId = req.query.vehicle_id ? parseInt(req.query.vehicle_id) : null;
    const { rows } = await pool.query(
      `SELECT sm.*, v.unit_number, v.make, v.model, v.year
       FROM scheduled_maintenance sm
       JOIN vehicles v ON v.id = sm.vehicle_id
       ${vehicleId ? 'WHERE sm.vehicle_id=$1' : ''}
       ORDER BY sm.scheduled_date ASC`,
      vehicleId ? [vehicleId] : []
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/scheduled-maintenance', requireAdmin, async (req, res) => {
  try {
    const { vehicle_id, maintenance_type, title, scheduled_date, notes } = req.body;
    if (!vehicle_id || !title || !scheduled_date) return res.status(400).json({ error: 'vehicle_id, title, scheduled_date required' });
    const { rows } = await pool.query(
      `INSERT INTO scheduled_maintenance (vehicle_id, maintenance_type, title, scheduled_date, notes, status, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,'scheduled',$6,$7) RETURNING *`,
      [parseInt(vehicle_id), maintenance_type || 'other', title, scheduled_date, notes || null, req.user.name, new Date().toISOString()]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/scheduled-maintenance/:id', requireAdmin, async (req, res) => {
  try {
    const { title, maintenance_type, scheduled_date, notes, status, completed_date, completed_notes } = req.body;
    await pool.query(
      `UPDATE scheduled_maintenance SET
       title=COALESCE($1,title), maintenance_type=COALESCE($2,maintenance_type),
       scheduled_date=COALESCE($3,scheduled_date), notes=COALESCE($4,notes),
       status=COALESCE($5,status), completed_date=$6, completed_notes=$7
       WHERE id=$8`,
      [title||null, maintenance_type||null, scheduled_date||null, notes||null,
       status||null, completed_date||null, completed_notes||null, parseInt(req.params.id)]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/scheduled-maintenance/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM scheduled_maintenance WHERE id=$1`, [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Vehicle inspection history (safety forms linked to a vehicle)
app.get('/api/vehicles/:id/inspections', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, form_number, form_type, submitted_at, submitted_by, status, form_data
       FROM safety_forms
       WHERE (form_data::jsonb->>'vehicle_id')::text = $1::text AND archived=0
       ORDER BY submitted_at DESC LIMIT 100`,
      [parseInt(req.params.id)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete vehicle (soft delete)
app.delete('/api/vehicles/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE vehicles SET status='deleted' WHERE id=$1`, [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// CORRECTIVE ACTIONS
// ─────────────────────────────────────────────

app.get('/api/corrective-actions', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const { status, project_id } = req.query;
    let q = `SELECT ca.*, u.name as assigned_to_display
             FROM corrective_actions ca
             LEFT JOIN users u ON u.id = ca.assigned_to_id
             WHERE 1=1`;
    const params = [];
    if (!isAdmin) { params.push(req.user.id); q += ` AND (ca.created_by_id=$${params.length} OR ca.assigned_to_id=$${params.length})`; }
    if (status)     { params.push(status);     q += ` AND ca.status=$${params.length}`; }
    if (project_id) { params.push(project_id); q += ` AND ca.project_id=$${params.length}`; }
    q += ' ORDER BY ca.created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/corrective-actions', requireAuth, async (req, res) => {
  try {
    const { source_form_type, source_form_id, source_form_number, project_id, action, assigned_to_id, assigned_to_name, due_date, notes } = req.body;
    if (!action) return res.status(400).json({ error: 'action required' });
    const { rows } = await pool.query(
      `INSERT INTO corrective_actions (source_form_type, source_form_id, source_form_number, project_id,
       action, assigned_to_id, assigned_to_name, due_date, notes, created_by_id, created_by_name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [source_form_type||'manual', source_form_id||null, source_form_number||null, project_id||null,
       action, assigned_to_id||null, assigned_to_name||null, due_date||null, notes||null,
       req.user.id, req.user.name, new Date().toISOString()]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/corrective-actions/:id', requireAuth, async (req, res) => {
  try {
    const { action, assigned_to_id, assigned_to_name, due_date, completion_date, status, notes } = req.body;
    await pool.query(
      `UPDATE corrective_actions SET action=COALESCE($1,action), assigned_to_id=COALESCE($2,assigned_to_id),
       assigned_to_name=COALESCE($3,assigned_to_name), due_date=COALESCE($4,due_date),
       completion_date=COALESCE($5,completion_date), status=COALESCE($6,status),
       notes=COALESCE($7,notes), updated_at=$8 WHERE id=$9`,
      [action, assigned_to_id, assigned_to_name, due_date, completion_date, status, notes,
       new Date().toISOString(), parseInt(req.params.id)]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// PANEL SCHEDULES
// ─────────────────────────────────────────────

function generateScheduleNumber() {
  const now = new Date();
  const date = now.toISOString().slice(0,10).replace(/-/g,'');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PS-${date}-${rand}`;
}

// List panel schedules (active)
app.get('/api/panel-schedules', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, schedule_number, panel_name, voltage, main_breaker, bus_rating, enclosure_type,
              num_circuits, project_id, project_name, job_number, created_by, created_at, updated_at, status
       FROM panel_schedules WHERE archived=0 ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List archived panel schedules
app.get('/api/panel-schedules/archived', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, schedule_number, panel_name, voltage, project_name, created_by, created_at, archived_at
       FROM panel_schedules WHERE archived=1 ORDER BY archived_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get single panel schedule
app.get('/api/panel-schedules/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM panel_schedules WHERE id=$1', [parseInt(req.params.id)]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ...rows[0], circuit_data: JSON.parse(rows[0].circuit_data || '[]') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create panel schedule
app.post('/api/panel-schedules', requireAuth, async (req, res) => {
  try {
    const { panel_name, voltage, main_breaker, bus_rating, enclosure_type, num_circuits,
            circuit_data, project_id, project_name, job_number } = req.body;
    if (!panel_name) return res.status(400).json({ error: 'Panel name required' });
    const schedule_number = generateScheduleNumber();
    const now = new Date().toISOString();
    const { rows } = await pool.query(
      `INSERT INTO panel_schedules
         (schedule_number, panel_name, voltage, main_breaker, bus_rating, enclosure_type,
          num_circuits, circuit_data, project_id, project_name, job_number,
          created_by_id, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, schedule_number`,
      [schedule_number, panel_name, voltage||'120/240V 1-Ph', main_breaker||null, bus_rating||null,
       enclosure_type||null, parseInt(num_circuits)||24, JSON.stringify(circuit_data||[]),
       project_id||null, project_name||null, job_number||null,
       req.user.id, req.user.name, now]
    );
    res.json({ ok: true, id: rows[0].id, schedule_number: rows[0].schedule_number });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update panel schedule
app.patch('/api/panel-schedules/:id', requireAuth, async (req, res) => {
  try {
    const { panel_name, voltage, main_breaker, bus_rating, enclosure_type, num_circuits,
            circuit_data, project_id, project_name, job_number } = req.body;
    const now = new Date().toISOString();
    await pool.query(
      `UPDATE panel_schedules SET
         panel_name=$1, voltage=$2, main_breaker=$3, bus_rating=$4, enclosure_type=$5,
         num_circuits=$6, circuit_data=$7, project_id=$8, project_name=$9, job_number=$10,
         updated_at=$11, updated_by=$12
       WHERE id=$13`,
      [panel_name, voltage||'120/240V 1-Ph', main_breaker||null, bus_rating||null, enclosure_type||null,
       parseInt(num_circuits)||24, JSON.stringify(circuit_data||[]),
       project_id||null, project_name||null, job_number||null,
       now, req.user.name, parseInt(req.params.id)]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Archive panel schedule (admin)
app.patch('/api/panel-schedules/:id/archive', requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE panel_schedules SET archived=1, archived_at=$1 WHERE id=$2',
      [new Date().toISOString(), parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Unarchive panel schedule (admin)
app.patch('/api/panel-schedules/:id/unarchive', requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE panel_schedules SET archived=0, archived_at=NULL WHERE id=$1',
      [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Archive/unarchive within project
app.patch('/api/panel-schedules/:id/project-archive', requireAdmin, async (req, res) => {
  try {
    const { archive } = req.body;
    await pool.query('UPDATE panel_schedules SET project_archived=$1 WHERE id=$2',
      [archive ? 1 : 0, parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

(async () => {
  try {
    await connectWithRetry();
    await initSchema();
    await ensureDefaultAdmin();
    app.listen(PORT, () => {
      console.log(`\n  J&D Western Electric — Field Operations Hub`);
      console.log(`  Running at http://localhost:${PORT}\n`);
    });
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }
})();
