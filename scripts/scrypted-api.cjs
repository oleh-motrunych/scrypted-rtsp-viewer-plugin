const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

function target(host) {
  if (!host || /[\s\\/?#@]/.test(host) || host.includes('://')) throw new Error('Use HOST:PORT without a URL scheme or path.');
  const url = new URL('https://' + host);
  if (!/:\d+$/.test(host)) url.port = '10443';
  return url;
}

function tlsOptions(url) {
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  // Local Scrypted commonly uses a self-signed certificate. This exception is
  // confined to loopback; localhost is pinned below rather than resolved by DNS.
  return { rejectUnauthorized: !loopback,
    ...(url.hostname === 'localhost' ? { lookup: (_host, options, callback) => {
      if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    } } : {}) };
}

async function request(host, pathname, credentials, body, contentType = 'application/json', env = process.env, json = true) {
  const url = target(host);
  const options = tlsOptions(url, env);
  if (env.SCRYPTED_CA_FILE) options.ca = await fs.readFile(env.SCRYPTED_CA_FILE);
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(pathname, url), { ...options, method: payload ? 'POST' : 'GET', headers: {
      Authorization: 'Basic ' + Buffer.from(credentials.username + ':' + credentials.token).toString('base64'),
      ...(payload ? { 'Content-Type': contentType, 'Content-Length': payload.length } : {}),
    } }, res => {
      const chunks = [];
      let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        if (length > 1024 * 1024) { res.destroy(new Error('Scrypted response exceeded 1 MiB.')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error('Scrypted returned HTTP ' + res.statusCode)); return; }
        try { resolve(json ? (length ? JSON.parse(Buffer.concat(chunks).toString()) : {}) : Buffer.concat(chunks)); }
        catch { reject(new Error('Scrypted returned invalid JSON.')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Scrypted request timed out.')), 15000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}

function loginPath(env = process.env) {
  return path.join(env.SCRYPTED_AUTH_DIR || path.join(os.homedir(), '.scrypted'), 'login.json');
}

function loginKey(host) {
  const url = target(host);
  return url.hostname + ':' + (url.port || '443');
}

async function saveLogin(host, login, env = process.env) {
  const filename = loginPath(env);
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid saved login file.');
  Object.defineProperty(saved, loginKey(host), { value: login, enumerable: true, configurable: true, writable: true });
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

async function deploy(host, directory = process.cwd(), env = process.env) {
  const key = loginKey(host);
  tlsOptions(target(host), env);
  const saved = JSON.parse(await fs.readFile(loginPath(env), 'utf8'));
  const credentials = saved[key];
  if (!credentials?.username || !credentials?.token) throw new Error('No saved login for ' + key + '. Run the login command first.');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const zip = await fs.readFile(path.join(directory, 'dist/plugin.zip'));
  const query = '?npmPackage=' + encodeURIComponent(manifest.name);
  await request(host, '/web/component/script/setup' + query, credentials, JSON.stringify(manifest), 'application/json', env, false);
  await request(host, '/web/component/script/deploy' + query, credentials, zip, 'application/zip', env, false);
}

module.exports = { target, tlsOptions, request, saveLogin, deploy };
