/**
 * setup-https.js — downloads mkcert for macOS, installs the local CA,
 * and generates a cert for localhost + your LAN IP.
 *
 * Run once: npm run https:setup
 * After this, "npm run dev:local" serves HTTPS on port 3443.
 */
'use strict';
const { execSync, spawnSync } = require('child_process');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const MKCERT_VERSION = 'v1.4.4';
const MKCERT_BIN     = path.join(__dirname, 'mkcert');
const CERTS_DIR      = path.join(__dirname, '..', 'certs');
const CERT_FILE      = path.join(CERTS_DIR, 'local.pem');
const KEY_FILE       = path.join(CERTS_DIR, 'local-key.pem');

// Detect arch
const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
const mkcertUrl = `https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-darwin-${arch}`;

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          follow(res.headers.location);
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    };
    follow(url);
  });
}

// Detect LAN IP
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(CERTS_DIR, { recursive: true });

  // Download mkcert if not already present
  if (!fs.existsSync(MKCERT_BIN)) {
    console.log(`▸ Downloading mkcert ${MKCERT_VERSION} (darwin-${arch})...`);
    await download(mkcertUrl, MKCERT_BIN);
    fs.chmodSync(MKCERT_BIN, 0o755);
    console.log('  ✓ Downloaded');
  } else {
    console.log('▸ mkcert already present — skipping download');
  }

  // Install local CA (writes to system keychain — requires password prompt once)
  console.log('▸ Installing local CA (you may be prompted for your Mac password)...');
  spawnSync(MKCERT_BIN, ['-install'], { stdio: 'inherit' });

  // Generate cert for localhost + LAN IP
  const lanIp = getLanIp();
  const hosts = ['localhost', '127.0.0.1'];
  if (lanIp) hosts.push(lanIp);

  console.log(`▸ Generating cert for: ${hosts.join(', ')}`);
  spawnSync(MKCERT_BIN, [
    `-cert-file=${CERT_FILE}`,
    `-key-file=${KEY_FILE}`,
    ...hosts,
  ], { stdio: 'inherit' });

  console.log('');
  console.log('✓ HTTPS setup complete.');
  console.log('');
  if (lanIp) {
    console.log(`  Your LAN IP: ${lanIp}`);
    console.log(`  App (HTTPS): https://${lanIp}:3443`);
    console.log('');
    console.log('  To test on your phone:');
    console.log(`  1. Open https://${lanIp}:3443 on your phone`);
    console.log('  2. Your phone will warn about the certificate — this is expected once.');
    console.log('     iOS: tap "Advanced" → "Proceed". Then go to:');
    console.log('       Settings → General → VPN & Device Management → trust the mkcert CA.');
    console.log('     Android: Settings → Security → Install from storage → pick the rootCA.pem.');
    console.log(`     The CA file is at: ${execSync(`${MKCERT_BIN} -CAROOT`, { encoding: 'utf8' }).trim()}/rootCA.pem`);
    console.log('  3. After trusting the CA, service worker registration and PWA install will work.');
  } else {
    console.log('  Could not detect LAN IP — connect to Wi-Fi and re-run.');
  }
}

main().catch(err => { console.error('✗', err.message); process.exit(1); });
