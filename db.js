const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'field_ops.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number TEXT UNIQUE NOT NULL,
    date TEXT NOT NULL,
    job_name TEXT NOT NULL,
    job_number TEXT,
    supervisor TEXT NOT NULL,
    work_description TEXT NOT NULL,
    equipment_used TEXT,
    notes TEXT,
    submitted_at TEXT NOT NULL,
    updated_at TEXT,
    archived INTEGER DEFAULT 0,
    archived_at TEXT
  );

  CREATE TABLE IF NOT EXISTS ticket_employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    employee_name TEXT NOT NULL,
    regular_hours REAL DEFAULT 0,
    overtime_hours REAL DEFAULT 0,
    level TEXT DEFAULT 'Journeyman',
    FOREIGN KEY (ticket_id) REFERENCES daily_tickets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    role TEXT DEFAULT 'field',
    status TEXT DEFAULT 'invited',
    invite_token TEXT,
    invite_expires TEXT,
    created_at TEXT NOT NULL,
    last_login TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    data TEXT NOT NULL,
    expires TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    user_name TEXT NOT NULL,
    action TEXT NOT NULL,
    ticket_id INTEGER,
    ticket_number TEXT,
    details TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  PRAGMA foreign_keys = ON;
`);

// Migrations for existing installs
db.exec(`
  CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_number TEXT UNIQUE NOT NULL,
    date TEXT NOT NULL,
    generated_by_id INTEGER,
    generated_by_name TEXT NOT NULL,
    jobber_job_number TEXT NOT NULL,
    supplier TEXT,
    description TEXT NOT NULL,
    estimated_amount REAL,
    status TEXT DEFAULT 'Open',
    office_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS po_sequence (
    year INTEGER PRIMARY KEY,
    last_seq INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS po_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id INTEGER NOT NULL,
    po_number TEXT NOT NULL,
    user_name TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
  );

  -- Real Project folders: admin-created organizational containers that
  -- Time Tickets and POs can be explicitly linked to via project_id.
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    job_numbers TEXT,                 -- comma-separated reference tags
    status TEXT DEFAULT 'active',     -- 'active' | 'complete'
    created_at TEXT NOT NULL,
    updated_at TEXT,
    completed_at TEXT
  );
`);

const migrations = [
  `ALTER TABLE daily_tickets ADD COLUMN archived INTEGER DEFAULT 0`,
  `ALTER TABLE daily_tickets ADD COLUMN archived_at TEXT`,
  `ALTER TABLE ticket_employees ADD COLUMN level TEXT DEFAULT 'Journeyman'`,
  `ALTER TABLE users ADD COLUMN reset_token TEXT`,
  `ALTER TABLE users ADD COLUMN reset_token_expires TEXT`,
  `ALTER TABLE users ADD COLUMN permissions TEXT`,
  `ALTER TABLE daily_tickets ADD COLUMN ticket_status TEXT DEFAULT 'Pending'`,
  `ALTER TABLE daily_tickets ADD COLUMN project_archived INTEGER DEFAULT 0`,
  `ALTER TABLE purchase_orders ADD COLUMN project_archived INTEGER DEFAULT 0`,
  `ALTER TABLE purchase_orders ADD COLUMN job_name TEXT`,
  `ALTER TABLE purchase_orders ADD COLUMN needs_reimbursement INTEGER DEFAULT 0`,
  `ALTER TABLE purchase_orders ADD COLUMN receipt_path TEXT`,
  // Link Time Tickets and POs to a real Project folder (optional)
  `ALTER TABLE daily_tickets ADD COLUMN project_id INTEGER`,
  `ALTER TABLE purchase_orders ADD COLUMN project_id INTEGER`,
];

// Set default permissions for existing users after migration
try {
  db.exec(`UPDATE users SET permissions = 'time_ticket,get_po,office_dashboard' WHERE role = 'admin' AND permissions IS NULL`);
  db.exec(`UPDATE users SET permissions = 'time_ticket' WHERE role = 'field' AND permissions IS NULL`);
} catch {}
for (const sql of migrations) { try { db.exec(sql); } catch {} }

module.exports = db;
