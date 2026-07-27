/**
 * db-guard.js — called by every script that opens a DB connection.
 * Refuses to run if DATABASE_URL points at anything other than localhost/127.0.0.1.
 * This is the hard stop that keeps destructive commands away from production.
 */
'use strict';
const url = process.env.DATABASE_URL || '';

let host = '';
try {
  host = new URL(url).hostname;
} catch {
  console.error('[db-guard] Could not parse DATABASE_URL — aborting.');
  process.exit(1);
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

if (!LOCAL_HOSTS.includes(host)) {
  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║  ABORT — non-local database detected                         ║');
  console.error(`║  Host: ${host.padEnd(54)}║`);
  console.error('║                                                              ║');
  console.error('║  This command only runs against localhost.                   ║');
  console.error('║  Check that .env.local is loaded (npm run dev:local)         ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error('');
  process.exit(1);
}
