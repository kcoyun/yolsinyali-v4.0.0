"""
YolSinyali - Gerçek Zamanlı Konum Sunucusu
Flask + Flask-SocketIO | Render.com uyumlu

Kurulum:
    pip install -r requirements.txt
    python server.py
"""

import os
import time
import threading
from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, join_room

# ─── Uygulama ─────────────────────────────────────────────────────────────────

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "yolsinyali-gizli-anahtar-2024")

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="eventlet",
    logger=False,
    engineio_logger=False,
    ping_timeout=60,
    ping_interval=25,
)

# ─── Bellek İçi Kullanıcı Kaydı ──────────────────────────────────────────────
# { username: { latitude, longitude, last_seen, sid } }
active_users_registry: dict = {}

# ─── Statik Dosyalar ──────────────────────────────────────────────────────────

@app.route("/")
def serve_index():
    return send_from_directory(".", "index.html")

@app.route("/app.js")
def serve_app_js():
    return send_from_directory(".", "app.js")

# ─── Health Check (Render.com uyku önleyici) ──────────────────────────────────

@app.route("/ping")
def ping():
    """Render.com free tier uyku moduna girmemesi için health check."""
    return jsonify({
        "status": "alive",
        "active_users": len(active_users_registry),
        "timestamp": time.time()
    }), 200

# ─── REST API ─────────────────────────────────────────────────────────────────

@app.route("/api/location", methods=["POST"])
def update_location():
    """Android Foreground Service'den konum alır."""
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Geçersiz JSON"}), 400

    username = (data.get("username") or "").strip()
    latitude  = data.get("latitude")
    longitude = data.get("longitude")

    if not username or latitude is None or longitude is None:
        return jsonify({"error": "username, latitude, longitude zorunlu"}), 400

    try:
        latitude  = float(latitude)
        longitude = float(longitude)
    except (ValueError, TypeError):
        return jsonify({"error": "Koordinat geçersiz"}), 400

    # Kayıt güncelle
    active_users_registry[username] = {
        "username":  username,
        "latitude":  latitude,
        "longitude": longitude,
        "last_seen": time.time(),
    }

    # Tüm web istemcilerine yayınla
    socketio.emit("friend_location_update", {
        "username":  username,
        "latitude":  latitude,
        "longitude": longitude,
        "timestamp": time.time(),
    })

    print(f"[LOC] {username}: {latitude:.5f}, {longitude:.5f}")
    return jsonify({"status": "ok", "active_users": len(active_users_registry)}), 200


@app.route("/api/location/stop", methods=["POST"])
def stop_location():
    """Kullanıcı paylaşımı durdurduğunda çağrılır."""
    data = request.get_json(silent=True)
    username = (data.get("username") or "").strip() if data else ""

    if not username:
        return jsonify({"error": "username zorunlu"}), 400

    removed = active_users_registry.pop(username, None)
    if removed:
        socketio.emit("friend_disconnected", {"username": username})
        print(f"[STOP] {username} kaldırıldı.")
        return jsonify({"status": "removed"}), 200

    return jsonify({"status": "not_found"}), 404


@app.route("/api/users", methods=["GET"])
def get_active_users():
    """Aktif kullanıcı listesi (debug)."""
    # 5 dakika güncellenmeyen eski kayıtları temizle
    stale = [u for u, d in active_users_registry.items()
             if d["last_seen"] < time.time() - 300]
    for u in stale:
        active_users_registry.pop(u, None)
        socketio.emit("friend_disconnected", {"username": u})

    return jsonify({
        "users": list(active_users_registry.values()),
        "count": len(active_users_registry),
    }), 200

# ─── Socket.IO Olayları ───────────────────────────────────────────────────────

@socketio.on("connect")
def on_connect():
    print(f"[WS] Bağlandı: {request.sid}")
    # Yeni istemciye mevcut kullanıcıları gönder
    for user in active_users_registry.values():
        emit("friend_location_update", {
            "username":  user["username"],
            "latitude":  user["latitude"],
            "longitude": user["longitude"],
            "timestamp": user["last_seen"],
        })


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    to_remove = next(
        (u for u, d in active_users_registry.items() if d.get("sid") == sid),
        None
    )
    if to_remove:
        active_users_registry.pop(to_remove, None)
        socketio.emit("friend_disconnected", {"username": to_remove})
        print(f"[WS] {to_remove} bağlantı kopması ile kaldırıldı.")


@socketio.on("join")
def on_join(data):
    username = (data.get("username") or "").strip() if data else ""
    if not username:
        return
    if username in active_users_registry:
        active_users_registry[username]["sid"] = request.sid
    join_room(username)
    print(f"[WS] join: {username}")

    # Anlık snapshot gönder
    emit("active_users_snapshot", {
        "users": [
            {"username": u, "latitude": d["latitude"], "longitude": d["longitude"]}
            for u, d in active_users_registry.items()
            if u != username
        ]
    })


@socketio.on("update_location")
def on_update_location(data):
    """Tarayıcı üzerinden gelen konum (Foreground Service olmaksızın)."""
    if not data:
        return
    username  = (data.get("username") or "").strip()
    latitude  = data.get("latitude")
    longitude = data.get("longitude")
    if not username or latitude is None or longitude is None:
        return
    try:
        latitude  = float(latitude)
        longitude = float(longitude)
    except (ValueError, TypeError):
        return

    active_users_registry[username] = {
        "username":  username,
        "latitude":  latitude,
        "longitude": longitude,
        "last_seen": time.time(),
        "sid":       request.sid,
    }
    emit("friend_location_update", {
        "username":  username,
        "latitude":  latitude,
        "longitude": longitude,
        "timestamp": time.time(),
    }, broadcast=True, include_self=False)

# ─── Uyku Önleyici (Render free tier) ────────────────────────────────────────

def keep_alive_worker():
    """
    Render.com free tier 15 dakika isteksiz kalırsa uyku moduna girer.
    Bu thread kendi kendine /ping atar ve bunu engeller.
    Kendi URL'nizi RENDER_URL ortam değişkeniyle verin:
        RENDER_URL=https://yolsinyali.onrender.com
    """
    import urllib.request
    render_url = os.environ.get("RENDER_URL", "").rstrip("/")
    if not render_url:
        print("[KEEP-ALIVE] RENDER_URL tanımlı değil, keep-alive devre dışı.")
        return

    print(f"[KEEP-ALIVE] Aktif → her 10 dakikada {render_url}/ping")
    while True:
        time.sleep(600)  # 10 dakika
        try:
            with urllib.request.urlopen(f"{render_url}/ping", timeout=10) as r:
                print(f"[KEEP-ALIVE] ping OK ({r.status})")
        except Exception as e:
            print(f"[KEEP-ALIVE] ping HATA: {e}")

# ─── Başlangıç ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Keep-alive thread başlat
    t = threading.Thread(target=keep_alive_worker, daemon=True)
    t.start()

    port = int(os.environ.get("PORT", 5000))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"\n🚦 YolSinyali Sunucu → http://{host}:{port}\n")
    socketio.run(app, host=host, port=port, debug=False)
