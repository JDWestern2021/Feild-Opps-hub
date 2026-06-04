const express  = require('express');
const path     = require('path');
const crypto   = require('crypto');
const XLSX     = require('xlsx');
const multer   = require('multer');
const nodemailer = require('nodemailer');
const db       = require('./db');
const { sessionMiddleware, requireAuth, requireAdmin, requirePermission, logAction, hashPassword, checkPassword, ensureDefaultAdmin } = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Uploads storage ──
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const fs = require('fs'); fs.mkdirSync(path.join(__dirname,'public','uploads'), {recursive:true}); cb(null, path.join(__dirname,'public','uploads')); },
    filename: (req, file, cb) => { cb(null, file.fieldname + path.extname(file.originalname)); }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
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
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(png|jpeg|jpg|heic|heif)|application\/pdf/.test(file.mimetype)
             || /\.(png|jpg|jpeg|heic|heif|pdf)$/i.test(file.originalname);
    cb(null, ok);
  }
});

app.use(express.json());
app.use(sessionMiddleware());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──
function getSetting(key, def = null) {
  return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? def;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}

function parseEmployeesRaw(raw) {
  if (!raw) return [];
  return raw.split('||').map(e => {
    const parts = e.split(':');
    return { name: parts[0], regular_hours: parseFloat(parts[1])||0, overtime_hours: parseFloat(parts[2])||0, level: parts[3]||'Journeyman' };
  });
}
const EMP_SELECT = `e.employee_name||':'||e.regular_hours||':'||e.overtime_hours||':'||COALESCE(e.level,'Journeyman')`;

function generateTicketNumber() {
  return `JDW-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(1000+Math.random()*9000)}`;
}

// Validate an optional project assignment. Returns the project id if it refers
// to an existing project folder, otherwise null (assignment is always optional).
function resolveProjectId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = parseInt(raw, 10);
  if (isNaN(id) || id <= 0) return null;
  const proj = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
  return proj ? id : null;
}

// Normalize associated job-number tags into a clean comma-separated string.
// Accepts an array or a free-text string of comma/space-separated values.
function normalizeJobNumbers(raw) {
  if (!raw) return null;
  const parts = (Array.isArray(raw) ? raw : String(raw).split(/[,\n]/))
    .map(s => String(s).trim()).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// ─────────────────────────────────────────────
// PUBLIC ROUTES (no auth)
// ─────────────────────────────────────────────

// Dynamic theme CSS
app.get('/theme.css', (req, res) => {
  const color = getSetting('theme_color', '#F47920');
  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(`:root { --orange: ${color}; --orange-dark: color-mix(in srgb, ${color} 85%, black); --orange-light: color-mix(in srgb, ${color} 15%, white); }`);
});

// Public settings (theme + logo for pages to read)
app.get('/api/settings/public', (req, res) => {
  res.json({
    theme_color: getSetting('theme_color', '#F47920'),
    logo_path:   getSetting('logo_path', null),
    home_bg:     getSetting('home_bg', null),
  });
});

// Auth: check if first-time setup needed
app.get('/api/auth/setup-needed', (req, res) => {
  res.json({ needed: db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0 });
});

// Auth: login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email.toLowerCase().trim());
  if (!user || !user.password_hash || !checkPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid email or password' });
  if (user.status !== 'active')
    return res.status(403).json({ error: 'Account is not active. Check your invite email.' });
  req.session.userId = user.id;
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

// Auth: me
app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT id, name, email, role, status, permissions FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'Not authenticated' });
  // Normalise permissions
  if (user.role === 'admin') user.permissions = 'time_ticket,get_po,office_dashboard';
  else if (!user.permissions) user.permissions = 'time_ticket';
  res.json(user);
});

// Auth: logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Auth: accept invite — validate token
app.get('/api/auth/invite/:token', (req, res) => {
  const user = db.prepare('SELECT id, name, email FROM users WHERE invite_token = ? AND status = ? AND invite_expires > ?').get(req.params.token, 'invited', new Date().toISOString());
  if (!user) return res.status(404).json({ error: 'Invalid or expired invite link' });
  res.json(user);
});

// Auth: accept invite — set password
app.post('/api/auth/invite/:token/accept', (req, res) => {
  const { name, password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const user = db.prepare('SELECT * FROM users WHERE invite_token = ? AND status = ? AND invite_expires > ?').get(req.params.token, 'invited', new Date().toISOString());
  if (!user) return res.status(404).json({ error: 'Invalid or expired invite link' });
  db.prepare('UPDATE users SET name = ?, password_hash = ?, status = ?, invite_token = NULL, invite_expires = NULL WHERE id = ?')
    .run(name || user.name, hashPassword(password), 'active', user.id);
  req.session.userId = user.id;
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  res.json({ ok: true, role: user.role });
});

// Auth: change own password
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!checkPassword(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
  if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), req.user.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// USER MANAGEMENT (Admin only)
// ─────────────────────────────────────────────

app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, status, permissions, created_at, last_login FROM users ORDER BY created_at DESC').all();
  res.json(users.map(u => ({
    ...u,
    permissions: u.role === 'admin' ? 'time_ticket,get_po,office_dashboard' : (u.permissions || 'time_ticket')
  })));
});

app.post('/api/users/invite', requireAdmin, async (req, res) => {
  const { name, email, role } = req.body;
  if (!name || !email || !role) return res.status(400).json({ error: 'Name, email and role required' });
  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'A user with this email already exists' });

  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 3600000).toISOString(); // 7 days
  db.prepare('INSERT INTO users (name, email, role, status, invite_token, invite_expires, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, email.toLowerCase(), role, 'invited', token, expires, new Date().toISOString());

  const inviteUrl = `${req.protocol}://${req.get('host')}/accept-invite.html?token=${token}`;

  // Try to send email if SMTP configured
  const smtpHost = getSetting('smtp_host');
  let emailSent = false;
  if (smtpHost) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost, port: parseInt(getSetting('smtp_port', '587')),
        auth: { user: getSetting('smtp_user'), pass: getSetting('smtp_pass') }
      });
      await transporter.sendMail({
        from: getSetting('smtp_from', 'noreply@jdwesternelectric.ca'),
        to: email,
        subject: "You've been invited to J&D Western Electric Field Hub",
        html: `<p>Hi ${name},</p><p>You have been invited to join the J&D Western Electric Field Operations Hub as a <strong>${role === 'admin' ? 'Office Admin' : 'Field User'}</strong>.</p><p><a href="${inviteUrl}">Click here to set your password and activate your account</a></p><p>This link expires in 7 days.</p>`
      });
      emailSent = true;
    } catch (err) {
      console.error('Email send failed:', err.message);
    }
  }

  res.status(201).json({ ok: true, invite_url: inviteUrl, email_sent: emailSent });
});

app.patch('/api/users/:id', requireAdmin, (req, res) => {
  const { name, role, status } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (parseInt(req.params.id) === req.user.id && status === 'inactive') return res.status(400).json({ error: 'Cannot deactivate your own account' });
  db.prepare('UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), status = COALESCE(?, status) WHERE id = ?')
    .run(name || null, role || null, status || null, req.params.id);
  res.json({ ok: true });
});

// ── Admin: set a user's password directly ──
app.post('/api/users/:id/reset-password', requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET password_hash = ?, status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
    .run(hashPassword(password), 'invited', 'active', req.params.id);
  res.json({ ok: true });
});

// ── Admin: send password reset email ──
app.post('/api/users/:id/send-reset-link', requireAdmin, async (req, res) => {
  const user = db.prepare('SELECT id, name, email, status FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 24 * 3600000).toISOString(); // 24 hours
  db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(token, expires, user.id);

  const resetUrl = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;

  const smtpHost = getSetting('smtp_host');
  let emailSent = false;
  if (smtpHost) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost, port: parseInt(getSetting('smtp_port', '587')),
        auth: { user: getSetting('smtp_user'), pass: getSetting('smtp_pass') }
      });
      await transporter.sendMail({
        from: getSetting('smtp_from', 'noreply@jdwesternelectric.ca'),
        to: user.email,
        subject: 'Reset your J&D Western Electric password',
        html: `<p>Hi ${user.name},</p><p>A password reset was requested for your account. Click the link below to set a new password. This link expires in 24 hours.</p><p><a href="${resetUrl}">Reset my password</a></p><p>If you did not request this, you can safely ignore this email.</p>`
      });
      emailSent = true;
    } catch (err) {
      console.error('Reset email failed:', err.message);
    }
  }

  res.json({ ok: true, reset_url: resetUrl, email_sent: emailSent });
});

// ── Public: validate reset token ──
app.get('/api/auth/reset/:token', (req, res) => {
  const user = db.prepare('SELECT id, name, email FROM users WHERE reset_token = ? AND reset_token_expires > ?')
    .get(req.params.token, new Date().toISOString());
  if (!user) return res.status(404).json({ error: 'This reset link is invalid or has expired.' });
  res.json({ name: user.name, email: user.email });
});

// ── Public: apply new password via reset token ──
app.post('/api/auth/reset/:token', (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const user = db.prepare('SELECT * FROM users WHERE reset_token = ? AND reset_token_expires > ?')
    .get(req.params.token, new Date().toISOString());
  if (!user) return res.status(404).json({ error: 'This reset link is invalid or has expired.' });
  db.prepare('UPDATE users SET password_hash = ?, status = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?')
    .run(hashPassword(password), 'active', user.id);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// SETTINGS (Admin only)
// ─────────────────────────────────────────────

app.get('/api/settings', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const s = {};
  rows.forEach(r => s[r.key] = r.value);
  // Mask SMTP password
  if (s.smtp_pass) s.smtp_pass = '••••••••';
  res.json(s);
});

app.post('/api/settings', requireAdmin, (req, res) => {
  const allowed = ['theme_color', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from'];
  for (const [key, val] of Object.entries(req.body)) {
    if (allowed.includes(key) && val !== '••••••••') setSetting(key, val);
  }
  res.json({ ok: true });
});

app.post('/api/settings/logo', requireAdmin, upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  setSetting('logo_path', '/uploads/' + req.file.filename);
  res.json({ ok: true, path: '/uploads/' + req.file.filename });
});

app.post('/api/settings/home-bg', requireAdmin, upload.single('home_bg'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  setSetting('home_bg', '/uploads/' + req.file.filename);
  res.json({ ok: true, path: '/uploads/' + req.file.filename });
});

app.delete('/api/settings/home-bg', requireAdmin, (req, res) => {
  setSetting('home_bg', null);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────

app.get('/api/tickets/:id/audit', requireAuth, (req, res) => {
  const logs = db.prepare('SELECT user_name, action, details, created_at FROM audit_log WHERE ticket_id = ? ORDER BY created_at ASC').all(req.params.id);
  res.json(logs);
});

// ── Update user permissions ──
app.patch('/api/users/:id/permissions', requireAdmin, (req, res) => {
  const { permissions } = req.body; // array like ['time_ticket','get_po']
  if (!Array.isArray(permissions)) return res.status(400).json({ error: 'permissions must be an array' });
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Admin users always have full access' });
  const valid = ['time_ticket', 'get_po'];
  const cleaned = permissions.filter(p => valid.includes(p)).join(',');
  db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(cleaned, req.params.id);
  res.json({ ok: true, permissions: cleaned });
});

// ─────────────────────────────────────────────
// PURCHASE ORDERS
// ─────────────────────────────────────────────

function generatePONumber() {
  const year = new Date().getFullYear();
  db.prepare('INSERT OR IGNORE INTO po_sequence (year, last_seq) VALUES (?, 0)').run(year);
  const seq = db.prepare('UPDATE po_sequence SET last_seq = last_seq + 1 WHERE year = ? RETURNING last_seq').get(year).last_seq;
  return `JD-PO-${year}-${String(seq).padStart(4, '0')}`;
}

function logPOAction(req, poId, poNumber, action, details = null) {
  db.prepare('INSERT INTO po_audit_log (po_id, po_number, user_name, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(poId, poNumber, req.user?.name || 'System', action, details, new Date().toISOString());
}

// Receipt upload (protected)
app.post('/api/po/:id/receipt', requirePermission('get_po'), receiptUpload.single('receipt'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const po = db.prepare('SELECT id FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const p = `/uploads/receipts/receipt-${req.params.id}${path.extname(req.file.originalname).toLowerCase()}`;
  db.prepare('UPDATE purchase_orders SET receipt_path = ? WHERE id = ?').run(p, req.params.id);
  res.json({ ok: true, path: p });
});

// Generate a new PO
app.post('/api/po', requirePermission('get_po'), async (req, res) => {
  const { jobber_job_number, job_name, supplier, description, estimated_amount, needs_reimbursement, project_id } = req.body;
  if (!jobber_job_number?.trim() || !description?.trim() || !job_name?.trim())
    return res.status(400).json({ error: 'Jobber Job Number, Job Name, and Description are required' });

  const projectId  = resolveProjectId(project_id);
  const po_number  = generatePONumber();
  const date       = new Date().toISOString().slice(0, 10);
  const created_at = new Date().toISOString();

  db.prepare(`INSERT INTO purchase_orders (po_number, date, generated_by_id, generated_by_name, jobber_job_number, job_name, supplier, description, estimated_amount, needs_reimbursement, status, created_at, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?)`)
    .run(po_number, date, req.user.id, req.user.name, jobber_job_number.trim(), job_name.trim(),
        supplier?.trim() || null, description.trim(),
        estimated_amount ? parseFloat(estimated_amount) : null,
        needs_reimbursement ? 1 : 0, created_at, projectId);

  const poId = db.prepare('SELECT id FROM purchase_orders WHERE po_number = ?').get(po_number).id;
  logPOAction(req, poId, po_number, 'po_created', `Created by ${req.user.name}`);

  // Notify office admins by email
  const smtpHost = getSetting('smtp_host');
  if (smtpHost) {
    try {
      const admins = db.prepare("SELECT email FROM users WHERE role = 'admin' AND status = 'active'").all();
      const to = admins.map(a => a.email).join(',');
      if (to) {
        const transporter = nodemailer.createTransport({
          host: smtpHost, port: parseInt(getSetting('smtp_port', '587')),
          auth: { user: getSetting('smtp_user'), pass: getSetting('smtp_pass') }
        });
        await transporter.sendMail({
          from: getSetting('smtp_from', 'noreply@jdwesternelectric.ca'),
          to,
          subject: `New PO Generated: ${po_number}`,
          html: `<h2>New Purchase Order — ${po_number}</h2>
            <table><tbody>
              <tr><td><b>PO Number</b></td><td>${po_number}</td></tr>
              <tr><td><b>Date</b></td><td>${date}</td></tr>
              <tr><td><b>Generated By</b></td><td>${req.user.name}</td></tr>
              <tr><td><b>Jobber Job #</b></td><td>${jobber_job_number}</td></tr>
              <tr><td><b>Job Name</b></td><td>${job_name}</td></tr>
              <tr><td><b>Supplier</b></td><td>${supplier || '—'}</td></tr>
              <tr><td><b>Description</b></td><td>${description}</td></tr>
              <tr><td><b>Estimated Amount</b></td><td>${estimated_amount ? '$' + parseFloat(estimated_amount).toFixed(2) : '—'}</td></tr>
              ${needs_reimbursement ? '<tr><td><b>⚠ Reimbursement Required</b></td><td>Yes — receipt to follow</td></tr>' : ''}
            </tbody></table>`
        });
      }
    } catch (err) { console.error('PO notify email failed:', err.message); }
  }

  res.status(201).json({ po_number, id: poId });
});

// List POs (admin)
app.get('/api/po', requireAdmin, (req, res) => {
  const { status, date_from, date_to, employee, job_name, reimbursement, limit = 200, offset = 0 } = req.query;
  let where = [], params = [];
  if (status)        { where.push('status = ?'); params.push(status); }
  if (date_from)     { where.push('date >= ?'); params.push(date_from); }
  if (date_to)       { where.push('date <= ?'); params.push(date_to); }
  if (employee)      { where.push('LOWER(generated_by_name) LIKE ?'); params.push(`%${employee.toLowerCase()}%`); }
  if (job_name)      { where.push("LOWER(COALESCE(job_name,'')) LIKE ?"); params.push(`%${job_name.toLowerCase()}%`); }
  if (reimbursement === '1') { where.push('needs_reimbursement = 1'); }
  const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { total } = db.prepare(`SELECT COUNT(*) as total FROM purchase_orders ${wc}`).get(...params);
  const pos = db.prepare(`SELECT * FROM purchase_orders ${wc} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), parseInt(offset));
  res.json({ total, purchase_orders: pos });
});

// Get single PO with audit log (admin)
app.get('/api/po/:id', requireAdmin, (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const audit = db.prepare('SELECT user_name, action, details, created_at FROM po_audit_log WHERE po_id = ? ORDER BY created_at ASC').all(po.id);
  logPOAction(req, po.id, po.po_number, 'po_viewed');
  res.json({ ...po, audit });
});

// Update PO status / note (admin)
app.patch('/api/po/:id', requireAdmin, (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const { status, office_note } = req.body;
  const updated_at = new Date().toISOString();
  db.prepare('UPDATE purchase_orders SET status = COALESCE(?, status), office_note = COALESCE(?, office_note), updated_at = ? WHERE id = ?')
    .run(status || null, office_note !== undefined ? office_note : null, updated_at, req.params.id);
  if (status && status !== po.status) logPOAction(req, po.id, po.po_number, 'status_changed', `${po.status} → ${status}`);
  if (office_note !== undefined && office_note !== po.office_note) logPOAction(req, po.id, po.po_number, 'note_updated');

  // Auto project-archive when status changes to Entered and PO is linked to a project
  const autoProjectArchive = status === 'Entered' && po.status !== 'Entered' && po.project_id && !po.project_archived;
  if (autoProjectArchive) {
    db.prepare('UPDATE purchase_orders SET project_archived = 1 WHERE id = ?').run(req.params.id);
    logPOAction(req, po.id, po.po_number, 'po_project_archived',
      `Auto-archived within project upon status change to Entered by ${req.user?.name}`);
  }

  res.json({ ok: true, auto_project_archived: autoProjectArchive });
});

// Delete PO (admin)
app.delete('/api/po/:id', requireAdmin, (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status !== 'Archived') return res.status(400).json({ error: 'A PO must be archived before it can be permanently deleted.' });
  logPOAction(req, po.id, po.po_number, 'po_deleted', `Permanently deleted by ${req.user.name}`);
  db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Export POs to XLSX (admin) — supports ?ids=1,2,3 for selective export
app.get('/api/po/export/xlsx', requireAdmin, (req, res) => {
  const { status, date_from, date_to, employee, job_name, reimbursement, ids } = req.query;
  let where = [], params = [];
  if (ids) {
    const idList = ids.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
    if (idList.length) { where.push(`id IN (${idList.map(()=>'?').join(',')})`); params.push(...idList); }
  } else {
    if (status)        { where.push('status = ?'); params.push(status); }
    if (date_from)     { where.push('date >= ?'); params.push(date_from); }
    if (date_to)       { where.push('date <= ?'); params.push(date_to); }
    if (employee)      { where.push('LOWER(generated_by_name) LIKE ?'); params.push(`%${employee.toLowerCase()}%`); }
    if (job_name)      { where.push("LOWER(COALESCE(job_name,'')) LIKE ?"); params.push(`%${job_name.toLowerCase()}%`); }
    if (reimbursement === '1') { where.push('needs_reimbursement = 1'); }
  }
  const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pos = db.prepare(`SELECT * FROM purchase_orders ${wc} ORDER BY created_at DESC`).all(...params);

  const exportDate = new Date().toISOString().slice(0, 10);
  const rows = [
    ['J&D Western Electric Ltd — Purchase Orders'],
    [`Exported: ${exportDate}`],
    [],
    ['PO Number','Date Generated','Generated By','Jobber Job #','Job Name','Supplier','Description','Estimated Amount','Needs Reimbursement','Status','Office Notes','Date Status Last Changed'],
    ...pos.map(p => [
      p.po_number,
      p.date,
      p.generated_by_name,
      p.jobber_job_number || '',
      p.job_name || '',
      p.supplier || '',
      p.description,
      p.estimated_amount != null ? parseFloat(p.estimated_amount) : '',
      p.needs_reimbursement ? 'Yes' : 'No',
      p.status,
      p.office_note || '',
      p.updated_at ? new Date(p.updated_at).toLocaleString('en-CA', {year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''
    ])
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:18},{wch:14},{wch:18},{wch:16},{wch:24},{wch:18},{wch:36},{wch:16},{wch:12},{wch:12},{wch:30},{wch:22}];
  XLSX.utils.book_append_sheet(wb, ws, 'Purchase Orders');
  logAction(req, 'po_export', null, null, 'PO XLSX export');
  const buf = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="JD-POs-${exportDate}.xlsx"`);
  res.send(buf);
});

// ─────────────────────────────────────────────
// TICKETS (Auth required)
// ─────────────────────────────────────────────

app.post('/api/tickets', requireAuth, (req, res) => {
  const { date, job_name, job_number, supervisor, work_description, equipment_used, notes, employees, project_id } = req.body;
  if (!date || !job_name || !supervisor || !work_description) return res.status(400).json({ error: 'Missing required fields' });
  if (!employees?.length) return res.status(400).json({ error: 'At least one employee required' });

  const projectId = resolveProjectId(project_id);

  const ticket_number = generateTicketNumber();
  const submitted_at  = new Date().toISOString();
  const insertTicket  = db.prepare(`INSERT INTO daily_tickets (ticket_number,date,job_name,job_number,supervisor,work_description,equipment_used,notes,submitted_at,project_id) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insertEmp     = db.prepare(`INSERT INTO ticket_employees (ticket_id,employee_name,regular_hours,overtime_hours,level) VALUES (?,?,?,?,?)`);

  try {
    db.exec('BEGIN');
    const { lastInsertRowid: tid } = insertTicket.run(ticket_number, date, job_name, job_number||null, supervisor, work_description, equipment_used||null, notes||null, submitted_at, projectId);
    for (const e of employees)
      if (e.name?.trim()) insertEmp.run(tid, e.name.trim(), parseFloat(e.regular_hours)||0, parseFloat(e.overtime_hours)||0, e.level||'Journeyman');
    db.exec('COMMIT');
    logAction(req, 'ticket_submitted', tid, ticket_number, `Submitted by ${req.user.name}`);
    res.status(201).json({ id: tid, ticket_number, message: 'Ticket submitted successfully' });
  } catch (err) {
    db.exec('ROLLBACK'); console.error(err);
    res.status(500).json({ error: 'Failed to save ticket' });
  }
});

app.get('/api/tickets', requireAuth, (req, res) => {
  const { job, date_from, date_to, supervisor, search, limit = 50, offset = 0, archived = '0' } = req.query;
  let where = ['t.archived = ?'], params = [archived === '1' ? 1 : 0];
  if (job)        { where.push(`(LOWER(t.job_name) LIKE ? OR LOWER(t.job_number) LIKE ?)`); params.push(`%${job.toLowerCase()}%`, `%${job.toLowerCase()}%`); }
  if (date_from)  { where.push(`t.date >= ?`); params.push(date_from); }
  if (date_to)    { where.push(`t.date <= ?`); params.push(date_to); }
  if (supervisor) { where.push(`LOWER(t.supervisor) LIKE ?`); params.push(`%${supervisor.toLowerCase()}%`); }
  if (search) {
    where.push(`(LOWER(t.job_name) LIKE ? OR LOWER(t.supervisor) LIKE ? OR LOWER(t.ticket_number) LIKE ? OR LOWER(t.work_description) LIKE ?)`);
    const s = `%${search.toLowerCase()}%`; params.push(s,s,s,s);
  }
  const wc = `WHERE ${where.join(' AND ')}`;
  const { total } = db.prepare(`SELECT COUNT(*) as total FROM daily_tickets t ${wc}`).get(...params);
  const tickets = db.prepare(`SELECT t.*, p.name as project_name, GROUP_CONCAT(${EMP_SELECT},'||') as employees_raw FROM daily_tickets t LEFT JOIN ticket_employees e ON e.ticket_id=t.id LEFT JOIN projects p ON p.id=t.project_id ${wc} GROUP BY t.id ORDER BY t.date DESC, t.submitted_at DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), parseInt(offset));
  res.json({ total, tickets: tickets.map(t => ({...t, employees: parseEmployeesRaw(t.employees_raw), employees_raw: undefined})) });
});

app.get('/api/tickets/:id', requireAuth, (req, res) => {
  const ticket = db.prepare('SELECT t.*, p.name as project_name FROM daily_tickets t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const employees = db.prepare(`SELECT employee_name, regular_hours, overtime_hours, COALESCE(level,'Journeyman') as level FROM ticket_employees WHERE ticket_id = ?`).all(ticket.id);
  logAction(req, 'ticket_viewed', ticket.id, ticket.ticket_number);
  res.json({ ...ticket, employees });
});

app.put('/api/tickets/:id', requireAdmin, (req, res) => {
  const { date, job_name, job_number, supervisor, work_description, equipment_used, notes, employees, project_id, ticket_status } = req.body;
  const ticket = db.prepare('SELECT * FROM daily_tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const resolvedProjectId = project_id !== undefined ? resolveProjectId(project_id) : ticket.project_id;
  const resolvedStatus = ['Pending','Reviewed','Entered'].includes(ticket_status) ? ticket_status : ticket.ticket_status;
  try {
    db.exec('BEGIN');
    db.prepare(`UPDATE daily_tickets SET date=?,job_name=?,job_number=?,supervisor=?,work_description=?,equipment_used=?,notes=?,updated_at=?,project_id=?,ticket_status=? WHERE id=?`)
      .run(date, job_name, job_number||null, supervisor, work_description, equipment_used||null, notes||null, new Date().toISOString(), resolvedProjectId, resolvedStatus, req.params.id);
    db.prepare('DELETE FROM ticket_employees WHERE ticket_id=?').run(req.params.id);
    const ins = db.prepare('INSERT INTO ticket_employees (ticket_id,employee_name,regular_hours,overtime_hours,level) VALUES (?,?,?,?,?)');
    for (const e of employees) if (e.name?.trim()) ins.run(req.params.id, e.name.trim(), parseFloat(e.regular_hours)||0, parseFloat(e.overtime_hours)||0, e.level||'Journeyman');
    db.exec('COMMIT');
    logAction(req, 'ticket_updated', ticket.id, ticket.ticket_number, `Edited by ${req.user?.name}`);
    res.json({ message: 'Updated' });
  } catch (err) { db.exec('ROLLBACK'); res.status(500).json({ error: 'Failed to update' }); }
});

// Full PO update (all fields)
app.put('/api/po/:id', requireAdmin, (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const {
    date, generated_by_name, jobber_job_number, job_name, supplier,
    description, estimated_amount, needs_reimbursement,
    status, office_note, project_id, ticket_status
  } = req.body;
  const resolvedProjectId = project_id !== undefined ? resolveProjectId(project_id) : po.project_id;
  const updated_at = new Date().toISOString();
  db.prepare(`UPDATE purchase_orders SET
    date=COALESCE(?,date), generated_by_name=COALESCE(?,generated_by_name),
    jobber_job_number=COALESCE(?,jobber_job_number), job_name=COALESCE(?,job_name),
    supplier=?, description=COALESCE(?,description),
    estimated_amount=?, needs_reimbursement=COALESCE(?,needs_reimbursement),
    status=COALESCE(?,status), office_note=?,
    project_id=?, updated_at=?
    WHERE id=?`)
    .run(date||null, generated_by_name||null, jobber_job_number||null, job_name||null,
         supplier||null, description||null,
         estimated_amount != null ? parseFloat(estimated_amount) : null,
         needs_reimbursement != null ? (needs_reimbursement ? 1 : 0) : null,
         status||null, office_note||null,
         resolvedProjectId, updated_at, req.params.id);
  logPOAction(req, po.id, po.po_number, 'po_edited', `Edited by ${req.user.name}`);
  res.json({ ok: true });
});

// Project-level archive / unarchive (independent of main dashboard archive)
app.patch('/api/tickets/:id/project-archive', requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM daily_tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE daily_tickets SET project_archived = 1 WHERE id = ?').run(req.params.id);
  logAction(req, 'ticket_project_archived', t.id, t.ticket_number);
  res.json({ ok: true });
});
app.patch('/api/tickets/:id/project-unarchive', requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM daily_tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE daily_tickets SET project_archived = 0 WHERE id = ?').run(req.params.id);
  logAction(req, 'ticket_project_unarchived', t.id, t.ticket_number);
  res.json({ ok: true });
});
app.patch('/api/po/:id/project-archive', requireAdmin, (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE purchase_orders SET project_archived = 1 WHERE id = ?').run(req.params.id);
  logPOAction(req, po.id, po.po_number, 'po_project_archived');
  res.json({ ok: true });
});
app.patch('/api/po/:id/project-unarchive', requireAdmin, (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE purchase_orders SET project_archived = 0 WHERE id = ?').run(req.params.id);
  logPOAction(req, po.id, po.po_number, 'po_project_unarchived');
  res.json({ ok: true });
});

// Update ticket workflow status (Pending / Reviewed / Entered)
// Auto-archives the ticket when status is set to Entered
app.patch('/api/tickets/:id/status', requireAdmin, (req, res) => {
  const { ticket_status } = req.body;
  if (!['Pending','Reviewed','Entered'].includes(ticket_status))
    return res.status(400).json({ error: 'Invalid status. Must be Pending, Reviewed, or Entered.' });
  const t = db.prepare('SELECT * FROM daily_tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });

  const now = new Date().toISOString();
  const autoArchive = ticket_status === 'Entered' && !t.archived;

  // Auto project-archive if ticket is linked to a project and not already project-archived
  const autoProjectArchive = ticket_status === 'Entered' && t.project_id && !t.project_archived;

  if (autoArchive) {
    db.prepare('UPDATE daily_tickets SET ticket_status = ?, archived = 1, archived_at = ? WHERE id = ?')
      .run(ticket_status, now, req.params.id);
    logAction(req, 'ticket_status_changed', t.id, t.ticket_number,
      `Status: ${t.ticket_status || 'Pending'} → ${ticket_status}`);
    logAction(req, 'ticket_archived', t.id, t.ticket_number,
      `Auto-archived upon status change to Entered by ${req.user?.name}`);
  } else {
    db.prepare('UPDATE daily_tickets SET ticket_status = ? WHERE id = ?').run(ticket_status, req.params.id);
    logAction(req, 'ticket_status_changed', t.id, t.ticket_number,
      `Status: ${t.ticket_status || 'Pending'} → ${ticket_status}`);
  }

  if (autoProjectArchive) {
    db.prepare('UPDATE daily_tickets SET project_archived = 1 WHERE id = ?').run(req.params.id);
    logAction(req, 'ticket_project_archived', t.id, t.ticket_number,
      `Auto-archived within project upon status change to Entered by ${req.user?.name}`);
  }

  res.json({ ok: true, auto_archived: autoArchive, auto_project_archived: autoProjectArchive });
});

app.patch('/api/tickets/:id/archive', requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM daily_tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE daily_tickets SET archived=1, archived_at=? WHERE id=?').run(new Date().toISOString(), req.params.id);
  logAction(req, 'ticket_archived', t.id, t.ticket_number);
  res.json({ message: 'Archived' });
});

app.patch('/api/tickets/:id/unarchive', requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM daily_tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE daily_tickets SET archived=0, archived_at=NULL WHERE id=?').run(req.params.id);
  logAction(req, 'ticket_unarchived', t.id, t.ticket_number);
  res.json({ message: 'Unarchived' });
});

app.delete('/api/tickets/:id', requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM daily_tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!t.archived) return res.status(400).json({ error: 'A ticket must be archived before it can be permanently deleted.' });
  logAction(req, 'ticket_deleted', t.id, t.ticket_number, `Permanently deleted by ${req.user?.name}`);
  db.prepare('DELETE FROM daily_tickets WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Export multiple tickets to XLSX by IDs
app.get('/api/tickets/export/xlsx', requireAuth, (req, res) => {
  const { ids, filename } = req.query;
  if (!ids) return res.status(400).json({ error: 'ids required' });
  const idList = ids.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
  if (!idList.length) return res.status(400).json({ error: 'no valid ids' });
  const tickets = db.prepare(`
    SELECT t.*, GROUP_CONCAT(${EMP_SELECT},'||') AS employees_raw
    FROM daily_tickets t LEFT JOIN ticket_employees e ON e.ticket_id = t.id
    WHERE t.id IN (${idList.map(()=>'?').join(',')})
    GROUP BY t.id ORDER BY t.date DESC
  `).all(...idList).map(t => ({...t, employees: parseEmployeesRaw(t.employees_raw), employees_raw: undefined}));

  const exportDate = new Date().toISOString().slice(0,10);
  const rows = [
    ['J&D Western Electric Ltd — Time Tickets Export'],
    [`Exported: ${exportDate}`], [],
    ['Ticket #','Date','Job Name','Job #','Supervisor','Employee','Level','Reg Hrs','OT Hrs','Total Hrs','Work Description','Equipment','Notes','Status']
  ];
  for (const t of tickets) {
    for (const e of t.employees) {
      rows.push([t.ticket_number, t.date, t.job_name, t.job_number||'', t.supervisor,
        e.name, e.level||'', e.regular_hours, e.overtime_hours, e.regular_hours+e.overtime_hours,
        t.work_description, t.equipment_used||'', t.notes||'', t.ticket_status||'Pending']);
    }
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:18},{wch:12},{wch:24},{wch:12},{wch:16},{wch:20},{wch:18},{wch:10},{wch:10},{wch:10},{wch:36},{wch:20},{wch:20},{wch:12}];
  XLSX.utils.book_append_sheet(wb, ws, 'Time Tickets');
  const safeName = filename ? decodeURIComponent(filename) : `JD-Tickets-${exportDate}.xlsx`;
  const buf = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${safeName}"`);
  res.send(buf);
});

// Single ticket XLSX
app.get('/api/tickets/:id/export/xlsx', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM daily_tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const emps = db.prepare(`SELECT employee_name, regular_hours, overtime_hours, COALESCE(level,'Journeyman') as level FROM ticket_employees WHERE ticket_id=?`).all(t.id);
  const totalReg = emps.reduce((s,e)=>s+e.regular_hours,0), totalOT = emps.reduce((s,e)=>s+e.overtime_hours,0);
  const rows = [
    ['J&D Western Electric Ltd — Daily Time Ticket'], [],
    ['Ticket #', t.ticket_number], ['Date', t.date], ['Job Name', t.job_name], ['Job #', t.job_number||''], ['Supervisor', t.supervisor], ['Submitted', t.submitted_at], [],
    ['Employee','Level','Regular Hrs','OT Hrs','Total Hrs'],
    ...emps.map(e=>[e.employee_name, e.level, e.regular_hours, e.overtime_hours, e.regular_hours+e.overtime_hours]),
    ['TOTAL','',totalReg, totalOT, totalReg+totalOT], [],
    ['Work Description', t.work_description], ['Equipment', t.equipment_used||''], ['Notes', t.notes||''],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:18},{wch:22},{wch:14},{wch:10},{wch:10}];
  XLSX.utils.book_append_sheet(wb, ws, 'Time Ticket');
  logAction(req, 'ticket_exported', t.id, t.ticket_number, 'XLSX export');
  const buf = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${t.ticket_number}.xlsx"`);
  res.send(buf);
});

// ─────────────────────────────────────────────
// PROJECTS
// ─────────────────────────────────────────────

app.get('/api/projects', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT t.job_name, t.job_number, COUNT(DISTINCT t.id) as ticket_count, MIN(t.date) as first_date, MAX(t.date) as last_date, COALESCE(SUM(e.regular_hours+e.overtime_hours),0) as total_hours FROM daily_tickets t LEFT JOIN ticket_employees e ON e.ticket_id=t.id WHERE t.archived=0 GROUP BY t.job_name ORDER BY MAX(t.date) DESC`).all());
});

app.get('/api/projects/:job/tickets', requireAuth, (req, res) => {
  const job = decodeURIComponent(req.params.job);
  const tickets = db.prepare(`SELECT t.*, GROUP_CONCAT(${EMP_SELECT},'||') as employees_raw FROM daily_tickets t LEFT JOIN ticket_employees e ON e.ticket_id=t.id WHERE t.job_name=? AND t.archived=0 GROUP BY t.id ORDER BY t.date DESC`).all(job);
  res.json(tickets.map(t=>({...t, employees: parseEmployeesRaw(t.employees_raw), employees_raw: undefined})));
});

app.get('/api/projects/:job/export/xlsx', requireAdmin, (req, res) => {
  const job = decodeURIComponent(req.params.job);
  const tickets = db.prepare(`SELECT t.*, GROUP_CONCAT(${EMP_SELECT},'||') as employees_raw FROM daily_tickets t LEFT JOIN ticket_employees e ON e.ticket_id=t.id WHERE t.job_name=? AND t.archived=0 GROUP BY t.id ORDER BY t.date ASC`).all(job);
  const rows = [['J&D Western Electric Ltd — Project Export'],[`Project: ${job}`],[`Exported: ${new Date().toLocaleDateString('en-CA')}`],[],['Date','Ticket #','Supervisor','Employee','Level','Regular Hrs','OT Hrs','Total Hrs','Work Description','Equipment','Notes']];
  let gReg=0, gOT=0;
  for (const t of tickets) {
    for (const e of parseEmployeesRaw(t.employees_raw)) {
      gReg+=e.regular_hours; gOT+=e.overtime_hours;
      rows.push([t.date, t.ticket_number, t.supervisor, e.name, e.level, e.regular_hours, e.overtime_hours, e.regular_hours+e.overtime_hours, t.work_description, t.equipment_used||'', t.notes||'']);
    }
  }
  rows.push([],[,'','','TOTAL','',gReg,gOT,gReg+gOT]);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:12},{wch:18},{wch:16},{wch:20},{wch:20},{wch:12},{wch:10},{wch:10},{wch:40},{wch:24},{wch:24}];
  XLSX.utils.book_append_sheet(wb, ws, 'Project Tickets');
  logAction(req, 'project_exported', null, null, `Project: ${job}`);
  const buf = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${job.replace(/[^a-z0-9]/gi,'_')}_export.xlsx"`);
  res.send(buf);
});

// ─────────────────────────────────────────────
// PROJECT FOLDERS (real admin-managed projects)
// Time Tickets and POs link to these via project_id.
// ─────────────────────────────────────────────

// Active projects for the assignment dropdown on field forms.
// Any authenticated user (field or admin) — read-only, names only.
app.get('/api/project-folders', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT id, name, job_numbers FROM projects WHERE status = 'active' ORDER BY name COLLATE NOCASE ASC`).all());
});

// Full project list with record counts (admin). Filter by status.
app.get('/api/project-folders/all', requireAdmin, (req, res) => {
  const allowed = ['active', 'complete', 'archived'];
  const status = allowed.includes(req.query.status) ? req.query.status : 'active';
  const projects = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM daily_tickets   t WHERE t.project_id = p.id) AS ticket_count,
      (SELECT COUNT(*) FROM purchase_orders o WHERE o.project_id = p.id) AS po_count,
      (SELECT COUNT(*) FROM daily_tickets   t WHERE t.project_id = p.id
        AND (t.ticket_status = 'Pending' OR t.ticket_status IS NULL)
        AND (t.project_archived = 0 OR t.project_archived IS NULL)) AS pending_tickets,
      (SELECT COUNT(*) FROM purchase_orders o WHERE o.project_id = p.id
        AND o.status = 'Open'
        AND (o.project_archived = 0 OR o.project_archived IS NULL)) AS open_pos
    FROM projects p
    WHERE p.status = ?
    ORDER BY p.updated_at DESC, p.created_at DESC
  `).all(status);
  res.json(projects);
});

// Create a project (admin)
app.post('/api/project-folders', requireAdmin, (req, res) => {
  const { name, job_numbers } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Project name is required' });
  const now = new Date().toISOString();
  const jn  = normalizeJobNumbers(job_numbers);
  const { lastInsertRowid } = db.prepare('INSERT INTO projects (name, job_numbers, status, created_at) VALUES (?, ?, ?, ?)')
    .run(name.trim(), jn, 'active', now);
  res.status(201).json({ id: lastInsertRowid, name: name.trim(), job_numbers: jn, status: 'active' });
});

// Quick-create a project from a field form (any authenticated user).
// Name only — admins can add job-number tags later. Field users land in the
// same active projects list as admin-created projects. Reuses an existing
// active project of the same name to avoid duplicates.
app.post('/api/project-folders/quick', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Project name is required' });
  const trimmed = name.trim();
  const existing = db.prepare("SELECT id, name, job_numbers, status FROM projects WHERE status = 'active' AND LOWER(name) = LOWER(?)").get(trimmed);
  if (existing) return res.json(existing);
  const { lastInsertRowid } = db.prepare('INSERT INTO projects (name, job_numbers, status, created_at) VALUES (?, ?, ?, ?)')
    .run(trimmed, null, 'active', new Date().toISOString());
  res.status(201).json({ id: lastInsertRowid, name: trimmed, job_numbers: null, status: 'active' });
});

// Edit a project's name / job numbers (admin)
app.patch('/api/project-folders/:id', requireAdmin, (req, res) => {
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const { name, job_numbers } = req.body;
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'Project name cannot be empty' });
  db.prepare('UPDATE projects SET name = COALESCE(?, name), job_numbers = ?, updated_at = ? WHERE id = ?')
    .run(name?.trim() || null,
         job_numbers !== undefined ? normalizeJobNumbers(job_numbers) : proj.job_numbers,
         new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

// Mark complete / archive / reactivate (admin). Does NOT touch any linked records.
app.patch('/api/project-folders/:id/status', requireAdmin, (req, res) => {
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const allowed = ['active', 'complete', 'archived'];
  const status = allowed.includes(req.body.status) ? req.body.status : 'active';
  const now = new Date().toISOString();
  db.prepare('UPDATE projects SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?')
    .run(status, (status === 'complete' || status === 'archived') ? now : null, now, req.params.id);
  res.json({ ok: true, status });
});

// Permanently delete a project (must be archived first). Unlinks records but does NOT delete them.
app.delete('/api/project-folders/:id', requireAdmin, (req, res) => {
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  if (proj.status !== 'archived') return res.status(400).json({ error: 'A project must be archived before it can be permanently deleted.' });
  // Unlink all records — they are NOT deleted, just lose the association
  db.prepare('UPDATE daily_tickets SET project_id = NULL WHERE project_id = ?').run(proj.id);
  db.prepare('UPDATE purchase_orders SET project_id = NULL WHERE project_id = ?').run(proj.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(proj.id);
  logAction(req, 'project_deleted', null, null, `Project "${proj.name}" permanently deleted by ${req.user.name}`);
  res.json({ ok: true });
});

// Project detail: the project plus ALL linked tickets and POs, regardless of
// archive status. The project view is a complete permanent record.
app.get('/api/project-folders/:id', requireAdmin, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const allTickets = db.prepare(`
    SELECT t.*, GROUP_CONCAT(${EMP_SELECT},'||') AS employees_raw
    FROM daily_tickets t LEFT JOIN ticket_employees e ON e.ticket_id = t.id
    WHERE t.project_id = ?
    GROUP BY t.id ORDER BY t.date DESC, t.submitted_at DESC
  `).all(project.id).map(t => ({ ...t, employees: parseEmployeesRaw(t.employees_raw), employees_raw: undefined }));

  const tickets          = allTickets.filter(t => !t.project_archived);
  const archived_tickets = allTickets.filter(t =>  t.project_archived);

  const allPOs     = db.prepare(`SELECT * FROM purchase_orders WHERE project_id = ? ORDER BY date DESC, created_at DESC`).all(project.id);
  const purchase_orders = allPOs.filter(p => !p.project_archived);
  const archived_pos    = allPOs.filter(p =>  p.project_archived);

  res.json({ project, tickets, purchase_orders, archived_tickets, archived_pos });
});

// Export a project to a single XLSX with two tabs: Time Tickets and POs.
app.get('/api/project-folders/:id/export/xlsx', requireAdmin, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const tickets = db.prepare(`
    SELECT t.*, GROUP_CONCAT(${EMP_SELECT},'||') AS employees_raw
    FROM daily_tickets t LEFT JOIN ticket_employees e ON e.ticket_id = t.id
    WHERE t.project_id = ?
    GROUP BY t.id ORDER BY t.date DESC, t.submitted_at DESC
  `).all(project.id);
  const pos = db.prepare(`SELECT * FROM purchase_orders WHERE project_id = ? ORDER BY date DESC, created_at DESC`).all(project.id);

  const exportDate = new Date().toISOString().slice(0, 10);
  const wb = XLSX.utils.book_new();

  // ── Time Tickets sheet ──
  const tRows = [
    ['J&D Western Electric Ltd — Project Export'],
    [`Project: ${project.name}`],
    [`Exported: ${exportDate}`],
    [],
    ['Date','Ticket #','Job Name','Job #','Supervisor','Employee','Level','Regular Hrs','OT Hrs','Total Hrs','Work Description','Equipment','Notes','Archived']
  ];
  let gReg = 0, gOT = 0;
  for (const t of tickets) {
    const emps = parseEmployeesRaw(t.employees_raw);
    if (!emps.length) {
      tRows.push([t.date, t.ticket_number, t.job_name, t.job_number||'', t.supervisor, '', '', 0, 0, 0, t.work_description, t.equipment_used||'', t.notes||'', t.archived ? 'Yes' : 'No']);
      continue;
    }
    for (const e of emps) {
      gReg += e.regular_hours; gOT += e.overtime_hours;
      tRows.push([t.date, t.ticket_number, t.job_name, t.job_number||'', t.supervisor, e.name, e.level, e.regular_hours, e.overtime_hours, e.regular_hours+e.overtime_hours, t.work_description, t.equipment_used||'', t.notes||'', t.archived ? 'Yes' : 'No']);
    }
  }
  tRows.push([], ['','','','','','','TOTAL','',gReg,gOT,gReg+gOT]);
  const tWs = XLSX.utils.aoa_to_sheet(tRows);
  tWs['!cols'] = [{wch:12},{wch:18},{wch:24},{wch:12},{wch:16},{wch:20},{wch:20},{wch:12},{wch:10},{wch:10},{wch:40},{wch:24},{wch:24},{wch:10}];
  XLSX.utils.book_append_sheet(wb, tWs, 'Time Tickets');

  // ── Purchase Orders sheet ──
  const pRows = [
    ['J&D Western Electric Ltd — Project Export'],
    [`Project: ${project.name}`],
    [`Exported: ${exportDate}`],
    [],
    ['PO Number','Date','Generated By','Jobber Job #','Job Name','Supplier','Description','Estimated Amount','Needs Reimbursement','Status','Office Notes'],
    ...pos.map(p => [
      p.po_number, p.date, p.generated_by_name, p.jobber_job_number||'', p.job_name||'', p.supplier||'',
      p.description, p.estimated_amount != null ? parseFloat(p.estimated_amount) : '',
      p.needs_reimbursement ? 'Yes' : 'No', p.status, p.office_note||''
    ])
  ];
  const pWs = XLSX.utils.aoa_to_sheet(pRows);
  pWs['!cols'] = [{wch:18},{wch:14},{wch:18},{wch:16},{wch:24},{wch:18},{wch:36},{wch:16},{wch:12},{wch:12},{wch:30}];
  XLSX.utils.book_append_sheet(wb, pWs, 'Purchase Orders');

  logAction(req, 'project_exported', null, null, `Project folder: ${project.name}`);
  const buf = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
  const safeName = project.name.replace(/[^a-z0-9]/gi,'_').replace(/_+/g,'_');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${safeName}_export.xlsx"`);
  res.send(buf);
});

// ─────────────────────────────────────────────
// DASHBOARD OVERVIEW
// ─────────────────────────────────────────────

app.get('/api/dashboard/overview', requireAdmin, (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const ws = weekStart.toISOString().slice(0,10);

  const t = {
    today:    db.prepare("SELECT COUNT(*) c FROM daily_tickets WHERE date=? AND archived=0").get(today).c,
    week:     db.prepare("SELECT COUNT(*) c FROM daily_tickets WHERE date>=? AND archived=0").get(ws).c,
    pending:  db.prepare("SELECT COUNT(*) c FROM daily_tickets WHERE (ticket_status='Pending' OR ticket_status IS NULL) AND archived=0").get().c,
    reviewed: db.prepare("SELECT COUNT(*) c FROM daily_tickets WHERE ticket_status='Reviewed' AND archived=0").get().c,
    entered:  db.prepare("SELECT COUNT(*) c FROM daily_tickets WHERE ticket_status='Entered' AND archived=0").get().c,
  };
  const p = {
    active:  db.prepare("SELECT COUNT(*) c FROM projects WHERE status='active'").get().c,
    outstanding: db.prepare(`SELECT COUNT(*) c FROM projects p WHERE p.status='active' AND (
      (SELECT COUNT(*) FROM daily_tickets t WHERE t.project_id=p.id AND (t.ticket_status='Pending' OR t.ticket_status IS NULL) AND (t.project_archived=0 OR t.project_archived IS NULL))
     +(SELECT COUNT(*) FROM purchase_orders o WHERE o.project_id=p.id AND o.status='Open' AND (o.project_archived=0 OR o.project_archived IS NULL))
    )>0`).get().c,
    // Total outstanding records across ALL active projects (for nav badge)
    outstanding_records: (
      db.prepare(`SELECT COUNT(*) c FROM daily_tickets t
        JOIN projects p ON p.id=t.project_id
        WHERE p.status='active'
        AND (t.ticket_status='Pending' OR t.ticket_status IS NULL OR t.ticket_status='Reviewed')
        AND (t.project_archived=0 OR t.project_archived IS NULL)`).get().c
      +
      db.prepare(`SELECT COUNT(*) c FROM purchase_orders o
        JOIN projects p ON p.id=o.project_id
        WHERE p.status='active'
        AND o.status='Open'
        AND (o.project_archived=0 OR o.project_archived IS NULL)`).get().c
    ),
    done:    db.prepare("SELECT COUNT(*) c FROM projects WHERE status IN ('complete','archived')").get().c,
  };
  const o = {
    open:           db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE status='Open'").get().c,
    entered_week:   db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE status='Entered' AND updated_at>=?").get(ws+'T00:00:00').c,
    reimbursement:  db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE needs_reimbursement=1 AND status='Open'").get().c,
  };
  const activity = db.prepare(`
    SELECT 'ticket' src, user_name, action, ticket_number ref, details, created_at FROM audit_log
    UNION ALL
    SELECT 'po' src, user_name, action, po_number ref, details, created_at FROM po_audit_log
    ORDER BY created_at DESC LIMIT 15`).all();

  res.json({ tickets: t, projects: p, pos: o, activity });
});

// ─────────────────────────────────────────────
// STATS & CSV
// ─────────────────────────────────────────────

app.get('/api/stats', requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate()-weekStart.getDay());
  res.json({
    total:    db.prepare('SELECT COUNT(*) as c FROM daily_tickets WHERE archived=0').get().c,
    archived: db.prepare('SELECT COUNT(*) as c FROM daily_tickets WHERE archived=1').get().c,
    today:    db.prepare('SELECT COUNT(*) as c FROM daily_tickets WHERE date=? AND archived=0').get(today).c,
    this_week:db.prepare('SELECT COUNT(*) as c FROM daily_tickets WHERE date>=? AND archived=0').get(weekStart.toISOString().slice(0,10)).c,
    active_jobs: db.prepare('SELECT COUNT(DISTINCT job_name) as c FROM daily_tickets WHERE archived=0').get().c,
  });
});

app.get('/api/export/csv', requireAuth, (req, res) => {
  const { date_from, date_to, job } = req.query;
  let where = ['t.archived=0'], params = [];
  if (date_from) { where.push('t.date>=?'); params.push(date_from); }
  if (date_to)   { where.push('t.date<=?'); params.push(date_to); }
  if (job)       { where.push(`(LOWER(t.job_name) LIKE ? OR LOWER(t.job_number) LIKE ?)`); params.push(`%${job.toLowerCase()}%`,`%${job.toLowerCase()}%`); }
  const rows = db.prepare(`SELECT t.ticket_number,t.date,t.job_name,t.job_number,t.supervisor,e.employee_name,COALESCE(e.level,'Journeyman') as level,e.regular_hours,e.overtime_hours,t.work_description,t.equipment_used,t.notes,t.submitted_at FROM daily_tickets t LEFT JOIN ticket_employees e ON e.ticket_id=t.id WHERE ${where.join(' AND ')} ORDER BY t.date DESC,t.id`).all(...params);
  const h = ['Ticket #','Date','Job Name','Job #','Supervisor','Employee','Level','Regular Hrs','OT Hrs','Work Description','Equipment','Notes','Submitted At'];
  const csv = [h.join(','),...rows.map(r=>[r.ticket_number,r.date,`"${(r.job_name||'').replace(/"/g,'""')}"`,r.job_number||'',`"${(r.supervisor||'').replace(/"/g,'""')}"`,`"${(r.employee_name||'').replace(/"/g,'""')}"`,`"${(r.level||'').replace(/"/g,'""')}"`,r.regular_hours,r.overtime_hours,`"${(r.work_description||'').replace(/"/g,'""')}"`,`"${(r.equipment_used||'').replace(/"/g,'""')}"`,`"${(r.notes||'').replace(/"/g,'""')}"`,r.submitted_at].join(','))].join('\n');
  logAction(req, 'csv_exported', null, null, 'CSV export');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="jdw-tickets-${Date.now()}.csv"`);
  res.send(csv);
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

ensureDefaultAdmin();

app.listen(PORT, () => {
  console.log(`\n  J&D Western Electric — Field Operations Hub`);
  console.log(`  Running at http://localhost:${PORT}\n`);
});
