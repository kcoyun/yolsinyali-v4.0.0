/**
 * YolSinyali — Harita & Socket.IO İstemci Mantığı
 * Leaflet.js + Socket.IO + AndroidBridge entegrasyonu
 */

// ─── Global State ─────────────────────────────────────────────────────────────
let map = null;
let socket = null;
let myUsername = "";
let serverUrl = "";
let myLatLng = null;
let myMarker = null;

// {username: {marker, ripple, latLng}}
const friendMarkers = {};

// Radar listesi: Set<string>
const radarList = new Set();

// Yakınlık alarmı
let alarmActive = false;
const ALARM_AUDIO_CTX = window.AudioContext ? new AudioContext() : null;

// ─── Başlangıç ────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  loadSavedSession();
});

function initMap() {
  map = L.map("map", {
    center: [39.9334, 32.8597], // Türkiye merkezi
    zoom: 6,
    zoomControl: true,
  });

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 19,
  }).addTo(map);
}

// ─── Oturum Yönetimi ──────────────────────────────────────────────────────────

function loadSavedSession() {
  const savedUsername = localStorage.getItem("ys_username");
  const savedServerUrl = localStorage.getItem("ys_server_url");

  if (savedUsername) {
    document.getElementById("login-username").value = savedUsername;
  }
  if (savedServerUrl) {
    document.getElementById("login-server-url").value = savedServerUrl;
  }

  // Eğer kayıtlı oturum varsa otomatik giriş
  if (savedUsername) {
    // Kısa gecikme sonrası otomatik başlat (haritanın yüklenmesi için)
    setTimeout(() => handleLogin(true), 300);
  }
}

function handleLogin(autoLogin = false) {
  const usernameInput = document.getElementById("login-username");
  const serverUrlInput = document.getElementById("login-server-url");

  const username = (usernameInput.value || "").trim();
  const url = (serverUrlInput.value || "").trim();

  if (!username) {
    shakeElement(usernameInput);
    usernameInput.focus();
    return;
  }

  myUsername = username;
  serverUrl = url || "";

  // LocalStorage'a kaydet
  localStorage.setItem("ys_username", username);
  if (url) localStorage.setItem("ys_server_url", url);

  // AndroidBridge entegrasyonu
  if (window.AndroidBridge) {
    try {
      if (url) {
        window.AndroidBridge.saveServerUrl(url);
      }
      window.AndroidBridge.saveUsernameAndStartTracking(username);
    } catch (e) {
      console.warn("AndroidBridge hatası:", e);
    }
  }

  // UI geçişi
  document.getElementById("login-screen").classList.add("hidden");
  const overlay = document.getElementById("ui-overlay");
  overlay.classList.add("visible");
  document.getElementById("topbar-username").textContent = username;

  // Socket.IO bağlantısı
  if (serverUrl) {
    connectSocket();
  }

  // Harita konumu al
  startGeolocationWatch();
}

function logout() {
  localStorage.removeItem("ys_username");
  localStorage.removeItem("ys_server_url");
  location.reload();
}

// ─── Geolocation ──────────────────────────────────────────────────────────────

function startGeolocationWatch() {
  if (!navigator.geolocation) {
    console.warn("Geolocation API desteklenmiyor.");
    return;
  }

  const options = {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 10000,
  };

  navigator.geolocation.watchPosition(onPositionUpdate, onPositionError, options);
}

function onPositionUpdate(pos) {
  const { latitude, longitude } = pos.coords;
  myLatLng = L.latLng(latitude, longitude);

  // Kendi marker'ını güncelle
  if (!myMarker) {
    myMarker = createUserMarker(latitude, longitude, myUsername, true);
    map.setView(myLatLng, 15);
  } else {
    myMarker.setLatLng(myLatLng);
  }

  // Socket.IO ile yayınla (tarayıcı üzerinden bağlanılıyorsa)
  if (socket && socket.connected) {
    socket.emit("update_location", {
      username: myUsername,
      latitude,
      longitude,
    });
  }

  // Radar kontrolü
  checkProximityAlarms();
}

function onPositionError(err) {
  console.warn("Geolocation hatası:", err.message);
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

  try {
    socket = io(serverUrl, {
      transports: ["websocket", "polling"],
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });

    socket.on("connect", () => {
      console.log("✅ Socket.IO bağlandı:", socket.id);
      socket.emit("join", { username: myUsername });
    });

    socket.on("disconnect", () => {
      console.log("❌ Socket.IO bağlantısı kesildi.");
      updateOnlineCount(0);
    });

    socket.on("friend_location_update", (data) => {
      if (data.username === myUsername) return;
      updateFriendMarker(data.username, data.latitude, data.longitude);
    });

    socket.on("friend_disconnected", (data) => {
      removeFriendMarker(data.username);
    });

    socket.on("active_users_snapshot", (data) => {
      (data.users || []).forEach((u) => {
        if (u.username !== myUsername) {
          updateFriendMarker(u.username, u.latitude, u.longitude);
        }
      });
      updateOnlineCount(data.users ? data.users.length : 0);
    });

  } catch (e) {
    console.error("Socket bağlantı hatası:", e);
  }
}

function updateOnlineCount(count) {
  const el = document.getElementById("online-count");
  if (el) el.textContent = `${count} kişi online`;
}

// ─── Marker Oluşturma ─────────────────────────────────────────────────────────

function createUserMarker(lat, lng, username, isMe = false) {
  const color = isMe ? "#3b82f6" : getColorForUser(username);
  const initial = username.charAt(0).toUpperCase();

  const iconHtml = `
    <div style="position:relative;width:44px;height:44px;display:flex;align-items:center;justify-content:center;">
      <div style="
        position:absolute;
        width:44px;height:44px;
        border-radius:50%;
        background:${color}22;
        border:2px solid ${color}66;
        animation:ripple 1.6s ease-out infinite;
      " class="radar-ripple"></div>
      <div class="pulse-dot" style="
        width:32px;height:32px;
        border-radius:50%;
        background:${color};
        display:flex;align-items:center;justify-content:center;
        color:white;font-weight:bold;font-size:14px;
        box-shadow:0 0 12px ${color}88;
        position:relative;z-index:2;
        border:2px solid white;
      ">${initial}</div>
    </div>
  `;

  const icon = L.divIcon({
    html: iconHtml,
    className: "",
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    popupAnchor: [0, -24],
  });

  const marker = L.marker([lat, lng], { icon })
    .addTo(map)
    .bindPopup(buildPopupContent(username, lat, lng, isMe));

  return marker;
}

function buildPopupContent(username, lat, lng, isMe) {
  const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
  const label = isMe ? `${username} (Sen)` : username;
  return `
    <div style="min-width:160px;">
      <div style="font-weight:bold;font-size:14px;margin-bottom:6px;">📍 ${label}</div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:8px;">
        ${lat.toFixed(5)}, ${lng.toFixed(5)}
      </div>
      <a href="${mapsUrl}" target="_blank"
        style="display:block;background:#3b82f6;color:#fff;text-align:center;padding:5px 10px;border-radius:8px;text-decoration:none;font-size:12px;font-weight:600;">
        Google Maps'te Aç
      </a>
    </div>
  `;
}

function updateFriendMarker(username, lat, lng) {
  if (friendMarkers[username]) {
    // Smooth animasyonlu geçiş
    animateMarker(friendMarkers[username].marker, L.latLng(lat, lng));
    friendMarkers[username].marker.setPopupContent(buildPopupContent(username, lat, lng, false));
    friendMarkers[username].latLng = L.latLng(lat, lng);
  } else {
    const marker = createUserMarker(lat, lng, username, false);
    friendMarkers[username] = { marker, latLng: L.latLng(lat, lng) };
    updateFriendListItem(username, lat, lng, true);
  }

  updateFriendListItem(username, lat, lng, false);
  checkProximityAlarms();
}

function removeFriendMarker(username) {
  if (friendMarkers[username]) {
    map.removeLayer(friendMarkers[username].marker);
    delete friendMarkers[username];
    updateFriendListItem(username, null, null, false, true);
  }
}

function animateMarker(marker, newLatLng) {
  const startLatLng = marker.getLatLng();
  const frames = 20;
  let frame = 0;

  const step = () => {
    frame++;
    const t = frame / frames;
    const lat = startLatLng.lat + (newLatLng.lat - startLatLng.lat) * t;
    const lng = startLatLng.lng + (newLatLng.lng - startLatLng.lng) * t;
    marker.setLatLng([lat, lng]);
    if (frame < frames) requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
}

// ─── Radar Listesi ────────────────────────────────────────────────────────────

function addFriend() {
  const input = document.getElementById("friend-input");
  const name = (input.value || "").trim();
  if (!name || name === myUsername) {
    shakeElement(input);
    return;
  }

  radarList.add(name);
  input.value = "";
  renderFriendList();
}

function removeFriend(name) {
  radarList.delete(name);
  renderFriendList();
}

function renderFriendList() {
  const container = document.getElementById("friend-list");
  const empty = document.getElementById("friend-list-empty");

  if (radarList.size === 0) {
    container.innerHTML = "";
    container.appendChild(empty);
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  container.innerHTML = "";

  radarList.forEach((name) => {
    const isOnline = !!friendMarkers[name];
    const item = document.createElement("div");
    item.className = `flex items-center justify-between p-2.5 rounded-xl ${isOnline ? "bg-blue-900/30" : "bg-slate-800/50"}`;
    item.innerHTML = `
      <div class="flex items-center gap-2">
        <div style="width:8px;height:8px;border-radius:50%;background:${isOnline ? "#34d399" : "#475569"}"></div>
        <span class="text-white text-xs font-medium">${name}</span>
        <span class="text-slate-500 text-xs">${isOnline ? "çevrimiçi" : "çevrimdışı"}</span>
      </div>
      <div class="flex gap-1">
        ${isOnline ? `<button onclick="focusFriend('${name}')" class="text-blue-400 hover:text-blue-300 text-xs px-2 py-1 rounded-lg hover:bg-blue-900/30 transition-colors">📍</button>` : ""}
        <button onclick="removeFriend('${name}')" class="text-red-400 hover:text-red-300 text-xs px-2 py-1 rounded-lg hover:bg-red-900/20 transition-colors">✕</button>
      </div>
    `;
    container.appendChild(item);
  });
}

function updateFriendListItem(username, lat, lng, isNew, isRemoved = false) {
  if (radarList.has(username)) {
    renderFriendList();
  }
}

function focusFriend(username) {
  const data = friendMarkers[username];
  if (data) {
    map.setView(data.latLng, 16, { animate: true });
    data.marker.openPopup();
  }
}

// ─── Yakınlık Alarmı ─────────────────────────────────────────────────────────

function checkProximityAlarms() {
  if (!myLatLng) return;
  const threshold = parseInt(document.getElementById("alarm-distance")?.value || "500");

  let triggered = false;
  let triggeredBy = "";

  radarList.forEach((name) => {
    const data = friendMarkers[name];
    if (!data) return;
    const dist = myLatLng.distanceTo(data.latLng);
    if (dist <= threshold) {
      triggered = true;
      triggeredBy = name;
    }
  });

  if (triggered && !alarmActive) {
    alarmActive = true;
    const banner = document.getElementById("alarm-banner");
    const text = document.getElementById("alarm-text");
    text.textContent = `⚠️ ${triggeredBy} yakında! (${threshold}m içinde)`;
    banner.classList.remove("hidden");
    playAlarmSound();
  } else if (!triggered && alarmActive) {
    dismissAlarm();
  }
}

function dismissAlarm() {
  alarmActive = false;
  document.getElementById("alarm-banner").classList.add("hidden");
}

function playAlarmSound() {
  if (!ALARM_AUDIO_CTX) return;
  try {
    const oscillator = ALARM_AUDIO_CTX.createOscillator();
    const gainNode = ALARM_AUDIO_CTX.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(ALARM_AUDIO_CTX.destination);
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, ALARM_AUDIO_CTX.currentTime);
    oscillator.frequency.setValueAtTime(660, ALARM_AUDIO_CTX.currentTime + 0.15);
    gainNode.gain.setValueAtTime(0.3, ALARM_AUDIO_CTX.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ALARM_AUDIO_CTX.currentTime + 0.5);
    oscillator.start(ALARM_AUDIO_CTX.currentTime);
    oscillator.stop(ALARM_AUDIO_CTX.currentTime + 0.5);
  } catch (e) {
    console.warn("Ses çalınamadı:", e);
  }
}

// ─── WhatsApp SOS ─────────────────────────────────────────────────────────────

function sendSOSWhatsApp() {
  if (!myLatLng) {
    alert("Konum henüz alınamadı. Lütfen bekleyin.");
    return;
  }

  const { lat, lng } = myLatLng;
  const mapsLink = `https://www.google.com/maps?q=${lat},${lng}`;
  const message = encodeURIComponent(
    `🚨 ACİL DURUM - YolSinyali\n\n` +
    `${myUsername} adlı kullanıcıdan acil yardım çağrısı!\n\n` +
    `📍 Konum: ${mapsLink}\n\n` +
    `Koordinatlar: ${lat.toFixed(5)}, ${lng.toFixed(5)}`
  );

  const waUrl = `https://wa.me/?text=${message}`;
  window.open(waUrl, "_blank");
}

// ─── Harita Kontrolleri ───────────────────────────────────────────────────────

function centerOnMe() {
  if (myLatLng) {
    map.setView(myLatLng, 16, { animate: true });
    if (myMarker) myMarker.openPopup();
  } else {
    alert("Konum henüz alınamadı.");
  }
}

function togglePanel(id) {
  const panel = document.getElementById(id);
  if (!panel) return;
  panel.classList.toggle("hidden");
}

function updateAlarmLabel() {
  const val = document.getElementById("alarm-distance")?.value || "500";
  const label = document.getElementById("alarm-label");
  if (label) {
    label.textContent = val >= 1000 ? `${(val / 1000).toFixed(1)} km` : `${val} m`;
  }
}

// ─── Yardımcı ─────────────────────────────────────────────────────────────────

function getColorForUser(username) {
  const colors = [
    "#ef4444", "#f97316", "#eab308", "#22c55e",
    "#14b8a6", "#8b5cf6", "#ec4899", "#06b6d4",
  ];
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function shakeElement(el) {
  el.style.transition = "transform 0.1s";
  const times = [0, 6, -6, 6, -6, 0];
  times.forEach((x, i) => {
    setTimeout(() => {
      el.style.transform = `translateX(${x}px)`;
    }, i * 60);
  });
  setTimeout(() => { el.style.transform = ""; }, 400);
}
