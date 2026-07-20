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

  await pool.query(`CREATE TABLE IF NOT EXISTS rfq_activity (
    id          SERIAL PRIMARY KEY,
    rfq_id      INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
    user_name   TEXT NOT NULL DEFAULT '',
    action      TEXT NOT NULL DEFAULT '',
    details     TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  console.log('  ✓ Database schema ready');
}

module.exports = { pool, connectWithRetry, initSchema };
