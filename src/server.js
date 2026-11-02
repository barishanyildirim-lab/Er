'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Tracker } = require('./tracker');
const { startSimulator } = require('./simulator');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('İstek gövdesi çok büyük'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Geçersiz JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Yasak' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Bulunamadı' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/**
 * HTTP sunucusu oluşturur.
 * adminToken verilirse yönetim API'si "Authorization: Bearer <token>" (veya SSE için ?token=) ister.
 * Konum bildirimleri her zaman araca özel cihaz anahtarıyla doğrulanır.
 */
function createServer({ tracker, adminToken = '' }) {
  const clients = new Set();

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  for (const ev of ['vehicle', 'vehicle:removed', 'position', 'alert', 'geofence', 'geofence:removed']) {
    tracker.on(ev, (data) => broadcast(ev, data));
  }
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  const isAdmin = (req, url) => {
    if (!adminToken) return true;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token') || '';
    return safeEqual(token, adminToken);
  };

  const deviceVehicle = (req, url, fallbackId) => {
    const token = req.headers['x-device-token'] || url.searchParams.get('deviceToken') || '';
    if (fallbackId) {
      const v = tracker.vehicles.get(fallbackId);
      return v && token && safeEqual(token, v.token) ? v : null;
    }
    return tracker.findByToken(token);
  };

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // 'api' sonrası
    const m = req.method;
    const q = Object.fromEntries(url.searchParams);

    // --- Cihaz uçları (yönetici anahtarı gerektirmez) ---
    // OsmAnd / Traccar Client protokolü: GET|POST /api/osmand?id=<cihazAnahtarı>&lat=..&lon=..&speed=<knot>&bearing=..&timestamp=<sn>
    if (parts[0] === 'osmand') {
      const v = tracker.findByToken(q.id || q.deviceid);
      if (!v) return sendJson(res, 401, { error: 'Geçersiz cihaz anahtarı' });
      const tsRaw = Number(q.timestamp);
      tracker.reportPosition(v.id, {
        lat: Number(q.lat),
        lng: Number(q.lon ?? q.lng),
        speed: q.speed !== undefined ? Number(q.speed) * 1.852 : undefined, // knot -> km/s
        heading: q.bearing !== undefined ? Number(q.bearing) : undefined,
        timestamp: Number.isFinite(tsRaw) ? (tsRaw < 1e12 ? tsRaw * 1000 : tsRaw) : undefined,
      });
      return sendJson(res, 200, { ok: true });
    }
    // JSON: POST /api/positions  (X-Device-Token başlığıyla)
    if (parts[0] === 'positions' && parts.length === 1 && m === 'POST') {
      const v = deviceVehicle(req, url);
      if (!v) return sendJson(res, 401, { error: 'Geçersiz cihaz anahtarı' });
      const body = await readBody(req);
      return sendJson(res, 201, tracker.reportPosition(v.id, body));
    }

    // --- Yönetim uçları ---
    if (!isAdmin(req, url)) return sendJson(res, 401, { error: 'Yetkisiz' });

    if (parts[0] === 'stream' && m === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify({
        vehicles: tracker.listVehicles(),
        geofences: tracker.listGeofences(),
        alerts: tracker.listAlerts({ limit: 50 }),
      })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (parts[0] === 'vehicles') {
      const id = parts[1];
      const sub = parts[2];
      if (!id) {
        if (m === 'GET') return sendJson(res, 200, tracker.listVehicles());
        if (m === 'POST') return sendJson(res, 201, tracker.addVehicle(await readBody(req)));
      } else if (!sub) {
        if (m === 'GET') return sendJson(res, 200, tracker.getVehicle(id));
        if (m === 'PUT' || m === 'PATCH') return sendJson(res, 200, tracker.updateVehicle(id, await readBody(req)));
        if (m === 'DELETE') {
          tracker.removeVehicle(id);
          return sendJson(res, 204);
        }
      } else if (sub === 'positions') {
        if (m === 'POST') return sendJson(res, 201, tracker.reportPosition(id, await readBody(req)));
        if (m === 'GET') return sendJson(res, 200, tracker.getHistory(id, q));
      } else if (sub === 'history' && m === 'GET') {
        return sendJson(res, 200, tracker.getHistory(id, q));
      } else if (sub === 'stats' && m === 'GET') {
        return sendJson(res, 200, tracker.getStats(id, q));
      } else if (sub === 'token' && m === 'GET') {
        return sendJson(res, 200, { token: tracker.getToken(id) });
      }
    }

    if (parts[0] === 'geofences') {
      if (!parts[1]) {
        if (m === 'GET') return sendJson(res, 200, tracker.listGeofences());
        if (m === 'POST') return sendJson(res, 201, tracker.addGeofence(await readBody(req)));
      } else if (m === 'DELETE') {
        tracker.removeGeofence(parts[1]);
        return sendJson(res, 204);
      }
    }

    if (parts[0] === 'alerts' && m === 'GET') {
      return sendJson(res, 200, tracker.listAlerts(q));
    }

    return sendJson(res, 404, { error: 'Uç bulunamadı' });
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Geçersiz adres' });
    }
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'İzin verilmeyen yöntem' });
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Sunucu hatası' : err.message });
    }
  });
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
  });
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
  const tracker = new Tracker({ dataFile });
  const server = createServer({ tracker, adminToken: process.env.ADMIN_TOKEN || '' });
  if (process.env.SIMULATE === '1') startSimulator(tracker);
  server.listen(port, () => {
    console.log(`Araç takip sunucusu: http://localhost:${port}`);
    if (process.env.SIMULATE === '1') console.log('Demo simülatörü açık (4 araç).');
  });
  const shutdown = () => {
    tracker.saveNow();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer };
