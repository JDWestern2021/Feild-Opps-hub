/**
 * db-reset.js — drops and recreates the local database, then runs initSchema().
 * Guard runs first. Never touches production.
 */
'use strict';
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
require('./db-guard');

const { Client } = require('pg');

async function reset() {
  const connStr = process.env.DATABASE_URL;
  const u       = new URL(connStr);
  const dbName  = u.pathname.replace(/^\//, '');

  // Step 1: drop + recreate via the 'postgres' maintenance DB
  const adminUrl = new URL(connStr);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();

  console.log(`▸ Dropping "${dbName}"...`);
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  console.log(`▸ Creating "${dbName}"...`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  // Step 2: run initSchema() — db.js reads DATABASE_URL from env (already set to local)
  const { connectWithRetry, initSchema, pool } = require('../db');
  await connectWithRetry();
  await initSchema();
  await pool.end();

  console.log('');
  console.log('✓ Reset complete. Run "npm run db:seed" to populate test data.');
  process.exit(0);
}

reset().catch(err => {
  console.error('✗ Reset failed:', err.message);
  process.exit(1);
});
