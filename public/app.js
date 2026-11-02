/* global L */
'use strict';

// ---------- Yardımcılar ----------
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STATUS_TEXT = { moving: 'Hareket halinde', idle: 'Duruyor', offline: 'Çevrimdışı', unknown: 'Veri yok' };
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('tr-TR') : '—');
const ago = (ts) => {
  if (!ts) return 'hiç veri yok';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s} sn önce`;
  if (s < 3600) return `${Math.round(s / 60)} dk önce`;
  if (s < 86400) return `${Math.round(s / 3600)} saat önce`;
  return `${Math.round(s / 86400)} gün önce`;
};
const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

let adminToken = '';
try { adminToken = localStorage.getItem('adminToken') || ''; } catch {}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
  const res = await fetch(`/api${path}`, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) {
    askToken();
    throw new Error('Yetkisiz');
  }
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'İstek başarısız');
  return data;
}

function askToken() {
  const t = prompt('Yönetici anahtarını girin (ADMIN_TOKEN):', '');
  if (t === null) return;
  adminToken = t.trim();
  try { localStorage.setItem('adminToken', adminToken); } catch {}
  connect();
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ---------- Durum ----------
const state = {
  vehicles: new Map(),
  geofences: new Map(),
  alerts: [],
  selected: null,
  unreadAlerts: 0,
  pickingFence: false,
};
const markers = new Map();
const fenceLayers = new Map();
const trails = new Map(); // canlı iz (son noktalar)
let historyLayer = null;
let playback = null;
let fitted = false;

// ---------- Harita ----------
const map = L.map('map', { zoomControl: true }).setView([41.015, 28.98], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap katkıcıları',
}).addTo(map);

const CAR_SVG =
  '<svg viewBox="0 0 24 24"><path d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7z"/></svg>';

function carIcon(v) {
  const heading = v.lastPosition?.heading ?? 0;
  const off = v.status === 'offline' ? ' offline' : '';
  return L.divIcon({
    className: `car-icon${off}`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    html: `<div class="car" style="background:${esc(v.color)}"><div style="transform:rotate(${Number(heading) || 0}deg);display:grid">${CAR_SVG}</div></div><div class="plate">${esc(v.plate)}</div>`,
  });
}

function popupHtml(v) {
  const p = v.lastPosition;
  return `<b>${esc(v.plate)}</b><br>${esc(v.driver || '—')} · ${esc(v.model || '')}<br>
    ${STATUS_TEXT[v.status]} · ${p ? Math.round(p.speed) : 0} km/s<br>
    <small>${p ? fmtTime(p.ts) : 'Veri yok'}</small>`;
}

function upsertMarker(v) {
  const p = v.lastPosition;
  let m = markers.get(v.id);
  if (!p) {
    if (m) { m.remove(); markers.delete(v.id); }
    return;
  }
  if (!m) {
    m = L.marker([p.lat, p.lng], { icon: carIcon(v) }).addTo(map).bindPopup(popupHtml(v));
    m.on('click', () => select(v.id));
    markers.set(v.id, m);
  } else {
    m.setLatLng([p.lat, p.lng]);
    m.setIcon(carIcon(v));
    m.setPopupContent(popupHtml(v));
  }
}

function addTrailPoint(v) {
  const p = v.lastPosition;
  if (!p) return;
  let t = trails.get(v.id);
  if (!t) {
    t = L.polyline([], { color: v.color, weight: 3, opacity: 0.5 }).addTo(map);
    trails.set(v.id, t);
  }
  t.setStyle({ color: v.color });
  const pts = t.getLatLngs();
  pts.push([p.lat, p.lng]);
  if (pts.length > 60) pts.shift();
  t.setLatLngs(pts);
}

function drawFence(f) {
  fenceLayers.get(f.id)?.remove();
  const c = L.circle([f.lat, f.lng], { radius: f.radius, color: '#7c3aed', weight: 1, fillOpacity: 0.08 })
    .addTo(map)
    .bindTooltip(esc(f.name));
  fenceLayers.set(f.id, c);
}

// ---------- Görünüm ----------
function renderSummary() {
  const counts = { moving: 0, idle: 0, offline: 0, unknown: 0 };
  for (const v of state.vehicles.values()) counts[v.status]++;
  $('#summary').innerHTML = `
    <span>Toplam <b>${state.vehicles.size}</b></span>
    <span><span class="dot st-moving" style="display:inline-block"></span> Hareketli <b>${counts.moving}</b></span>
    <span><span class="dot st-idle" style="display:inline-block"></span> Duran <b>${counts.idle}</b></span>
    <span><span class="dot st-offline" style="display:inline-block"></span> Çevrimdışı <b>${counts.offline + counts.unknown}</b></span>`;
}

function renderVehicles() {
  const q = $('#search').value.trim().toLocaleLowerCase('tr');
  const list = [...state.vehicles.values()]
    .filter((v) => !q || `${v.plate} ${v.driver} ${v.model}`.toLocaleLowerCase('tr').includes(q))
    .sort((a, b) => a.plate.localeCompare(b.plate, 'tr'));
  $('#vehicleList').innerHTML =
    list
      .map((v) => {
        const p = v.lastPosition;
        const over = p && p.speed > v.speedLimit ? ' style="color:var(--danger)"' : '';
        return `<li data-id="${esc(v.id)}" class="${state.selected === v.id ? 'selected' : ''}">
          <span class="dot st-${esc(v.status)}" title="${STATUS_TEXT[v.status]}"></span>
          <div class="grow"><div class="title">${esc(v.plate)}</div>
          <div class="sub">${esc(v.driver || 'Sürücü yok')} · ${ago(p?.ts)}</div></div>
          <div class="speed"${over}>${p ? Math.round(p.speed) : '—'}<div class="sub">km/s</div></div></li>`;
      })
      .join('') || '<p class="hint">Araç bulunamadı.</p>';
  renderSummary();
}

const ALERT_ICON = { speeding: '⚠️', geofence_enter: '📍', geofence_exit: '🚪', online: '📶' };
function renderAlerts() {
  $('#alertList').innerHTML =
    state.alerts
      .map(
        (a) => `<li class="alert-${esc(a.type)}" data-lat="${a.lat}" data-lng="${a.lng}">
        <span>${ALERT_ICON[a.type] || '🔔'}</span>
        <div class="grow"><div>${esc(a.message)}</div><div class="sub">${fmtTime(a.ts)}</div></div></li>`
      )
      .join('') || '<p class="hint">Henüz alarm yok.</p>';
  const b = $('#alertBadge');
  b.hidden = state.unreadAlerts === 0;
  b.textContent = state.unreadAlerts;
}

function renderFences() {
  $('#fenceList').innerHTML =
    [...state.geofences.values()]
      .map(
        (f) => `<li data-id="${esc(f.id)}"><span>📍</span>
        <div class="grow"><div class="title">${esc(f.name)}</div><div class="sub">Yarıçap ${Math.round(f.radius)} m</div></div>
        <button class="icon" data-del="${esc(f.id)}" title="Sil">🗑</button></li>`
      )
      .join('') || '<p class="hint">Tanımlı bölge yok.</p>';
}

function renderDetail() {
  const v = state.vehicles.get(state.selected);
  if (!v) { $('#detail').hidden = true; return; }
  $('#detail').hidden = false;
  $('#dTitle').textContent = v.plate;
  const p = v.lastPosition;
  $('#dInfo').innerHTML = `
    <dt>Durum</dt><dd><span class="dot st-${esc(v.status)}" style="display:inline-block"></span> ${STATUS_TEXT[v.status]}</dd>
    <dt>Sürücü</dt><dd>${esc(v.driver || '—')}</dd>
    <dt>Model</dt><dd>${esc(v.model || '—')}</dd>
    <dt>Hız</dt><dd>${p ? Math.round(p.speed) : 0} km/s (limit ${esc(v.speedLimit)})</dd>
    <dt>Yön</dt><dd>${p ? p.heading + '°' : '—'}</dd>
    <dt>Konum</dt><dd>${p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : '—'}</dd>
    <dt>Son veri</dt><dd>${p ? `${fmtTime(p.ts)} (${ago(p.ts)})` : '—'}</dd>
    <dt>Kilometre</dt><dd>${(v.odometer / 1000).toFixed(1)} km</dd>`;
}

function fillEditForm(v) {
  const f = $('#editForm');
  f.driver.value = v.driver || '';
  f.model.value = v.model || '';
  f.speedLimit.value = v.speedLimit;
  f.color.value = v.color || '#2563eb';
  $('#dTokenBox').hidden = true;
}

function select(id) {
  state.selected = id;
  const v = state.vehicles.get(id);
  if (!v) return;
  clearHistory();
  fillEditForm(v);
  // Bitiş boş bırakılırsa "şimdiye kadar" anlamına gelir
  $('#hTo').value = '';
  $('#hFrom').value = toLocalInput(new Date(Date.now() - 24 * 3600 * 1000));
  $('#hStats').innerHTML = '';
  if (v.lastPosition) map.setView([v.lastPosition.lat, v.lastPosition.lng], Math.max(map.getZoom(), 14));
  renderVehicles();
  renderDetail();
}

// ---------- Rota geçmişi ----------
function historyRange() {
  const from = $('#hFrom').value ? new Date($('#hFrom').value).getTime() : '';
  // datetime-local dakika hassasiyetinde; seçilen dakikanın sonuna kadar dahil et
  const to = $('#hTo').value ? new Date($('#hTo').value).getTime() + 59999 : '';
  return `from=${from}&to=${to}`;
}

function clearHistory() {
  if (playback) { clearInterval(playback.timer); playback.marker.remove(); playback = null; }
  historyLayer?.remove();
  historyLayer = null;
  $('#hPlay').textContent = '▶ Oynat';
}

async function showHistory() {
  const id = state.selected;
  clearHistory();
  const [points, stats] = await Promise.all([
    api(`/vehicles/${id}/history?${historyRange()}`),
    api(`/vehicles/${id}/stats?${historyRange()}`),
  ]);
  $('#hStats').innerHTML = `
    <div><b>${stats.distanceKm}</b><span>km</span></div>
    <div><b>${stats.maxSpeed}</b><span>maks km/s</span></div>
    <div><b>${stats.avgSpeed}</b><span>ort km/s</span></div>
    <div><b>${stats.movingMinutes}</b><span>dk hareket</span></div>
    <div><b>${stats.idleMinutes}</b><span>dk duruş</span></div>
    <div><b>${stats.points}</b><span>nokta</span></div>`;
  if (!points.length) { toast('Bu aralıkta konum verisi yok.'); return null; }
  const v = state.vehicles.get(id);
  const latlngs = points.map((p) => [p.lat, p.lng]);
  historyLayer = L.layerGroup([
    L.polyline(latlngs, { color: v?.color || '#2563eb', weight: 5, opacity: 0.85 }),
    L.circleMarker(latlngs[0], { radius: 6, color: '#16a34a', fillOpacity: 1 }).bindTooltip('Başlangıç'),
    L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: '#dc2626', fillOpacity: 1 }).bindTooltip('Bitiş'),
  ]).addTo(map);
  map.fitBounds(L.latLngBounds(latlngs), { paddingTopLeft: [40, 40], paddingBottomRight: [window.innerWidth > 760 ? 400 : 40, 40] });
  return points;
}

async function togglePlay() {
  if (playback) { clearHistory(); return; }
  const points = await showHistory();
  if (!points || points.length < 2) return;
  const marker = L.circleMarker([points[0].lat, points[0].lng], { radius: 9, color: '#111827', fillColor: '#facc15', fillOpacity: 1 })
    .addTo(map)
    .bindTooltip('', { permanent: true, direction: 'top' });
  const step = Math.max(1, Math.floor(points.length / 300)); // en fazla ~300 kare
  let i = 0;
  playback = {
    marker,
    timer: setInterval(() => {
      i = Math.min(points.length - 1, i + step);
      const p = points[i];
      marker.setLatLng([p.lat, p.lng]);
      marker.setTooltipContent(`${new Date(p.ts).toLocaleTimeString('tr-TR')} · ${Math.round(p.speed)} km/s`);
      if (i >= points.length - 1) { clearInterval(playback.timer); $('#hPlay').textContent = '■ Bitti'; }
    }, 60),
  };
  $('#hPlay').textContent = '■ Durdur';
}

// ---------- Canlı veri (SSE) ----------
let es = null;
function connect() {
  es?.close();
  const conn = $('#conn');
  es = new EventSource(`/api/stream${adminToken ? `?token=${encodeURIComponent(adminToken)}` : ''}`);
  es.onopen = () => { conn.textContent = '● Canlı'; conn.classList.add('ok'); };
  es.onerror = () => {
    conn.textContent = '● Bağlantı yok'; conn.classList.remove('ok');
    // 401 durumunda tarayıcı yeniden denemeyi bırakır; anahtar iste
    if (es.readyState === EventSource.CLOSED) fetch('/api/vehicles', { headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {} })
      .then((r) => { if (r.status === 401) askToken(); else setTimeout(connect, 3000); })
      .catch(() => setTimeout(connect, 3000));
  };

  es.addEventListener('snapshot', (e) => {
    const s = JSON.parse(e.data);
    for (const m of markers.values()) m.remove();
    for (const t of trails.values()) t.remove();
    for (const c of fenceLayers.values()) c.remove();
    markers.clear(); trails.clear(); fenceLayers.clear();
    state.vehicles = new Map(s.vehicles.map((v) => [v.id, v]));
    state.geofences = new Map(s.geofences.map((f) => [f.id, f]));
    state.alerts = s.alerts;
    for (const v of state.vehicles.values()) upsertMarker(v);
    for (const f of state.geofences.values()) drawFence(f);
    if (!fitted && markers.size) {
      map.fitBounds(L.latLngBounds([...markers.values()].map((m) => m.getLatLng())), { padding: [60, 60], maxZoom: 14 });
      fitted = true;
    }
    renderVehicles(); renderAlerts(); renderFences(); renderDetail();
  });

  es.addEventListener('position', (e) => {
    const { vehicle } = JSON.parse(e.data);
    state.vehicles.set(vehicle.id, vehicle);
    upsertMarker(vehicle);
    addTrailPoint(vehicle);
    scheduleRender();
  });

  es.addEventListener('vehicle', (e) => {
    const v = JSON.parse(e.data);
    state.vehicles.set(v.id, v);
    upsertMarker(v);
    scheduleRender();
  });

  es.addEventListener('vehicle:removed', (e) => {
    const { id } = JSON.parse(e.data);
    state.vehicles.delete(id);
    markers.get(id)?.remove(); markers.delete(id);
    trails.get(id)?.remove(); trails.delete(id);
    if (state.selected === id) { state.selected = null; clearHistory(); }
    scheduleRender();
  });

  es.addEventListener('alert', (e) => {
    const a = JSON.parse(e.data);
    state.alerts.unshift(a);
    state.alerts.length = Math.min(state.alerts.length, 200);
    if ($('#tab-alerts').hidden) state.unreadAlerts++;
    renderAlerts();
    toast(a.message);
  });

  es.addEventListener('geofence', (e) => {
    const f = JSON.parse(e.data);
    state.geofences.set(f.id, f);
    drawFence(f);
    renderFences();
  });

  es.addEventListener('geofence:removed', (e) => {
    const { id } = JSON.parse(e.data);
    state.geofences.delete(id);
    fenceLayers.get(id)?.remove(); fenceLayers.delete(id);
    renderFences();
  });
}

let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; renderVehicles(); renderDetail(); });
}
// "x sn önce" ve çevrimdışı durumlarını tazelemek için
setInterval(() => {
  const OFFLINE = 5 * 60 * 1000;
  for (const v of state.vehicles.values()) {
    if (v.lastPosition && Date.now() - v.lastPosition.ts > OFFLINE && v.status !== 'offline') {
      v.status = 'offline';
      upsertMarker(v);
    }
  }
  scheduleRender();
}, 10000);

// ---------- Olay bağlama ----------
document.querySelectorAll('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    for (const name of ['vehicles', 'alerts', 'geofences']) $(`#tab-${name}`).hidden = btn.dataset.tab !== name;
    if (btn.dataset.tab === 'alerts') { state.unreadAlerts = 0; renderAlerts(); }
  })
);

$('#search').addEventListener('input', renderVehicles);
$('#vehicleList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) select(li.dataset.id);
});
$('#alertList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-lat]');
  if (li) map.setView([Number(li.dataset.lat), Number(li.dataset.lng)], 16);
});

$('#dClose').addEventListener('click', () => { state.selected = null; clearHistory(); renderVehicles(); renderDetail(); });
$('#hShow').addEventListener('click', () => showHistory().catch((e) => toast(e.message)));
$('#hPlay').addEventListener('click', () => togglePlay().catch((e) => toast(e.message)));
$('#hClear').addEventListener('click', () => { clearHistory(); $('#hStats').innerHTML = ''; });

$('#editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api(`/vehicles/${state.selected}`, {
      method: 'PUT',
      body: { driver: f.driver.value, model: f.model.value, speedLimit: Number(f.speedLimit.value), color: f.color.value },
    });
    trails.get(state.selected)?.setStyle({ color: f.color.value });
    toast('Araç bilgileri kaydedildi.');
  } catch (err) { toast(err.message); }
});

$('#dDelete').addEventListener('click', async () => {
  const v = state.vehicles.get(state.selected);
  if (!v || !confirm(`${v.plate} plakalı araç ve tüm geçmişi silinsin mi?`)) return;
  try { await api(`/vehicles/${v.id}`, { method: 'DELETE' }); } catch (err) { toast(err.message); }
});

$('#dToken').addEventListener('click', async () => {
  try {
    const { token } = await api(`/vehicles/${state.selected}/token`);
    const box = $('#dTokenBox');
    box.hidden = false;
    box.textContent =
      `Cihaz anahtarı:\n${token}\n\n` +
      `JSON gönderimi:\nPOST ${location.origin}/api/positions\nX-Device-Token: ${token}\n{"lat":41.0,"lng":29.0,"speed":50}\n\n` +
      `Traccar Client / OsmAnd uygulaması:\nSunucu: ${location.origin}/api/osmand\nCihaz kimliği: ${token}`;
  } catch (err) { toast(err.message); }
});

// Araç ekleme
const dlg = $('#vehicleDialog');
$('#addVehicleBtn').addEventListener('click', () => {
  $('#vehicleForm').reset();
  $('#vehicleError').textContent = '';
  dlg.showModal();
});
$('#vehicleForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target;
  try {
    const v = await api('/vehicles', {
      method: 'POST',
      body: { plate: f.plate.value, driver: f.driver.value, model: f.model.value, speedLimit: Number(f.speedLimit.value), color: f.color.value },
    });
    dlg.close();
    state.vehicles.set(v.id, v);
    select(v.id);
    $('#dToken').click();
  } catch (err) { $('#vehicleError').textContent = err.message; }
});

// Bölge ekleme
$('#addFenceBtn').addEventListener('click', () => {
  state.pickingFence = !state.pickingFence;
  $('#addFenceBtn').classList.toggle('active', state.pickingFence);
  $('#map').classList.toggle('picking', state.pickingFence);
  if (state.pickingFence) toast('Bölgenin merkezi için haritaya tıklayın.');
});
map.on('click', async (e) => {
  if (!state.pickingFence) return;
  state.pickingFence = false;
  $('#addFenceBtn').classList.remove('active');
  $('#map').classList.remove('picking');
  const name = prompt('Bölge adı:');
  if (!name) return;
  const radius = Number(prompt('Yarıçap (metre):', '500'));
  try { await api('/geofences', { method: 'POST', body: { name, lat: e.latlng.lat, lng: e.latlng.lng, radius } }); }
  catch (err) { toast(err.message); }
});
$('#fenceList').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const f = state.geofences.get(del.dataset.del);
    if (f && confirm(`"${f.name}" bölgesi silinsin mi?`)) {
      try { await api(`/geofences/${f.id}`, { method: 'DELETE' }); } catch (err) { toast(err.message); }
    }
    return;
  }
  const li = e.target.closest('li[data-id]');
  const f = li && state.geofences.get(li.dataset.id);
  if (f) map.fitBounds(fenceLayers.get(f.id).getBounds());
});

connect();
