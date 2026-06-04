const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

// ── Retry connection on startup ──
async function connectWithRetry(maxRetries = 10, delayMs = 2000) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const client = await pool.connect();
      client.release();
      console.log('  ✓ Database connected');
      return;
    } catch (err) {
      console.log(`  ⟳ DB connection attempt ${i}/${maxRetries} failed — retrying in ${delayMs}ms`);
      if (i === maxRetries) throw new Error('Could not connect to database: ' + err.message);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ── Create all tables ──
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_tickets (
      id               SERIAL PRIMARY KEY,
      ticket_number    TEXT UNIQUE NOT NULL,
      date             TEXT NOT NULL,
      job_name         TEXT NOT NULL,
      job_number       TEXT,
      supervisor       TEXT NOT NULL,
      work_description TEXT NOT NULL,
      equipment_used   TEXT,
      notes            TEXT,
      submitted_at     TEXT NOT NULL,
      updated_at       TEXT,
      archived         INTEGER DEFAULT 0,
      archived_at      TEXT,
      project_id       INTEGER,
      ticket_status    TEXT DEFAULT 'Pending',
      project_archived INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ticket_employees (
      id             SERIAL PRIMARY KEY,
      ticket_id      INTEGER NOT NULL REFERENCES daily_tickets(id) ON DELETE CASCADE,
      employee_name  TEXT NOT NULL,
      regular_hours  REAL DEFAULT 0,
      overtime_hours REAL DEFAULT 0,
      level          TEXT DEFAULT 'Journeyman'
    );

    CREATE TABLE IF NOT EXISTS users (
      id                   SERIAL PRIMARY KEY,
      name                 TEXT NOT NULL,
      email                TEXT UNIQUE NOT NULL,
      password_hash        TEXT,
      role                 TEXT DEFAULT 'field',
      status               TEXT DEFAULT 'invited',
      invite_token         TEXT,
      invite_expires       TEXT,
      created_at           TEXT NOT NULL,
      last_login           TEXT,
      reset_token          TEXT,
      reset_token_expires  TEXT,
      permissions          TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid    TEXT NOT NULL PRIMARY KEY,
      sess   JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);

    CREATE TABLE IF NOT EXISTS audit_log (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER,
      user_name     TEXT NOT NULL,
      action        TEXT NOT NULL,
      ticket_id     INTEGER,
      ticket_number TEXT,
      details       TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id                 SERIAL PRIMARY KEY,
      po_number          TEXT UNIQUE NOT NULL,
      date               TEXT NOT NULL,
      generated_by_id    INTEGER,
      generated_by_name  TEXT NOT NULL,
      jobber_job_number  TEXT NOT NULL,
      supplier           TEXT,
      description        TEXT NOT NULL,
      estimated_amount   REAL,
      status             TEXT DEFAULT 'Open',
      office_note        TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT,
      job_name           TEXT,
      needs_reimbursement INTEGER DEFAULT 0,
      receipt_path       TEXT,
      project_id         INTEGER,
      project_archived   INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS po_sequence (
      year     INTEGER PRIMARY KEY,
      last_seq INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS po_audit_log (
      id         SERIAL PRIMARY KEY,
      po_id      INTEGER NOT NULL,
      po_number  TEXT NOT NULL,
      user_name  TEXT NOT NULL,
      action     TEXT NOT NULL,
      details    TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      job_numbers  TEXT,
      status       TEXT DEFAULT 'active',
      created_at   TEXT,
      updated_at   TEXT,
      completed_at TEXT
    );
  `);
  console.log('  ✓ Database schema ready');
}

module.exports = { pool, connectWithRetry, initSchema };
