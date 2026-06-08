require('dotenv').config(); // load .env in development
const express  = require('express');
const path     = require('path');
const crypto   = require('crypto');
const XLSX     = require('xlsx');
const multer   = require('multer');
const nodemailer = require('nodemailer');
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

app.use(express.json());
app.use(sessionMiddleware());
app.use(express.static(path.join(__dirname, 'public')));

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

app.post('/api/auth/login', async (req, res) => {
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

app.post('/api/auth/reset/:token', async (req, res) => {
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

app.get('/api/users', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id,name,email,role,status,permissions,created_at,last_login FROM users ORDER BY created_at DESC');
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
  const valid = ['time_ticket','get_po','office_dashboard'];
  if (user.role==='admin' && !permissions.includes('office_dashboard')) {
    const { rows: ac } = await pool.query("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND status='active'");
    if (parseInt(ac[0].c) <= 1) return res.status(400).json({ error: 'Cannot revoke Office Dashboard access — at least one Office Admin must keep this permission.' });
  }
  const cleaned = permissions.filter(p=>valid.includes(p)).join(',');
  await pool.query('UPDATE users SET permissions=$1 WHERE id=$2', [cleaned, req.params.id]);
  logAction(req,'permissions_changed',null,null,`Permissions updated for ${user.name}: ${cleaned||'none'} by ${req.user.name}`);
  res.json({ ok: true, permissions: cleaned });
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
  const { date, job_name, job_number, supervisor, work_description, equipment_used, notes, employees, project_id } = req.body;
  if (!date||!job_name||!supervisor||!work_description) return res.status(400).json({ error: 'Missing required fields' });
  if (!employees?.length) return res.status(400).json({ error: 'At least one employee required' });
  const ticket_number = generateTicketNumber();
  const submitted_at  = new Date().toISOString();
  const resolvedPid   = await resolveProjectId(project_id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO daily_tickets (ticket_number,date,job_name,job_number,supervisor,work_description,equipment_used,notes,submitted_at,project_id,submitted_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [ticket_number,date,job_name,job_number||null,supervisor,work_description,equipment_used||null,notes||null,submitted_at,resolvedPid,req.user?.name||null]
    );
    const tid = rows[0].id;
    for (const e of employees) {
      if (e.name?.trim()) await client.query(
        'INSERT INTO ticket_employees (ticket_id,employee_name,regular_hours,overtime_hours,level,user_id,travel_hours) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [tid, e.name.trim(), parseFloat(e.regular_hours)||0, parseFloat(e.overtime_hours)||0, e.level||'Journeyman', e.user_id||null, parseFloat(e.travel_hours)||0]
      );
    }
    await client.query('COMMIT');
    logAction(req,'ticket_submitted',tid,ticket_number,`Submitted by ${req.user.name}`);
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
        const { rows: admins } = await pool.query("SELECT email FROM users WHERE role='admin' AND status='active'");
        const to = admins.map(a=>a.email).join(',');
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
  const mapT = t => ({ ...t, employees: parseEmployeesRaw(t.employees_raw), employees_raw: undefined });
  res.json({
    project: pr[0],
    tickets:          allT.filter(t=>!t.project_archived).map(mapT),
    purchase_orders:  allP.filter(p=>!p.project_archived),
    archived_tickets: allT.filter(t=> t.project_archived).map(mapT),
    archived_pos:     allP.filter(p=> p.project_archived),
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
      t.updated_at
    FROM ticket_employees te
    JOIN daily_tickets t ON t.id = te.ticket_id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE te.user_id = $1 AND t.date >= $2 AND t.date <= $3
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
      let dayReg = 0, dayOT = 0, dayTravel = 0;
      const allEntered = entries.every(e => e.ticket_status === 'Entered');
      const anyEntered = entries.some(e => e.ticket_status === 'Entered');
      entries.forEach(e => {
        dayReg    += parseFloat(e.regular_hours) ||0;
        dayOT     += parseFloat(e.overtime_hours)||0;
        dayTravel += parseFloat(e.travel_hours)  ||0;
      });
      const approvalStatus = allEntered ? 'entered' : (anyEntered ? 'partial' : 'pending');
      if (allEntered) { enteredReg += dayReg; enteredOT += dayOT; enteredTravel += dayTravel; }
      else            { pendingReg += dayReg; pendingOT += dayOT; pendingTravel += dayTravel; }
      const first = entries[0];
      days.push({ date: dateStr, dow,
        regular_hours: dayReg, overtime_hours: dayOT, travel_hours: dayTravel,
        total_hours: dayReg + dayOT + dayTravel,
        approval_status: approvalStatus, source: 'ticket',
        job_number: entries.map(e=>e.job_number||'').filter(Boolean).join(', '),
        job_name:   entries.map(e=>e.job_name||'').filter(Boolean).join(', '),
        project_name: [...new Set(entries.map(e=>e.project_name||'').filter(Boolean))].join(', '),
        level: first.level,
        ticket_numbers: entries.map(e=>e.ticket_number).join(', '),
        supervisor: first.supervisor, updated_at: first.updated_at, entries });
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
      WHERE te.user_id=$1 AND t.date>=$2 AND t.date<=$3 AND t.ticket_status='Entered'`,
      [u.id, period.start, period.end]);
    const { rows: pendHrs } = await pool.query(`
      SELECT COALESCE(SUM(te.regular_hours),0) AS reg, COALESCE(SUM(te.overtime_hours),0) AS ot,
             COALESCE(SUM(te.travel_hours),0) AS travel
      FROM ticket_employees te JOIN daily_tickets t ON t.id=te.ticket_id
      WHERE te.user_id=$1 AND t.date>=$2 AND t.date<=$3 AND COALESCE(t.ticket_status,'Pending')='Pending'`,
      [u.id, period.start, period.end]);
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

// ── Admin: get one employee's full timesheet ──
app.get('/api/timesheets/:userId', requireAdmin, async (req, res) => {
  const { base, days } = await getPayrollBase();
  const offset = parseInt(req.query.offset ?? getCurrentPeriodOffset(base, days));
  const period = calcPayPeriod(base, days, offset);
  const ts = await buildTimesheet(parseInt(req.params.userId), period.start, period.end);
  if (!ts) return res.status(404).json({ error: 'User not found' });
  res.json({ ...ts, period, offset });
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
  const { status, user_id, from_date, to_date } = req.query;
  const params = []; let where = []; let p = 0;
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
    `SELECT r.*, u.name AS requester_name FROM time_off_requests r
     LEFT JOIN users u ON u.id=r.user_id ${wc} ORDER BY r.created_at DESC`, params);
  res.json(rows);
});

// ── Calendar data ──
// Admins: see all approved + pending
// Field users: see their OWN (any status) + OTHER PEOPLE'S approved only (not pending from others)
app.get('/api/time-off/calendar', requireAuth, async (req, res) => {
  const { from_date, to_date } = req.query;
  let params = []; let where = []; let p = 0;

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
    `SELECT r.id,r.user_id,r.user_name,r.start_date,r.end_date,r.return_to_work_date,r.half_day,r.type,r.note,r.status
     FROM time_off_requests r WHERE ${where.join(' AND ')} ORDER BY r.start_date`, params);
  res.json(rows);
});

// ── Get single request ──
app.get('/api/time-off/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM time_off_requests WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  if (!canApproveTimeOff(req.user) && rows[0].user_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  const { rows: audit } = await pool.query('SELECT * FROM time_off_audit WHERE request_id=$1 ORDER BY created_at ASC', [req.params.id]);
  res.json({ ...rows[0], audit });
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
