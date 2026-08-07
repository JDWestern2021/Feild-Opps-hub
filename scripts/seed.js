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
const { addSpace, bulkSpaces, duplicateSubtree, typeId } = require('./spaces-service');

// ── Helpers ─────────────────────────────────────────────────────────────────
const hash = pwd => bcrypt.hashSync(pwd, 10);
const now  = () => new Date().toISOString();
const date = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

// ── Worksite review seed data (material requests, deficiencies, notes) ────────
async function seedWorksiteData(slId, adminId, supervisorId, leadId, field1Id, field2Id) {
  // Look up suite IDs by identifier — spread across both buildings, multiple floors
  async function suiteId(identifier) {
    const { rows } = await pool.query(
      `SELECT s.id FROM spaces s
       JOIN space_types st ON st.id = s.space_type_id
       WHERE s.project_id=$1 AND s.identifier=$2 AND st.name='Suite' LIMIT 1`,
      [slId, identifier]
    );
    return rows[0]?.id;
  }

  const suites = {
    // Building 1
    b1f1_101: await suiteId('Suite 101'),
    b1f1_103: await suiteId('Suite 103'),
    b1f1_108: await suiteId('Suite 108'),
    b1f2_205: await suiteId('Suite 205'),
    b1f2_211: await suiteId('Suite 211'),
    b1f2_215: await suiteId('Suite 215'),
    b1f3_302: await suiteId('Suite 302'),
    b1f3_309: await suiteId('Suite 309'),
    b1f4_412: await suiteId('Suite 412'),
    b1f4_420: await suiteId('Suite 420'),
  };

  // In the duplicated Building 2, suite identifiers are identical (same seeder)
  // so we can't distinguish by identifier alone — look up by building path instead.
  async function b2SuiteId(identifier) {
    const { rows } = await pool.query(`
      WITH RECURSIVE tree AS (
        SELECT id FROM spaces WHERE project_id=$1 AND identifier='Building 2' AND parent_id IS NULL
        UNION ALL
        SELECT s.id FROM spaces s JOIN tree t ON s.parent_id = t.id WHERE s.archived_at IS NULL
      )
      SELECT s.id FROM spaces s
      JOIN space_types st ON st.id = s.space_type_id
      WHERE s.id IN (SELECT id FROM tree) AND s.identifier=$2 AND st.name='Suite'
      LIMIT 1
    `, [slId, identifier]);
    return rows[0]?.id;
  }

  const b2 = {
    f1_102: await b2SuiteId('Suite 102'),
    f2_207: await b2SuiteId('Suite 207'),
    f3_314: await b2SuiteId('Suite 314'),
    f4_401: await b2SuiteId('Suite 401'),
    f4_416: await b2SuiteId('Suite 416'),
  };

  // ── Material requests ────────────────────────────────────────────────────────
  // Duplicate descriptions intentional: smoke detectors & dimmer switches appear
  // in multiple suites → summary export must sum them.
  const matRequests = [
    // B1 Floor 1
    { sid: suites.b1f1_101, desc: 'Smoke detector',       qty: 1,  unit: 'ea',  status: 'delivered', by: leadId },
    { sid: suites.b1f1_101, desc: 'Dimmer switch',        qty: 2,  unit: 'ea',  status: 'delivered', by: leadId },
    { sid: suites.b1f1_103, desc: 'Smoke detector',       qty: 1,  unit: 'ea',  status: 'ordered',   by: leadId },
    { sid: suites.b1f1_103, desc: 'GFCI outlet',          qty: 3,  unit: 'ea',  status: 'needed',    by: field1Id },
    { sid: suites.b1f1_108, desc: 'Dimmer switch',        qty: 3,  unit: 'ea',  status: 'ordered',   by: leadId },
    { sid: suites.b1f1_108, desc: 'Range hood outlet',    qty: 1,  unit: 'ea',  status: 'needed',    by: field1Id },
    // B1 Floor 2
    { sid: suites.b1f2_205, desc: 'Smoke detector',       qty: 1,  unit: 'ea',  status: 'needed',    by: field1Id },
    { sid: suites.b1f2_205, desc: 'USB outlet',           qty: 2,  unit: 'ea',  status: 'needed',    by: field1Id },
    { sid: suites.b1f2_211, desc: 'GFCI outlet',          qty: 2,  unit: 'ea',  status: 'ordered',   by: leadId },
    { sid: suites.b1f2_211, desc: 'Dimmer switch',        qty: 4,  unit: 'ea',  status: 'needed',    by: field2Id },
    { sid: suites.b1f2_215, desc: '50A dryer outlet',     qty: 1,  unit: 'ea',  status: 'needed',    by: field2Id },
    // B1 Floor 3
    { sid: suites.b1f3_302, desc: 'Smoke detector',       qty: 1,  unit: 'ea',  status: 'needed',    by: field2Id },
    { sid: suites.b1f3_309, desc: 'GFCI outlet',          qty: 4,  unit: 'ea',  status: 'needed',    by: field2Id },
    { sid: suites.b1f4_412, desc: 'Smoke detector',       qty: 1,  unit: 'ea',  status: 'ordered',   by: field1Id },
    // B1 Floor 4
    { sid: suites.b1f4_420, desc: 'Dimmer switch',        qty: 2,  unit: 'ea',  status: 'delivered', by: leadId },
    // Building 2
    { sid: b2.f1_102,       desc: 'Smoke detector',       qty: 1,  unit: 'ea',  status: 'ordered',   by: leadId },
    { sid: b2.f1_102,       desc: 'GFCI outlet',          qty: 3,  unit: 'ea',  status: 'needed',    by: field1Id },
    { sid: b2.f2_207,       desc: 'Dimmer switch',        qty: 3,  unit: 'ea',  status: 'needed',    by: field1Id },
    { sid: b2.f3_314,       desc: '50A dryer outlet',     qty: 1,  unit: 'ea',  status: 'needed',    by: field2Id },
    { sid: b2.f4_401,       desc: 'USB outlet',           qty: 2,  unit: 'ea',  status: 'needed',    by: field2Id },
    { sid: b2.f4_416,       desc: 'Smoke detector',       qty: 1,  unit: 'ea',  status: 'delivered', by: leadId },
    { sid: b2.f4_416,       desc: 'Dimmer switch',        qty: 2,  unit: 'ea',  status: 'needed',    by: field2Id },
  ];

  const offsetDays = [-25, -18, -14, -10, -7, -5, -3, -1];
  for (let i = 0; i < matRequests.length; i++) {
    const r = matRequests[i];
    if (!r.sid) continue;
    const d = new Date();
    d.setDate(d.getDate() + offsetDays[i % offsetDays.length]);
    await pool.query(
      `INSERT INTO material_requests (space_id, description, quantity, unit, status, added_by, added_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [r.sid, r.desc, r.qty, r.unit, r.status, r.by, d.toISOString()]
    );
  }
  console.log(`    Material: ${matRequests.length} requests seeded`);

  // ── Deficiencies ─────────────────────────────────────────────────────────────
  const defs = [
    { sid: suites.b1f1_101, desc: 'Missing cover plate on bedroom outlet',   status: 'open',        by: field1Id },
    { sid: suites.b1f1_103, desc: 'Bathroom GFCI tripping — investigate',    status: 'in_progress', by: field1Id },
    { sid: suites.b1f2_205, desc: 'Kitchen dimmer buzzing at 50% — replace', status: 'open',        by: field2Id },
    { sid: suites.b1f2_211, desc: 'Panel breaker not labelled',              status: 'resolved',    by: leadId },
    { sid: suites.b1f3_302, desc: 'Doorbell transformer wrong voltage',      status: 'open',        by: field2Id },
    { sid: b2.f2_207,       desc: 'Smoke detector missing — not installed',  status: 'open',        by: field1Id },
    { sid: b2.f3_314,       desc: 'Counter outlet too low — GC drywall issue', status: 'in_progress', by: leadId },
  ];

  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    if (!d.sid) continue;
    const ts = new Date();
    ts.setDate(ts.getDate() - (defs.length - i) * 3);
    await pool.query(
      `INSERT INTO deficiencies (space_id, description, status, raised_by, raised_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [d.sid, d.desc, d.status, d.by, ts.toISOString()]
    );
  }
  console.log(`    Deficiencies: ${defs.length} seeded`);

  // ── Space notes ───────────────────────────────────────────────────────────────
  const notes = [
    { sid: suites.b1f1_101, body: 'Confirmed rough-in complete. Panel connections pending trim.', by: leadId },
    { sid: suites.b1f2_205, body: 'GC installed extra pot lights not on drawing E205 — verify circuit capacity.', by: supervisorId },
    { sid: suites.b1f3_309, body: 'Tenant requested extra USB outlets in master bedroom. Confirm with PM before ordering.', by: field2Id },
    { sid: b2.f1_102,       body: 'Dryer circuit relocated from laundry closet to ensuite — update as-built.', by: leadId },
    { sid: b2.f4_401,       body: 'Final inspection passed. All outlets, lights, and panel confirmed.', by: supervisorId },
  ];

  for (const n of notes) {
    if (!n.sid) continue;
    await pool.query(
      `INSERT INTO space_notes (space_id, body, author_id) VALUES ($1,$2,$3)`,
      [n.sid, n.body, n.by]
    );
  }
  console.log(`    Notes: ${notes.length} seeded`);
}

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
      VALUES ('Riverside Reno', 'JOB-002', 'active', 'unset', $1)
      RETURNING id
    `, [now()]);

    // ── Smith's Landing — 2 buildings × 80 units ─────────────────────────────
    console.log("▸ Seeding Smith's Landing (160 units across 2 buildings)...");
    const { rows: [sl] } = await client.query(`
      INSERT INTO projects (name, job_numbers, status, permit_required, permit_number, permit_stage, created_at)
      VALUES ($2, 'JOB-003', 'active', 'yes', 'E-2024-08871', 'rough_in_booked', $1)
      RETURNING id
    `, [now(), "Smith's Landing"]);

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
      `, ['PS-SEED-' + bldg.replace(/\s/g,''), bldg + ' Main Panel', JSON.stringify(circuits), slId, now()]);
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

    // ── Worksites space trees (run after COMMIT — uses pool, not client) ──────
    console.log('▸ Seeding worksite spaces...');
    await seedSpaces(p1.id, p2.id, slId);
    console.log('▸ Seeding worksite review data...');
    await seedWorksiteData(slId, adminId, supervisorId, leadId, field1Id, field2Id);
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

async function seedSpaces(p1Id, p2Id, slId) {
  // Idempotent: skip if spaces already exist for the project
  async function hasSpaces(projectId) {
    const { rows } = await pool.query('SELECT 1 FROM spaces WHERE project_id=$1 LIMIT 1', [projectId]);
    return rows.length > 0;
  }

  // Space type ids — throws loudly if schema wasn't seeded
  const T = {
    building:    await typeId('Building'),
    floor:       await typeId('Floor'),
    suite:       await typeId('Suite'),
    stairwell:   await typeId('Stairwell'),
    parkade:     await typeId('Parkade'),
    parkingLot:  await typeId('Parking Lot'),
    elec:        await typeId('Electrical Room'),
    mech:        await typeId('Mechanical Room'),
    lobby:       await typeId('Lobby'),
    common:      await typeId('Common Area'),
    storage:     await typeId('Storage Room'),
    exterior:    await typeId('Exterior'),
    elevator:    await typeId('Elevator'),
    shaft:       await typeId('Mechanical Shaft'),
  };

  // ── Henderson Commercial — one General space ────────────────────────────
  if (!await hasSpaces(p1Id)) {
    await addSpace({ project_id: p1Id, identifier: 'General', space_type_id: T.common });
    console.log('  ✓ Henderson Commercial: 1 space');
  } else { console.log('  · Henderson Commercial: already seeded, skipping'); }

  // ── Riverside Reno — one General space ─────────────────────────────────
  if (!await hasSpaces(p2Id)) {
    await addSpace({ project_id: p2Id, identifier: 'General', space_type_id: T.common });
    console.log('  ✓ Riverside Reno: 1 space');
  } else { console.log('  · Riverside Reno: already seeded, skipping'); }

  // ── Smith's Landing ─────────────────────────────────────────────────────
  if (await hasSpaces(slId)) {
    console.log("  · Smith's Landing: already seeded, skipping");
    return;
  }

  // Project-level surface lot — uses Parking Lot type, not Parkade
  await addSpace({ project_id: slId, identifier: 'Parking Lot', space_type_id: T.parkingLot, sort_order: 0 });

  // ── Plan type assignment map (last 2 digits of suite identifier → type code) ─
  // Verified against drawing E105. Same pattern on every floor of both buildings.
  const SUFFIX_TYPE = {
    '01':'C','02':'C','03':'B','04':'B','05':'B','06':'B','07':'B',
    '08':'F','09':'E','10':'E','11':'D','12':'D','13':'D','14':'D',
    '15':'B','16':'B','17':'B','18':'B','19':'C','20':'A',
  };

  // Helper: build one full building tree, return the building space
  async function buildBuilding(name, sortOrder) {
    const bldg = await addSpace({ project_id: slId, identifier: name, space_type_id: T.building, sort_order: sortOrder });

    // Building-level verticals (run through the full building, not per-floor)
    await addSpace({ project_id: slId, parent_id: bldg.id, identifier: 'Stair 1',    space_type_id: T.stairwell, sort_order: 0 });
    await addSpace({ project_id: slId, parent_id: bldg.id, identifier: 'Stair 2',    space_type_id: T.stairwell, sort_order: 1 });
    await addSpace({ project_id: slId, parent_id: bldg.id, identifier: 'Elevator',   space_type_id: T.elevator,  sort_order: 2 });
    await addSpace({ project_id: slId, parent_id: bldg.id, identifier: 'Mech Shaft', space_type_id: T.shaft,     sort_order: 3 });

    // Parkade level
    const parkade = await addSpace({ project_id: slId, parent_id: bldg.id, identifier: 'Parkade', space_type_id: T.parkade, sort_order: 4 });
    await addSpace({ project_id: slId, parent_id: parkade.id, identifier: 'Electrical Room', space_type_id: T.elec,  sort_order: 0 });
    await addSpace({ project_id: slId, parent_id: parkade.id, identifier: 'Mechanical Room', space_type_id: T.mech,  sort_order: 1 });
    await addSpace({ project_id: slId, parent_id: parkade.id, identifier: 'Lobby',           space_type_id: T.lobby, sort_order: 2 });

    // Floor builder — rooms named per drawing numbering (floorNum e.g. 1,2,3,4)
    async function buildFloor(floorNum, sortOrder) {
      const n   = floorNum;                         // 1, 2, 3, 4
      const pre = n * 100;                          // 100, 200, 300, 400
      const floor = await addSpace({
        project_id: slId, parent_id: bldg.id,
        identifier: `Floor ${n}`, space_type_id: T.floor, sort_order: sortOrder,
      });
      await bulkSpaces({ project_id: slId, parent_id: floor.id, space_type_id: T.suite, prefix: 'Suite ', start: pre + 1, end: pre + 20, pad: false });
      await addSpace({ project_id: slId, parent_id: floor.id, identifier: `Elec ${pre + 21}`,    space_type_id: T.elec,    sort_order: 100 });
      await addSpace({ project_id: slId, parent_id: floor.id, identifier: `Lobby ${pre}a`,        space_type_id: T.lobby,   sort_order: 101 });
      if (n === 1) {
        await addSpace({ project_id: slId, parent_id: floor.id, identifier: 'Bike Storage',        space_type_id: T.storage, sort_order: 102 });
      } else if (n <= 3) {
        await addSpace({ project_id: slId, parent_id: floor.id, identifier: `Tenant Storage ${pre + 22}`, space_type_id: T.storage, sort_order: 102 });
      } else {
        await addSpace({ project_id: slId, parent_id: floor.id, identifier: `Mech Room ${pre + 22}`,      space_type_id: T.mech,    sort_order: 102 });
      }
      await addSpace({ project_id: slId, parent_id: floor.id, identifier: `Corridor ${pre}`,      space_type_id: T.common,  sort_order: 103 });
      return floor;
    }

    await buildFloor(1, 5);
    await buildFloor(2, 6);
    await buildFloor(3, 7);
    await buildFloor(4, 8);

    return bldg;
  }

  // ── Build Building 1 ────────────────────────────────────────────────────────
  const bldg1 = await buildBuilding('Building 1', 1);

  // ── Create plan types A–F for Smith's Landing ───────────────────────────────
  const planTypeCodes = ['A','B','C','D','E','F'];
  for (const code of planTypeCodes) {
    await pool.query(
      `INSERT INTO plan_types (project_id, code) VALUES ($1, $2) ON CONFLICT (project_id, code) DO NOTHING`,
      [slId, code]
    );
  }
  const { rows: ptRows } = await pool.query(
    `SELECT id, code FROM plan_types WHERE project_id=$1`, [slId]
  );
  const PT = Object.fromEntries(ptRows.map(r => [r.code, r.id])); // { A: id, B: id, ... }

  // ── Assign plan types to Building 1 suites ──────────────────────────────────
  // Match last 2 digits of identifier (e.g. "Suite 103" → "03" → type B)
  const { rows: bldg1Suites } = await pool.query(`
    SELECT s.id, s.identifier
    FROM spaces s
    JOIN space_types st ON st.id = s.space_type_id
    WHERE s.project_id = $1 AND st.name = 'Suite'
      AND s.archived_at IS NULL
      AND s.id IN (
        SELECT id FROM spaces WHERE parent_id IN (
          SELECT id FROM spaces WHERE parent_id = $2 AND archived_at IS NULL
        ) AND archived_at IS NULL
      )
  `, [slId, bldg1.id]);

  for (const suite of bldg1Suites) {
    const suffix = suite.identifier.replace(/\D/g, '').slice(-2);
    const code   = SUFFIX_TYPE[suffix];
    if (code && PT[code]) {
      await pool.query('UPDATE spaces SET plan_type_id=$1 WHERE id=$2', [PT[code], suite.id]);
    }
  }

  // ── Duplicate Building 1 → Building 2 (copies plan_type_id) ─────────────────
  await duplicateSubtree(bldg1.id, { new_identifier: 'Building 2', new_parent_id: null });

  // ── Print counts for verification ───────────────────────────────────────────
  const { rows: typeCounts } = await pool.query(`
    SELECT pt.code, COUNT(s.id)::int AS cnt
    FROM plan_types pt
    LEFT JOIN spaces s ON s.plan_type_id = pt.id AND s.archived_at IS NULL
    WHERE pt.project_id = $1
    GROUP BY pt.code ORDER BY pt.code
  `, [slId]);
  const countLine = typeCounts.map(r => `Type ${r.code}: ${r.cnt}`).join('  ');
  const { rows: [{ count }] } = await pool.query('SELECT COUNT(*) FROM spaces WHERE project_id=$1', [slId]);
  console.log(`  ✓ Smith's Landing: ${count} spaces`);
  console.log(`    Plan types — ${countLine}`);
}

seed().then(() => process.exit(0)).catch(err => {
  console.error('✗ Seed failed:', err.message);
  process.exit(1);
});
