# 🚦 YolSinyali — Gerçek Zamanlı Canlı Konum Takip Uygulaması

Farklı internet bağlantılarındaki kullanıcıların birbirini canlı harita üzerinde takip edebildiği hibrit Android uygulaması.

---

## 📁 Proje Yapısı

```
YolSinyali/
├── app/                          ← Android modülü
│   └── src/main/
│       ├── assets/               ← Web dosyaları (otomatik kopyalanır)
│       │   ├── index.html
│       │   └── app.js
│       ├── java/com/example/
│       │   ├── MainActivity.kt           ← Ana aktivite + WebView + AndroidBridge
│       │   └── LocationTrackingService.kt ← GPS Foreground Service
│       └── AndroidManifest.xml
├── index.html                    ← Harita arayüzü (kaynak)
├── app.js                        ← Harita mantığı (kaynak)
├── server.py                     ← Flask sunucu
├── requirements.txt              ← Python bağımlılıkları
├── render.yaml                   ← Render.com deploy yapılandırması
├── Procfile                      ← Sunucu başlatma komutu
├── gradle/libs.versions.toml     ← Bağımlılık sürümleri
├── settings.gradle.kts
├── build.gradle.kts
└── debug.keystore                ← Debug APK imzalama
```

---

## 🌐 ADIM 1 — Render.com'a Sunucu Deploy Et (ÜCRETSİZ)

### 1.1 GitHub'a Yükle
```bash
git init
git add .
git commit -m "YolSinyali ilk commit"
# GitHub'da yeni repo aç → push et
git remote add origin https://github.com/KULLANICI/yolsinyali.git
git push -u origin main
```

### 1.2 Render.com'da Servis Oluştur
1. https://render.com → "New +" → **Web Service**
2. GitHub repoyu bağla
3. Ayarlar:
   - **Name:** `yolsinyali`
   - **Runtime:** `Python`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn --worker-class eventlet -w 1 --bind 0.0.0.0:$PORT server:app`
   - **Instance Type:** `Free`
4. "Create Web Service" → Deploy başlar

### 1.3 URL'yi Al
Deploy tamamlanınca URL şu formatta olur:
```
https://yolsinyali.onrender.com
```

### 1.4 Keep-Alive Ayarla (Uyku Önleme)
Render.com → Environment → Add Environment Variable:
```
Key:   RENDER_URL
Value: https://yolsinyali.onrender.com
```
Bu sayede sunucu her 10 dakikada kendine ping atar ve uyumaz.

---

## 📱 ADIM 2 — Android APK Yap

### 2.1 Android Studio'da Aç
```
File → Open → yolsinyali_project klasörünü seç
```
Gradle sync otomatik başlar (~2-3 dk).

### 2.2 local.properties Oluştur
`local.properties.example` dosyasını kopyala:
```bash
cp local.properties.example local.properties
# İçindeki sdk.dir yolunu kendi Android SDK yolunla değiştir
```

### 2.3 APK Derle
```
Build → Build Bundle(s) / APK(s) → Build APK(s)
```
veya terminal:
```bash
./gradlew assembleDebug
```

### 2.4 APK Dosyası
```
app/build/outputs/apk/debug/app-debug.apk
```
Telefonuna AirDrop / WhatsApp / USB ile gönder ve yükle.

---

## 📖 ADIM 3 — Uygulamayı Kullan

1. Uygulamayı aç
2. **Kullanıcı Adı** gir
3. **Sunucu URL** kısmına Render.com adresini gir:
   ```
   https://yolsinyali.onrender.com
   ```
4. "Başla & Konumu Paylaş" butonuna bas
5. Konum izni istenir → **"Her zaman izin ver"** seç (arka plan için şart!)
6. Pil tasarrufu → **"Kısıtlama Yok / Sınırsız"** seç

Arkadaşın da aynı adımları yapıp aynı Sunucu URL'sini girerse haritada birbirinizi canlı görürsünüz.

---

## ⚙️ Teknik Mimari

```
[Android Telefon]                    [Render.com Sunucu]
 ┌─────────────────────┐              ┌──────────────────┐
 │ LocationTracking    │──POST /api───▶ Flask + SocketIO │
 │ Service (GPS)       │  location    │                  │
 │                     │              │ active_users     │
 │ WebView             │◀─SocketIO ──│ registry         │
 │ (Leaflet Harita)    │  broadcast   │                  │
 └─────────────────────┘              └──────────────────┘
         │                                    ▲
    AndroidBridge                             │
    (JS ↔ Native)                    [Diğer Telefonlar]
```

---

## 🔧 Sorun Giderme

| Sorun | Çözüm |
|-------|-------|
| Sunucu ilk açılışta yavaş | Render.com free tier ~30sn uyku sonrası uyandırma yapıyor, normal |
| Konum paylaşılmıyor | Konum izni "Her zaman" değil mi? Pil kısıtlaması var mı? |
| Haritada arkadaş görünmüyor | İkisi de aynı sunucu URL'sine bağlı mı? |
| APK yüklenmiyor | Bilinmeyen kaynaklardan yüklemeye izin ver (Ayarlar → Güvenlik) |
| Build hatası: compileSdk | Android SDK 35 yüklü mü? SDK Manager'dan indir |
