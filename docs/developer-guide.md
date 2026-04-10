# Smart Plant Pro — Developer Guide

This guide is for someone taking over the codebase. It covers the architecture, where things live, how they connect, and how to make common changes.

---

## Table of Contents

1. [Dev Environment Setup](#1-dev-environment-setup)
2. [Architecture Overview](#2-architecture-overview)
3. [Firmware Walkthrough](#3-firmware-walkthrough)
4. [Firebase Schema](#4-firebase-schema)
5. [Frontend Walkthrough](#5-frontend-walkthrough)
6. [Common Tasks (Recipes)](#6-common-tasks-recipes)
7. [Data Flow Diagrams](#7-data-flow-diagrams)
8. [Concurrency & Safety](#8-concurrency--safety)
9. [Deployment](#9-deployment)
10. [Gotchas & Pitfalls](#10-gotchas--pitfalls)
11. [Future Work](#11-future-work)

---

## 1. Dev Environment Setup

### Firmware

```bash
git clone <repository-url>
cd ESP32_PlantMonitor

# Install PlatformIO (VS Code extension or CLI)
# pip install platformio

# Optional: set up local Firebase credentials for development
cp src/secrets.h.example src/secrets.h
# Edit src/secrets.h with your Firebase API key, DB URL, email, password
```

Build and upload:
```bash
pio run -e esp32dev -t upload    # ESP32-D DevKit
pio run -e esp32-s3-zero -t upload  # ESP32-S3 Zero
pio device monitor -b 115200     # Serial monitor
```

### Frontend

```bash
cd frontend
cp .env.example .env.local
# Fill .env.local with Firebase web config from Firebase Console → Project Settings → Your Apps

npm install
npm run dev    # Starts at http://localhost:5173
```

Required `.env.local` variables:
```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_DATABASE_URL=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

---

## 2. Architecture Overview

### End-to-End Data Flow

```
Sensors (2s) → SensorState struct (mutex) → Firebase sync (3s) → RTDB → React onValue() → UI
```

1. **taskReadSensors** reads BME280/BMP280, soil ADC, LDR every 2 seconds
2. Stores readings in shared `SensorState` struct (protected by `gStateMutex`)
3. **taskFirebaseSync** acquires `gFirebaseMutex`, pushes JSON to `devices/{MAC}/readings` every 3 seconds
4. Firebase RTDB stores the data
5. React dashboard subscribes with `onValue()` listeners for real-time updates
6. UI renders sensor cards, gauges, charts

### Control Flow (App → Device)

```
Dashboard button → Firebase set() → RTDB control path → ESP32 polls (1s) → Execute action
```

The ESP32 polls `devices/{MAC}/control/*` paths every 1 second. This is intentional — Firebase streams caused FreeRTOS mutex crashes on the ESP32, so polling was chosen for reliability.

### Why FreeRTOS Tasks?

Three independent tasks run concurrently:
- **Sensor reads** (2s) don't block on network
- **Firebase sync** (3s) doesn't block sensor reads even during slow SSL handshakes
- **Pump control** (event-driven) responds to requests independently

Tasks are pinned to cores: sensor reading on Core 0, networking and pump on Core 1. This prevents the Core 0 idle task watchdog from firing during long SSL operations.

---

## 3. Firmware Walkthrough

Everything lives in **`src/main.cpp`** (~1150 lines). Here's the structure:

### Pin Configuration (lines 25–30)

```cpp
static constexpr uint8_t I2C_SDA_PIN      = 33;
static constexpr uint8_t I2C_SCL_PIN      = 32;
static constexpr uint8_t SOIL_SENSOR_PIN  = 34;
static constexpr uint8_t LIGHT_SENSOR_PIN = 35;
static constexpr uint8_t RELAY_PIN        = 25;
```

These are hardcoded for the ESP32-D. The ESP32-S3 Zero pins are noted in `platformio.ini` comments but the multi-board `#ifdef` infrastructure doesn't exist yet — pins would need to be changed manually or via build flags.

### Shared State (lines 81–95)

```cpp
struct SensorState {
  float    temperatureC;
  float    pressurePa;
  float    humidity;       // NAN when sensor is BMP280
  uint16_t soilRaw;
  bool     lightBright;
  bool     pumpRunning;
};

SensorState gState{};
SemaphoreHandle_t gStateMutex;
SemaphoreHandle_t gFirebaseMutex;
volatile bool gPumpRequest = false;
volatile int gPumpReason = 0;   // 0=manual, 1=schedule
```

### setup() (lines 170–482)

Initialization order:
1. **Relay OFF** — `digitalWrite(RELAY_PIN, HIGH)` — safety first
2. **Hardware init** — I2C, sensor detection (BME280 vs BMP280), ADC/GPIO setup
3. **WiFiManager** — Captive portal with custom branding, Firebase params behind PIN gate
4. **NVS Firebase load** — Read credentials from flash (or use compile-time defaults)
5. **NTP time sync** — Wait for real Unix timestamps
6. **Firebase init** — `Firebase.begin()`, wait for auth
7. **Create mutexes** — `gStateMutex`, `gFirebaseMutex`
8. **Launch FreeRTOS tasks** — Three tasks pinned to cores

### taskReadSensors (lines 650–718)

- Runs on **Core 0**, every **2 seconds**
- Reads BME280/BMP280 (temperature, pressure, humidity)
- Reads soil ADC and LDR digital pin
- Includes **fake BME280 clone detection**: if humidity reads 0/100/NaN for 5 consecutive readings, downgrades to BMP280 mode
- Validates sensor ranges (temp: -20–60°C, pressure: 80–110 kPa)
- Acquires `gStateMutex` (50ms timeout) and writes to `gState`

### taskFirebaseSync (lines 744–941)

- Runs on **Core 1**, loop runs every **1 second** (reset polling), full sync every **3 seconds**
- **Full sync (every 3s):**
  - Acquires `gFirebaseMutex`, pushes readings JSON to `devices/{MAC}/readings`
  - Updates `deviceList/{MAC}/lastSeen`
  - Writes alerts if health != OK
  - Updates diagnostics (uptime, sync counts, WiFi RSSI)
  - Pushes history snapshot every 60 cycles (~5 minutes)
  - Checks watering schedule every 12 cycles (~60 seconds)
- **Every cycle (1s):**
  - Polls `devices/{MAC}/control/resetProvisioning` — if true, clears WiFi and reboots
  - Polls `devices/{MAC}/control/pumpRequest` — if true, sets `gPumpRequest`
- **SSL fail detection:** After 15 consecutive SSL/connection failures, clears WiFi and restarts
- **Reset grace period:** Ignores stale `resetProvisioning` flags for 15 seconds after boot

### taskPumpControl (lines 1094–1146)

- Runs on **Core 1**, event-driven (waits for `gPumpRequest`)
- Fetches `targetSoil` from Firebase (default: 2800)
- **Pulse watering loop:**
  1. Check if soil ≤ target → stop
  2. Pump ON for 1s (`RELAY_PIN` LOW)
  3. Pump OFF for 5s (soak)
  4. Log watering event to `devices/{MAC}/waterLog/{epoch}`
  5. Repeat until target reached
- Clears `pumpRequest` in Firebase when done

### Helper Functions

| Function | Line | Purpose |
|----------|------|---------|
| `loadFirebaseFromNVSAndApply()` | 492 | Load Firebase creds from NVS or use defaults |
| `clearFirebaseNVS()` | 531 | Clear all Firebase creds from NVS |
| `initializeHardware()` | 542 | I2C init, sensor scan, ADC/GPIO setup |
| `printSensorDiagnostic()` | 600 | Boot diagnostic report |
| `healthStatus()` | 728 | Determine health string from sensor state |
| `fetchTargetSoil()` | 960 | Read target soil from Firebase |
| `fetchResetProvisioning()` | 974 | Check reset flag in Firebase |
| `fetchPumpRequest()` | 944 | Check pump request in Firebase |
| `taskScheduleCheck()` | 984 | Check if auto-watering should trigger |
| `updateScheduleAfterWater()` | 1058 | Update schedule state after watering |
| `writeWaterLog()` | 1080 | Log a watering event |
| `clearBadWiFiAndRestart()` | 154 | Erase WiFi credentials and reboot |
| `isBlockedSSID()` | 141 | Check if SSID is a blocked guest network |

---

## 4. Firebase Schema

Device identity is the WiFi MAC address (e.g., `3C:0F:02:DF:73:74`).

### Device Data (written by ESP32)

```
devices/{MAC}/
  readings/                    ← Updated every 3s by firmware
    temperature: number        (°C)
    pressure: number           (Pa)
    humidity: number           (%, BME280 only)
    soilRaw: number            (0–4095 ADC, higher = drier)
    lightBright: boolean       (true = bright)
    pumpRunning: boolean       (true = pump currently on)
    health: string             ("OK" | "Pump running, soil still dry" | "Overheat" | "High humidity")
    timestamp: number          (Unix epoch from NTP)
    wifiSSID: string
    wifiRSSI: number           (dBm, negative)

  diagnostics/                 ← Updated every 3s
    uptimeSec: number
    lastSyncAt: number         (Unix epoch)
    syncSuccessCount: number
    syncFailCount: number
    wifiRSSI: number

  history/{epoch}/             ← Compact snapshot every 5 min
    t: number                  (temperature)
    p: number                  (pressure)
    h: number                  (humidity)
    s: number                  (soil raw)
    l: number                  (1 = bright, 0 = dim)

  alerts/
    lastAlert/                 ← Written when health != OK
      timestamp: number
      type: "health"
      message: string

  waterLog/{epoch}/            ← One entry per watering pulse
    reason: "manual" | "schedule"
    durationMs: number
    soilBefore: number
    soilAfter: number
```

### Control Paths (written by dashboard, read by ESP32)

```
devices/{MAC}/
  control/
    pumpRequest: boolean       ← true = start watering
    targetSoil: number         ← ADC threshold for pump stop (default 2800)
    resetProvisioning: boolean ← true = clear WiFi and reboot
    schedule/
      enabled: boolean
      hour: number             (0–23)
      minute: number           (0–59)
      hysteresis: number       (default 200)
      maxSecondsPerDay: number (default 120)
      cooldownMinutes: number  (default 30)
      day: string              ("YYYY-MM-DD", tracks current day)
      todaySeconds: number     (cumulative seconds watered today)
      lastWateredAt: number    (Unix epoch)

  calibration/                 ← Set by dashboard calibration wizard
    boneDry: number            (ADC reading in dry air)
    submerged: number          (ADC reading in water)
```

### User Data (written by dashboard)

```
users/{uid}/
  devices/{MAC}/
    claimedAt: number
    meta/
      name: string             (e.g., "Kitchen Herbs")
      room: string             (e.g., "Kitchen")

  plantProfiles/{profileId}/
    name: string
    type: string
    createdAt: number
    soilMin: number            (optional)
    soilMax: number            (optional)
    tempMin: number            (optional)
    tempMax: number            (optional)
    humidityMin: number        (optional)
    humidityMax: number        (optional)
    lightPreference: "bright" | "dim" | "any"  (optional)

  devicePlant/{MAC}: profileId (links device to plant profile)

  invites/{key}/
    email: string
    at: number

deviceList/{MAC}/
  lastSeen: number             ← Updated by ESP32 every 3s
  claimedBy: uid               ← Set by dashboard on claim
```

---

## 5. Frontend Walkthrough

### File Map

```
frontend/src/
├── main.tsx                    # Entry point, renders App with AuthProvider + ThemeProvider
├── App.tsx                     # BrowserRouter, AnimatePresence, route definitions
├── types.ts                    # TypeScript types: Readings, PlantProfile, DeviceStatus, etc.
│
├── pages/
│   ├── LoginPage.tsx           # Email/password auth (sign in + sign up)
│   ├── ClaimDevicePage.tsx     # Enter MAC or discover devices, save to user's device list
│   ├── DashboardPage.tsx       # Main page: readings, gauges, charts, pump, schedule, profiles
│   └── OverviewPage.tsx        # Multi-device grid view
│
├── components/
│   ├── ProtectedRoute.tsx      # Auth guard + loading skeleton
│   ├── CircularGauge.tsx       # SVG soil moisture gauge
│   ├── HistoryChart.tsx        # Recharts line chart (6/12/24h tabs)
│   ├── CollapsibleSection.tsx  # Expandable section wrapper
│   ├── ConfirmDestructiveButton.tsx  # Two-click confirmation for dangerous actions
│   ├── BottomTabBar.tsx        # Mobile tab navigation
│   ├── SkeletonCard.tsx        # Loading placeholder
│   ├── dashboard/
│   │   ├── DeviceStatusBar.tsx # Live/delayed/offline status indicator
│   │   ├── StatusBanners.tsx   # Health alert banners
│   │   ├── PlantHero.tsx       # Plant profile header display
│   │   └── SensorGrid.tsx      # Temperature, pressure, humidity, light cards
│   ├── icons/                  # SVG icon components
│   └── ui/
│       ├── rotating-text.tsx   # Animated rotating text
│       └── ScrollStack.tsx     # Scroll-based stacking animation
│
├── context/
│   ├── AuthContext.tsx          # Firebase Auth provider (signIn, signUp, signOut, user state)
│   └── ThemeContext.tsx         # Light/dark mode provider (persists to localStorage)
│
├── lib/
│   ├── firebase.ts             # Firebase app init (getApp, getAuth, getDatabase)
│   └── motion.ts               # Framer Motion animation presets
│
├── utils/
│   ├── soil.ts                 # soilRawToGaugeCalibrated(), soilStatus(), soilStatusLabel()
│   ├── deviceStatus.ts         # getDeviceStatus() — live/delayed/offline from timestamp
│   ├── sanitize.ts             # sanitizeString(), sanitizeEmail(), sanitizeInt(), sanitizeNumber()
│   └── profileTips.ts          # Plant care tips by plant type
│
└── hooks/
    └── useRateLimit.ts         # Rate limiting hook (8s pump, 10s invites)
```

### Routing

Defined in `App.tsx`:

| Route | Component | Auth Required |
|-------|-----------|--------------|
| `/login` | `LoginPage` | No |
| `/claim` | `ClaimDevicePage` | Yes (ProtectedRoute) |
| `/` | `DashboardPage` | Yes (ProtectedRoute) |
| `/overview` | `OverviewPage` | Yes (ProtectedRoute) |

### How Firebase Listeners Work

In `DashboardPage.tsx`, Firebase real-time listeners are set up in `useEffect` hooks:

```typescript
// Example pattern used throughout DashboardPage
useEffect(() => {
  if (!selectedMac) return
  const dbRef = ref(firebaseDb, `devices/${selectedMac}/readings`)
  const unsub = onValue(dbRef, (snap) => {
    if (snap.exists()) setReadings(snap.val())
  })
  return unsub  // Cleanup on unmount or MAC change
}, [selectedMac])
```

Each listener subscribes to a specific RTDB path and updates React state on every change. Cleanup functions (`unsub`) are returned to prevent memory leaks when the component unmounts or the selected device changes.

### State Flow

`DashboardPage` is a large component (~1000 lines) that manages most of the app state. Key state variables:

- `myDevices` / `devicesMeta` — User's claimed device MACs and metadata
- `selectedMac` — Currently viewed device (persisted to localStorage)
- `readings` — Latest sensor readings from Firebase
- `calibration` — boneDry/submerged values for soil gauge
- `schedule` — Watering schedule config
- `profiles` / `linkedProfileId` — Plant profiles and device-profile link
- `diagnostics` — Uptime, sync counts, WiFi RSSI
- `waterLog` — Watering history entries
- `lastAlert` — Current health alert (if any)

---

## 6. Common Tasks (Recipes)

### Add a New Sensor Reading

**Firmware (`src/main.cpp`):**

1. Add hardware pin constant at the top (~line 25)
2. Add field to `SensorState` struct (~line 81)
3. Initialize and read the sensor in `taskReadSensors()` (~line 650)
4. Add the value to the JSON in `taskFirebaseSync()` (~line 784):
   ```cpp
   json.set("myNewSensor", s.myNewField);
   ```
5. Optionally add to history snapshot (~line 862)

**Frontend:**

1. Add the field to `Readings` type in `frontend/src/types.ts`
2. Display it in `DashboardPage.tsx` or create a new card component in `components/dashboard/`

### Add a New Dashboard Card

1. Create a component in `frontend/src/components/dashboard/` (follow `SensorGrid.tsx` pattern)
2. Import and render it in `DashboardPage.tsx`
3. The data is already in the `readings` state if it's being synced from the device

### Add a New Control Command (App → Device)

**Frontend:**

1. Add a button/form in `DashboardPage.tsx`
2. Write to Firebase:
   ```typescript
   import { ref, set } from 'firebase/database'
   import { firebaseDb } from '../lib/firebase'

   await set(ref(firebaseDb, `devices/${mac}/control/myCommand`), value)
   ```

**Firmware:**

1. Add a polling function (follow `fetchPumpRequest()` pattern, ~line 944):
   ```cpp
   bool fetchMyCommand() {
     String path = "devices/" + deviceId + "/control/myCommand";
     if (xSemaphoreTake(gFirebaseMutex, pdMS_TO_TICKS(500)) != pdTRUE) return false;
     bool ok = Firebase.RTDB.getBool(&fbClient, path.c_str());
     bool val = ok && fbClient.boolData();
     xSemaphoreGive(gFirebaseMutex);
     return val;
   }
   ```
2. Poll it in `taskFirebaseSync()` every cycle (~line 927)

### Change Sync Interval

In `src/main.cpp`, modify the constants at the top (~line 45):

```cpp
static constexpr uint32_t SENSOR_READ_INTERVAL_MS   = 2000;  // Sensor read rate
static constexpr uint32_t FIREBASE_SYNC_INTERVAL_MS = 3000;  // Firebase push rate
static constexpr uint32_t RESET_POLL_MS             = 1000;  // Control polling rate
```

The sync task runs every `RESET_POLL_MS` (1s) but only does a full Firebase push every `FIREBASE_SYNC_INTERVAL_MS / RESET_POLL_MS` cycles (every 3 cycles = 3s).

### Add a New Board/Pinout

> **Note:** Multi-board `#ifdef` conditional compilation does not exist yet. Pins are hardcoded.

Current approach:
1. Add a new PlatformIO environment in `platformio.ini` with a build flag
2. Add `#ifdef` blocks around pin constants in `main.cpp`:
   ```cpp
   #ifdef BOARD_MY_NEW_BOARD
   static constexpr uint8_t I2C_SDA_PIN = 21;
   // ... other pins
   #else
   static constexpr uint8_t I2C_SDA_PIN = 33;
   // ... ESP32-D defaults
   #endif
   ```
3. Add the board's pin table to the [User Manual](user-manual.md#2-hardware-assembly)

### Modify the WiFi Portal

The portal HTML/CSS/JS is inline in `setup()` (~lines 197–370 of `main.cpp`):
- **Branding/CSS** — The `customHead` string (~line 197)
- **Firebase PIN gate** — `WiFiManagerParameter p_fb_gate` (~line 281)
- **Landing page** — `landingHtml` string (~line 330)
- **Captive portal redirects** — Server route handlers (~line 349)

### Add a New Page/Route

1. Create `frontend/src/pages/MyPage.tsx`
2. Add route in `frontend/src/App.tsx`:
   ```tsx
   <Route
     path="/my-page"
     element={<ProtectedRoute><MyPage /></ProtectedRoute>}
   />
   ```
3. Add navigation link in the dashboard or `BottomTabBar.tsx`

---

## 7. Data Flow Diagrams

### Sensor → Firebase → Dashboard

```
taskReadSensors (Core 0, 2s)
  │
  │  reads BME280/BMP280, soil ADC, LDR
  │
  ▼
SensorState struct (gStateMutex)
  │
  │  copied by taskFirebaseSync
  │
  ▼
taskFirebaseSync (Core 1, 3s)
  │
  │  Firebase.RTDB.updateNode()
  │  (gFirebaseMutex)
  │
  ▼
Firebase RTDB: devices/{MAC}/readings
  │
  │  onValue() listener
  │
  ▼
React DashboardPage → setReadings() → UI render
```

### App → Device Control

```
User clicks "Water Now"
  │
  ▼
set(ref(db, 'devices/{MAC}/control/pumpRequest'), true)
  │
  ▼
Firebase RTDB: devices/{MAC}/control/pumpRequest = true
  │
  │  polled every 1s by taskFirebaseSync
  │
  ▼
gPumpRequest = true
  │
  │  detected by taskPumpControl
  │
  ▼
Pulse watering loop (1s ON, 5s soak, repeat)
  │
  │  when soil ≤ target
  │
  ▼
pumpRequest = false (in Firebase + gPumpRequest)
```

### Device Claiming

```
User enters MAC on /claim page
  │
  ▼
set(ref(db, 'users/{uid}/devices/{MAC}'), { claimedAt, meta })
  │
  ▼
DashboardPage: onValue('users/{uid}/devices') → myDevices list
  │
  ▼
Device dropdown populated → select device → subscribe to readings
```

---

## 8. Concurrency & Safety

### Two Mutexes

| Mutex | Protects | Used By | Timeout |
|-------|----------|---------|---------|
| `gStateMutex` | `SensorState gState` struct | taskReadSensors (write), taskFirebaseSync (read), taskPumpControl (read) | 50ms |
| `gFirebaseMutex` | `FirebaseData fbClient` | taskFirebaseSync (write), taskPumpControl (read/write for target soil, pump request) | 500ms–1000ms |

### Why They Exist

- **`gStateMutex`** — Without it, taskFirebaseSync could read a partially-written `SensorState` (e.g., temperature from one reading, soil from the next). The struct is small so the lock is held briefly.

- **`gFirebaseMutex`** — The Firebase client (`fbClient`) is not thread-safe. Concurrent SSL calls corrupt its internal state and crash. Every Firebase operation must acquire this mutex first.

### What Breaks Without Them

- **Without `gStateMutex`:** Torn reads — dashboard shows mismatched sensor values. Rare but possible.
- **Without `gFirebaseMutex`:** SSL crashes, Firebase client corruption, watchdog resets. This **will** crash within minutes.

### Timeout Values

- `gStateMutex`: **50ms** — Sensor reads are fast. If blocked for 50ms, something is wrong; skip this cycle.
- `gFirebaseMutex`: **500ms–1000ms** — SSL operations can take hundreds of milliseconds. Longer timeout prevents unnecessary skips, but cap at 1s to avoid watchdog.

### Watchdog Considerations

- taskReadSensors runs on **Core 0** — must not starve the Core 0 idle task (watchdog). Sensor reads are fast, so this isn't an issue.
- taskFirebaseSync and taskPumpControl run on **Core 1** — SSL operations can block for seconds. The `vTaskDelay()` calls between operations feed the watchdog.

---

## 9. Deployment

### Frontend (Vercel)

1. Push to GitHub (Vercel auto-deploys from the main branch)
2. In Vercel → Project → Settings:
   - **Root Directory:** `frontend`
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
3. Set environment variables: all `VITE_FIREBASE_*` keys
4. `frontend/vercel.json` handles SPA routing (rewrites all paths to `index.html`)

### Firmware

Upload via USB:
```bash
pio run -e esp32dev -t upload
```

**OTA (Over-the-Air):** The firmware includes ArduinoOTA code (`ArduinoOTA.begin()` in setup, `ArduinoOTA.handle()` in loop), but **it is currently non-functional**. The `huge_app.csv` partition table uses a single 3MB app slot with no OTA partition. To re-enable OTA:

1. Switch to a dual-app partition table (e.g., `default.csv` or `min_spiffs.csv`)
2. This reduces max firmware size to ~1.25MB
3. Uncomment `upload_protocol = espota` and `upload_port` in `platformio.ini`
4. The firmware may need to be trimmed to fit the smaller partition

---

## 10. Gotchas & Pitfalls

### Active-Low Relay
The relay module expects `LOW` = ON, `HIGH` = OFF. The firmware sets `HIGH` (OFF) immediately in `setup()` before any other initialization. If you change the relay pin or add a new relay, ensure this safety behavior is preserved.

### Fake BME280 Clone Detection
Cheap BME280 modules sometimes have a BMP280 die with a fake BME280 chip ID. The firmware checks the first 5 humidity readings — if all are 0%, 100%, or NaN, it downgrades to BMP280 mode. This means `humidity` will be `NAN` even though the chip reported `0x60`.

### SSL Failure Auto-Reset
After 15 consecutive SSL/connection failures, the firmware clears WiFi credentials and reboots into AP mode. This is intentional — it's usually caused by captive/guest networks that pass WiFi auth but block HTTPS. Be aware that network outages >45 seconds will trigger this.

### Stale Reset Flags
If the device crashes after the dashboard sets `resetProvisioning = true` but before the device clears the flag, the device would reset on every boot (infinite loop). The firmware has a 15-second grace period — it silently clears any stale flag found within 15s of boot without acting on it.

### Guest Network Blocking
The firmware blocks a hardcoded list of guest/captive network SSIDs (ubcvisitor, xfinitywifi, starbucks, etc.) in `BLOCKED_SSIDS[]` (~line 130). The WiFi portal's JavaScript also hides these from the scan list. To add/remove blocked networks, update both the C++ array and the JS array.

### NVS Namespace Keys
Firebase credentials are stored in NVS under namespace `"fb"` with keys:
- `apik` — API Key
- `url` — DB URL
- `em` — Email
- `pw` — Password

If you change these key names, existing devices will lose their stored credentials on the next firmware update.

### Rate Limiting
The frontend enforces rate limits:
- **8 seconds** between pump commands (`useRateLimit` hook)
- **10 seconds** between invite sends

There is no server-side rate limiting (Firebase rules are permissive). Production deployments should add Firebase Security Rules.

### Input Sanitization
All user inputs are sanitized via `frontend/src/utils/sanitize.ts`:
- `sanitizeString()` — Trims, length-limits strings
- `sanitizeEmail()` — Validates email format
- `sanitizeInt()` / `sanitizeNumber()` — Validates numeric inputs within bounds

---

## 11. Future Work

See [PLAN.md](../PLAN.md) for the full feature roadmap and implementation status.

Key items not yet implemented:
- **Per-device auth** (Phase 2) — Cloud Functions to create per-device Firebase tokens. Currently uses a shared user account.
- **Multi-slot** (Phase 7) — Multiple probes/relays per device for monitoring multiple plants from one ESP32.
- **Firebase Security Rules** — RTDB rules are permissive by default. Production needs rules restricting access by `auth.uid`.
- **Multi-board `#ifdef`** — Pin selection is hardcoded. Needs conditional compilation for different boards.
- **OTA re-enablement** — Requires switching to a dual-app partition table.

For credential handling guidelines, see [SECURITY.md](../SECURITY.md).
