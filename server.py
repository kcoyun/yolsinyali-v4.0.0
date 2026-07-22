"""
YolSinyali - Gerçek Zamanlı Konum Sunucusu
Flask + Flask-SocketIO | Render.com Python 3.14 uyumlu (threading modu)
"""

import os
import time
import uuid
import threading
from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, join_room

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "yolsinyali-secret-2024")

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",
    logger=False,
    engineio_logger=False,
    ping_timeout=60,
    ping_interval=25,
)

active_users_registry: dict = {}

# ─── Harita İşaretleri (Kaza / Çevirme / Yemek vb.) ───────────────────────────
# Herkese açık: arkadaş olsun olmasın tüm bağlı kullanıcılar canlı görür.
active_pins: dict = {}
VALID_PIN_CATEGORIES = {"kaza", "cevirme", "yemek", "trafik", "tehlike", "diger"}
MIN_PIN_DURATION_HOURS = 2
MAX_PIN_DURATION_HOURS = 24
DEFAULT_PIN_DURATION_HOURS = 6  # kullanıcı süre göndermezse


def _cleanup_expired_pins():
    now = time.time()
    expired = [pid for pid, p in active_pins.items() if now >= p["expires_at"]]
    for pid in expired:
        active_pins.pop(pid, None)
        socketio.emit("pin_removed", {"id": pid})

@app.route("/")
def serve_index():
    return send_from_directory(".", "index.html")

@app.route("/app.js")
def serve_app_js():
    return send_from_directory(".", "app.js")

@app.route("/ping")
def ping():
    return jsonify({"status": "alive", "active_users": len(active_users_registry), "timestamp": time.time()}), 200

@app.route("/api/location", methods=["POST"])
def update_location():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Geçersiz JSON"}), 400
    username  = (data.get("username") or "").strip()
    latitude  = data.get("latitude")
    longitude = data.get("longitude")
    if not username or latitude is None or longitude is None:
        return jsonify({"error": "username, latitude, longitude zorunlu"}), 400
    try:
        latitude  = float(latitude)
        longitude = float(longitude)
    except (ValueError, TypeError):
        return jsonify({"error": "Koordinat geçersiz"}), 400

    active_users_registry[username] = {
        "username": username, "latitude": latitude,
        "longitude": longitude, "last_seen": time.time(),
    }
    socketio.emit("friend_location_update", {
        "username": username, "latitude": latitude,
        "longitude": longitude, "timestamp": time.time(),
    })
    print(f"[LOC] {username}: {latitude:.5f}, {longitude:.5f}")
    return jsonify({"status": "ok", "active_users": len(active_users_registry)}), 200

@app.route("/api/location/stop", methods=["POST"])
def stop_location():
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
    stale = [u for u, d in active_users_registry.items() if d["last_seen"] < time.time() - 300]
    for u in stale:
        active_users_registry.pop(u, None)
        socketio.emit("friend_disconnected", {"username": u})
    return jsonify({"users": list(active_users_registry.values()), "count": len(active_users_registry)}), 200


@app.route("/api/pins", methods=["GET"])
def get_pins():
    _cleanup_expired_pins()
    return jsonify({"pins": list(active_pins.values())}), 200

@socketio.on("connect")
def on_connect():
    print(f"[WS] Bağlandı: {request.sid}")
    for user in active_users_registry.values():
        emit("friend_location_update", {
            "username": user["username"], "latitude": user["latitude"],
            "longitude": user["longitude"], "timestamp": user["last_seen"],
        })

@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    to_remove = next((u for u, d in active_users_registry.items() if d.get("sid") == sid), None)
    if to_remove:
        active_users_registry.pop(to_remove, None)
        socketio.emit("friend_disconnected", {"username": to_remove})

@socketio.on("join")
def on_join(data):
    username = (data.get("username") or "").strip() if data else ""
    if not username:
        return
    if username in active_users_registry:
        active_users_registry[username]["sid"] = request.sid
    join_room(username)
    emit("active_users_snapshot", {
        "users": [
            {"username": u, "latitude": d["latitude"], "longitude": d["longitude"]}
            for u, d in active_users_registry.items() if u != username
        ]
    })
    _cleanup_expired_pins()
    emit("pins_snapshot", {"pins": list(active_pins.values())})

@socketio.on("update_location")
def on_update_location(data):
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
        "username": username, "latitude": latitude,
        "longitude": longitude, "last_seen": time.time(), "sid": request.sid,
    }
    emit("friend_location_update", {
        "username": username, "latitude": latitude,
        "longitude": longitude, "timestamp": time.time(),
    }, broadcast=True, include_self=False)

@socketio.on("add_pin")
def on_add_pin(data):
    """Haritaya tıklanan yeri kategoriyle işaretler; HERKESE yayınlanır (arkadaş şartı yok)."""
    if not data:
        return
    category = (data.get("category") or "diger").strip().lower()
    if category not in VALID_PIN_CATEGORIES:
        category = "diger"
    latitude = data.get("latitude")
    longitude = data.get("longitude")
    username = (data.get("username") or "Anonim").strip() or "Anonim"
    if latitude is None or longitude is None:
        return
    try:
        latitude = float(latitude)
        longitude = float(longitude)
    except (ValueError, TypeError):
        return

    try:
        duration_hours = float(data.get("duration_hours", DEFAULT_PIN_DURATION_HOURS))
    except (ValueError, TypeError):
        duration_hours = DEFAULT_PIN_DURATION_HOURS
    # Kullanıcı ne gönderirse göndersin 2-24 saat aralığına sıkıştırılır
    duration_hours = max(MIN_PIN_DURATION_HOURS, min(MAX_PIN_DURATION_HOURS, duration_hours))

    _cleanup_expired_pins()

    now = time.time()
    pin_id = uuid.uuid4().hex[:10]
    pin = {
        "id": pin_id,
        "category": category,
        "latitude": latitude,
        "longitude": longitude,
        "username": username,
        "timestamp": now,
        "duration_hours": duration_hours,
        "expires_at": now + duration_hours * 3600,
    }
    active_pins[pin_id] = pin
    socketio.emit("pin_added", pin)
    print(f"[PIN] {username} → {category} @ {latitude:.5f},{longitude:.5f} ({duration_hours}sa)")


@socketio.on("remove_pin")
def on_remove_pin(data):
    """Sadece işareti ekleyen kullanıcı kaldırabilir."""
    if not data:
        return
    pin_id = data.get("id")
    username = (data.get("username") or "").strip()
    pin = active_pins.get(pin_id)
    if not pin:
        return
    if pin.get("username") != username:
        return
    active_pins.pop(pin_id, None)
    socketio.emit("pin_removed", {"id": pin_id})
    print(f"[PIN] {username} kaldırdı: {pin_id}")


def pin_expiry_worker():
    """Süresi dolan pinleri periyodik olarak temizler ve herkese 'pin_removed' yayınlar."""
    while True:
        time.sleep(60)
        try:
            _cleanup_expired_pins()
        except Exception as e:
            print(f"[PIN-CLEANUP] hata: {e}")


def keep_alive_worker():
    import urllib.request
    render_url = os.environ.get("RENDER_URL", "").rstrip("/")
    if not render_url:
        return
    print(f"[KEEP-ALIVE] Aktif → {render_url}/ping")
    while True:
        time.sleep(600)
        try:
            with urllib.request.urlopen(f"{render_url}/ping", timeout=10) as r:
                print(f"[KEEP-ALIVE] ping OK ({r.status})")
        except Exception as e:
            print(f"[KEEP-ALIVE] ping HATA: {e}")

_workers_started = False


def _start_background_workers():
    """Modül import edildiğinde (gunicorn dahil) arka plan işlerini bir kez başlatır."""
    global _workers_started
    if _workers_started:
        return
    _workers_started = True
    threading.Thread(target=keep_alive_worker, daemon=True).start()
    threading.Thread(target=pin_expiry_worker, daemon=True).start()


_start_background_workers()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"\n🚦 YolSinyali Sunucu → http://0.0.0.0:{port}\n")
    socketio.run(app, host="0.0.0.0", port=port, debug=False)
