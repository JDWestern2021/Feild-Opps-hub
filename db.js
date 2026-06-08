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

    CREATE TABLE IF NOT EXISTS payroll_config (
      id                INTEGER PRIMARY KEY DEFAULT 1,
      cycle_start_date  TEXT NOT NULL DEFAULT '2026-05-25',
      period_days       INTEGER NOT NULL DEFAULT 14
    );

    CREATE TABLE IF NOT EXISTS timesheet_overrides (
      id                 SERIAL PRIMARY KEY,
      employee_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date               TEXT NOT NULL,
      regular_hours      REAL DEFAULT 0,
      overtime_hours     REAL DEFAULT 0,
      travel_hours       REAL DEFAULT 0,
      original_regular   REAL DEFAULT 0,
      original_ot        REAL DEFAULT 0,
      original_travel    REAL DEFAULT 0,
      edited_by_id       INTEGER,
      edited_by_name     TEXT,
      edit_reason        TEXT,
      created_at         TEXT NOT NULL,
      UNIQUE(employee_user_id, date)
    );

    CREATE TABLE IF NOT EXISTS time_off_requests (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_name       TEXT NOT NULL,
      start_date      TEXT NOT NULL,
      end_date        TEXT NOT NULL,
      half_day        TEXT DEFAULT NULL,
      type            TEXT NOT NULL DEFAULT 'Vacation',
      note            TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      reviewed_by_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_by     TEXT,
      reviewed_at     TEXT,
      review_note     TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS time_off_audit (
      id          SERIAL PRIMARY KEY,
      request_id  INTEGER NOT NULL REFERENCES time_off_requests(id) ON DELETE CASCADE,
      user_name   TEXT NOT NULL,
      action      TEXT NOT NULL,
      details     TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS time_off_config (
      id                     INTEGER PRIMARY KEY DEFAULT 1,
      overlap_warning_count  INTEGER NOT NULL DEFAULT 2,
      optional_heritage_day  INTEGER NOT NULL DEFAULT 0,
      optional_boxing_day    INTEGER NOT NULL DEFAULT 0,
      optional_easter_monday INTEGER NOT NULL DEFAULT 0,
      optional_truth_rec_day INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Seed default payroll config if not present
  await pool.query(`INSERT INTO payroll_config (id, cycle_start_date, period_days) VALUES (1, '2026-05-25', 14) ON CONFLICT DO NOTHING`);
  // Add user_id column to ticket_employees if missing
  await pool.query(`ALTER TABLE ticket_employees ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS submitted_by_name TEXT`);
  // Add travel_hours column to ticket_employees
  await pool.query(`ALTER TABLE ticket_employees ADD COLUMN IF NOT EXISTS travel_hours REAL DEFAULT 0`);
  // Seed default time-off config
  await pool.query(`INSERT INTO time_off_config (id) VALUES (1) ON CONFLICT DO NOTHING`);
  // Add return_to_work_date to time_off_requests
  await pool.query(`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS return_to_work_date TEXT`);
  // Add time_off tracking columns to timesheet_overrides
  await pool.query(`ALTER TABLE timesheet_overrides ADD COLUMN IF NOT EXISTS is_time_off INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE timesheet_overrides ADD COLUMN IF NOT EXISTS time_off_request_id INTEGER REFERENCES time_off_requests(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS archived INTEGER DEFAULT 0`);
  console.log('  ✓ Database schema ready');
}

module.exports = { pool, connectWithRetry, initSchema };
