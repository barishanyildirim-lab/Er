'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Tracker } = require('../src/tracker');
const { createServer } = require('../src/server');

async function start(opts = {}) {
  const tracker = new Tracker();
  const server = createServer({ tracker, ...opts });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { tracker, base, close };
}

const json = (method, body, headers = {}) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('REST API: araç, konum, geçmiş, istatistik', async (t) => {
  const { base, close } = await start();
  t.after(close);
  let r = await fetch(`${base}/api/vehicles`, json('POST', { plate: '34 TEST 1', speedLimit: 50 }));
  assert.equal(r.status, 201);
  const v = await r.json();
  assert.ok(v.token);

  r = await fetch(`${base}/api/positions`, json('POST', { lat: 41, lng: 29, speed: 70 }, { 'X-Device-Token': v.token }));
  assert.equal(r.status, 201);
  r = await fetch(`${base}/api/positions`, json('POST', { lat: 41, lng: 29 }, { 'X-Device-Token': 'yanlis' }));
  assert.equal(r.status, 401);
  r = await fetch(`${base}/api/positions`, json('POST', { lat: 'x', lng: 29 }, { 'X-Device-Token': v.token }));
  assert.equal(r.status, 400);

  // OsmAnd protokolü (hız knot, zaman saniye)
  const ts = Math.floor(Date.now() / 1000) + 5;
  r = await fetch(`${base}/api/osmand?id=${v.token}&lat=41.001&lon=29.001&speed=10&bearing=90&timestamp=${ts}`);
  assert.equal(r.status, 200);

  const hist = await (await fetch(`${base}/api/vehicles/${v.id}/history`)).json();
  assert.equal(hist.length, 2);
  assert.equal(hist[1].speed, 18.5);
  assert.equal(hist[1].heading, 90);
  assert.equal(hist[1].ts, ts * 1000);

  const stats = await (await fetch(`${base}/api/vehicles/${v.id}/stats`)).json();
  assert.equal(stats.points, 2);

  const alerts = await (await fetch(`${base}/api/alerts`)).json();
  assert.equal(alerts[0].type, 'speeding');

  r = await fetch(`${base}/api/vehicles/${v.id}`, json('PUT', { driver: 'Veli' }));
  assert.equal((await r.json()).driver, 'Veli');
  r = await fetch(`${base}/api/vehicles/${v.id}`, { method: 'DELETE' });
  assert.equal(r.status, 204);
  r = await fetch(`${base}/api/vehicles/${v.id}`);
  assert.equal(r.status, 404);
});

test('yönetici anahtarı korumalı mod', async (t) => {
  const { base, close, tracker } = await start({ adminToken: 'gizli' });
  t.after(close);
  assert.equal((await fetch(`${base}/api/vehicles`)).status, 401);
  const ok = await fetch(`${base}/api/vehicles`, { headers: { Authorization: 'Bearer gizli' } });
  assert.equal(ok.status, 200);
  // cihaz uçları yönetici anahtarı istemez
  const v = tracker.addVehicle({ plate: '34 X 1' });
  const r = await fetch(`${base}/api/positions`, json('POST', { lat: 41, lng: 29 }, { 'X-Device-Token': v.token }));
  assert.equal(r.status, 201);
});

test('canlı akış (SSE) konum olayını iletir', async (t) => {
  const { base, close, tracker } = await start();
  t.after(close);
  const v = tracker.addVehicle({ plate: '34 SSE 1' });
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const readUntil = async (needle) => {
    while (!buf.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('akış kapandı');
      buf += dec.decode(value);
    }
  };
  await readUntil('event: snapshot');
  tracker.reportPosition(v.id, { lat: 41, lng: 29, speed: 20 });
  await readUntil('event: position');
  assert.ok(buf.includes(v.id));
});

test('statik dosyalar ve dizin dışına çıkma engeli', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Araç Takip/);
  const bad = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.notEqual(bad.status, 200);
});
