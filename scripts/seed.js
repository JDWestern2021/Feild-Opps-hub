/**
 * seed.js — populates the local database with realistic test data.
 * Guard runs first. Never touches production.
 */
'use strict';
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
require('./db-guard');

const { pool } = require('../db');
const bcrypt   = require('bcryptjs');

// ── Helpers ─────────────────────────────────────────────────────────────────
const hash = pwd => bcrypt.hashSync(pwd, 10);
const now  = () => new Date().toISOString();
const date = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Users (one per role) ─────────────────────────────────────────────────
    console.log('▸ Seeding users...');
    const userRows = await client.query(`
      INSERT INTO users (name, email, password_hash, role, status, created_at)
      VALUES
        ('Admin Office',   'admin@local.dev',      $1, 'admin',      'active', $5),
        ('Sarah Office',   'office@local.dev',     $2, 'office',     'active', $5),
        ('Jake Supervisor','supervisor@local.dev',  $3, 'supervisor', 'active', $5),
        ('Mike LeadHand',  'lead@local.dev',        $4, 'lead_hand',  'active', $5),
        ('Tom Field',      'field@local.dev',       $4, 'field',      'active', $5),
        ('Lisa Field',     'field2@local.dev',      $4, 'field',      'active', $5)
      RETURNING id, name, role
    `, [hash('admin123'), hash('office123'), hash('super123'), hash('field123'), now()]);

    const users = {};
    for (const u of userRows.rows) users[u.role] = u.id;
    const adminId      = userRows.rows.find(u => u.name === 'Admin Office').id;
    const supervisorId = userRows.rows.find(u => u.name === 'Jake Supervisor').id;
    const leadId       = userRows.rows.find(u => u.name === 'Mike LeadHand').id;
    const field1Id     = userRows.rows.find(u => u.name === 'Tom Field').id;
    const field2Id     = userRows.rows.find(u => u.name === 'Lisa Field').id;

    // ── Small project 1 — Henderson Commercial ───────────────────────────────
    console.log('▸ Seeding small projects...');
    const { rows: [p1] } = await client.query(`
      INSERT INTO projects (name, job_numbers, status, permit_required, permit_stage, created_at)
      VALUES ('Henderson Commercial', 'JOB-001', 'active', 'yes', 'submitted', $1)
      RETURNING id
    `, [now()]);

    // Small project 2 — Riverside Reno
    const { rows: [p2] } = await client.query(`
      INSERT INTO projects (name, job_numbers, status, permit_required, created_at)
      VALUES ('Riverside Reno', 'JOB-002', 'active', 'no', $1)
      RETURNING id
    `, [now()]);

    // ── Smith's Landing — 2 buildings × 80 units ─────────────────────────────
    console.log("▸ Seeding Smith's Landing (160 units across 2 buildings)...");
    const { rows: [sl] } = await client.query(`
      INSERT INTO projects (name, job_numbers, status, permit_required, permit_number, permit_stage, created_at)
      VALUES ('Smith''s Landing', 'JOB-003', 'active', 'yes', 'E-2024-08871', 'rough_in_booked', $1)
      RETURNING id
    `, [now()]);

    const slId = sl.id;

    // Panel schedules for Smith's Landing — one per building
    let panelSeq = 1;
    for (const bldg of ['Building A', 'Building B']) {
      const circuits = [];
      const commonCircuits = [
        { desc: 'Corridor lighting', poles: '1', amps: '15' },
        { desc: 'Corridor receptacles', poles: '1', amps: '20' },
        { desc: 'Elevator', poles: '3', amps: '30' },
        { desc: 'Fire alarm panel', poles: '2', amps: '20' },
        { desc: 'Mechanical room', poles: '1', amps: '20' },
        { desc: 'Parkade lighting', poles: '2', amps: '20' },
        { desc: 'Exterior lighting', poles: '1', amps: '15' },
        { desc: 'Lobby receptacles', poles: '1', amps: '20' },
        { desc: 'Security system', poles: '1', amps: '15' },
        { desc: 'Intercom/access', poles: '1', amps: '15' },
        { desc: 'Utility room', poles: '1', amps: '20' },
        { desc: 'Spare', poles: '', amps: '' },
      ];
      for (let i = 0; i < 12; i++) {
        const c = commonCircuits[i] || {};
        circuits.push({
          la_desc: c.desc || '', la_poles: c.poles || '', la_amps: c.amps || '',
          ra_desc: c.desc ? c.desc + ' (B)' : '', ra_poles: c.poles || '', ra_amps: c.amps || '',
        });
      }
      await client.query(`
        INSERT INTO panel_schedules
          (schedule_number, panel_name, voltage, main_breaker, bus_rating, enclosure_type,
           num_circuits, circuit_data, project_id, project_name, job_number,
           created_by, created_at)
        VALUES ($1, $2, '120/240V 1-Ph', '200', '200', 'Indoor',
                24, $3, $4, 'Smith''s Landing', 'JOB-003',
                'Admin Office', $5)
      `, ['PS-' + String(panelSeq++).padStart(4, '0'), bldg + ' Main Panel', JSON.stringify(circuits), slId, now()]);
    }

    // 42-circuit panel — seed for print/column-width regression testing.
    // Uses three-character circuit numbers (A1A, A1B … B21A) to verify
    // cct-col is wide enough after the desc-col width:auto fix.
    const c42 = [];
    const loads42 = [
      { desc: 'Main switchboard feed', poles: '3', amps: '100' },
      { desc: 'HVAC-1 rooftop unit', poles: '3', amps: '60' },
      { desc: 'HVAC-2 rooftop unit', poles: '3', amps: '60' },
      { desc: 'Elevator machine room', poles: '3', amps: '30' },
      { desc: 'Fire alarm panel', poles: '2', amps: '20' },
      { desc: 'Emergency lighting', poles: '2', amps: '20' },
      { desc: 'Corridor lighting L1', poles: '1', amps: '15' },
      { desc: 'Corridor lighting L2', poles: '1', amps: '15' },
      { desc: 'Corridor lighting L3', poles: '1', amps: '15' },
      { desc: 'Lobby receptacles', poles: '1', amps: '20' },
      { desc: 'Lobby lighting', poles: '1', amps: '15' },
      { desc: 'Security / access ctrl', poles: '1', amps: '15' },
      { desc: 'Intercom system', poles: '1', amps: '15' },
      { desc: 'Parkade lighting A', poles: '2', amps: '20' },
      { desc: 'Parkade lighting B', poles: '2', amps: '20' },
      { desc: 'Exterior receptacles N', poles: '1', amps: '20' },
      { desc: 'Exterior receptacles S', poles: '1', amps: '20' },
      { desc: 'Mechanical room', poles: '1', amps: '20' },
      { desc: 'Electrical room', poles: '1', amps: '20' },
      { desc: 'Utility room', poles: '1', amps: '20' },
      { desc: 'Spare', poles: '', amps: '' },
    ];
    for (let i = 0; i < 21; i++) {
      const l = loads42[i] || {};
      const r = loads42[i + 1] || {};
      c42.push({
        la_desc: l.desc || '', la_poles: l.poles || '', la_amps: l.amps || '',
        la_cct:  `A${i+1}A`,
        ra_desc: r.desc || '', ra_poles: r.poles || '', ra_amps: r.amps || '',
        ra_cct:  `B${i+1}A`,
      });
    }
    await client.query(`
      INSERT INTO panel_schedules
        (schedule_number, panel_name, voltage, main_breaker, bus_rating, enclosure_type,
         num_circuits, circuit_data, project_id, project_name, job_number,
         created_by, created_at)
      VALUES ($1, $2, '347/600V 3-Ph', '400', '400', 'Indoor',
              42, $3, $4, 'Smith''s Landing', 'JOB-003',
              'Admin Office', $5)
    `, ['PS-' + String(panelSeq++).padStart(4, '0'), 'Building C Distribution Panel — 42 cct PRINT TEST', JSON.stringify(c42), slId, now()]);

    // Daily tickets for Smith's Landing
    const ticketNums = ['DT-2024-0042', 'DT-2024-0043', 'DT-2024-0044'];
    const ticketDescs = [
      'Rough-in wiring — units 101–110 Building A. Installed conduit, pulled wire, terminated at panels.',
      'Rough-in wiring — units 201–210 Building A. All home-runs complete to panel.',
      'Site meeting with GC re: schedule. Walked Building B floor 1 with inspector.',
    ];
    for (let i = 0; i < 3; i++) {
      const { rows: [tk] } = await client.query(`
        INSERT INTO daily_tickets
          (ticket_number, date, job_name, job_number, supervisor, work_description,
           submitted_at, submitted_by_name, submitted_by_id, project_id, ticket_status)
        VALUES ($1, $2, 'Smith''s Landing', 'JOB-003', 'Jake Supervisor', $3,
                $4, 'Tom Field', $5, $6, 'Approved')
        RETURNING id
      `, [ticketNums[i], date(-7 + i), ticketDescs[i], now(), field1Id, slId]);

      await client.query(`
        INSERT INTO ticket_employees (ticket_id, employee_name, regular_hours, level, user_id)
        VALUES ($1, 'Tom Field', 10, 'Journeyman', $2),
               ($1, 'Mike LeadHand', 10, 'Lead Hand', $3)
      `, [tk.id, field1Id, leadId]);
    }

    // ── A time-off request ───────────────────────────────────────────────────
    await client.query(`
      INSERT INTO time_off_requests
        (user_id, user_name, start_date, end_date, type, note, status, created_at)
      VALUES ($1, 'Lisa Field', $2, $3, 'Vacation', 'Family trip', 'pending', $4)
    `, [field2Id, date(14), date(18), now()]);

    await client.query('COMMIT');
    console.log('');
    console.log('✓ Seed complete.');
    console.log('');
    console.log('  Test credentials (all local only):');
    console.log('  admin@local.dev      / admin123   (admin)');
    console.log('  office@local.dev     / office123  (office)');
    console.log('  supervisor@local.dev / super123   (supervisor)');
    console.log('  lead@local.dev       / field123   (lead_hand)');
    console.log('  field@local.dev      / field123   (field)');
    console.log('  field2@local.dev     / field123   (field)');
    console.log('');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().then(() => process.exit(0)).catch(err => {
  console.error('✗ Seed failed:', err.message);
  process.exit(1);
});
