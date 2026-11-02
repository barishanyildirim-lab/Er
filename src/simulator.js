'use strict';

const geo = require('./geo');

/**
 * Demo amaçlı araç simülatörü: İstanbul çevresinde rastgele dolaşan araçlar üretir
 * ve konumlarını gerçek bir GPS cihazı gibi Tracker'a bildirir.
 */
const DEMO_VEHICLES = [
  { plate: '34 ABC 123', driver: 'Ahmet Yılmaz', model: 'Ford Transit', color: '#2563eb', speedLimit: 82, start: { lat: 41.0082, lng: 28.9784 } },
  { plate: '34 DEF 456', driver: 'Ayşe Kaya', model: 'Renault Clio', color: '#16a34a', speedLimit: 90, start: { lat: 41.0422, lng: 29.0083 } },
  { plate: '34 GHI 789', driver: 'Mehmet Demir', model: 'Fiat Doblo', color: '#dc2626', speedLimit: 70, start: { lat: 40.9906, lng: 29.0290 } },
  { plate: '06 JKL 012', driver: 'Zeynep Çelik', model: 'Toyota Corolla', color: '#9333ea', speedLimit: 90, start: { lat: 41.0766, lng: 29.0503 } },
];

function startSimulator(tracker, { intervalMs = 2000 } = {}) {
  const sims = [];
  for (const demo of DEMO_VEHICLES) {
    let vehicle = tracker.listVehicles().find((v) => v.plate === demo.plate);
    if (!vehicle) {
      const { start, ...fields } = demo;
      vehicle = tracker.addVehicle(fields);
    }
    sims.push({
      id: vehicle.id,
      pos: vehicle.lastPosition || { ...demo.start },
      heading: vehicle.lastPosition?.heading ?? Math.random() * 360,
      speed: 30 + Math.random() * 30,
      home: demo.start,
      stopUntil: 0,
    });
  }

  if (tracker.listGeofences().length === 0) {
    tracker.addGeofence({ name: 'Merkez Depo', lat: 41.0082, lng: 28.9784, radius: 800 });
    tracker.addGeofence({ name: 'Kadıköy Şube', lat: 40.9906, lng: 29.029, radius: 600 });
  }

  const tick = () => {
    const now = Date.now();
    for (const s of sims) {
      if (!tracker.vehicles.has(s.id)) continue; // kullanıcı silmiş olabilir
      if (now < s.stopUntil) {
        s.speed = 0;
      } else {
        if (Math.random() < 0.02) s.stopUntil = now + 10000 + Math.random() * 20000; // kısa mola
        s.speed = Math.max(10, Math.min(120, s.speed + (Math.random() - 0.5) * 20));
        s.heading += (Math.random() - 0.5) * 40;
        // Başlangıç noktasından 6 km'den uzaklaşırsa geri dön
        if (geo.distanceMeters(s.pos, s.home) > 6000) s.heading = geo.bearing(s.pos, s.home);
        const dist = (s.speed / 3.6) * (intervalMs / 1000);
        s.pos = geo.destination(s.pos, s.heading, dist);
      }
      try {
        tracker.reportPosition(s.id, { lat: s.pos.lat, lng: s.pos.lng, speed: s.speed, heading: (s.heading + 360) % 360 });
      } catch (err) {
        console.error('Simülatör hatası:', err.message);
      }
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

module.exports = { startSimulator };
