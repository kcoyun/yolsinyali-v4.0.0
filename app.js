/**
 * YolSinyali — Harita, Socket.IO, Territory Sistemi
 */

// ─── Global State ─────────────────────────────────────────────────────────────
let map = null;
let socket = null;
let myUsername = "";
let serverUrl = "";
let myLatLng = null;
let myMarker = null;

// Arkadaş marker'ları
const friendMarkers = {};
const radarList = new Set();

// Territory sistemi
let isDrawingTerritory = false;
let territoryPath = [];          // Yürürken biriken koordinatlar
let territoryPolyline = null;    // Haritadaki çizgi
let territoryStartMarker = null; // Başlangıç noktası marker'ı
let CLOSE_THRESHOLD_M = 30;      // Başlangıca bu kadar yakınsa kapat (metre)
let myTerritories = [];          // Kendi bölgelerim [{id,name,polygon,area,color}]

// Tüm kullanıcıların bölgeleri: { username: [{id,name,polygon,layer,color}] }
const allTerritories = {};

// Yakınlık alarmı
let alarmActive = false;
const ALARM_AUDIO_CTX = window.AudioContext ? new AudioContext() : null;

// ─── Renkler ──────────────────────────────────────────────────────────────────
const USER_COLORS = [
  "#3b82f6","#ef4444","#22c55e","#f97316",
  "#8b5cf6","#14b8a6","#ec4899","#eab308"
];
function getColorForUser(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

// ─── Başlangıç ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  loadSavedSession();
});

function initMap() {
  map = L.map("map", { center: [39.9334, 32.8597], zoom: 6, zoomControl: true });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: "abcd", maxZoom: 19,
  }).addTo(map);
}

// ─── Oturum ───────────────────────────────────────────────────────────────────
function loadSavedSession() {
  const u = localStorage.getItem("ys_username");
  const s = localStorage.getItem("ys_server_url");
  if (u) document.getElementById("login-username").value = u;
  if (s) document.getElementById("login-server-url").value = s;
  if (u) setTimeout(() => handleLogin(true), 300);
}

function handleLogin(auto = false) {
  const username = (document.getElementById("login-username").value || "").trim();
  const url = (document.getElementById("login-server-url").value || "").trim();
  if (!username) { shakeElement(document.getElementById("login-username")); return; }
  myUsername = username;
  serverUrl = url || "";
  localStorage.setItem("ys_username", username);
  if (url) localStorage.setItem("ys_server_url", url);

  if (window.AndroidBridge) {
    try {
      if (url) window.AndroidBridge.saveServerUrl(url);
      window.AndroidBridge.saveUsernameAndStartTracking(username);
    } catch(e) { console.warn("AndroidBridge:", e); }
  }

  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("ui-overlay").classList.add("visible");
  document.getElementById("topbar-username").textContent = username;

  if (serverUrl) connectSocket();
  startGeolocationWatch();
}

// ─── GPS ──────────────────────────────────────────────────────────────────────
function startGeolocationWatch() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(onPositionUpdate, e => console.warn(e.message), {
    enableHighAccuracy: true, maximumAge: 3000, timeout: 10000,
  });
}

function onPositionUpdate(pos) {
  const { latitude, longitude } = pos.coords;
  const latlng = L.latLng(latitude, longitude);
  myLatLng = latlng;

  if (!myMarker) {
    myMarker = createUserMarker(latitude, longitude, myUsername, true);
    map.setView(myLatLng, 17);
  } else {
    myMarker.setLatLng(myLatLng);
  }

  // Territory çizimi
  if (isDrawingTerritory) {
    addTerritoryPoint(latlng);
  }

  if (socket && socket.connected) {
    socket.emit("update_location", { username: myUsername, latitude, longitude });
  }

  checkProximityAlarms();
}

// ─── TERRITORY SİSTEMİ ────────────────────────────────────────────────────────

function toggleTerritoryDrawing() {
  if (isDrawingTerritory) {
    stopTerritoryDrawing(false);
  } else {
    startTerritoryDrawing();
  }
}

function startTerritoryDrawing() {
  if (!myLatLng) { showToast("Konum henüz alınamadı, bekle."); return; }

  isDrawingTerritory = true;
  territoryPath = [myLatLng];

  // Başlangıç marker'ı
  territoryStartMarker = L.circleMarker(myLatLng, {
    radius: 8, color: "#fff", weight: 2,
    fillColor: getColorForUser(myUsername), fillOpacity: 1,
  }).addTo(map).bindTooltip("Buraya dön!", { permanent: true, direction: "top" });

  // Çizgi
  territoryPolyline = L.polyline([myLatLng], {
    color: getColorForUser(myUsername),
    weight: 3, opacity: 0.9, dashArray: "8 4",
  }).addTo(map);

  // UI güncelle
  document.getElementById("territory-btn").innerHTML = `<span class="animate-pulse">⏹ Durdur</span>`;
  document.getElementById("territory-btn").classList.add("bg-red-700");
  document.getElementById("territory-btn").classList.remove("bg-blue-700");
  document.getElementById("territory-status").classList.remove("hidden");
  showToast("🗺 Bölge çizimi başladı! Yürü ve başlangıca dön.");
}

function addTerritoryPoint(latlng) {
  // Son noktayla arasında minimum 5m varsa ekle
  const last = territoryPath[territoryPath.length - 1];
  if (last && last.distanceTo(latlng) < 5) return;

  territoryPath.push(latlng);
  territoryPolyline.addLatLng(latlng);

  updateTerritoryStatus();

  // Başlangıca yaklaştı mı? (minimum 4 nokta sonra kontrol et)
  if (territoryPath.length >= 4) {
    const start = territoryPath[0];
    const distToStart = latlng.distanceTo(start);
    document.getElementById("dist-to-start").textContent = Math.round(distToStart) + "m";

    if (distToStart <= CLOSE_THRESHOLD_M) {
      stopTerritoryDrawing(true); // Otomatik kapat!
    }
  }
}

function stopTerritoryDrawing(autoClose) {
  isDrawingTerritory = false;
  document.getElementById("territory-btn").innerHTML = `🗺 Bölge Çiz`;
  document.getElementById("territory-btn").classList.remove("bg-red-700");
  document.getElementById("territory-btn").classList.add("bg-blue-700");
  document.getElementById("territory-status").classList.add("hidden");

  // Temizle
  if (territoryStartMarker) { map.removeLayer(territoryStartMarker); territoryStartMarker = null; }
  if (territoryPolyline) { map.removeLayer(territoryPolyline); territoryPolyline = null; }

  if (!autoClose || territoryPath.length < 4) {
    if (!autoClose) showToast("Bölge çizimi iptal edildi.");
    territoryPath = [];
    return;
  }

  // Çokgeni kapat ve kaydet
  const closedPath = [...territoryPath, territoryPath[0]];
  showNameTerritoryModal(closedPath);
}

function updateTerritoryStatus() {
  document.getElementById("territory-points").textContent = territoryPath.length;
  if (territoryPath.length >= 2) {
    let total = 0;
    for (let i = 1; i < territoryPath.length; i++) {
      total += territoryPath[i-1].distanceTo(territoryPath[i]);
    }
    document.getElementById("territory-dist").textContent = total >= 1000
      ? (total/1000).toFixed(2) + "km" : Math.round(total) + "m";
  }
}

function showNameTerritoryModal(path) {
  document.getElementById("territory-modal").classList.remove("hidden");
  document.getElementById("territory-name-input").value = "";
  document.getElementById("territory-name-input").focus();

  // Önizleme polygon çiz
  const previewPoly = L.polygon(path, {
    color: getColorForUser(myUsername), weight: 2,
    fillColor: getColorForUser(myUsername), fillOpacity: 0.15,
  }).addTo(map);
  map.fitBounds(previewPoly.getBounds(), { padding: [40, 40] });

  window._pendingTerritoryPath = path;
  window._pendingPreviewPoly = previewPoly;
}

function saveTerritoryFromModal() {
  const name = (document.getElementById("territory-name-input").value || "").trim();
  if (!name) { shakeElement(document.getElementById("territory-name-input")); return; }

  const path = window._pendingTerritoryPath;
  if (window._pendingPreviewPoly) { map.removeLayer(window._pendingPreviewPoly); }
  document.getElementById("territory-modal").classList.add("hidden");

  finalizeTerritory(path, name);
}

function cancelTerritoryModal() {
  if (window._pendingPreviewPoly) { map.removeLayer(window._pendingPreviewPoly); }
  document.getElementById("territory-modal").classList.add("hidden");
  territoryPath = [];
}

function finalizeTerritory(path, name) {
  const color = getColorForUser(myUsername);
  const id = Date.now().toString();
  const area = calcPolygonArea(path);

  const layer = L.polygon(path, {
    color: color, weight: 2, opacity: 0.9,
    fillColor: color, fillOpacity: 0.2,
  }).addTo(map);

  layer.bindPopup(buildTerritoryPopup({ name, username: myUsername, area, id }, true));

  const territory = { id, name, path, layer, color, area, username: myUsername };
  myTerritories.push(territory);

  if (!allTerritories[myUsername]) allTerritories[myUsername] = [];
  allTerritories[myUsername].push(territory);

  // Sunucuya yayınla
  if (socket && socket.connected) {
    socket.emit("territory_created", {
      id, name, username: myUsername, color,
      path: path.map(p => [p.lat, p.lng]),
      area,
    });
  }

  showToast(`✅ "${name}" bölgesi oluşturuldu! Alan: ${formatArea(area)}`);
  renderTerritoryList();
}

// Bölge ele geçirme — merkeze ulaşınca
function checkTerritoryCapture() {
  if (!myLatLng) return;

  Object.entries(allTerritories).forEach(([owner, territories]) => {
    if (owner === myUsername) return;

    territories.forEach(territory => {
      if (territory.captured) return;

      // Polygon merkezini hesapla
      const center = territory.layer.getBounds().getCenter();
      const distToCenter = myLatLng.distanceTo(center);

      if (distToCenter <= 20) { // 20 metre içindeyse ele geçir
        captureTerritory(territory, owner);
      }
    });
  });
}

function captureTerritory(territory, previousOwner) {
  territory.captured = true;
  const oldColor = territory.color;
  const newColor = getColorForUser(myUsername);

  // Rengi değiştir — ele geçirildi göstergesi
  territory.layer.setStyle({
    color: newColor, fillColor: newColor,
    fillOpacity: 0.35, dashArray: "6 3",
  });
  territory.layer.setPopupContent(
    buildTerritoryPopup({ ...territory, username: myUsername, capturedFrom: previousOwner }, true)
  );

  // Animasyon efekti
  flashLayer(territory.layer);

  // Sunucuya bildir
  if (socket && socket.connected) {
    socket.emit("territory_captured", {
      id: territory.id,
      capturedBy: myUsername,
      previousOwner,
    });
  }

  showToast(`🏴 "${territory.name}" bölgesini ele geçirdin! (${previousOwner}'dan)`);
  playAlarmSound();
}

function flashLayer(layer) {
  let count = 0;
  const interval = setInterval(() => {
    layer.setStyle({ fillOpacity: count % 2 === 0 ? 0.7 : 0.2 });
    count++;
    if (count >= 6) clearInterval(interval);
  }, 200);
}

// ─── Territory Harita Render ───────────────────────────────────────────────────

function renderFriendTerritory(data) {
  const { id, name, username, color, path, area } = data;
  const latLngs = path.map(p => L.latLng(p[0], p[1]));

  const layer = L.polygon(latLngs, {
    color, weight: 2, opacity: 0.8,
    fillColor: color, fillOpacity: 0.15,
  }).addTo(map);

  layer.bindPopup(buildTerritoryPopup({ name, username, area, id }, false));

  if (!allTerritories[username]) allTerritories[username] = [];

  // Varsa güncelle, yoksa ekle
  const existing = allTerritories[username].findIndex(t => t.id === id);
  const territory = { id, name, path: latLngs, layer, color, area, username };

  if (existing >= 0) {
    map.removeLayer(allTerritories[username][existing].layer);
    allTerritories[username][existing] = territory;
  } else {
    allTerritories[username].push(territory);
  }
}

function removeTerritoryById(id) {
  Object.values(allTerritories).forEach(list => {
    const idx = list.findIndex(t => t.id === id);
    if (idx >= 0) {
      map.removeLayer(list[idx].layer);
      list.splice(idx, 1);
    }
  });
}

function buildTerritoryPopup(t, isOwner) {
  const captureNote = t.capturedFrom ? `<div style="color:#f97316;font-size:11px;margin-top:4px;">⚔️ ${t.capturedFrom}'dan ele geçirildi</div>` : "";
  const deleteBtn = isOwner && t.username === myUsername
    ? `<button onclick="deleteMyTerritory('${t.id}')" style="display:block;margin-top:8px;background:#ef4444;color:#fff;border:none;padding:5px 10px;border-radius:6px;font-size:12px;cursor:pointer;width:100%">Bölgeyi Sil</button>`
    : "";
  return `
    <div style="min-width:160px;">
      <div style="font-weight:bold;font-size:14px;margin-bottom:4px;">📍 ${t.name}</div>
      <div style="font-size:12px;color:#94a3b8;">Sahibi: <b style="color:#e2e8f0">${t.username}</b></div>
      <div style="font-size:12px;color:#94a3b8;margin-top:2px;">Alan: ${formatArea(t.area)}</div>
      ${captureNote}
      ${deleteBtn}
    </div>`;
}

function deleteMyTerritory(id) {
  const idx = myTerritories.findIndex(t => t.id === id);
  if (idx >= 0) {
    map.removeLayer(myTerritories[idx].layer);
    myTerritories.splice(idx, 1);
  }
  removeTerritoryById(id);

  if (socket && socket.connected) {
    socket.emit("territory_deleted", { id, username: myUsername });
  }
  renderTerritoryList();
  showToast("Bölge silindi.");
}

function renderTerritoryList() {
  const container = document.getElementById("territory-list");
  const myT = myTerritories;

  if (myT.length === 0) {
    container.innerHTML = `<p class="text-slate-500 text-xs text-center py-3">Henüz bölgen yok. Yürüyerek çiz!</p>`;
    return;
  }

  container.innerHTML = myT.map(t => `
    <div class="flex items-center justify-between p-2 rounded-lg bg-slate-800/60 mb-1">
      <div class="flex items-center gap-2">
        <div style="width:10px;height:10px;border-radius:2px;background:${t.color}"></div>
        <span class="text-white text-xs font-medium">${t.name}</span>
        <span class="text-slate-500 text-xs">${formatArea(t.area)}</span>
      </div>
      <button onclick="focusTerritory('${t.id}')" class="text-blue-400 text-xs hover:text-blue-300">🔍</button>
    </div>
  `).join("");
}

function focusTerritory(id) {
  const all = Object.values(allTerritories).flat();
  const t = all.find(t => t.id === id);
  if (t) map.fitBounds(t.layer.getBounds(), { padding: [40, 40] });
}

// ─── Alan Hesaplama ───────────────────────────────────────────────────────────
function calcPolygonArea(latlngs) {
  // Shoelace + Haversine yaklaşımı (m²)
  let area = 0;
  const n = latlngs.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = latlngs[i].lng * Math.cos(latlngs[i].lat * Math.PI / 180);
    const yi = latlngs[i].lat;
    const xj = latlngs[j].lng * Math.cos(latlngs[j].lat * Math.PI / 180);
    const yj = latlngs[j].lat;
    area += xi * yj - xj * yi;
  }
  return Math.abs(area / 2) * 111320 * 111320;
}

function formatArea(m2) {
  if (m2 >= 1000000) return (m2 / 1000000).toFixed(2) + " km²";
  if (m2 >= 10000) return (m2 / 10000).toFixed(1) + " hektar";
  return Math.round(m2) + " m²";
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
function connectSocket() {
  if (socket) socket.disconnect();
  try {
    socket = io(serverUrl, { transports: ["websocket","polling"], reconnectionAttempts: 10 });

    socket.on("connect", () => {
      socket.emit("join", { username: myUsername });
    });

    socket.on("friend_location_update", data => {
      if (data.username === myUsername) return;
      updateFriendMarker(data.username, data.latitude, data.longitude);
      checkTerritoryCapture(); // her konum güncellemesinde kontrol et
    });

    socket.on("friend_disconnected", data => removeFriendMarker(data.username));

    socket.on("active_users_snapshot", data => {
      (data.users || []).forEach(u => {
        if (u.username !== myUsername) updateFriendMarker(u.username, u.latitude, u.longitude);
      });
      document.getElementById("online-count").textContent = `${data.users?.length || 0} kişi`;
    });

    // Territory olayları
    socket.on("territory_created", data => {
      if (data.username !== myUsername) renderFriendTerritory(data);
    });

    socket.on("territory_deleted", data => {
      removeTerritoryById(data.id);
    });

    socket.on("territory_captured", data => {
      if (data.previousOwner === myUsername) {
        showToast(`⚠️ "${data.id}" bölgen ${data.capturedBy} tarafından ele geçirildi!`);
        playAlarmSound();
      }
      // Görsel güncelle
      const all = Object.values(allTerritories).flat();
      const t = all.find(t => t.id === data.id);
      if (t) {
        const newColor = getColorForUser(data.capturedBy);
        t.layer.setStyle({ color: newColor, fillColor: newColor });
        flashLayer(t.layer);
      }
    });

    socket.on("territories_snapshot", data => {
      (data.territories || []).forEach(t => {
        if (t.username !== myUsername) renderFriendTerritory(t);
      });
    });

  } catch(e) { console.error("Socket:", e); }
}

// ─── Marker'lar ───────────────────────────────────────────────────────────────
function createUserMarker(lat, lng, username, isMe = false) {
  const color = isMe ? "#3b82f6" : getColorForUser(username);
  const initial = username.charAt(0).toUpperCase();
  const iconHtml = `
    <div style="position:relative;width:44px;height:44px;display:flex;align-items:center;justify-content:center;">
      <div style="position:absolute;width:44px;height:44px;border-radius:50%;background:${color}22;border:2px solid ${color}66;animation:ripple 1.6s ease-out infinite;"></div>
      <div style="width:32px;height:32px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:14px;box-shadow:0 0 12px ${color}88;position:relative;z-index:2;border:2px solid white;">${initial}</div>
    </div>`;
  return L.marker([lat,lng], {
    icon: L.divIcon({ html: iconHtml, className: "", iconSize:[44,44], iconAnchor:[22,22], popupAnchor:[0,-24] })
  }).addTo(map).bindPopup(`<b>${username}${isMe?" (Sen)":""}</b><br><small>${lat.toFixed(5)}, ${lng.toFixed(5)}</small>`);
}

function updateFriendMarker(username, lat, lng) {
  if (friendMarkers[username]) {
    animateMarker(friendMarkers[username], L.latLng(lat,lng));
  } else {
    friendMarkers[username] = createUserMarker(lat, lng, username, false);
  }
}

function removeFriendMarker(username) {
  if (friendMarkers[username]) { map.removeLayer(friendMarkers[username]); delete friendMarkers[username]; }
}

function animateMarker(marker, newLatLng) {
  const start = marker.getLatLng();
  let frame = 0;
  const go = () => {
    frame++;
    const t = frame / 20;
    marker.setLatLng([start.lat + (newLatLng.lat - start.lat)*t, start.lng + (newLatLng.lng - start.lng)*t]);
    if (frame < 20) requestAnimationFrame(go);
  };
  requestAnimationFrame(go);
}

// ─── Radar ────────────────────────────────────────────────────────────────────
function addFriend() {
  const input = document.getElementById("friend-input");
  const name = (input.value||"").trim();
  if (!name || name === myUsername) { shakeElement(input); return; }
  radarList.add(name);
  input.value = "";
  renderRadarList();
}

function renderRadarList() {
  const container = document.getElementById("friend-list");
  if (radarList.size === 0) {
    container.innerHTML = `<p class="text-slate-500 text-xs text-center py-3">Henüz takip edilen yok.</p>`;
    return;
  }
  container.innerHTML = [...radarList].map(name => {
    const online = !!friendMarkers[name];
    return `
      <div class="flex items-center justify-between p-2 rounded-lg ${online?"bg-blue-900/30":"bg-slate-800/50"} mb-1">
        <div class="flex items-center gap-2">
          <div style="width:7px;height:7px;border-radius:50%;background:${online?"#34d399":"#475569"}"></div>
          <span class="text-white text-xs">${name}</span>
          <span class="text-slate-500 text-xs">${online?"çevrimiçi":"çevrimdışı"}</span>
        </div>
        <div class="flex gap-1">
          ${online?`<button onclick="focusFriend('${name}')" class="text-blue-400 text-xs px-1">📍</button>`:""}
          <button onclick="removeFriend('${name}')" class="text-red-400 text-xs px-1">✕</button>
        </div>
      </div>`;
  }).join("");
}

function removeFriend(name) { radarList.delete(name); renderRadarList(); }
function focusFriend(name) {
  if (friendMarkers[name]) { map.setView(friendMarkers[name].getLatLng(), 17, {animate:true}); }
}

// ─── Yakınlık Alarmı ─────────────────────────────────────────────────────────
function checkProximityAlarms() {
  if (!myLatLng) return;
  const threshold = parseInt(document.getElementById("alarm-distance")?.value||"500");
  let triggered = false, triggeredBy = "";
  radarList.forEach(name => {
    const m = friendMarkers[name];
    if (!m) return;
    if (myLatLng.distanceTo(m.getLatLng()) <= threshold) { triggered=true; triggeredBy=name; }
  });
  if (triggered && !alarmActive) {
    alarmActive = true;
    const banner = document.getElementById("alarm-banner");
    document.getElementById("alarm-text").textContent = `⚠️ ${triggeredBy} yakında!`;
    banner.classList.remove("hidden");
    playAlarmSound();
  } else if (!triggered && alarmActive) { dismissAlarm(); }

  checkTerritoryCapture();
}

function dismissAlarm() { alarmActive=false; document.getElementById("alarm-banner").classList.add("hidden"); }

function playAlarmSound() {
  if (!ALARM_AUDIO_CTX) return;
  try {
    const osc = ALARM_AUDIO_CTX.createOscillator();
    const gain = ALARM_AUDIO_CTX.createGain();
    osc.connect(gain); gain.connect(ALARM_AUDIO_CTX.destination);
    osc.type = "sine"; osc.frequency.setValueAtTime(880, ALARM_AUDIO_CTX.currentTime);
    osc.frequency.setValueAtTime(660, ALARM_AUDIO_CTX.currentTime+0.15);
    gain.gain.setValueAtTime(0.3, ALARM_AUDIO_CTX.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ALARM_AUDIO_CTX.currentTime+0.5);
    osc.start(); osc.stop(ALARM_AUDIO_CTX.currentTime+0.5);
  } catch(e) {}
}

// ─── WhatsApp SOS ─────────────────────────────────────────────────────────────
function sendSOSWhatsApp() {
  if (!myLatLng) { alert("Konum henüz alınamadı."); return; }
  const { lat, lng } = myLatLng;
  const msg = encodeURIComponent(`🚨 ACİL - YolSinyali\n${myUsername} yardım istiyor!\n📍 https://www.google.com/maps?q=${lat},${lng}`);
  window.open(`https://wa.me/?text=${msg}`, "_blank");
}

// ─── Yardımcılar ──────────────────────────────────────────────────────────────
function centerOnMe() {
  if (myLatLng) map.setView(myLatLng, 17, {animate:true});
}

function togglePanel(id) {
  document.getElementById(id)?.classList.toggle("hidden");
}

function updateAlarmLabel() {
  const v = document.getElementById("alarm-distance")?.value||"500";
  document.getElementById("alarm-label").textContent = v>=1000 ? (v/1000).toFixed(1)+"km" : v+"m";
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("opacity-0"); t.classList.add("opacity-100");
  setTimeout(() => { t.classList.remove("opacity-100"); t.classList.add("opacity-0"); }, 3000);
}

function shakeElement(el) {
  el.style.transition = "transform 0.07s";
  [0,8,-8,8,-8,0].forEach((x,i) => setTimeout(() => el.style.transform=`translateX(${x}px)`, i*70));
  setTimeout(() => el.style.transform="", 500);
}
