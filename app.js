/**
 * YolSinyali — Harita, Socket.IO, Territory Sistemi
 * Pointer-events düzeltilmiş versiyon
 */

// ─── Global State ─────────────────────────────────────────────────────────────
let map = null;
let socket = null;
let myUsername = "";
let serverUrl = "";
let myLatLng = null;
let myMarker = null;

const friendMarkers = {};
const radarList = new Set();

// Territory
let isDrawingTerritory = false;
let territoryPath = [];
let territoryPolyline = null;
let territoryStartMarker = null;
const CLOSE_THRESHOLD_M = 30;
let myTerritories = [];
const allTerritories = {};

// Alarm
let alarmActive = false;
const ALARM_AUDIO_CTX = (window.AudioContext || window.webkitAudioContext)
  ? new (window.AudioContext || window.webkitAudioContext)() : null;

// ─── Renkler ──────────────────────────────────────────────────────────────────
const USER_COLORS = ["#3b82f6","#ef4444","#22c55e","#f97316","#8b5cf6","#14b8a6","#ec4899","#eab308"];
function getColorForUser(u) {
  let h = 0;
  for (let i = 0; i < u.length; i++) h = u.charCodeAt(i) + ((h << 5) - h);
  return USER_COLORS[Math.abs(h) % USER_COLORS.length];
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  loadSavedSession();
});

function initMap() {
  map = L.map("map", { center: [39.9334, 32.8597], zoom: 6, zoomControl: true });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '© OpenStreetMap © CARTO', subdomains: "abcd", maxZoom: 19,
  }).addTo(map);
}

// ─── Panel toggle — display:none/block kullan ─────────────────────────────────
function togglePanel(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const isVisible = el.style.display !== "none" && el.style.display !== "";
  el.style.display = isVisible ? "none" : "block";
}

function showEl(id)  { const e = document.getElementById(id); if (e) e.style.display = "block"; }
function hideEl(id)  { const e = document.getElementById(id); if (e) e.style.display = "none"; }

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
  if (!username) { shakeEl("login-username"); return; }

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

  hideEl("login-screen");
  document.getElementById("topbar-username").textContent = username;

  if (serverUrl) connectSocket();
  startGeolocationWatch();
}

// ─── GPS ──────────────────────────────────────────────────────────────────────
function startGeolocationWatch() {
  if (!navigator.geolocation) { showToast("Tarayıcı konumu desteklemiyor."); return; }
  navigator.geolocation.watchPosition(onPositionUpdate, e => console.warn(e.message), {
    enableHighAccuracy: true, maximumAge: 3000, timeout: 15000,
  });
}

function onPositionUpdate(pos) {
  const { latitude: lat, longitude: lng } = pos.coords;
  myLatLng = L.latLng(lat, lng);

  if (!myMarker) {
    myMarker = createUserMarker(lat, lng, myUsername, true);
    map.setView(myLatLng, 17);
  } else {
    myMarker.setLatLng(myLatLng);
  }

  if (isDrawingTerritory) addTerritoryPoint(myLatLng);

  if (socket && socket.connected) {
    socket.emit("update_location", { username: myUsername, latitude: lat, longitude: lng });
  }

  checkProximityAlarms();
}

// ─── Territory ────────────────────────────────────────────────────────────────
function toggleTerritoryDrawing() {
  isDrawingTerritory ? stopTerritoryDrawing(false) : startTerritoryDrawing();
}

function startTerritoryDrawing() {
  if (!myLatLng) { showToast("Konum henüz alınamadı, bekle."); return; }

  isDrawingTerritory = true;
  territoryPath = [myLatLng];

  territoryStartMarker = L.circleMarker(myLatLng, {
    radius: 9, color: "#fff", weight: 2.5,
    fillColor: getColorForUser(myUsername), fillOpacity: 1,
  }).addTo(map).bindTooltip("Buraya dön!", { permanent: true, direction: "top" });

  territoryPolyline = L.polyline([myLatLng], {
    color: getColorForUser(myUsername), weight: 3.5, opacity: 0.9, dashArray: "8 5",
  }).addTo(map);

  const btn = document.getElementById("territory-btn");
  btn.textContent = "⏹ Durdur";
  btn.style.background = "#7e22ce";

  showEl("territory-status");
  showToast("🗺 Yürü! Başlangıç noktasına 30m yaklaşınca bölge kapanır.");
}

function addTerritoryPoint(latlng) {
  const last = territoryPath[territoryPath.length - 1];
  if (last && last.distanceTo(latlng) < 5) return;

  territoryPath.push(latlng);
  territoryPolyline.addLatLng(latlng);
  updateTerritoryStatus();

  if (territoryPath.length >= 5) {
    const dist = latlng.distanceTo(territoryPath[0]);
    document.getElementById("dist-to-start").textContent = Math.round(dist) + " m";
    if (dist <= CLOSE_THRESHOLD_M) stopTerritoryDrawing(true);
  }
}

function stopTerritoryDrawing(autoClose) {
  isDrawingTerritory = false;

  const btn = document.getElementById("territory-btn");
  btn.textContent = "🗺 Bölge Çizmeye Başla";
  btn.style.background = "";

  hideEl("territory-status");

  if (territoryStartMarker) { map.removeLayer(territoryStartMarker); territoryStartMarker = null; }
  if (territoryPolyline)    { map.removeLayer(territoryPolyline);    territoryPolyline = null; }

  if (!autoClose || territoryPath.length < 5) {
    showToast(autoClose ? "En az 5 nokta gerekli, daha fazla yürü." : "Bölge çizimi iptal edildi.");
    territoryPath = [];
    return;
  }

  const closed = [...territoryPath, territoryPath[0]];
  showNameModal(closed);
}

function updateTerritoryStatus() {
  document.getElementById("territory-points").textContent = territoryPath.length;
  let total = 0;
  for (let i = 1; i < territoryPath.length; i++) total += territoryPath[i-1].distanceTo(territoryPath[i]);
  document.getElementById("territory-dist").textContent =
    total >= 1000 ? (total/1000).toFixed(2)+"km" : Math.round(total)+"m";
}

function showNameModal(path) {
  window._pendingPath = path;
  document.getElementById("territory-name-input").value = "";

  // Önizleme
  if (window._previewLayer) { map.removeLayer(window._previewLayer); }
  window._previewLayer = L.polygon(path, {
    color: getColorForUser(myUsername), weight: 2,
    fillColor: getColorForUser(myUsername), fillOpacity: 0.15,
  }).addTo(map);
  map.fitBounds(window._previewLayer.getBounds(), { padding: [50, 50] });

  showEl("territory-modal");
  setTimeout(() => document.getElementById("territory-name-input").focus(), 100);
}

function saveTerritoryFromModal() {
  const name = (document.getElementById("territory-name-input").value || "").trim();
  if (!name) { shakeEl("territory-name-input"); return; }

  if (window._previewLayer) { map.removeLayer(window._previewLayer); window._previewLayer = null; }
  hideEl("territory-modal");

  createTerritory(window._pendingPath, name);
  window._pendingPath = null;
}

function cancelTerritoryModal() {
  if (window._previewLayer) { map.removeLayer(window._previewLayer); window._previewLayer = null; }
  hideEl("territory-modal");
  territoryPath = [];
}

function createTerritory(path, name) {
  const color = getColorForUser(myUsername);
  const id = Date.now().toString();
  const area = calcArea(path);

  const layer = L.polygon(path, {
    color, weight: 2.5, opacity: 0.9, fillColor: color, fillOpacity: 0.2,
  }).addTo(map).bindPopup(buildPopup({ id, name, username: myUsername, area }, true));

  const t = { id, name, path, layer, color, area, username: myUsername };
  myTerritories.push(t);
  if (!allTerritories[myUsername]) allTerritories[myUsername] = [];
  allTerritories[myUsername].push(t);

  if (socket && socket.connected) {
    socket.emit("territory_created", {
      id, name, username: myUsername, color,
      path: path.map(p => [p.lat, p.lng]), area,
    });
  }

  showToast(`✅ "${name}" oluşturuldu! (${formatArea(area)})`);
  renderTerritoryList();
}

// ─── Ele geçirme — merkeze git ────────────────────────────────────────────────
function checkCapture() {
  if (!myLatLng) return;
  Object.entries(allTerritories).forEach(([owner, list]) => {
    if (owner === myUsername) return;
    list.forEach(t => {
      if (t.captured) return;
      const center = t.layer.getBounds().getCenter();
      if (myLatLng.distanceTo(center) <= 25) captureTerritory(t, owner);
    });
  });
}

function captureTerritory(t, prevOwner) {
  t.captured = true;
  const nc = getColorForUser(myUsername);
  t.layer.setStyle({ color: nc, fillColor: nc, fillOpacity: 0.35, dashArray: "6 3" });
  t.layer.setPopupContent(buildPopup({ ...t, username: myUsername, capturedFrom: prevOwner }, false));
  flashLayer(t.layer);

  if (socket && socket.connected) {
    socket.emit("territory_captured", { id: t.id, capturedBy: myUsername, previousOwner: prevOwner });
  }
  showToast(`🏴 "${t.name}" ele geçirildi! (${prevOwner}'dan)`);
  playAlarmSound();
}

function flashLayer(layer) {
  let n = 0;
  const iv = setInterval(() => {
    layer.setStyle({ fillOpacity: n++ % 2 === 0 ? 0.7 : 0.15 });
    if (n >= 8) { clearInterval(iv); layer.setStyle({ fillOpacity: 0.35 }); }
  }, 180);
}

function renderFriendTerritory(data) {
  const latlngs = data.path.map(p => L.latLng(p[0], p[1]));
  const layer = L.polygon(latlngs, {
    color: data.color, weight: 2, opacity: 0.8, fillColor: data.color, fillOpacity: 0.15,
  }).addTo(map).bindPopup(buildPopup({ ...data }, false));

  if (!allTerritories[data.username]) allTerritories[data.username] = [];
  const idx = allTerritories[data.username].findIndex(t => t.id === data.id);
  const t = { ...data, path: latlngs, layer };
  if (idx >= 0) { map.removeLayer(allTerritories[data.username][idx].layer); allTerritories[data.username][idx] = t; }
  else allTerritories[data.username].push(t);
}

function removeTerritoryById(id) {
  Object.values(allTerritories).forEach(list => {
    const i = list.findIndex(t => t.id === id);
    if (i >= 0) { map.removeLayer(list[i].layer); list.splice(i, 1); }
  });
}

function buildPopup(t, isOwner) {
  const cap = t.capturedFrom ? `<div style="color:#f97316;font-size:11px;margin-top:3px">⚔️ ${t.capturedFrom}'dan alındı</div>` : "";
  const del = isOwner && t.username === myUsername
    ? `<button onclick="deleteTerritory('${t.id}')" style="margin-top:8px;width:100%;background:#ef4444;color:#fff;border:none;padding:5px 0;border-radius:6px;font-size:12px;cursor:pointer">Sil</button>` : "";
  return `<div style="min-width:150px">
    <b style="font-size:14px">📍 ${t.name}</b>
    <div style="font-size:12px;color:#94a3b8;margin-top:3px">Sahibi: <b style="color:#e2e8f0">${t.username}</b></div>
    <div style="font-size:12px;color:#94a3b8">Alan: ${formatArea(t.area)}</div>
    ${cap}${del}
  </div>`;
}

function deleteTerritory(id) {
  const i = myTerritories.findIndex(t => t.id === id);
  if (i >= 0) { map.removeLayer(myTerritories[i].layer); myTerritories.splice(i, 1); }
  removeTerritoryById(id);
  if (socket && socket.connected) socket.emit("territory_deleted", { id, username: myUsername });
  renderTerritoryList();
  showToast("Bölge silindi.");
}

function renderTerritoryList() {
  const el = document.getElementById("territory-list");
  if (!myTerritories.length) {
    el.innerHTML = `<p class="text-slate-600 text-xs text-center py-3">Henüz bölgen yok.</p>`;
    return;
  }
  el.innerHTML = myTerritories.map(t => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:10px;background:rgba(30,40,60,0.6);margin-bottom:4px">
      <div style="display:flex;align-items:center;gap:8px;min-width:0">
        <div style="width:10px;height:10px;border-radius:3px;background:${t.color};flex-shrink:0"></div>
        <span style="color:#e2e8f0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.name}</span>
        <span style="color:#475569;font-size:11px;flex-shrink:0">${formatArea(t.area)}</span>
      </div>
      <button onclick="focusTerritory('${t.id}')" style="color:#60a5fa;font-size:13px;background:none;border:none;cursor:pointer;padding:2px 6px">🔍</button>
    </div>`).join("");
}

function focusTerritory(id) {
  const t = Object.values(allTerritories).flat().find(t => t.id === id);
  if (t) map.fitBounds(t.layer.getBounds(), { padding: [40, 40] });
}

// ─── Alan hesaplama ───────────────────────────────────────────────────────────
function calcArea(lls) {
  let a = 0, n = lls.length;
  for (let i = 0; i < n; i++) {
    const j = (i+1) % n;
    const xi = lls[i].lng * Math.cos(lls[i].lat * Math.PI/180);
    const xj = lls[j].lng * Math.cos(lls[j].lat * Math.PI/180);
    a += xi * lls[j].lat - xj * lls[i].lat;
  }
  return Math.abs(a/2) * 111320 * 111320;
}
function formatArea(m2) {
  if (m2 >= 1e6)  return (m2/1e6).toFixed(2)+" km²";
  if (m2 >= 1e4)  return (m2/1e4).toFixed(1)+" ha";
  return Math.round(m2)+" m²";
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
function connectSocket() {
  if (socket) socket.disconnect();
  try {
    socket = io(serverUrl, { transports: ["websocket","polling"], reconnectionAttempts: 10 });

    socket.on("connect", () => {
      socket.emit("join", { username: myUsername });
    });

    socket.on("friend_location_update", d => {
      if (d.username === myUsername) return;
      updateFriendMarker(d.username, d.latitude, d.longitude);
      checkCapture();
    });

    socket.on("friend_disconnected",    d => removeFriendMarker(d.username));

    socket.on("active_users_snapshot", d => {
      (d.users||[]).forEach(u => { if (u.username !== myUsername) updateFriendMarker(u.username, u.latitude, u.longitude); });
      document.getElementById("online-count").textContent = `${d.users?.length||0} kişi`;
    });

    socket.on("territory_created",  d => { if (d.username !== myUsername) renderFriendTerritory(d); });
    socket.on("territory_deleted",  d => removeTerritoryById(d.id));
    socket.on("territories_snapshot", d => (d.territories||[]).forEach(t => { if (t.username !== myUsername) renderFriendTerritory(t); }));

    socket.on("territory_captured", d => {
      if (d.previousOwner === myUsername) {
        showToast(`⚠️ "${d.id}" bölgen ${d.capturedBy} tarafından alındı!`);
        playAlarmSound();
      }
      const t = Object.values(allTerritories).flat().find(t => t.id === d.id);
      if (t) { const c = getColorForUser(d.capturedBy); t.layer.setStyle({ color: c, fillColor: c }); flashLayer(t.layer); }
    });

  } catch(e) { console.error("Socket hatası:", e); }
}

// ─── Marker ───────────────────────────────────────────────────────────────────
function createUserMarker(lat, lng, username, isMe=false) {
  const color = isMe ? "#3b82f6" : getColorForUser(username);
  const initial = username.charAt(0).toUpperCase();
  const html = `<div style="position:relative;width:44px;height:44px;display:flex;align-items:center;justify-content:center">
    <div style="position:absolute;width:44px;height:44px;border-radius:50%;background:${color}22;border:2px solid ${color}66;animation:ripple 1.6s ease-out infinite"></div>
    <div style="width:32px;height:32px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px;box-shadow:0 0 12px ${color}88;position:relative;z-index:2;border:2px solid #fff">${initial}</div>
  </div>`;
  return L.marker([lat,lng], {
    icon: L.divIcon({ html, className:"", iconSize:[44,44], iconAnchor:[22,22], popupAnchor:[0,-24] })
  }).addTo(map).bindPopup(`<b>${username}${isMe?" (Sen)":""}</b><br><small style="color:#94a3b8">${lat.toFixed(5)}, ${lng.toFixed(5)}</small>`);
}

function updateFriendMarker(username, lat, lng) {
  if (friendMarkers[username]) {
    animateMarker(friendMarkers[username], L.latLng(lat, lng));
  } else {
    friendMarkers[username] = createUserMarker(lat, lng, username, false);
    if (radarList.has(username)) renderRadarList();
  }
}

function removeFriendMarker(username) {
  if (friendMarkers[username]) { map.removeLayer(friendMarkers[username]); delete friendMarkers[username]; }
  renderRadarList();
}

function animateMarker(marker, newLL) {
  const s = marker.getLatLng(); let f = 0;
  const go = () => { f++; const t=f/20; marker.setLatLng([s.lat+(newLL.lat-s.lat)*t, s.lng+(newLL.lng-s.lng)*t]); if(f<20)requestAnimationFrame(go); };
  requestAnimationFrame(go);
}

// ─── Radar ────────────────────────────────────────────────────────────────────
function addFriend() {
  const input = document.getElementById("friend-input");
  const name = (input.value||"").trim();
  if (!name || name === myUsername) { shakeEl("friend-input"); return; }
  radarList.add(name);
  input.value = "";
  renderRadarList();
}

function renderRadarList() {
  const el = document.getElementById("friend-list");
  if (!radarList.size) {
    el.innerHTML = `<p style="color:#475569;font-size:12px;text-align:center;padding:12px 0">Henüz takip edilen yok.</p>`;
    return;
  }
  el.innerHTML = [...radarList].map(name => {
    const online = !!friendMarkers[name];
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:10px;background:${online?"rgba(30,58,138,0.3)":"rgba(30,40,60,0.5)"};margin-bottom:4px">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:7px;height:7px;border-radius:50%;background:${online?"#34d399":"#374151"}"></div>
        <span style="color:#e2e8f0;font-size:13px">${name}</span>
        <span style="color:#475569;font-size:11px">${online?"çevrimiçi":"çevrimdışı"}</span>
      </div>
      <div style="display:flex;gap:4px">
        ${online?`<button onclick="focusFriend('${name}')" style="background:none;border:none;color:#60a5fa;cursor:pointer;padding:2px 5px;font-size:13px">📍</button>`:""}
        <button onclick="removeFriend('${name}')" style="background:none;border:none;color:#f87171;cursor:pointer;padding:2px 5px;font-size:13px">✕</button>
      </div>
    </div>`;
  }).join("");
}

function removeFriend(name) { radarList.delete(name); renderRadarList(); }
function focusFriend(name) { if (friendMarkers[name]) map.setView(friendMarkers[name].getLatLng(), 17, {animate:true}); }

// ─── Yakınlık alarmı ──────────────────────────────────────────────────────────
function checkProximityAlarms() {
  if (!myLatLng) return;
  const threshold = parseInt(document.getElementById("alarm-distance")?.value||"500");
  let triggered=false, triggeredBy="";
  radarList.forEach(name => {
    const m = friendMarkers[name];
    if (m && myLatLng.distanceTo(m.getLatLng()) <= threshold) { triggered=true; triggeredBy=name; }
  });
  if (triggered && !alarmActive) {
    alarmActive = true;
    document.getElementById("alarm-text").textContent = `⚠️ ${triggeredBy} yakında!`;
    showEl("alarm-banner");
    playAlarmSound();
  } else if (!triggered && alarmActive) { dismissAlarm(); }
  checkCapture();
}

function dismissAlarm() { alarmActive=false; hideEl("alarm-banner"); }

function playAlarmSound() {
  if (!ALARM_AUDIO_CTX) return;
  try {
    const osc = ALARM_AUDIO_CTX.createOscillator();
    const gain = ALARM_AUDIO_CTX.createGain();
    osc.connect(gain); gain.connect(ALARM_AUDIO_CTX.destination);
    osc.type="sine"; osc.frequency.setValueAtTime(880, ALARM_AUDIO_CTX.currentTime);
    osc.frequency.setValueAtTime(660, ALARM_AUDIO_CTX.currentTime+0.15);
    gain.gain.setValueAtTime(0.3, ALARM_AUDIO_CTX.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ALARM_AUDIO_CTX.currentTime+0.5);
    osc.start(); osc.stop(ALARM_AUDIO_CTX.currentTime+0.5);
  } catch(e) {}
}

// ─── WhatsApp SOS ─────────────────────────────────────────────────────────────
function sendSOSWhatsApp() {
  if (!myLatLng) { showToast("Konum henüz alınamadı."); return; }
  const msg = encodeURIComponent(`🚨 ACİL - YolSinyali\n${myUsername} yardım istiyor!\n📍 https://maps.google.com?q=${myLatLng.lat},${myLatLng.lng}`);
  window.open(`https://wa.me/?text=${msg}`, "_blank");
}

// ─── Harita ───────────────────────────────────────────────────────────────────
function centerOnMe() {
  if (myLatLng) map.setView(myLatLng, 17, {animate:true});
  else showToast("Konum henüz alınamadı.");
}

function updateAlarmLabel() {
  const v = document.getElementById("alarm-distance")?.value||"500";
  document.getElementById("alarm-label").textContent = v>=1000?(v/1000).toFixed(1)+"km":v+" m";
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

// ─── Shake ────────────────────────────────────────────────────────────────────
function shakeEl(id) {
  const el = document.getElementById(id); if (!el) return;
  el.style.transition="transform .07s";
  [0,8,-8,8,-8,0].forEach((x,i)=>setTimeout(()=>el.style.transform=`translateX(${x}px)`,i*70));
  setTimeout(()=>el.style.transform="",500);
}
