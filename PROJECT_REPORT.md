# Smart Plant Pro — Full Project Report

> **Purpose of this document:** Provide complete context about the Smart Plant Pro project — architecture, tech stack, data flow, features, file structure, Firebase schema, and current state — so that any AI assistant or developer can immediately understand and continue work on it.

---

## 1. Project Overview

**Smart Plant Pro** is a full-stack IoT plant monitoring system. An ESP32 microcontroller reads environmental sensors (temperature, pressure, optional humidity, soil moisture, light) and pushes real-time data to Firebase Realtime Database every 3 seconds (first push immediate). A React web dashboard displays live readings, device status, historical charts, and allows remote control of a water pump — all synced through Firebase.

### High-level architecture

```
┌──────────────────┐       WiFi        ┌──────────────────────┐       HTTPS        ┌──────────────────────┐
│   ESP32 Device   │ ──────────────▶   │  Firebase RTDB       │ ◀──────────────▶   │  React Web Dashboard │
│  (Sensors+Pump)  │   Push JSON       │  (Cloud NoSQL DB)    │   onValue listener │  (Vercel hosted)     │
└──────────────────┘   every 3s*      └──────────────────────┘                    └──────────────────────┘
 * First push immediate; subsequent every 3 s
                                                │
                                       Firebase Auth (email/pass)
                                       Used by both ESP32 and web app
```

### Key principles
- **Free tier only** — No Cloud Functions, no paid services. Everything runs on Firebase Spark (free) plan.
- **Real-time** — 3-second sync interval; first push immediate; dashboard updates live via Firebase `onValue` listeners.
- **No hardcoded WiFi** — WiFiManager captive portal for first-time setup; credentials stored in ESP32 NVS flash.
- **FreeRTOS multitasking** — Three concurrent tasks on the ESP32's dual cores for sensors, Firebase sync, and pump control.

---

## 2. Tech Stack

### 2.1 Firmware (ESP32)

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **MCU** | ESP32 (dual-core Xtensa LX6, 240 MHz, 520 KB SRAM) | Runs FreeRTOS, reads sensors, controls pump |
| **Framework** | Arduino (via PlatformIO) | Hardware abstraction layer |
| **Build system** | PlatformIO | Dependency management, compilation, upload |
| **RTOS** | FreeRTOS (built into ESP-IDF/Arduino) | Task scheduling, mutexes, semaphores |
| **WiFi provisioning** | WiFiManager (tzapu v2.0.16) | Captive portal AP "SmartPlantPro" for first-time WiFi setup |
| **Cloud sync** | Firebase-ESP-Client (mobizt) | HTTPS JSON push to Firebase RTDB |
| **OTA updates** | ArduinoOTA | Over-the-air firmware upload via WiFi |
| **NVS storage** | Preferences library | Persists Firebase config, WiFi credentials in flash |
| **Time sync** | NTP (pool.ntp.org) | Accurate Unix epoch timestamps |

**Sensors:**
| Sensor | Pin | Type | What it measures |
|--------|-----|------|-----------------|
| BME280 or BMP280 | I2C (SDA=33, SCL=32) | Temp + Pressure (+ Humidity for BME280) | Auto-detected via chip ID (0x60=BME280, 0x58=BMP280); temp °C, pressure Pa |
| Capacitive soil probe | GPIO 34 (ADC) | Soil moisture | Raw ADC 0–4095 (lower = wetter) |
| LDR module | GPIO 35 (Digital) | Light | Bright (LOW) / Dim (HIGH) |
| Relay | GPIO 25 | Output (active LOW) | Controls water pump on/off |

**Sensor auto-detection:** On boot, firmware scans I2C 0x76/0x77, reads register 0xD0 (chip ID). BME280 (0x60) enables humidity; BMP280 (0x58) reads temp + pressure only. Fake BME280 clones that report invalid humidity are downgraded to BMP280.

### 2.2 Frontend (Web Dashboard)

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| **UI framework** | React | 19.2 | Component-based UI |
| **Language** | TypeScript | 5.9 | Type safety |
| **Bundler** | Vite | 7.3 | Fast dev server + production builds |
| **Styling** | Tailwind CSS | 3.4 | Utility-first CSS, dark mode (`darkMode: 'class'`), custom design tokens |
| **Animations** | Framer Motion | 12.34 | Smooth transitions, mount/unmount animations |
| **Charts** | Recharts | 3.7 | Line charts for historical sensor data |
| **Routing** | React Router DOM | 7.13 | SPA routing (Login, Dashboard, Claim Device, Overview) |
| **Backend** | Firebase Auth + Realtime Database | 12.9 | Authentication + real-time data sync |
| **Hosting** | Vercel | — | Auto-deploys from GitHub on push to `main` |
| **PWA** | vite-plugin-pwa | 1.2 | Service worker, manifest, installable app |
| **Theme** | ThemeContext | — | Light/dark mode toggle, persisted in localStorage |

### 2.3 Cloud / Backend

| Service | Plan | Purpose |
|---------|------|---------|
| Firebase Realtime Database | Spark (free) | Stores all device data, readings, profiles, alerts |
| Firebase Authentication | Free | Email/password auth for web users AND ESP32 device |
| Vercel | Hobby (free) | Hosts the React frontend, auto-deploys from GitHub |
| GitHub | Free | Source control, two remotes (personal + org) |

---

## 3. FreeRTOS Task Architecture

The ESP32 has two CPU cores. Tasks are pinned to specific cores to avoid blocking:

```
Core 0                              Core 1
┌─────────────────────┐            ┌─────────────────────┐
│ taskReadSensors     │            │ taskFirebaseSync    │
│ (every 2s)          │            │ (every 3s, 1st imm.) │
│ - Read BME/BMP280   │            │ - Update deviceList │
│ - Read soil ADC     │  shared    │ - Write alerts      │
│ - Read LDR          │◀─mutex──▶ │ - Push history (5m)  │
│ - Write gState      │           │
│ - Set gSensorReady  │            │ - Check reprovision │
└─────────────────────┘            ├─────────────────────┤
                                   │ taskPumpControl     │
                                   │ (event-driven)      │
                                   │ - Listen pumpRequest│
                                   │ - Pulse relay on/off│
                                   │ - Check target soil │
                                   └─────────────────────┘
```

### Synchronization
- **`gStateMutex`** — Protects the shared `SensorState` struct between sensor read and Firebase sync tasks.
- **`gFirebaseMutex`** — Serializes all Firebase API calls (sync, pump, alerts) to prevent concurrent HTTPS requests.
- **`gSensorReady`** — Volatile flag; Firebase sync waits until the first real sensor reading before pushing, preventing garbage default values (0°C, 0 soil) from reaching the dashboard.
- **`gPumpRequest`** — Set by Firebase stream callback when the user taps "Water now" in the dashboard.

### Data flow (sensor → dashboard)
1. `taskReadSensors` reads BME280/BMP280 (temp, pressure, humidity), soil ADC, LDR every 2 seconds → writes to `gState`
2. `taskFirebaseSync` reads `gState`; first push is immediate when sensor ready; then every 3 seconds → builds JSON → `Firebase.RTDB.updateNode()` to `devices/{MAC}/readings`
3. Firebase RTDB stores the JSON
4. React dashboard has `onValue(ref(firebaseDb, 'devices/{MAC}/readings'))` listener → state update → re-render

---

## 4. Firebase Realtime Database Schema

```
root/
├── deviceList/
│   └── {MAC}/
│       ├── lastSeen: 1738500000          // Unix epoch, updated every sync
│       └── claimedBy: "uid_abc123"       // UID of claiming user (or null)
│
├── devices/
│   └── {MAC}/
│       ├── readings/
│       │   ├── temperature: 24.8         // °C from BME280/BMP280
│       │   ├── pressure: 101325          // Pa (optional, from BME/BMP)
│       │   ├── humidity: 45.2            // % (optional, BME280 only)
│       │   ├── soilRaw: 2150             // ADC 0–4095
│       │   ├── lightBright: true         // LDR digital
│       │   ├── pumpRunning: false        // relay state
│       │   ├── health: "OK"             // "OK" | "Overheat" | "Pump running, soil still dry" | etc.
│       │   ├── timestamp: 1738500000     // Unix epoch (NTP)
│       │   ├── wifiSSID: "TELUS8180"     // connected network name
│       │   └── wifiRSSI: -35             // signal strength dBm
│       │
│       ├── control/
│       │   ├── targetSoil: 2800          // pump stops when soilRaw <= this
│       │   ├── pumpRequest: false        // true = user wants manual water pulse
│       │   └── resetProvisioning: false  // true = clear WiFi+NVS, reboot to AP
│       │
│       ├── calibration/
│       │   ├── boneDry: 3500             // user-marked dry reading
│       │   └── submerged: 1200           // user-marked wet reading
│       │
│       ├── alerts/
│       │   └── lastAlert/
│       │       ├── timestamp: 1738499500
│       │       ├── type: "health"
│       │       ├── message: "Overheat"
│       │       └── ackAt: 1738499600     // set when user dismisses
│       │
│       └── history/
│           └── {epoch}/                  // pushed every ~5 min (60 × 3s cycles)
│               ├── t: 24.8              // temperature
│               ├── s: 2150              // soilRaw
│               ├── p: 101325            // pressure (optional)
│               ├── h: 45.2              // humidity (optional)
│               └── l: 1                 // light (1=bright, 0=dim)
│
└── users/
    └── {uid}/
        ├── devices/
        │   └── {MAC}/
        │       └── claimedAt: 1738400000
        │
        ├── plantProfiles/
        │   └── {pushId}/
        │       ├── name: "Living Room Monstera"
        │       ├── type: "Monstera"
        │       └── createdAt: 1738400000
        │
        ├── devicePlant/
        │   └── {MAC}: "{pushId}"         // links a device to a plant profile
        │
        └── invites/
            └── {emailKey}/
                ├── email: "friend@example.com"
                └── at: 1738400000
```

---

## 5. File Structure

```
ESP32_PlantMonitor/
├── platformio.ini                    # PlatformIO config (ESP32, huge_app partition, libs)
├── src/
│   ├── main.cpp                      # All firmware: tasks, WiFiManager, Firebase, pump, captive portal
│   ├── firebase_defaults.h           # Hardcoded fallback Firebase creds; overridden by secrets.h if present
│   └── secrets.h                     # (gitignored) Project-specific Firebase creds
│
├── frontend/                         # React web app (Vercel root directory)
│   ├── package.json                  # Dependencies: react, firebase, recharts, framer-motion
│   ├── tailwind.config.js            # Design tokens: colors, fonts, shadows, animations
│   ├── index.html                    # Entry HTML (Google Fonts: Inter, Plus Jakarta Sans)
│   ├── src/
│   │   ├── main.tsx                  # React entry point, wraps App in AuthProvider
│   │   ├── App.tsx                   # Router: /login, /claim, /overview, / (dashboard); ThemeProvider wrap
│   │   ├── App.css                   # (empty, unused)
│   │   ├── index.css                 # Global styles, Tailwind layers, component classes
│   │   │
│   │   ├── lib/
│   │   │   ├── firebase.ts           # Firebase init from env vars (VITE_FIREBASE_*)
│   │   │   └── motion.ts             # Framer Motion variants (fadeSlideUp, spring, accordionContent)
│   │   │
│   │   ├── context/
│   │   │   ├── AuthContext.tsx        # React context: signIn, signUp, signOut, user state
│   │   │   └── ThemeContext.tsx       # Dark/light mode toggle, persisted in localStorage
│   │   │
│   │   ├── utils/
│   │   │   ├── soil.ts               # soilStatus, soilRawToGauge, soilRawToGaugeCalibrated
│   │   │   └── deviceStatus.ts      # getDeviceStatus(), STATUS_META, formatSecondsAgo (6-state machine)
│   │   │
│   │   ├── pages/
│   │   │   ├── LoginPage.tsx          # Email/pass login + signup, glassmorphism card
│   │   │   ├── ClaimDevicePage.tsx     # Discover devices (online/claimed/available), manual MAC entry
│   │   │   ├── DashboardPage.tsx      # Main dashboard: sensors, status, charts, pump, profiles, watering log, diagnostics
│   │   │   └── OverviewPage.tsx       # Overview / landing for logged-in users; links to dashboard, claim
│   │   │
│   │   └── components/
│   │       ├── ThemeToggleIcon.tsx      # Floating button (bottom-right) for light/dark mode; shown on all pages
│   │       ├── CircularGauge.tsx        # SVG circular gauge for soil moisture %
│   │       ├── CollapsibleSection.tsx  # Accordion-style expandable card (Target moisture, Calibration, etc.)
│   │       ├── HistoryChart.tsx        # Recharts line chart (temp, soil, pressure, humidity; 6/12/24h tabs)
│   │       ├── ProtectedRoute.tsx      # Auth guard + loading skeleton
│   │       ├── dashboard/               # Dashboard subcomponents
│   │       │   ├── DeviceStatusBar.tsx # Device selector, Reset WiFi, Live/Delayed/Offline badge
│   │       │   ├── PlantHero.tsx       # Plant name, type, health + inline live readings (temp, soil, pressure, light)
│   │       │   ├── SensorGrid.tsx      # Temp, Light, Soil gauge, Pressure, Humidity cards (dynamic)
│   │       │   └── StatusBanners.tsx   # Synced, WiFi connecting, Delayed, Offline banners
│   │       └── icons/                  # SVG icon components (Plant, Sun, Thermometer, etc.)
│   │
│   └── public/
│       └── plant-icon.svg             # Notification icon
│
├── PLAN.md                            # Master improvement plan with status tracking
├── TEST_AND_OVERVIEW.md               # Testing guide
├── PROJECT_REPORT.md                  # This file
└── .gitignore                         # Ignores .pio, node_modules, .DS_Store, .env files
```

---

## 6. Features (Complete List)

### 6.1 Firmware Features
| Feature | Description |
|---------|-------------|
| **BME280/BMP280 auto-detection** | Scans I2C 0x76/0x77; reads chip ID (0xD0); 0x60=BME280 (temp+pressure+humidity), 0x58=BMP280 (temp+pressure only). Boot diagnostic report printed. Fake BME280 clones with invalid humidity are downgraded to BMP280. |
| **WiFiManager provisioning** | First boot creates AP "SmartPlantPro"; user connects and sees landing page at `http://192.168.4.1/start` — Configure WiFi, Device info, Reset & reconnect. Captive portal handlers for Android, Apple, Windows, Firefox; `onNotFound` redirects to `/start`. |
| **Firebase credentials behind PIN** | WiFiManager portal shows only WiFi SSID/password by default; Firebase API key, DB URL, email, password hidden behind 4-digit PIN (1234) |
| **Branded portal** | Custom CSS injection: green brand bar, plant emoji, styled buttons/inputs matching the web app theme |
| **WiFi validation** | 3 connection retries with 15s timeout; on failure: keep AP active, redirect to config page, show "Connection failed. Please check your password." Loading state during connection attempt |
| **Firebase NVS storage** | API key, DB URL, email, password saved in ESP32 flash; survives reboots; cleared on re-provision |
| **NTP time sync** | Real Unix epoch timestamps (not uptime); syncs from pool.ntp.org on boot |
| **Sensor ready gate** | `gSensorReady` flag prevents pushing default/zero values before first real sensor read |
| **Health monitoring** | Computes health string: "OK", "Overheat" (>45°C), "Pump running, soil still dry", "Humidity high" (>95%) |
| **Alert writing** | Writes `lastAlert` to RTDB when health != OK |
| **History snapshots** | Pushes compact {t, s, p, h, l} JSON to `history/{epoch}` every ~5 minutes (60 × 5s cycles) |
| **WiFi info reporting** | Pushes `wifiSSID` and `wifiRSSI` with every sync for dashboard display |
| **Remote re-provisioning** | Polls `control/resetProvisioning` every 1s; clears flag in Firebase first; erases only WiFi credentials (Firebase NVS kept); reboots to AP mode. No grace period — reset runs within 1–2s of click. |
| **Pump control** | Stream listener for `pumpRequest`; pulse watering (1s on, 5s soak) until soil target reached |
| **Huge APP partition** | `huge_app.csv` (3 MB app slot) for flash headroom; USB upload default. OTA not supported without partition change |
| **OTA updates** | ArduinoOTA code present; OTA upload not viable with huge_app partition (single app slot) |

### 6.2 Frontend Features
| Feature | Description |
|---------|-------------|
| **Authentication** | Email/password sign-in and sign-up via Firebase Auth |
| **Device discovery** | Lists all devices from `deviceList/`; shows online/offline/claimed/available status |
| **Device claiming** | One-click claim from discovery list or manual MAC entry |
| **6-state device status** | Pure function `getDeviceStatus()`: Live, Delayed (12–30s), Offline (>30s), Syncing, WiFi_connected, No_data. No grace period — status updates as soon as new readings arrive after reset. |
| **Reset flow UX** | `resetRequestedAt` persisted in localStorage (5 min expiry); immediate UI transition to syncing state; phased reconnection guide; polling every 1s for faster detection |
| **Plant hero with live readings** | Plant name, type, health badge + inline quick stats: temp, soil raw, pressure (hPa), light — no scroll needed |
| **Real-time sensor cards** | Temperature, Light, Soil (circular gauge), Pressure, Humidity (if BME280) — dynamic cards based on available data |
| **Circular soil gauge** | SVG gauge with gradient color; supports user calibration |
| **Soil calibration** | "Mark as dry" / "Mark as wet" buttons; gauge recalculates % based on user's actual sensor range |
| **History chart** | Recharts line chart with temp, soil, pressure, humidity; 6h/12h/24h tabs; series toggle buttons; skeleton loading state |
| **Collapsible accordion sections** | Target moisture, Calibrate soil, Plant profiles, Invite user — expand/collapse with animated chevron; reduced clutter |
| **Target moisture slider** | Drag slider (0–4095) to set pump activation threshold; saved to RTDB |
| **Manual pump control** | "Water now" button with 8s cooldown; live pump status indicator |
| **Plant profiles** | Create/edit/delete named plant profiles; link to device |
| **Example plants dropdown** | Preset plants (Mint/2000, Sunflower/2400, Herb/2200, Succulent/1800, Tomato/2600) auto-set type + target moisture |
| **WiFi status display** | Shows connected SSID + RSSI when live; "Last WiFi: X" when stale/offline |
| **Offline detection** | Stale after 12s (amber), offline after 30s (red); sensor cards blur + "Data frozen" overlay |
| **Offline troubleshooting** | Banner with hints: "Check power", "Check WiFi range", "Try resetting WiFi" |
| **Alert display** | Shows last alert with timestamp and "Dismiss" button (writes `ackAt`) |
| **Browser notifications** | Toggle switch; uses Notification API when health drops (tab must be open) |
| **Pro tips** | Context-aware tips (e.g., temperature above 28°C) |
| **Invite users** | Copy app URL; add emails to invite list |
| **Design system** | Kombai-inspired: spring physics, Framer Motion variants, reduced whitespace, tighter card padding |
| **Loading skeleton** | Branded loading screen; history chart shimmer bars |
| **Responsive design** | Mobile-first; works on phones, tablets, desktops |

### 6.3 Design System
| Token | Value | Usage |
|-------|-------|-------|
| Primary (green) | `#3B7A57` (+ scale 50–900) | Buttons, badges, active states, soil chart line |
| Forest (dark green) | `#1B2F27` | Text, dark accents |
| Mint / Sage | `#EDF3EF`, sage-50–400 | Light green backgrounds |
| Terracotta (red) | `#DC4A4A` | Alerts, errors, offline states |
| Surface | `#FAFBFA` | Page background |
| Font: sans | Inter | Body text |
| Font: display | Plus Jakarta Sans | Headings, large numbers |
| Font: mono | JetBrains Mono | MAC addresses, code |
| Cards | Glassmorphism (blur + white/92 + subtle border); section-card 1rem padding, 1.25rem radius | All content cards |
| Sensor cards | .sensor-card with hover lift (shadow + border color) | Sensor grid items |
| Animations | Framer Motion spring presets (gentle, snappy), fadeSlideUp, accordionContent | Page transitions, accordion expand/collapse |

---

## 7. Data Flow Diagrams

### 7.1 First-time device setup
```
1. Power on ESP32 (no WiFi saved)
2. ESP32 starts WiFiManager AP: "SmartPlantPro"
3. User connects phone/laptop to "SmartPlantPro" WiFi
4. Captive portal opens at 192.168.4.1 (branded UI)
5. User selects home WiFi SSID, enters password
6. (Optional) User enters Firebase API key, DB URL, email, password
7. ESP32 saves to NVS, connects to WiFi
8. ESP32 syncs NTP time, initializes Firebase, starts 3 FreeRTOS tasks
9. Sensors begin reading; after first real read, Firebase sync starts pushing
```

### 7.2 Normal operation loop (every 3 seconds)
```
ESP32:
  taskReadSensors → read BMP280/soil/LDR → update gState (mutex)
  taskFirebaseSync → read gState (mutex) → build JSON → HTTPS PUT to Firebase RTDB
    → also: update deviceList/{MAC}/lastSeen
    → also: if health != OK → write alerts/lastAlert
    → also: every 60 cycles (~5 min) → push to history/{epoch}

Dashboard (React):
  onValue listener fires → setReadings(data) → React re-renders
  useEffect ticks nowSec every 2s → updates "last seen" counter + status detection
```

### 7.3 Remote WiFi reset
```
1. User clicks "Reset WiFi" in dashboard
2. Frontend writes: control/resetProvisioning = true
3. ESP32 taskFirebaseSync polls every 1s; detects flag within 1–2s
4. ESP32 clears flag in Firebase FIRST (prevents boot loop)
5. ESP32 clears only WiFi (Firebase NVS kept — user keeps same project)
6. WiFi.eraseAP() / esp_wifi_restore clears stored SSID/password
7. ESP32 reboots → enters AP mode ("SmartPlantPro")
8. User connects to AP, sees landing page at /start → Configure WiFi → selects network
9. ESP32 connects, resumes syncing with existing Firebase creds
10. Dashboard detects new readings → phased sync: idle → synced (sensor data arrives)
```

### 7.4 Manual pump control
```
1. User clicks "Water now" in dashboard
2. Frontend writes: control/pumpRequest = true
3. ESP32 Firebase stream callback sets gPumpRequest = true
4. taskPumpControl: relay ON (1s pulse) → relay OFF (5s soak) → check soil
5. If soilRaw <= targetSoil → clear pumpRequest, stop
6. If not → repeat pulse/soak cycle
7. Dashboard shows live pumpRunning state from readings
```

---

## 8. Environment & Configuration

### 8.1 Firmware (Firebase credentials)
`src/firebase_defaults.h` defines **hardcoded fallback** credentials (API key, DB URL, email, password). If `src/secrets.h` exists (gitignored), it overrides these via `#define`. This ensures auth works out-of-the-box and after WiFi reset (Firebase NVS kept).

For local/project-specific use, copy `src/secrets.h.example` to `src/secrets.h` and fill in your values. Never commit `secrets.h`.

**Important:** If credentials were previously exposed in git history, rotate the Firebase API key in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) and revoke/regenerate the user password in Firebase Auth.

### 8.2 Frontend (environment variables)
The React app reads from `frontend/.env.local` (not committed to git):
```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_DATABASE_URL=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```
These same values must be set in Vercel's Environment Variables for production builds.

### 8.3 PlatformIO (platformio.ini)
```ini
[env:esp32dev]
platform = espressif32
board = esp32dev
framework = arduino
board_build.partitions = huge_app.csv   ; 3 MB app slot, no OTA partition; USB upload default
monitor_speed = 115200
lib_deps = 
    adafruit/Adafruit Unified Sensor@^1.1.9
    adafruit/Adafruit BusIO@^1.14.5
    adafruit/Adafruit BMP280 Library@^2.6.6
    adafruit/Adafruit BME280 Library@^2.2.4
    https://github.com/mobizt/Firebase-ESP-Client.git
    tzapu/WiFiManager@^2.0.16
```

---

## 9. Timing Configuration

| Parameter | Value | Where |
|-----------|-------|-------|
| Sensor read interval | 2 seconds | `SENSOR_READ_INTERVAL_MS` in main.cpp |
| Firebase sync interval | 3 seconds | `FIREBASE_SYNC_INTERVAL_MS` in main.cpp |
| First push | Immediate (no delay) | `firstPushDone` in taskFirebaseSync |
| Reset flag poll | 1 second | `RESET_POLL_MS` in main.cpp |
| History snapshot interval | ~5 minutes (60 cycles × 3s) | `histCycles >= 60` in main.cpp |
| Frontend stale threshold | 12 seconds | `getDeviceStatus()` in deviceStatus.ts |
| Frontend offline threshold | 30 seconds | `getDeviceStatus()` in deviceStatus.ts |
| Reset grace period | None | Removed — status updates as soon as new readings arrive after reset |
| Frontend status tick | 2 seconds | `setInterval` in DashboardPage.tsx |
| Pump pulse duration | 1 second on | `PUMP_PULSE_MS` in main.cpp |
| Pump soak duration | 5 seconds off | `PUMP_SOAK_MS` in main.cpp |
| Pump cooldown (UI) | 8 seconds | `setTimeout` in DashboardPage.tsx |

---

## 10. Deployment

### GitHub
Two remotes configured:
- `origin` → `https://github.com/eswubc/ESP32_PlantMonitor.git` (organization)
- `personal` → `https://github.com/deepakroshant/ESP32_PlantMonitor.git` (personal, linked to Vercel)

Push to both: `git push personal main && git push origin main`

### Vercel
- Connected to `deepakroshant/ESP32_PlantMonitor`
- **Root directory:** `frontend`
- **Framework:** Vite
- **Build command:** `npm run build`
- **Output:** `dist`
- Auto-deploys on every push to `main`

### Firmware upload
- **USB:** `pio run --target upload` (or PlatformIO IDE button)
- **OTA (WiFi):** Set `upload_port = <device-IP>` and `upload_protocol = espota` in platformio.ini

---

## 11. Current State & Known Limitations

### What's done
All core features from PLAN.md implemented. Recent additions: BME280/BMP280 auto-detection, pressure/humidity in dashboard and chart, deterministic 6-state device status, collapsible accordion settings, inline live readings on plant card, WiFiManager PIN for Firebase creds, reset flow fixes (WiFi-only erase, no grace period, 1s poll), huge_app partition for flash headroom. **Captive portal** landing at `/start` with Configure WiFi, Device info, Reset & reconnect. **firebase_defaults.h** hardcoded fallbacks so auth works after reset. **Dark mode** (floating theme toggle bottom-right, persisted in localStorage). **PWA** (vite-plugin-pwa), **watering log** table, **device diagnostics** table. **3s sync** and **immediate first push**. Friendlier copy: "Waiting for first reading…", "Connecting" (pulsing) instead of "No Data".

### Flash usage (with huge_app partition)
- **Partition:** huge_app.csv — ~3 MB for app (vs ~1.25 MB default)
- **RAM:** Similar to before (~16–20%)
- **Flash:** Much more headroom; allows future features without partition changes

### Known limitations
1. **Flash (mitigated)** — huge_app partition provides ~3 MB; sufficient for current feature set. OTA updates disabled with this partition.
2. **Single Firebase user for device auth** — All ESP32 devices share one Firebase email/password. Proper per-device tokens would require Cloud Functions (paid).
3. **No push notifications when dashboard is closed** — Browser Notification API only works when the tab is open. True background push would need a Service Worker + FCM (which needs Cloud Functions for the server key).
4. **History data grows unbounded** — The `history/` node accumulates forever. A cleanup mechanism (e.g., client-side deletion of entries older than 7 days) should be added.
5. **No multi-device pump hardware** — Pump control assumes one relay per ESP32 board.
6. **Firebase RTDB rules** — Currently using relatively open rules for development; should be tightened for production.

---

## 12. How to Set Up From Scratch

### Prerequisites
- ESP32 dev board with BMP280, capacitive soil sensor, LDR, relay
- Node.js (18+), npm
- PlatformIO CLI or VS Code extension
- Firebase project (Spark/free plan)

### Steps
1. **Clone:** `git clone https://github.com/deepakroshant/ESP32_PlantMonitor.git`
2. **Firmware:** Open in PlatformIO; edit default Firebase credentials in `src/main.cpp` if needed; `pio run --target upload`
3. **First boot:** Connect to "SmartPlantPro" AP → enter WiFi + Firebase creds at 192.168.4.1
4. **Frontend:** `cd frontend && cp .env.example .env.local` → fill Firebase config → `npm install && npm run dev`
5. **Web login:** Sign up at the login page
6. **Claim device:** Go to "Add device" → device appears in list → click "Claim"
7. **Dashboard:** Live data appears within 5 seconds

---

## 13. Summary of Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Firebase RTDB over Firestore | Lower latency for real-time sensor data; simpler JSON structure; better ESP32 library support |
| FreeRTOS tasks over loop() | Prevents blocking (SSL handshakes block for 1-2s); sensor reads stay consistent regardless of network |
| Firebase sync on Core 1 | Keeps Core 0's idle task running to prevent watchdog timer resets during long SSL operations |
| WiFiManager over hardcoded WiFi | Users can change networks without reflashing; supports field deployment |
| NTP over millis() | Accurate timestamps that work across device reboots and match the frontend's Date.now() |
| Recharts over Chart.js | Better React integration, tree-shakeable, composable API |
| Tailwind over CSS modules | Faster iteration, consistent design tokens, responsive utilities built-in |
| Vercel over Firebase Hosting | Zero-config React deploys, automatic HTTPS, preview deployments on PR |
| 3s sync interval | Near-real-time feel; well within Firebase free tier limits; balances responsiveness with load |
| `gSensorReady` gate | Prevents dashboard from briefly showing 0°C / 0% when device first boots |

---

## 14. Future Improvements & More Functionality

Ideas to extend the project, organized by area:

### 14.1 Firmware
| Idea | Effort | Notes |
|------|--------|-------|
| **OTA firmware updates** | Medium | Switch partition back to dual-app; add UI trigger in dashboard to start OTA; serve firmware from Firebase Storage or simple HTTP server |
| **Multi-slot soil sensing** | High | Extra ADC pins + relays for multiple plants per device; needs hardware and schema changes |
| **Low-power sleep mode** | Medium | Deep sleep between syncs for battery operation; wake on timer or external interrupt |
| **Calibration flow on device** | Low | Simple button/LED sequence to mark dry/wet instead of only via dashboard |
| **Configurable sync interval** | Low | Store interval in NVS; user sets 3s / 5s / 10s via portal or dashboard |
| **Per-device Firebase auth** | High | Needs Cloud Functions to mint custom tokens; paid tier |

### 14.2 Frontend / UX
| Idea | Effort | Notes |
|------|--------|-------|
| **Multi-language (i18n)** | Medium | Add react-i18next or similar; extract strings |
| **Plant care tips** | Low | Show watering/sunlight hints per plant type from profile |
| **Export data (CSV/JSON)** | Low | Download history for a device as file |
| **Dashboard widgets / layout** | Medium | Drag-and-drop or preset layouts (compact vs. spaced) |
| **Notification scheduling** | Medium | "Notify me at 8am if soil is dry" — needs client-side scheduling or Cloud Functions |
| **Mobile app (React Native / Flutter)** | High | Same Firebase backend; native push notifications |

### 14.3 Data & Analytics
| Idea | Effort | Notes |
|------|--------|-------|
| **History cleanup** | Low | Client script or scheduled job to delete `history/{epoch}` older than 7 days |
| **Aggregated stats** | Medium | Daily min/max/avg for temp, soil; show "trend" badges |
| **Watering log** | Low | Log each pump activation with timestamp; show in history |
| **Plant growth journal** | Medium | Optional photo + note per plant profile; store in Firebase Storage |

### 14.4 Integrations
| Idea | Effort | Notes |
|------|--------|-------|
| **Webhook on alert** | Medium | Post to user-defined URL when health != OK; needs Cloud Functions or client-side fetch |
| **Home Assistant / MQTT** | High | Bridge Firebase → MQTT for smart home integration |
| **Google Home / Alexa** | High | Custom action for "water my plant" via voice |

### 14.5 Security & Scale
| Idea | Effort | Notes |
|------|--------|-------|
| **Tighten Firebase rules** | Low | Per-uid device access; validated structure |
| **Rate limiting** | Medium | Prevent abuse of pump/alert writes; Firebase rules or Cloud Functions |
| **Audit log** | Medium | Log claim, reset, pump actions for each device |

---

## 15. Changelog & Recent Updates (AI Handoff Context)

This section summarizes changes made during recent development so any AI assistant (ChatGPT, etc.) or new developer can understand the **current** state without re-reading the full history.

### Firmware
| Change | Before | After |
|--------|--------|-------|
| **Sync interval** | 5 s | 3 s |
| **First push** | Waited 5 s | Immediate when sensor ready |
| **Reset poll** | 5 s | 1 s (faster detection) |
| **Reset grace period** | 3 min, then 30 s | None — reset runs within 1–2 s of click |
| **What reset clears** | WiFi + Firebase NVS | WiFi only (Firebase NVS kept) |
| **Reset sequence** | Clear NVS, reboot | Clear flag in Firebase first → erase WiFi → reboot |
| **force_portal recovery** | Could cause boot loop | Removed; stale flag cleared on boot |
| **Firebase defaults** | Empty fallbacks | Hardcoded in `firebase_defaults.h`; `secrets.h` overrides |
| **Captive portal** | Generic config page | Landing at `/start`: Configure WiFi, Device info, Reset & reconnect |
| **Captive portal handlers** | Default | Extra handlers for Android, Apple, Windows, Firefox; `onNotFound` → `/start` |

### Frontend
| Change | Before | After |
|--------|--------|-------|
| **Dark mode** | Not implemented | Theme toggle (floating button, bottom-right), `ThemeContext`, persisted in localStorage |
| **Tailwind dark mode** | — | `darkMode: 'class'` in tailwind.config |
| **"No data" copy** | "This device has never sent readings" | "Waiting for first reading…" |
| **Connecting state** | "No Data" | "Connecting" with pulse animation |
| **Reset polling** | 5 s | 1 s |
| **Grace period logic** | 30 s ignored readings after reset | Removed — status updates immediately |
| **History chart** | Duplicate legend | Single legend, series toggles, clearer axis labels |
| **Tables** | Basic styling | Stronger headers, borders, dark-mode contrast (diagnostics, watering log) |
| **PWA** | — | vite-plugin-pwa, installable |
| **Overview page** | — | `/overview` for logged-in users |

### Known Issues / Edge Cases
- **Captive portal**: First connect may not auto-open on some devices (HTTPS/caching); user can manually open `http://192.168.4.1/start`.
- **Firebase stream**: Occasional "Stream begin failed: not connected" or SSL timeouts; push task still runs and data is sent.
- **Firebase credentials after reset**: With hardcoded defaults, user keeps same project; no need to re-enter Firebase in portal.

### Git Remotes
- `origin` → `eswubc/ESP32_PlantMonitor` (org)
- `personal` → `deepakroshant/ESP32_PlantMonitor` (user, Vercel)
- Push to `personal main` for Vercel deploys.

---

*Last updated: February 2026*
