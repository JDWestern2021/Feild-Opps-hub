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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS time_off_color TEXT DEFAULT NULL`);
  // Indexes for fast time-off calendar queries
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tor_status       ON time_off_requests(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tor_start_date   ON time_off_requests(start_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tor_end_date     ON time_off_requests(end_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tor_user_id      ON time_off_requests(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tor_archived      ON time_off_requests(archived)`);
  // OT approval tracking on daily_tickets
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS ot_approved       INTEGER DEFAULT NULL`);
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS ot_approved_by    TEXT    DEFAULT NULL`);
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS ot_approval_ts    TEXT    DEFAULT NULL`);
  // Duplicate-entry tracking on daily_tickets
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS has_duplicate         INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS duplicate_ticket_ids  TEXT    DEFAULT NULL`);
  // Vendor sign-off on daily_tickets
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS vendor_signoff TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS submitted_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  // Returns flag on daily_tickets
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS has_returns INTEGER DEFAULT 0`);
  // Review flag on daily_tickets
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS flag_status TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS flag_reason TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS flag_assigned_to_name TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS flag_assigned_to_id INTEGER DEFAULT NULL`);
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS flag_assigned_at TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS flag_resolved_at TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS flag_resolved_by TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE daily_tickets ADD COLUMN IF NOT EXISTS flag_resolved_note TEXT DEFAULT NULL`);
  // Safety module
  await pool.query(`
    CREATE TABLE IF NOT EXISTS safety_forms (
      id               SERIAL PRIMARY KEY,
      form_type        TEXT NOT NULL,
      form_number      TEXT NOT NULL UNIQUE,
      project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      project_name     TEXT,
      job_number       TEXT,
      submitted_by_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      submitted_by     TEXT NOT NULL,
      submitted_at     TEXT NOT NULL,
      date             TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'Submitted',
      form_data        TEXT NOT NULL DEFAULT '{}',
      archived         INTEGER NOT NULL DEFAULT 0,
      archived_at      TEXT,
      project_archived INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`ALTER TABLE safety_forms ADD COLUMN IF NOT EXISTS project_archived INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE safety_forms ADD COLUMN IF NOT EXISTS psi_flag INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE safety_forms ADD COLUMN IF NOT EXISTS wcb_flag INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE safety_forms ADD COLUMN IF NOT EXISTS reviewed_by TEXT`);
  await pool.query(`ALTER TABLE safety_forms ADD COLUMN IF NOT EXISTS reviewed_at TEXT`);

  // Vehicles fleet list
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id            SERIAL PRIMARY KEY,
      unit_number   TEXT NOT NULL,
      make          TEXT,
      model         TEXT,
      year          INTEGER,
      vin           TEXT,
      license_plate TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      notes         TEXT,
      created_at    TEXT NOT NULL
    )
  `);

  // Vehicle maintenance columns (added incrementally)
  await pool.query(`ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS current_odometer INTEGER`);
  await pool.query(`ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS next_oil_change_km INTEGER`);
  await pool.query(`ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS last_oil_change_date TEXT`);
  await pool.query(`ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS last_inspection_date TEXT`);
  await pool.query(`ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS insurance_expiry TEXT`);
  await pool.query(`ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS registration_expiry TEXT`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicle_documents (
      id           SERIAL PRIMARY KEY,
      vehicle_id   INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      file_type    TEXT,
      data_url     TEXT NOT NULL,
      uploaded_by  TEXT,
      uploaded_at  TEXT NOT NULL,
      notes        TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_maintenance (
      id               SERIAL PRIMARY KEY,
      vehicle_id       INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      maintenance_type TEXT NOT NULL DEFAULT 'other',
      title            TEXT NOT NULL,
      scheduled_date   TEXT NOT NULL,
      notes            TEXT,
      status           TEXT NOT NULL DEFAULT 'scheduled',
      completed_date   TEXT,
      completed_notes  TEXT,
      created_by       TEXT,
      created_at       TEXT NOT NULL
    )
  `);

  // Worker safety certifications
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worker_certifications (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cert_name    TEXT NOT NULL,
      cert_type    TEXT NOT NULL DEFAULT 'other',
      issued_date  TEXT,
      expiry_date  TEXT,
      photo_data   TEXT,
      photo_type   TEXT,
      notes        TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT
    )
  `);

  // Safety photo / signature attachments
  await pool.query(`
    CREATE TABLE IF NOT EXISTS safety_attachments (
      id              SERIAL PRIMARY KEY,
      form_id         INTEGER REFERENCES safety_forms(id) ON DELETE CASCADE,
      attachment_type TEXT NOT NULL,
      field_key       TEXT,
      file_path       TEXT NOT NULL,
      uploaded_by_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      uploaded_at     TEXT NOT NULL,
      meta            TEXT DEFAULT '{}'
    )
  `);

  // Shared corrective-actions register
  await pool.query(`
    CREATE TABLE IF NOT EXISTS corrective_actions (
      id                SERIAL PRIMARY KEY,
      source_form_type  TEXT NOT NULL,
      source_form_id    INTEGER REFERENCES safety_forms(id) ON DELETE SET NULL,
      source_form_number TEXT,
      project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      action            TEXT NOT NULL,
      assigned_to_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      assigned_to_name  TEXT,
      due_date          TEXT,
      completion_date   TEXT,
      status            TEXT NOT NULL DEFAULT 'open',
      notes             TEXT,
      created_by_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by_name   TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      updated_at        TEXT
    )
  `);

  // In-app notifications
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT,
      link        TEXT,
      read        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )
  `);

  // Panel schedules
  await pool.query(`
    CREATE TABLE IF NOT EXISTS panel_schedules (
      id               SERIAL PRIMARY KEY,
      schedule_number  TEXT NOT NULL UNIQUE,
      panel_name       TEXT NOT NULL,
      voltage          TEXT NOT NULL DEFAULT '120/240V 1-Ph',
      main_breaker     TEXT,
      bus_rating       TEXT,
      enclosure_type   TEXT,
      num_circuits     INTEGER NOT NULL DEFAULT 24,
      circuit_data     TEXT NOT NULL DEFAULT '[]',
      project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      project_name     TEXT,
      job_number       TEXT,
      created_by_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by       TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT,
      updated_by       TEXT,
      status           TEXT NOT NULL DEFAULT 'Active',
      archived         INTEGER NOT NULL DEFAULT 0,
      archived_at      TEXT,
      project_archived INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Backfill user_id on ticket_employees rows where it was never set (case-insensitive name match)
  await pool.query(`
    UPDATE ticket_employees te
    SET user_id = u.id
    FROM users u
    WHERE te.user_id IS NULL
      AND LOWER(TRIM(te.employee_name)) = LOWER(TRIM(u.name))
  `);
  // Seed each user's color from the same deterministic palette currently used in the UI
  await pool.query(`UPDATE users SET time_off_color = (ARRAY['#93c5fd','#c4b5fd','#f9a8d4','#6ee7b7','#fcd34d','#fca5a5','#67e8f9','#bef264','#d8b4fe','#fdba74','#5eead4','#fde047'])[((id % 12) + 1)::int] WHERE time_off_color IS NULL`);

  // Tool inventory
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tools (
      id            SERIAL PRIMARY KEY,
      tool_number   TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      category      TEXT NOT NULL DEFAULT 'General',
      description   TEXT,
      serial_number TEXT,
      status        TEXT NOT NULL DEFAULT 'available',
      notes         TEXT,
      added_by_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      added_by_name TEXT,
      created_at    TEXT NOT NULL
    )
  `);

  // Tool sign-out/return log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tool_assignments (
      id                   SERIAL PRIMARY KEY,
      tool_id              INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
      tool_number          TEXT NOT NULL,
      tool_name            TEXT NOT NULL,
      project_id           INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      project_name         TEXT,
      vehicle_id           INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
      vehicle_unit         TEXT,
      assigned_to_name     TEXT,
      checked_out_by_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      checked_out_by_name  TEXT NOT NULL,
      checked_out_at       TEXT NOT NULL,
      checked_in_by_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      checked_in_by_name   TEXT,
      checked_in_at        TEXT,
      condition_on_return  TEXT,
      return_notes         TEXT,
      status               TEXT NOT NULL DEFAULT 'active'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tool_number_seq (
      last_seq INTEGER DEFAULT 0
    )
  `);
  await pool.query(`INSERT INTO tool_number_seq (last_seq) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM tool_number_seq)`);
  await pool.query(`ALTER TABLE tools ADD COLUMN IF NOT EXISTS photo_data TEXT`);
  await pool.query(`ALTER TABLE tool_assignments ADD COLUMN IF NOT EXISTS return_photo_data TEXT`);
  await pool.query(`ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS nickname TEXT`);
  await pool.query(`ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS photo_data TEXT`);
  await pool.query(`ALTER TABLE tools ADD COLUMN IF NOT EXISTS archived_at TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS vehicle_service_records (
    id SERIAL PRIMARY KEY,
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    service_type TEXT NOT NULL DEFAULT 'other',
    description TEXT NOT NULL,
    service_date TEXT NOT NULL,
    odometer INTEGER,
    performed_by TEXT,
    cost NUMERIC(10,2),
    notes TEXT,
    created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_name TEXT,
    created_at TEXT NOT NULL
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS sop_categories (
    id SERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SS')
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sop_documents (
    id SERIAL PRIMARY KEY,
    category_slug TEXT NOT NULL,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_size INTEGER,
    uploaded_by TEXT,
    uploaded_at TEXT NOT NULL DEFAULT to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SS'),
    sort_order INTEGER DEFAULT 0
  )`);
  // Add new columns if they don't exist yet (safe for live DB)
  await pool.query(`ALTER TABLE sop_documents ADD COLUMN IF NOT EXISTS file_data BYTEA`);
  await pool.query(`ALTER TABLE sop_documents ADD COLUMN IF NOT EXISTS mime_type TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE sop_documents ADD COLUMN IF NOT EXISTS archived_at TEXT`);
  await pool.query(`ALTER TABLE sop_documents ADD COLUMN IF NOT EXISTS archived_by TEXT NOT NULL DEFAULT ''`);
  // Seed default category if none exist
  await pool.query(`INSERT INTO sop_categories (slug,label,sort_order) VALUES ('residential','Residential Homes',0) ON CONFLICT(slug) DO NOTHING`);

  await pool.query(`CREATE TABLE IF NOT EXISTS project_wire (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    wire_type TEXT NOT NULL DEFAULT '',
    gauge TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    kg_per_m NUMERIC(8,4) NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SS')
  )`);
  // Safe migrations for existing installs
  await pool.query(`ALTER TABLE project_wire ADD COLUMN IF NOT EXISTS kg_per_m NUMERIC(8,4) NOT NULL DEFAULT 0`);
  await pool.query(`CREATE TABLE IF NOT EXISTS project_wire_entries (
    id SERIAL PRIMARY KEY,
    wire_id INTEGER NOT NULL REFERENCES project_wire(id) ON DELETE CASCADE,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('sent','installed')),
    entry_date TEXT NOT NULL,
    kg NUMERIC(10,3) NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SS')
  )`);
  await pool.query(`ALTER TABLE project_wire_entries ADD COLUMN IF NOT EXISTS deleted_at TEXT`);
  await pool.query(`ALTER TABLE project_wire_entries ADD COLUMN IF NOT EXISTS deleted_by TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE project_wire ADD COLUMN IF NOT EXISTS deleted_at TEXT`);
  // Store wire label in each entry so the activity log survives wire type deletion
  await pool.query(`ALTER TABLE project_wire_entries ADD COLUMN IF NOT EXISTS wire_label TEXT NOT NULL DEFAULT ''`);

  // ─── RFQ MODULE ───────────────────────────────────────────────────────────
  await pool.query(`CREATE TABLE IF NOT EXISTS suppliers (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    contact    TEXT NOT NULL DEFAULT '',
    email      TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SS')
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS rfq_sequence (
    year     INTEGER PRIMARY KEY,
    last_seq INTEGER DEFAULT 0
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS rfqs (
    id              SERIAL PRIMARY KEY,
    rfq_number      TEXT UNIQUE NOT NULL,
    project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    project_name    TEXT NOT NULL DEFAULT '',
    title           TEXT NOT NULL DEFAULT '',
    attention       TEXT NOT NULL DEFAULT '',
    due_date        TEXT NOT NULL DEFAULT '',
    notes           TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'DRAFT',
    created_by_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_name TEXT NOT NULL DEFAULT '',
    approved_by     TEXT NOT NULL DEFAULT '',
    approved_at     TEXT,
    converted_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SS'),
    updated_at      TEXT
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS rfq_line_items (
    id          SERIAL PRIMARY KEY,
    rfq_id      INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
    item_num    INTEGER NOT NULL DEFAULT 0,
    qty         NUMERIC(12,3) NOT NULL DEFAULT 0,
    unit        TEXT NOT NULL DEFAULT 'EA',
    part_number TEXT NOT NULL DEFAULT '',
    size        TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS rfq_suppliers (
    id          SERIAL PRIMARY KEY,
    rfq_id      INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    sent_at     TEXT,
    notes       TEXT NOT NULL DEFAULT ''
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS rfq_quotes (
    id                SERIAL PRIMARY KEY,
    rfq_id            INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
    rfq_line_item_id  INTEGER NOT NULL REFERENCES rfq_line_items(id) ON DELETE CASCADE,
    rfq_supplier_id   INTEGER NOT NULL REFERENCES rfq_suppliers(id) ON DELETE CASCADE,
    unit_price        NUMERIC(12,4) NOT NULL DEFAULT 0,
    lead_time         TEXT NOT NULL DEFAULT '',
    notes             TEXT NOT NULL DEFAULT '',
    is_selected       INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SS'),
    updated_at        TEXT
  )`);

  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS rfq_quotes_line_supplier_uidx
    ON rfq_quotes(rfq_line_item_id, rfq_supplier_id)`);

  await pool.query(`CREATE TABLE IF NOT EXISTS rfq_pos (
    id              SERIAL PRIMARY KEY,
    rfq_id          INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE RESTRICT,
    po_id           INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
    po_number       TEXT NOT NULL DEFAULT '',
    rfq_supplier_id INTEGER REFERENCES rfq_suppliers(id) ON DELETE SET NULL,
    supplier_name   TEXT NOT NULL DEFAULT '',
    subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
    gst             NUMERIC(12,2) NOT NULL DEFAULT 0,
    total           NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SS')
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS rfq_po_items (
    id                  SERIAL PRIMARY KEY,
    rfq_id              INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
    rfq_pos_id          INTEGER REFERENCES rfq_pos(id) ON DELETE CASCADE,
    po_id               INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
    po_number           TEXT NOT NULL DEFAULT '',
    rfq_line_item_id    INTEGER REFERENCES rfq_line_items(id) ON DELETE CASCADE,
    rfq_supplier_id     INTEGER REFERENCES rfq_suppliers(id) ON DELETE SET NULL,
    supplier_name       TEXT NOT NULL DEFAULT '',
    unit_price          NUMERIC(12,2) NOT NULL DEFAULT 0,
    qty                 NUMERIC(10,3) NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SS')
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS rfq_change_orders (
    id              SERIAL PRIMARY KEY,
    rfq_id          INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE RESTRICT,
    co_number       TEXT NOT NULL DEFAULT '',
    project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    project_name    TEXT NOT NULL DEFAULT '',
    gc_name         TEXT NOT NULL DEFAULT '',
    gc_contact      TEXT NOT NULL DEFAULT '',
    notes           TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'DRAFT',
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SS'),
    updated_at      TEXT
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS rfq_co_line_items (
    id               SERIAL PRIMARY KEY,
    change_order_id  INTEGER NOT NULL REFERENCES rfq_change_orders(id) ON DELETE CASCADE,
    rfq_line_item_id INTEGER REFERENCES rfq_line_items(id) ON DELETE SET NULL,
    description      TEXT NOT NULL DEFAULT '',
    qty              NUMERIC(12,3) NOT NULL DEFAULT 0,
    unit             TEXT NOT NULL DEFAULT 'EA',
    unit_cost        NUMERIC(12,4) NOT NULL DEFAULT 0,
    markup_pct       NUMERIC(6,2) NOT NULL DEFAULT 0,
    labour_hours     NUMERIC(10,2) NOT NULL DEFAULT 0,
    labour_rate      NUMERIC(10,2) NOT NULL DEFAULT 0,
    sort_order       INTEGER NOT NULL DEFAULT 0
  )`);

  await pool.query(`ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS archived_at TEXT`);
  await pool.query(`ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS deleted_at TEXT`);

  // ─── CERTIFICATION CATALOG ────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cert_catalog (
      id               SERIAL PRIMARY KEY,
      display_name     TEXT NOT NULL,
      short_code       TEXT NOT NULL UNIQUE,
      tier             TEXT NOT NULL CHECK (tier IN ('required','tracked')),
      validity_months  INTEGER,
      expires          BOOLEAN NOT NULL DEFAULT TRUE,
      active           BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order       INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Seed catalog — ON CONFLICT DO NOTHING so re-runs are safe
  await pool.query(`
    INSERT INTO cert_catalog (display_name, short_code, tier, validity_months, expires, sort_order) VALUES
      ('WHMIS 2015',                         'WHMIS',  'required', 12,   TRUE,  1),
      ('TDG (Transportation of Dangerous Goods)', 'TDG', 'required', 36, TRUE,  2),
      ('Standard First Aid / CPR',           'SFA',    'required', 36,   TRUE,  3),
      ('Fall Protection (Fall Arrest)',       'FP',     'required', 36,   TRUE,  4),
      ('Aerial Work Platform',               'AWP',    'required', 36,   TRUE,  5),
      ('Ground Disturbance 201',             'GD201',  'required', 36,   TRUE,  6),
      ('CSTS-2020',                          'CSTS',   'tracked',  36,   TRUE,  7),
      ('Bear / Wildlife Awareness',          'BWA',    'tracked',  36,   TRUE,  8),
      ('H2S Alive',                          'H2S',    'tracked',  36,   TRUE,  9),
      ('Forklift',                           'FORK',   'tracked',  36,   TRUE,  10),
      ('Skid Steer',                         'SKID',   'tracked',  36,   TRUE,  11),
      ('Zoom Boom (Telehandler)',             'ZOOM',   'tracked',  36,   TRUE,  12),
      ('Leadership for Safety Excellence',   'LSE',    'tracked',  NULL, FALSE, 13),
      ('Supervisor Certification',           'SUPV',   'tracked',  NULL, FALSE, 14),
      ('Project Management Certification',   'PMC',    'tracked',  NULL, FALSE, 15)
    ON CONFLICT (short_code) DO NOTHING
  `);
  // Add catalog FK to worker_certifications (nullable — existing rows get mapped separately)
  await pool.query(`ALTER TABLE worker_certifications ADD COLUMN IF NOT EXISTS catalog_id INTEGER REFERENCES cert_catalog(id)`);
  // Soft-delete flag on users — replaces hard DELETE
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`);
  // Expiry warning window (days before expiry that cert shows as "expiring soon")
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('cert_expiry_warning_days', '60') ON CONFLICT DO NOTHING`);

  // ── Per-employee requirement templates ──────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cert_requirement_templates (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS template_cert_requirements (
      template_id INTEGER NOT NULL REFERENCES cert_requirement_templates(id) ON DELETE CASCADE,
      catalog_id  INTEGER NOT NULL REFERENCES cert_catalog(id) ON DELETE CASCADE,
      required    BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (template_id, catalog_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_cert_requirements (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      catalog_id INTEGER NOT NULL REFERENCES cert_catalog(id) ON DELETE CASCADE,
      required   BOOLEAN NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, catalog_id)
    )
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS template_id INTEGER REFERENCES cert_requirement_templates(id)`);

  // Seed Field Staff template (WHMIS, TDG, SFA, Fall Protection, AWP, Ground Disturbance)
  await pool.query(`
    WITH ins AS (
      INSERT INTO cert_requirement_templates (name)
      SELECT 'Field Staff'
      WHERE NOT EXISTS (SELECT 1 FROM cert_requirement_templates WHERE name = 'Field Staff')
      RETURNING id
    )
    INSERT INTO template_cert_requirements (template_id, catalog_id)
    SELECT ins.id, c.id FROM ins CROSS JOIN cert_catalog c
    WHERE c.short_code IN ('WHMIS','TDG','SFA','FP','AWP','GD201')
  `);

  // Seed Office Staff template (WHMIS, SFA only)
  await pool.query(`
    WITH ins AS (
      INSERT INTO cert_requirement_templates (name)
      SELECT 'Office Staff'
      WHERE NOT EXISTS (SELECT 1 FROM cert_requirement_templates WHERE name = 'Office Staff')
      RETURNING id
    )
    INSERT INTO template_cert_requirements (template_id, catalog_id)
    SELECT ins.id, c.id FROM ins CROSS JOIN cert_catalog c
    WHERE c.short_code IN ('WHMIS','SFA')
  `);

  // Auto-assign templates to existing users that have none yet
  await pool.query(`
    UPDATE users SET template_id = (SELECT id FROM cert_requirement_templates WHERE name = 'Field Staff')
    WHERE role = 'field' AND template_id IS NULL
  `);
  await pool.query(`
    UPDATE users SET template_id = (SELECT id FROM cert_requirement_templates WHERE name = 'Office Staff')
    WHERE role != 'field' AND template_id IS NULL
  `);

  await pool.query(`CREATE TABLE IF NOT EXISTS rfq_activity (
    id          SERIAL PRIMARY KEY,
    rfq_id      INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
    user_name   TEXT NOT NULL DEFAULT '',
    action      TEXT NOT NULL DEFAULT '',
    details     TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // ── Permit tracking ──
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS permit_required TEXT NOT NULL DEFAULT 'unset'`);
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS permit_number TEXT`);
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS permit_stage TEXT NOT NULL DEFAULT 'not_started'`);
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS permit_notes TEXT`);
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS permit_updated_at TEXT`);

  await pool.query(`CREATE TABLE IF NOT EXISTS project_documents (
    id           SERIAL PRIMARY KEY,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    category     TEXT NOT NULL,
    file_name    TEXT NOT NULL,
    mime_type    TEXT NOT NULL,
    file_data    BYTEA NOT NULL,
    uploaded_by  TEXT NOT NULL DEFAULT '',
    uploaded_at  TEXT NOT NULL
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS project_inspections (
    id               SERIAL PRIMARY KEY,
    project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    inspection_type  TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'requested',
    requested_at     TEXT NOT NULL,
    result_at        TEXT,
    notes            TEXT,
    created_by       TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS space_types (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    icon       TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS spaces (
    id            SERIAL PRIMARY KEY,
    project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id     INTEGER REFERENCES spaces(id) ON DELETE CASCADE,
    space_type_id INTEGER REFERENCES space_types(id),
    identifier    TEXT NOT NULL,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    archived_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Seed space_types once
  const { rowCount: stCount } = await pool.query('SELECT 1 FROM space_types LIMIT 1');
  if (stCount === 0) {
    await pool.query(`
      INSERT INTO space_types (name, icon, sort_order) VALUES
        ('Building',          '🏢', 1),
        ('Floor',             '📐', 2),
        ('Unit',              '🚪', 3),
        ('Suite',             '🏠', 4),
        ('Common Area',       '🛋️', 5),
        ('Lobby',             '🏛️', 6),
        ('Parkade',           '🚗', 7),
        ('Mechanical Room',   '⚙️', 8),
        ('Electrical Room',   '⚡', 9),
        ('Stairwell',         '🪜', 10),
        ('Roof',              '🏗️', 11),
        ('Exterior',          '🌿', 12),
        ('Service Room',      '🔧', 13),
        ('Storage Room',      '📦', 14)
    `);
  }

  // ── Plan types (suite layout types, per-project) ───────────────────────────
  // Panel schedules live here as BYTEA — six files max. See implementation
  // notes: before deficiency photos, decide on file storage (BYTEA vs object
  // storage) — thousands of photos as BYTEA inside Postgres is not the plan.
  await pool.query(`CREATE TABLE IF NOT EXISTS plan_types (
    id                SERIAL PRIMARY KEY,
    project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    code              TEXT NOT NULL,
    name              TEXT,
    notes             TEXT,
    panel_file_data   BYTEA,
    panel_mime_type   TEXT,
    panel_file_name   TEXT,
    panel_file_size   INTEGER,
    panel_uploaded_by TEXT,
    panel_uploaded_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, code)
  )`);

  // plan_type_id — the only change to spaces; nullable so non-suite spaces stay null
  await pool.query(`ALTER TABLE spaces ADD COLUMN IF NOT EXISTS plan_type_id INTEGER REFERENCES plan_types(id) ON DELETE SET NULL`);

  // New space types for building-level verticals — idempotent, UNIQUE(name) exists
  await pool.query(`
    INSERT INTO space_types (name, icon, sort_order)
    VALUES ('Elevator', '', 15), ('Mechanical Shaft', '', 16)
    ON CONFLICT (name) DO NOTHING
  `);

  // Parking Lot is a surface lot at project level — distinct from Parkade (underground level)
  await pool.query(`
    INSERT INTO space_types (name, icon, sort_order)
    VALUES ('Parking Lot', '🅿️', 17)
    ON CONFLICT (name) DO NOTHING
  `);

  await pool.query(`CREATE TABLE IF NOT EXISTS user_module_permissions (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module     TEXT NOT NULL,
    access     TEXT NOT NULL DEFAULT 'none' CHECK (access IN ('none','field','manage')),
    UNIQUE (user_id, module)
  )`);

  // Rename levels: view→field, edit→manage. DROP before UPDATE so old values
  // don't violate the new constraint; WHERE guard makes UPDATE a no-op on re-runs.
  await pool.query(`
    ALTER TABLE user_module_permissions
      DROP CONSTRAINT IF EXISTS user_module_permissions_access_check
  `);
  await pool.query(`
    UPDATE user_module_permissions
      SET access = CASE access WHEN 'view' THEN 'field' WHEN 'edit' THEN 'manage' ELSE access END
      WHERE access IN ('view', 'edit')
  `);
  await pool.query(`
    ALTER TABLE user_module_permissions
      ADD CONSTRAINT user_module_permissions_access_check CHECK (access IN ('none','field','manage'))
  `);

  // Backfill: any existing non-admin user gets 'field' on worksites if they have no row yet
  await pool.query(`
    INSERT INTO user_module_permissions (user_id, module, access)
    SELECT u.id, 'worksites', 'field'
    FROM users u
    WHERE u.role <> 'admin'
      AND NOT EXISTS (
        SELECT 1 FROM user_module_permissions p
        WHERE p.user_id = u.id AND p.module = 'worksites'
      )
  `);

  // ── space_files ─────────────────────────────────────────────────────────────
  await pool.query(`CREATE TABLE IF NOT EXISTS space_files (
    id           SERIAL PRIMARY KEY,
    space_id     INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    file_data    BYTEA NOT NULL,
    mime_type    TEXT NOT NULL,
    file_name    TEXT NOT NULL,
    caption      TEXT,
    uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // ── deficiencies ────────────────────────────────────────────────────────────
  await pool.query(`CREATE TABLE IF NOT EXISTS deficiencies (
    id           SERIAL PRIMARY KEY,
    space_id     INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    description  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
    raised_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    raised_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_to  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at  TIMESTAMPTZ
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS deficiency_photos (
    id              SERIAL PRIMARY KEY,
    deficiency_id   INTEGER NOT NULL REFERENCES deficiencies(id) ON DELETE CASCADE,
    file_data       BYTEA NOT NULL,
    mime_type       TEXT NOT NULL,
    uploaded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS plan_type_files (
    id            SERIAL PRIMARY KEY,
    plan_type_id  INTEGER NOT NULL REFERENCES plan_types(id) ON DELETE CASCADE,
    file_data     BYTEA NOT NULL,
    mime_type     TEXT NOT NULL,
    file_name     TEXT NOT NULL,
    caption       TEXT,
    uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // ── Chunk 8: Lists & Notes ──────────────────────────────────────────────

  await pool.query(`CREATE TABLE IF NOT EXISTS list_types (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);

  await pool.query(`
    INSERT INTO list_types (name, sort_order) VALUES ('Material', 1), ('Finishing', 2)
    ON CONFLICT (name) DO NOTHING
  `);

  // Exactly one of space_id / plan_type_id must be set (enforced by CHECK).
  await pool.query(`CREATE TABLE IF NOT EXISTS space_lists (
    id           SERIAL PRIMARY KEY,
    space_id     INTEGER REFERENCES spaces(id) ON DELETE CASCADE,
    plan_type_id INTEGER REFERENCES plan_types(id) ON DELETE CASCADE,
    list_type_id INTEGER NOT NULL REFERENCES list_types(id),
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
      (space_id IS NOT NULL AND plan_type_id IS NULL) OR
      (space_id IS NULL     AND plan_type_id IS NOT NULL)
    )
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS list_items (
    id          SERIAL PRIMARY KEY,
    list_id     INTEGER NOT NULL REFERENCES space_lists(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    quantity    NUMERIC NOT NULL DEFAULT 1,
    unit        TEXT,
    status      TEXT NOT NULL DEFAULT 'needed'
                  CHECK (status IN ('needed','ordered','received','installed')),
    added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes       TEXT
  )`);

  // Migrate list_items status from 4-value to 3-value set.
  // Order: drop old constraint → migrate rows → add new constraint.
  // All three steps are idempotent (IF EXISTS / WHERE covers already-migrated rows).
  await pool.query(`ALTER TABLE list_items DROP CONSTRAINT IF EXISTS list_items_status_check`);
  await pool.query(`UPDATE list_items SET status = 'delivered' WHERE status IN ('received','installed')`);
  await pool.query(`ALTER TABLE list_items ADD CONSTRAINT list_items_status_check
    CHECK (status IN ('needed','ordered','delivered'))`);

  // One-time migration log — records which migrations have already run.
  // Checked before any destructive or one-time data operation.
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name   TEXT PRIMARY KEY,
    ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Flat material requests per space (replaces space-level space_lists in the UI).
  // Type-level standard lists still live in space_lists with plan_type_id.
  await pool.query(`CREATE TABLE IF NOT EXISTS material_requests (
    id          SERIAL PRIMARY KEY,
    space_id    INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    quantity    NUMERIC NOT NULL DEFAULT 1,
    unit        TEXT,
    status      TEXT NOT NULL DEFAULT 'needed'
                  CHECK (status IN ('needed','ordered','delivered')),
    added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes       TEXT
  )`);

  // One-time backfill: copy space-level list_items → material_requests.
  // Guards on the schema_migrations row so it never re-runs (and never
  // resurrects items the user has deleted).
  {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = 'material_requests_backfill'"
    );
    if (!rowCount) {
      await pool.query(`
        INSERT INTO material_requests (space_id, description, quantity, unit, status, added_by, added_at, notes)
        SELECT sl.space_id, li.description, li.quantity, li.unit, li.status, li.added_by, li.added_at, li.notes
        FROM list_items li
        JOIN space_lists sl ON sl.id = li.list_id
        WHERE sl.space_id IS NOT NULL
      `);
      await pool.query(
        "INSERT INTO schema_migrations (name) VALUES ('material_requests_backfill')"
      );
    }
  }

  await pool.query(`CREATE TABLE IF NOT EXISTS space_notes (
    id           SERIAL PRIMARY KEY,
    space_id     INTEGER REFERENCES spaces(id) ON DELETE CASCADE,
    plan_type_id INTEGER REFERENCES plan_types(id) ON DELETE CASCADE,
    body         TEXT NOT NULL,
    author_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
      (space_id IS NOT NULL AND plan_type_id IS NULL) OR
      (space_id IS NULL     AND plan_type_id IS NOT NULL)
    )
  )`);

  // Per-suite panel overrides — separate table keeps BYTEA off the spaces row
  // so tree loads never pull panel PDFs accidentally.
  await pool.query(`CREATE TABLE IF NOT EXISTS space_panel_overrides (
    id              SERIAL PRIMARY KEY,
    space_id        INTEGER NOT NULL UNIQUE REFERENCES spaces(id) ON DELETE CASCADE,
    panel_file_data BYTEA NOT NULL,
    panel_mime_type TEXT,
    panel_file_name TEXT,
    panel_file_size INTEGER,
    uploaded_by     TEXT,
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Migrate existing plan_types.notes (free-text textarea) to space_notes entries.
  // Runs once per type that has notes and no space_notes row yet — idempotent.
  await pool.query(`
    INSERT INTO space_notes (plan_type_id, body, author_id, created_at)
    SELECT pt.id, pt.notes, NULL, NOW()
    FROM   plan_types pt
    WHERE  pt.notes IS NOT NULL AND pt.notes != ''
      AND  NOT EXISTS (
        SELECT 1 FROM space_notes sn WHERE sn.plan_type_id = pt.id
      )
  `);

  console.log('  ✓ Database schema ready');
}

module.exports = { pool, connectWithRetry, initSchema };
