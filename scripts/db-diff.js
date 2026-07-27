/**
 * db-diff.js — dumps the local schema and compares it to the baseline snapshot.
 * Run this before deploying to check for drift between local and what initSchema() last wrote.
 * Does NOT connect to production.
 */
'use strict';
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
require('./db-guard');

const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

const snapshotPath = path.join(__dirname, '..', 'migrations', '000_local_schema_snapshot.sql');
const connStr      = process.env.DATABASE_URL;

console.log('▸ Dumping local schema...');
const current = execSync(
  `pg_dump --schema-only --no-owner --no-acl "${connStr}"`,
  { encoding: 'utf8' }
);

if (!fs.existsSync(snapshotPath)) {
  fs.writeFileSync(snapshotPath, current);
  console.log('✓ No snapshot existed — wrote baseline to migrations/000_local_schema_snapshot.sql');
  process.exit(0);
}

const baseline = fs.readFileSync(snapshotPath, 'utf8');
if (current === baseline) {
  console.log('✓ No schema drift detected.');
} else {
  console.log('⚠  Schema has drifted from snapshot. Review the diff:');
  // Write temp files and diff them
  fs.writeFileSync('/tmp/schema_baseline.sql', baseline);
  fs.writeFileSync('/tmp/schema_current.sql', current);
  try {
    execSync('diff /tmp/schema_baseline.sql /tmp/schema_current.sql', { stdio: 'inherit' });
  } catch {
    // diff exits non-zero when files differ — that's expected
  }
  console.log('');
  console.log('To update the snapshot after intentional changes: delete migrations/000_local_schema_snapshot.sql and run db:diff again.');
}
process.exit(0);
