'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Tracker } = require('../src/tracker');
const geo = require('../src/geo');

function setup() {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  return { tracker: new Tracker({ now: clock.now }), clock };
}

test('mesafe hesabı (İstanbul–Ankara ≈ 350 km)', () => {
  const d = geo.distanceMeters({ lat: 41.0082, lng: 28.9784 }, { lat: 39.9334, lng: 32.8597 });
  assert.ok(d > 340000 && d < 360000, String(d));
});

test('araç ekleme, plaka doğrulama ve tekrar kontrolü', () => {
  const { tracker } = setup();
  const v = tracker.addVehicle({ plate: ' 34 abc  123 ', driver: 'Ali' });
  assert.equal(v.plate, '34 ABC 123');
  assert.ok(v.token);
  assert.equal(tracker.listVehicles()[0].token, undefined, 'liste anahtarı göstermemeli');
  assert.throws(() => tracker.addVehicle({ plate: '34 ABC 123' }), /zaten/);
  assert.throws(() => tracker.addVehicle({}), /zorunlu/);
  assert.throws(() => tracker.addVehicle({ plate: 'X', speedLimit: -5 }), /Hız limiti/);
});

test('konum bildirimi: hız/yön hesaplama, kilometre ve durum', () => {
  const { tracker, clock } = setup();
  const v = tracker.addVehicle({ plate: '06 A 1' });
  assert.equal(tracker.getVehicle(v.id).status, 'unknown');
  tracker.reportPosition(v.id, { lat: 41, lng: 29 });
  clock.advance(60_000);
  // ~1 km kuzeye 1 dakikada -> ~60 km/s
  const p = tracker.reportPosition(v.id, { lat: 41.009, lng: 29 });
  assert.ok(Math.abs(p.speed - 60) < 2, String(p.speed));
  assert.equal(p.heading, 0);
  const got = tracker.getVehicle(v.id);
  assert.equal(got.status, 'moving');
  assert.ok(Math.abs(got.odometer - 1000) < 20);
  clock.advance(6 * 60_000);
  assert.equal(tracker.getVehicle(v.id).status, 'offline');
  assert.throws(() => tracker.reportPosition(v.id, { lat: 200, lng: 0 }), /enlem/);
  assert.throws(() => tracker.reportPosition(v.id, { lat: 41, lng: 29, timestamp: 1 }), /eski/);
});

test('hız ihlali alarmı yalnızca limit aşıldığı anda üretilir', () => {
  const { tracker, clock } = setup();
  const v = tracker.addVehicle({ plate: '35 B 2', speedLimit: 50 });
  for (const speed of [40, 70, 80, 45, 90]) {
    tracker.reportPosition(v.id, { lat: 38.4, lng: 27.1, speed });
    clock.advance(1000);
  }
  const alerts = tracker.listAlerts().filter((a) => a.type === 'speeding');
  assert.equal(alerts.length, 2);
});

test('bölge giriş/çıkış alarmları', () => {
  const { tracker, clock } = setup();
  const v = tracker.addVehicle({ plate: '34 G 3' });
  tracker.addGeofence({ name: 'Depo', lat: 41, lng: 29, radius: 500 });
  const route = [
    { lat: 41.01, lng: 29 }, // dışarıda (~1.1 km)
    { lat: 41.001, lng: 29 }, // içeride
    { lat: 41.0005, lng: 29 }, // içeride
    { lat: 41.02, lng: 29 }, // dışarıda
  ];
  for (const p of route) { tracker.reportPosition(v.id, { ...p, speed: 30 }); clock.advance(1000); }
  const types = tracker.listAlerts().map((a) => a.type).reverse();
  assert.deepEqual(types, ['geofence_enter', 'geofence_exit']);
  assert.throws(() => tracker.addGeofence({ name: 'x', lat: 0, lng: 0, radius: 1 }), /Yarıçap/);
});

test('geçmiş filtreleme ve istatistik', () => {
  const { tracker, clock } = setup();
  const v = tracker.addVehicle({ plate: '16 H 4' });
  const start = clock.now();
  for (let i = 0; i < 10; i++) {
    tracker.reportPosition(v.id, { lat: 40 + i * 0.001, lng: 29, speed: i < 5 ? 0 : 60 });
    clock.advance(60_000);
  }
  assert.equal(tracker.getHistory(v.id).length, 10);
  assert.equal(tracker.getHistory(v.id, { from: start + 5 * 60_000 }).length, 5);
  assert.equal(tracker.getHistory(v.id, { to: new Date(start + 60_000).toISOString() }).length, 2);
  const s = tracker.getStats(v.id);
  assert.equal(s.points, 10);
  assert.equal(s.maxSpeed, 60);
  assert.equal(s.movingMinutes, 5);
  assert.equal(s.idleMinutes, 4);
  assert.ok(Math.abs(s.distanceKm - 1) < 0.05);
  assert.throws(() => tracker.getHistory(v.id, { from: 'abc' }), /tarih/);
});

test('veri dosyasına kaydedip geri yükleme', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arac-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db.json');
  const a = new Tracker({ dataFile: file });
  const v = a.addVehicle({ plate: '01 K 5' });
  a.reportPosition(v.id, { lat: 37, lng: 35, speed: 10 });
  a.saveNow();
  clearTimeout(a._saveTimer);
  const b = new Tracker({ dataFile: file });
  assert.equal(b.getVehicle(v.id).plate, '01 K 5');
  assert.equal(b.getHistory(v.id).length, 1);
  assert.equal(b.findByToken(v.token).id, v.id);
});
