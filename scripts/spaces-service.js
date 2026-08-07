'use strict';
/**
 * spaces-service.js — shared logic for creating, bulk-generating,
 * and duplicating spaces. Used by both the API routes and the seed script.
 * If these functions throw, callers find out immediately.
 */

const { pool } = require('../db');

/**
 * Add a single space.
 */
async function addSpace({ project_id, parent_id, space_type_id, identifier, sort_order = 0 }, client) {
  const db = client || pool;
  const { rows: [space] } = await db.query(`
    INSERT INTO spaces (project_id, parent_id, space_type_id, identifier, sort_order)
    VALUES ($1, $2, $3, $4, $5) RETURNING *
  `, [project_id, parent_id || null, space_type_id || null, identifier, sort_order]);
  return space;
}

/**
 * Bulk-generate numbered spaces under a parent.
 * prefix + number = identifier  (e.g. prefix "Suite " + 101 = "Suite 101")
 * pad: zero-pad to the width of `end`
 */
async function bulkSpaces({ project_id, parent_id, space_type_id, prefix = '', start, end, pad = true }, client) {
  const db     = client || pool;
  const from   = parseInt(start, 10);
  const to     = parseInt(end,   10);
  if (isNaN(from) || isNaN(to) || from > to || to - from > 500) {
    throw new Error(`Invalid bulk range ${from}–${to} (max 500)`);
  }
  const created = [];
  for (let n = from; n <= to; n++) {
    const num        = pad ? String(n).padStart(String(to).length, '0') : String(n);
    const identifier = prefix ? `${prefix}${num}` : num;
    const { rows: [s] } = await db.query(`
      INSERT INTO spaces (project_id, parent_id, space_type_id, identifier, sort_order)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [project_id, parent_id || null, space_type_id || null, identifier, n - from]);
    created.push(s);
  }
  return created;
}

/**
 * Deep-copy a space and all its descendants under a new parent.
 * new_identifier overrides the root's label only.
 */
async function duplicateSubtree(sourceId, { new_identifier, new_parent_id } = {}, client) {
  const db = client || pool;
  const { rows: [src] } = await db.query('SELECT * FROM spaces WHERE id=$1', [sourceId]);
  if (!src) throw new Error(`Space ${sourceId} not found`);

  async function copy(sid, targetParentId, isRoot) {
    const { rows: [s] } = await db.query('SELECT * FROM spaces WHERE id=$1', [sid]);
    const label = isRoot && new_identifier ? new_identifier : s.identifier;

    // Guard: if duplicating into a different project, don't carry a reference to
    // another project's plan types — null it out instead of copying a broken FK.
    let destProjectId = s.project_id;
    if (targetParentId !== null && targetParentId !== undefined) {
      const { rows: [par] } = await db.query('SELECT project_id FROM spaces WHERE id=$1', [targetParentId]);
      if (par) destProjectId = par.project_id;
    }
    const safePlanTypeId = (destProjectId === s.project_id) ? (s.plan_type_id ?? null) : null;

    const { rows: [created] } = await db.query(`
      INSERT INTO spaces (project_id, parent_id, space_type_id, identifier, sort_order, plan_type_id)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `, [s.project_id, targetParentId, s.space_type_id, label, s.sort_order, safePlanTypeId]);
    const { rows: children } = await db.query(
      'SELECT id FROM spaces WHERE parent_id=$1 AND archived_at IS NULL ORDER BY sort_order, id',
      [sid]
    );
    for (const child of children) await copy(child.id, created.id, false);
    return created;
  }

  return copy(src.id, new_parent_id ?? src.parent_id, true);
}

/**
 * Look up a space_type id by name. Throws if not found.
 */
async function typeId(name, client) {
  const db = client || pool;
  const { rows } = await db.query('SELECT id FROM space_types WHERE name=$1', [name]);
  if (!rows[0]) throw new Error(`space_type "${name}" not found — is the schema seeded?`);
  return rows[0].id;
}

module.exports = { addSpace, bulkSpaces, duplicateSubtree, typeId };
