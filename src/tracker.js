'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const geo = require('./geo');

const IDLE_SPEED_KMH = 3; // Bu hızın altı "durağan" kabul edilir
const OFFLINE_AFTER_MS = 5 * 60 * 1000; // 5 dk veri gelmezse "çevrimdışı"
const MAX_HISTORY_PER_VEHICLE = 20000;
const MAX_ALERTS = 1000;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.status = 404;
  }
}

const newId = () => crypto.randomBytes(6).toString('hex');
const newToken = () => crypto.randomBytes(16).toString('hex');

/** Milisaniye sayı ya da ISO tarih metnini milisaniyeye çevirir */
function parseTime(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return v;
  return /^\d+$/.test(String(v)) ? Number(v) : Date.parse(v);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Araç takip çekirdeği: araçlar, konum geçmişi, bölgeler (geofence) ve alarmlar.
 * Olaylar: 'vehicle', 'vehicle:removed', 'position', 'alert', 'geofence', 'geofence:removed'
 */
class Tracker extends EventEmitter {
  constructor({ dataFile = null, now = () => Date.now() } = {}) {
    super();
    this.dataFile = dataFile;
    this.now = now;
    this.vehicles = new Map();
    this.history = new Map(); // vehicleId -> [{lat,lng,speed,heading,ts}]
    this.geofences = new Map();
    this.alerts = [];
    this._saveTimer = null;
    this._load();
  }

  // ---------- Kalıcılık ----------
  _load() {
    if (!this.dataFile || !fs.existsSync(this.dataFile)) return;
    try {
      const db = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
      for (const v of db.vehicles || []) this.vehicles.set(v.id, v);
      for (const [id, h] of Object.entries(db.history || {})) this.history.set(id, h);
      for (const g of db.geofences || []) this.geofences.set(g.id, g);
      this.alerts = db.alerts || [];
    } catch (err) {
      console.error('Veri dosyası okunamadı:', err.message);
    }
  }

  _scheduleSave() {
    if (!this.dataFile || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 1000);
    this._saveTimer.unref?.();
  }

  saveNow() {
    if (!this.dataFile) return;
    const db = {
      vehicles: [...this.vehicles.values()],
      history: Object.fromEntries(this.history),
      geofences: [...this.geofences.values()],
      alerts: this.alerts,
    };
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    const tmp = this.dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, this.dataFile);
  }

  // ---------- Araçlar ----------
  _requireVehicle(id) {
    const v = this.vehicles.get(id);
    if (!v) throw new NotFoundError('Araç bulunamadı');
    return v;
  }

  status(vehicle) {
    const p = vehicle.lastPosition;
    if (!p) return 'unknown';
    if (this.now() - p.ts > OFFLINE_AFTER_MS) return 'offline';
    return p.speed >= IDLE_SPEED_KMH ? 'moving' : 'idle';
  }

  /** Dışarıya verilecek araç görünümü (cihaz anahtarı gizlenir) */
  view(vehicle, { includeToken = false } = {}) {
    const { token, ...rest } = vehicle;
    const out = { ...rest, status: this.status(vehicle) };
    if (includeToken) out.token = token;
    return out;
  }

  listVehicles() {
    return [...this.vehicles.values()].map((v) => this.view(v));
  }

  getVehicle(id) {
    return this.view(this._requireVehicle(id));
  }

  _validateVehicleFields(data, partial) {
    const out = {};
    if (data.plate !== undefined || !partial) {
      const plate = String(data.plate ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
      if (!plate) throw new ValidationError('Plaka zorunludur');
      if (plate.length > 20) throw new ValidationError('Plaka çok uzun');
      out.plate = plate;
    }
    for (const key of ['driver', 'model', 'color']) {
      if (data[key] !== undefined) out[key] = String(data[key]).trim().slice(0, 80);
    }
    if (data.speedLimit !== undefined) {
      const lim = Number(data.speedLimit);
      if (!Number.isFinite(lim) || lim <= 0 || lim > 300)
        throw new ValidationError('Hız limiti 1-300 km/s arasında olmalıdır');
      out.speedLimit = lim;
    }
    return out;
  }

  _plateTaken(plate, exceptId) {
    for (const v of this.vehicles.values()) if (v.plate === plate && v.id !== exceptId) return true;
    return false;
  }

  addVehicle(data = {}) {
    const fields = this._validateVehicleFields(data, false);
    if (this._plateTaken(fields.plate)) throw new ValidationError('Bu plaka zaten kayıtlı');
    const vehicle = {
      id: newId(),
      driver: '',
      model: '',
      color: '#2563eb',
      speedLimit: 90,
      ...fields,
      token: newToken(),
      createdAt: this.now(),
      lastPosition: null,
      odometer: 0, // metre
    };
    this.vehicles.set(vehicle.id, vehicle);
    this.history.set(vehicle.id, []);
    this._scheduleSave();
    this.emit('vehicle', this.view(vehicle));
    return this.view(vehicle, { includeToken: true });
  }

  updateVehicle(id, data = {}) {
    const v = this._requireVehicle(id);
    const fields = this._validateVehicleFields(data, true);
    if (fields.plate && this._plateTaken(fields.plate, id))
      throw new ValidationError('Bu plaka zaten kayıtlı');
    Object.assign(v, fields);
    this._scheduleSave();
    this.emit('vehicle', this.view(v));
    return this.view(v);
  }

  removeVehicle(id) {
    this._requireVehicle(id);
    this.vehicles.delete(id);
    this.history.delete(id);
    this._scheduleSave();
    this.emit('vehicle:removed', { id });
  }

  getToken(id) {
    return this._requireVehicle(id).token;
  }

  findByToken(token) {
    if (!token) return null;
    for (const v of this.vehicles.values()) if (v.token === token) return v;
    return null;
  }

  // ---------- Konum ----------
  /** GPS cihazından gelen konum bildirimini işler */
  reportPosition(id, data = {}) {
    const v = this._requireVehicle(id);
    const lat = Number(data.lat);
    const lng = Number(data.lng);
    if (!isFiniteNumber(lat) || lat < -90 || lat > 90) throw new ValidationError('Geçersiz enlem');
    if (!isFiniteNumber(lng) || lng < -180 || lng > 180) throw new ValidationError('Geçersiz boylam');

    const ts = parseTime(data.timestamp) ?? this.now();
    if (!Number.isFinite(ts)) throw new ValidationError('Geçersiz zaman damgası');

    const prev = v.lastPosition;
    if (prev && ts < prev.ts) throw new ValidationError('Zaman damgası son konumdan eski');

    const point = { lat, lng };
    let speed = data.speed !== undefined ? Number(data.speed) : NaN;
    if (!Number.isFinite(speed) || speed < 0) {
      // Hız gönderilmemişse önceki noktaya göre hesapla
      speed = prev && ts > prev.ts ? (geo.distanceMeters(prev, point) / ((ts - prev.ts) / 1000)) * 3.6 : 0;
    }
    let heading = data.heading !== undefined ? Number(data.heading) : NaN;
    if (!Number.isFinite(heading)) {
      heading = prev && geo.distanceMeters(prev, point) > 1 ? geo.bearing(prev, point) : prev?.heading ?? 0;
    }

    const position = {
      lat,
      lng,
      speed: Math.round(speed * 10) / 10,
      heading: Math.round(((heading % 360) + 360) % 360),
      ts,
    };

    const prevStatus = this.status(v);
    if (prev) v.odometer += geo.distanceMeters(prev, position);
    v.lastPosition = position;

    const hist = this.history.get(id);
    hist.push(position);
    if (hist.length > MAX_HISTORY_PER_VEHICLE) hist.splice(0, hist.length - MAX_HISTORY_PER_VEHICLE);

    this._checkAlerts(v, prev, position, prevStatus);
    this._scheduleSave();
    this.emit('position', { vehicleId: id, position, vehicle: this.view(v) });
    return position;
  }

  getHistory(id, { from, to } = {}) {
    this._requireVehicle(id);
    const f = parseTime(from) ?? -Infinity;
    const t = parseTime(to) ?? Infinity;
    if (Number.isNaN(f) || Number.isNaN(t)) throw new ValidationError('Geçersiz tarih aralığı');
    return (this.history.get(id) || []).filter((p) => p.ts >= f && p.ts <= t);
  }

  /** Belirli aralık için özet istatistik */
  getStats(id, range = {}) {
    const points = this.getHistory(id, range);
    const distance = geo.pathLength(points);
    let maxSpeed = 0;
    let speedSum = 0;
    let movingMs = 0;
    let idleMs = 0;
    for (let i = 0; i < points.length; i++) {
      maxSpeed = Math.max(maxSpeed, points[i].speed);
      speedSum += points[i].speed;
      if (i > 0) {
        const dt = points[i].ts - points[i - 1].ts;
        if (dt > OFFLINE_AFTER_MS) continue; // veri boşluğu
        if (points[i].speed >= IDLE_SPEED_KMH) movingMs += dt;
        else idleMs += dt;
      }
    }
    return {
      points: points.length,
      distanceKm: Math.round(distance / 10) / 100,
      maxSpeed: Math.round(maxSpeed),
      avgSpeed: points.length ? Math.round(speedSum / points.length) : 0,
      movingMinutes: Math.round(movingMs / 60000),
      idleMinutes: Math.round(idleMs / 60000),
    };
  }

  // ---------- Bölgeler (Geofence) ----------
  listGeofences() {
    return [...this.geofences.values()];
  }

  addGeofence(data = {}) {
    const name = String(data.name ?? '').trim().slice(0, 80);
    const lat = Number(data.lat);
    const lng = Number(data.lng);
    const radius = Number(data.radius);
    if (!name) throw new ValidationError('Bölge adı zorunludur');
    if (!isFiniteNumber(lat) || lat < -90 || lat > 90) throw new ValidationError('Geçersiz enlem');
    if (!isFiniteNumber(lng) || lng < -180 || lng > 180) throw new ValidationError('Geçersiz boylam');
    if (!isFiniteNumber(radius) || radius < 10 || radius > 100000)
      throw new ValidationError('Yarıçap 10 - 100000 metre arasında olmalıdır');
    const fence = { id: newId(), name, lat, lng, radius, createdAt: this.now() };
    this.geofences.set(fence.id, fence);
    this._scheduleSave();
    this.emit('geofence', fence);
    return fence;
  }

  removeGeofence(id) {
    if (!this.geofences.delete(id)) throw new NotFoundError('Bölge bulunamadı');
    this._scheduleSave();
    this.emit('geofence:removed', { id });
  }

  // ---------- Alarmlar ----------
  listAlerts({ vehicleId, limit = 100 } = {}) {
    let list = this.alerts;
    if (vehicleId) list = list.filter((a) => a.vehicleId === vehicleId);
    return list.slice(-Math.max(1, Math.min(1000, Number(limit) || 100))).reverse();
  }

  _alert(vehicle, type, message, position) {
    const alert = {
      id: newId(),
      vehicleId: vehicle.id,
      plate: vehicle.plate,
      type,
      message,
      lat: position.lat,
      lng: position.lng,
      ts: position.ts,
    };
    this.alerts.push(alert);
    if (this.alerts.length > MAX_ALERTS) this.alerts.splice(0, this.alerts.length - MAX_ALERTS);
    this.emit('alert', alert);
    return alert;
  }

  _checkAlerts(vehicle, prev, pos, prevStatus) {
    // Hız ihlali: limit aşıldığı ilk anda alarm üret (her noktada tekrar etmesin)
    const limit = vehicle.speedLimit;
    if (pos.speed > limit && !(prev && prev.speed > limit)) {
      this._alert(vehicle, 'speeding', `${vehicle.plate} hız sınırını aştı: ${Math.round(pos.speed)} km/s (limit ${limit})`, pos);
    }
    // Uzun süre sinyal yokken tekrar bağlanma
    if (prevStatus === 'offline') {
      this._alert(vehicle, 'online', `${vehicle.plate} tekrar çevrimiçi`, pos);
    }
    // Bölge giriş / çıkış
    if (prev) {
      for (const fence of this.geofences.values()) {
        const wasIn = geo.insideCircle(prev, fence);
        const isIn = geo.insideCircle(pos, fence);
        if (!wasIn && isIn) this._alert(vehicle, 'geofence_enter', `${vehicle.plate} "${fence.name}" bölgesine girdi`, pos);
        else if (wasIn && !isIn) this._alert(vehicle, 'geofence_exit', `${vehicle.plate} "${fence.name}" bölgesinden çıktı`, pos);
      }
    }
  }
}

module.exports = { Tracker, ValidationError, NotFoundError, IDLE_SPEED_KMH, OFFLINE_AFTER_MS };
