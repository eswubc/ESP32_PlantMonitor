# Smart Plant Pro — Complete System Documentation

**Audience:** Someone with basic coding knowledge who needs to fully understand and own this project.
**Last updated:** March 2026

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Structure](#2-repository-structure)
3. [Firmware Deep-Dive](#3-firmware-deep-dive)
4. [Firebase Data Structure](#4-firebase-data-structure)
5. [Frontend Deep-Dive](#5-frontend-deep-dive)
6. [First-Time Setup Guide](#6-first-time-setup-guide)
7. [How to Make Common Changes](#7-how-to-make-common-changes)
8. [Known Issues and Quirks](#8-known-issues-and-quirks)

---

## 1. Project Overview

Smart Plant Pro is an IoT plant monitoring and automated watering system. A small ESP32-S3-based device sits near your plant, reads temperature, pressure, humidity, soil moisture, and ambient light every 2 seconds, then pushes readings to Firebase Realtime Database every 3 seconds. A React web app (hosted on Vercel, installable as a PWA) displays live sensor data, trends, and lets you trigger or schedule automatic watering.

### What it does

- Reads temperature, barometric pressure, and optionally humidity via a BME280 (or BMP280) sensor over I2C
- Reads ambient light in lux via a VEML7700 sensor over I2C
- Reads soil moisture via an analog capacitive sensor (ADC reading 0–4095; higher = drier)
- Monitors a float switch in the water reservoir to detect "tank empty"
- Controls a water pump via a MOSFET relay on GPIO10 (active-HIGH)
- Syncs all of the above to Firebase Realtime Database in near real-time
- Accepts pump commands and configuration from the web dashboard via Firebase
- Hosts a captive-portal WiFi setup page (no app, no serial cable needed after first flash)
- Provides OTA (over-the-air) firmware updates via ArduinoOTA over WiFi

### Tech Stack

| Layer | Technology |
|---|---|
| Hardware | ESP32-S3-Zero (Waveshare), 4 MB flash, 2 MB PSRAM |
| Firmware build | PlatformIO + Arduino framework |
| Sensors | Adafruit BME280 / BMP280 + VEML7700 libraries |
| WiFi provisioning | WiFiManager (tzapu) |
| OTA | ArduinoOTA |
| Cloud database | Firebase Realtime Database (RTDB) |
| Firmware Firebase client | mobizt/Firebase-ESP-Client |
| Frontend framework | React 19 + TypeScript |
| Frontend build tool | Vite 7 |
| Styling | Tailwind CSS 3 |
| Routing | React Router DOM 7 |
| Charts | Recharts (dashboard) + Chart.js (Excel export) |
| Animations | Framer Motion |
| Excel export | ExcelJS + date-fns + date-fns-tz |
| Frontend Firebase client | Firebase JS SDK v12 |
| Hosting | Vercel (auto-deploys from git push) |
| PWA | vite-plugin-pwa (Workbox) |

### High-Level Architecture

```
  ┌──────────────────────────────────────────────────────────┐
  │                      Physical Device                      │
  │                                                          │
  │  BME280/BMP280 ──I2C──┐                                  │
  │  VEML7700 ────I2C──┐   ├── ESP32-S3-Zero                 │
  │  Soil sensor ─ADC──┤   │   (3 FreeRTOS tasks)           │
  │  Float switch ─GPIO┤   │                                  │
  │  Pump relay ───GPIO┘   │                                  │
  │                        │                                  │
  └────────────────────────┼──────────────────────────────────┘
                           │  WiFi (HTTPS / TLS)
                           ▼
  ┌──────────────────────────────────────────────────────────┐
  │              Firebase Realtime Database                   │
  │                                                          │
  │  deviceList/{mac}/lastSeen, claimedBy                    │
  │  devices/{mac}/readings   ← firmware writes (3s)         │
  │  devices/{mac}/history    ← firmware writes (~60s)       │
  │  devices/{mac}/control    ← frontend writes              │
  │  devices/{mac}/waterLog   ← firmware writes              │
  │  devices/{mac}/diagnostics← firmware writes              │
  │  devices/{mac}/alerts     ← firmware writes              │
  │  users/{uid}/devices, plantProfiles, devicePlant         │
  └──────────────────────────────────────────────────────────┘
                           │  Firebase JS SDK (HTTPS)
                           ▼
  ┌──────────────────────────────────────────────────────────┐
  │              React + TypeScript Frontend                  │
  │              (Vercel, installable as PWA)                 │
  │                                                          │
  │  /login        ← Firebase Auth sign-in/sign-up           │
  │  /claim        ← link a device MAC to your account       │
  │  /             ← main dashboard with live readings       │
  │  /overview     ← multi-device overview (future)          │
  └──────────────────────────────────────────────────────────┘
```

---

## 2. Repository Structure

```
ESP32_PlantMonitor/
├── src/
│   ├── main.cpp               Entire firmware (all tasks, WiFiManager, Firebase)
│   ├── firebase_defaults.h    Compile-time fallback credentials (empty by default)
│   └── secrets.h              (gitignored) local override for credentials
├── frontend/
│   ├── src/
│   │   ├── App.tsx            Router definition, top-level layout
│   │   ├── main.tsx           React entry point, AuthProvider + ThemeProvider wrapping
│   │   ├── types.ts           Shared TypeScript types (Readings, PlantProfile, etc.)
│   │   ├── pages/
│   │   │   ├── LoginPage.tsx        Email/password sign-in and sign-up
│   │   │   ├── DashboardPage.tsx    Main dashboard — all Firebase listeners, pump control
│   │   │   ├── ClaimDevicePage.tsx  Claim a device MAC to your user account
│   │   │   └── OverviewPage.tsx     Multi-device summary (future/experimental)
│   │   ├── components/
│   │   │   ├── HistoryChart.tsx     Recharts line chart, limitToLast(288) from Firebase
│   │   │   ├── ProtectedRoute.tsx   Redirects unauthenticated users to /login
│   │   │   ├── dashboard/
│   │   │   │   ├── SensorGrid.tsx   Grid of sensor value cards (temp, humidity, soil, etc.)
│   │   │   │   ├── PlantHero.tsx    Plant name/profile hero section
│   │   │   │   ├── DeviceStatusBar.tsx  Online/offline/delayed status pill
│   │   │   │   ├── StatusBanners.tsx    Alert banners (tank empty, overheating, etc.)
│   │   │   │   └── ExportModal.tsx  Date-range picker, triggers exportExcel
│   │   │   └── ui/
│   │   │       ├── ScrollStack.tsx  Stacked-card scroll animation
│   │   │       └── rotating-text.tsx Animated rotating label
│   │   ├── context/
│   │   │   ├── AuthContext.tsx    Firebase Auth state, signIn/signUp/signOut
│   │   │   └── ThemeContext.tsx   Dark/light theme persistence via localStorage
│   │   ├── hooks/
│   │   │   └── useRateLimit.ts   Prevents rapid button presses (pump, invite, claim)
│   │   ├── lib/
│   │   │   ├── firebase.ts       Firebase app init, exports firebaseAuth + firebaseDb
│   │   │   └── motion.ts         Shared Framer Motion animation variants
│   │   └── utils/
│   │       ├── exportExcel.ts    ExcelJS workbook builder (2 sheets + Chart.js charts)
│   │       ├── soil.ts           Soil raw ADC → moisture status, calibrated gauge %
│   │       ├── profileTips.ts    Per-plant-profile care tips
│   │       ├── deviceStatus.ts   last-seen timestamp → DeviceStatus enum
│   │       └── sanitize.ts       Input sanitization (MAC, email, int, string)
│   ├── public/
│   │   └── plant-icon.svg        App icon for PWA manifest
│   ├── index.html               Vite HTML entry
│   ├── vite.config.ts           Vite + PWA plugin configuration
│   ├── package.json             npm dependencies
│   └── .env.local               (gitignored) VITE_FIREBASE_* environment variables
├── docs/
│   └── SYSTEM.md                This file
├── partitions/
│   └── huge_app.csv             3 MB single-slot partition table (used by PlatformIO)
├── platformio.ini               PlatformIO build configuration
├── database.rules.json          Firebase RTDB security rules source
├── firebase.json                Firebase CLI configuration
└── package.json                 Root-level (minimal, for Firebase CLI tooling)
```

### Key file purposes at a glance

| File | What it does |
|---|---|
| `src/main.cpp` | Everything the ESP32 does. There are no other C++ source files. |
| `src/firebase_defaults.h` | Provides empty `#define` fallbacks for Firebase credentials. Real values come from NVS (WiFiManager portal) or a local `secrets.h`. |
| `platformio.ini` | Specifies the board (`lilygo-t3-s3`), partition table (`huge_app.csv`), libraries, and build flags. |
| `database.rules.json` | The security rules deployed to Firebase. Deploy with `firebase deploy --only database`. |
| `frontend/src/lib/firebase.ts` | Reads `VITE_FIREBASE_*` env vars, throws at startup if any required ones are missing. |
| `frontend/src/types.ts` | The single source of truth for TypeScript types shared across the frontend. |

---

## 3. Firmware Deep-Dive

All firmware lives in `src/main.cpp`. The file is approximately 1,230 lines.

### Pin Constants

Defined as `static constexpr uint8_t` near the top of the file:

| Constant | GPIO | Connected to |
|---|---|---|
| `I2C_SDA_PIN` | 5 | SDA line — BME280/BMP280 and VEML7700 |
| `I2C_SCL_PIN` | 9 | SCL line — BME280/BMP280 and VEML7700 |
| `SOIL_SENSOR_PIN` | 12 | Capacitive soil moisture sensor output (ADC2 channel 11) |
| `TANK_SENSOR_PIN` | 11 | Float switch (INPUT_PULLUP; LOW = float down = tank empty) |
| `RELAY_PIN` | 10 | MOSFET gate for water pump (active-HIGH: HIGH = pump ON) |

**I2C bus:** Wire.begin is called with SDA=5 SCL=9 at 100 kHz. Both the Bosch pressure sensor and the VEML7700 light sensor share this bus.

**Soil sensor (GPIO12 / ADC2):** This is an ADC2 pin, which is shared with the WiFi radio on the ESP32. See section 8 for the known limitation. The reading is `analogRead(12)`, which returns 0–4095 (12-bit). A higher value means the soil is drier (less capacitance).

**Float switch (GPIO11):** Configured as `INPUT_PULLUP`. When the float is up (water present), the pin reads HIGH. When the float is down (tank empty), it shorts to GND and reads LOW. The firmware sets `tankEmpty = (digitalRead(TANK_SENSOR_PIN) == LOW)`.

**Pump relay (GPIO10):** Set as OUTPUT. `digitalWrite(10, HIGH)` turns the pump ON. `digitalWrite(10, LOW)` turns it OFF. The MOSFET gate is driven directly from the GPIO.

### Timing Constants

| Constant | Value | Meaning |
|---|---|---|
| `SENSOR_READ_INTERVAL_MS` | 2000 ms | How often `taskReadSensors` reads all sensors |
| `FIREBASE_SYNC_INTERVAL_MS` | 3000 ms | How often `taskFirebaseSync` pushes to RTDB |
| `RESET_POLL_MS` | 1000 ms | Inner loop rate for `taskFirebaseSync` (also controls reset check speed) |
| `PUMP_PULSE_MS` | 1000 ms | Pump ON duration per pulse |
| `PUMP_SOAK_MS` | 5000 ms | Soak pause between pulses |
| `PUMP_IDLE_MS` | 500 ms | Polling interval when no pump request is active |

### SensorState Struct

```cpp
struct SensorState {
  float    temperatureC;   // Degrees Celsius from BME280/BMP280; NAN if read fails
  float    pressurePa;     // Pascals from BME280/BMP280; NAN if read fails
  float    humidity;       // Percent relative humidity from BME280; NAN if BMP280 or read fails
  uint16_t soilRaw;        // ADC reading 0–4095; higher = drier soil
  float    lux;            // Ambient light in lux from VEML7700; NAN if read fails
  bool     tankEmpty;      // true = float switch LOW = tank needs refill
  bool     pumpRunning;    // true = RELAY_PIN is HIGH = pump is physically on
};
```

One global instance `gState` is shared between the three tasks. All access to `gState` must be protected by `gStateMutex`.

### Global Variables of Interest

| Variable | Type | Purpose |
|---|---|---|
| `gState` | `SensorState` | Latest sensor readings, updated by `taskReadSensors` |
| `gStateMutex` | `SemaphoreHandle_t` | Binary semaphore protecting `gState` |
| `gFirebaseMutex` | `SemaphoreHandle_t` | Binary semaphore serializing all Firebase RTDB calls |
| `gPumpRequest` | `volatile bool` | Set to `true` to request pump activation |
| `gPumpReason` | `volatile int` | 0 = manual (dashboard button), 1 = schedule |
| `gSensorReady` | `volatile bool` | Set to `true` once `taskReadSensors` completes its first read |
| `deviceId` | `String` | WiFi MAC address, e.g. `"24:6F:28:AA:BB:CC"` — used as the device key in Firebase |

### FreeRTOS Task Architecture

The firmware creates three tasks in `setup()`. The `loop()` function only calls `ArduinoOTA.handle()`.

#### taskReadSensors

```
xTaskCreatePinnedToCore(taskReadSensors, "taskReadSensors", 4096, nullptr, 1, nullptr, 0)
```

| Property | Value |
|---|---|
| Core | 0 |
| Stack size | 4096 bytes |
| Priority | 1 |
| Period | 2000 ms (`SENSOR_READ_INTERVAL_MS`) |

**What it does:**

1. Reads temperature and pressure from BME280 or BMP280 (whichever was detected at boot). If BME280, also reads humidity.
2. Fake BME280 clone detection: over the first 5 readings, if humidity is always NaN, 0, or 100, the task demotes `gSensorType` to `SENSOR_BMP280` and reinitializes the BMP280 library.
3. Validates readings against sanity ranges: temperature -20 to 60 °C, pressure 80000 to 110000 Pa, humidity 0 to 100 %. Out-of-range values emit a serial warning at most once every 30 seconds.
4. Calls `analogRead(SOIL_SENSOR_PIN)` to get a 12-bit ADC reading.
5. Calls `veml.readLux()` to get ambient light. Returns NaN on error.
6. Reads `digitalRead(TANK_SENSOR_PIN)`: LOW = tank empty.
7. Reads `digitalRead(RELAY_PIN)`: HIGH = pump is on.
8. Takes `gStateMutex` (50 ms timeout), copies the local struct into `gState`, sets `gSensorReady = true`, gives the semaphore.
9. Delays for `SENSOR_READ_INTERVAL_MS`.

#### taskFirebaseSync

```
xTaskCreatePinnedToCore(taskFirebaseSync, "taskFirebaseSync", 8192, nullptr, 1, nullptr, 1)
```

| Property | Value |
|---|---|
| Core | 1 |
| Stack size | 8192 bytes |
| Priority | 1 |
| Inner loop rate | 1000 ms (`RESET_POLL_MS`) |
| Full sync every | 3rd cycle (every ~3 s, matching `FIREBASE_SYNC_INTERVAL_MS`) |

**What it does:**

The task starts by waiting for `gSensorReady`. Once ready, it enters a loop that ticks every 1 second.

Every tick: checks the reset-provisioning flag (see below). Polls `pumpRequest` from Firebase. Handles the SSL-fail streak counter.

Every 3rd tick (full sync): takes `gFirebaseMutex` (500 ms timeout) and does the following:

1. Snapshots `gState` under `gStateMutex`.
2. Builds a `FirebaseJson` object with all sensor fields and calls `Firebase.RTDB.updateNode` to write to `devices/{mac}/readings`. The exact fields written are:
   - `temperature` (float, omitted if NaN)
   - `pressure` (float, omitted if NaN)
   - `humidity` (float, omitted if NaN)
   - `soilRaw` (uint16)
   - `lux` (float, omitted if NaN)
   - `tk` (int: 1 = empty, 0 = full)
   - `pumpRunning` (bool)
   - `health` (string: result of `healthStatus()`)
   - `timestamp` (int: Unix epoch from `time()`)
   - `wifiSSID` (string)
   - `wifiRSSI` (int, dBm)
3. Updates `deviceList/{mac}/lastSeen` with the current epoch.
4. If `healthStatus()` is not "OK", writes `devices/{mac}/alerts/lastAlert` with `timestamp`, `type="health"`, and the health message string.
5. Every 12 full-sync cycles (~60 seconds): calls `taskScheduleCheck()` to evaluate the auto-water schedule.
6. Updates `devices/{mac}/diagnostics` with `uptimeSec`, `lastSyncAt`, `syncSuccessCount`, `syncFailCount`, `wifiRSSI`.
7. Every 12 full-sync cycles (~60 seconds): writes a compact history snapshot to `devices/{mac}/history/{epoch}` with fields `t`, `p`, `h`, `s`, `l`, `pu`, `tk`.

**History write cycle:** The inner cycle counter `histCycles` increments every full sync (every ~3 s). When it reaches 12 it resets. So history is written every 12 × 3 s = 36 s. The comment in the code says "~1 min (12 cycles × 5 s)" — this reflects a previous sync interval; with `FIREBASE_SYNC_INTERVAL_MS = 3000` the actual interval is closer to 36 seconds.

**`healthStatus()` logic:**
- If `pumpRunning` is true and `soilRaw > 3000`: returns "Pump running, soil still dry"
- If `temperatureC > 45.0`: returns "Overheat"
- If `humidity > 95.0`: returns "High humidity"
- Otherwise: returns "OK"

**SSL fail streak:** A counter `sslFailStreak` increments when Firebase is not ready or a sync fails with an SSL/connection error. When it reaches 15 (`SSL_FAIL_THRESHOLD`), the firmware calls `clearBadWiFiAndRestart()` to erase WiFi credentials and restart, forcing re-provisioning. This guards against captive-portal networks that block HTTPS.

#### taskPumpControl

```
xTaskCreatePinnedToCore(taskPumpControl, "taskPumpControl", 4096, nullptr, 1, nullptr, 1)
```

| Property | Value |
|---|---|
| Core | 1 |
| Stack size | 4096 bytes |
| Priority | 1 |
| Idle poll | 500 ms (`PUMP_IDLE_MS`) |

**What it does:**

Loops forever. If `gPumpRequest` is false, ensures pump is off and delays 500 ms.

When `gPumpRequest` becomes true:

1. Records `pumpStartMs = millis()`.
2. Calls `fetchTargetSoil()` to get the threshold from Firebase (defaults to 2800 if unset or unreachable).
3. Takes `gStateMutex` to snapshot `gState`.
4. **Tank empty guard:** if `s.tankEmpty` is true, turns pump off, clears `gPumpRequest`, writes a `tank_empty` alert (debounced to once per hour), and continues idle. The pump will not run without water.
5. **60-second hard cap:** if `millis() - pumpStartMs > 60000`, turns pump off, logs "TIMEOUT", clears `gPumpRequest`. This prevents the pump from running indefinitely if the soil target is never reached.
6. **Target reached:** if `s.soilRaw <= target`, clears `pumpRequest` in Firebase, clears `gPumpRequest`, calls `writeWaterLog()`, and continues idle.
7. **Pulse:** turns pump ON, waits `PUMP_PULSE_MS` (1 s), turns pump OFF, waits `PUMP_SOAK_MS` (5 s), re-reads soil. After the soak, calls `writeWaterLog()` with reason "manual" or "schedule". If the reason was "schedule", also calls `updateScheduleAfterWater()`.

The pump cycle repeats (pulse → soak → check → pulse...) until soil reaches target, tank empties, or the 60-second cap is hit.

### Mutexes

The firmware uses **binary semaphores** (not true mutexes) specifically to avoid the `vTaskPriorityDisinheritAfterTimeout` assertion crash on the ESP32-S3's dual-core SMP. This is documented in a code comment. Binary semaphores do not have priority inheritance, which sidesteps the crash.

| Semaphore | Protects | Typical hold time |
|---|---|---|
| `gStateMutex` | `gState` struct | Microseconds (struct copy) |
| `gFirebaseMutex` | All `Firebase.RTDB.*` calls | Tens to hundreds of milliseconds (TLS round trips) |

**gStateMutex usage:**
- `taskReadSensors` takes it to write the new readings, gives it back.
- `taskFirebaseSync` takes it to snapshot gState before building the JSON, gives it back.
- `taskPumpControl` takes it to read soil/tank values before deciding, gives it back.
- Timeout for all takes: 50 ms.

**gFirebaseMutex usage:**
- `taskFirebaseSync` takes it for the full sync block (updateNode + deviceList + diagnostics + history), gives it back.
- `taskFirebaseSync` takes it to clear the reset flag.
- `taskFirebaseSync` takes it to poll `pumpRequest`.
- `taskPumpControl` takes it to clear `pumpRequest` in Firebase when target is reached.
- `taskPumpControl` takes it to write tank-empty alerts.
- `fetchTargetSoil()` takes it to read `control/targetSoil`.
- `fetchResetProvisioning()` takes it to read `control/resetProvisioning`.
- `writeWaterLog()` takes it to write a log entry.
- `updateScheduleAfterWater()` takes it to update schedule stats.
- Timeout: 500–1000 ms depending on call site.

### WiFiManager Provisioning Flow

1. On first boot (no saved WiFi credentials), the ESP32 creates an AP with SSID `SmartPlantPro_{last6hexOfMAC}` (e.g. `SmartPlantPro_BD36CC`).
2. A phone or laptop connects to this AP. The captive portal redirects all URLs to `http://192.168.4.1/start`.
3. The landing page shows a "Configure WiFi" button that goes to `/wifi`.
4. Normal users fill in their home WiFi SSID and password and tap Save. The Firebase fields are hidden behind an "Advanced settings" section protected by the PIN `1234`.
5. If the user enters Firebase credentials in the advanced section, those are saved to NVS (ESP32 non-volatile storage) under the namespace `"fb"` using keys `"apik"`, `"url"`, `"em"`, `"pw"`.
6. On subsequent boots, `wm.autoConnect()` reconnects silently using the stored credentials.
7. `setConfigPortalTimeout(300)` — if nobody connects to the AP within 5 minutes, the ESP32 restarts.
8. After connecting, the firmware checks if the connected SSID is a known captive-portal network (Starbucks, UBC Visitor, Xfinity, etc.) and immediately erases WiFi credentials and restarts if it is.

### ArduinoOTA Setup

```cpp
ArduinoOTA.setHostname("SmartPlantPro");
ArduinoOTA.setPassword("SmartPlantOTA2024!");
ArduinoOTA.begin();
```

`ArduinoOTA.handle()` is called from `loop()`. To use OTA from PlatformIO, add `upload_protocol = espota` and `upload_port = <device-IP>` to `platformio.ini`. The OTA password is `SmartPlantOTA2024!`.

**Important caveat:** The current partition table is `huge_app.csv`, a single 3 MB app partition. ArduinoOTA requires a second app partition to upload into while the first runs. With a single partition, OTA upload will fail. The code is kept in place for future use. To re-enable OTA, switch to a dual-partition scheme (e.g. the default `default_16MB.csv` or a custom `partitions_ota.csv`).

### NVS Storage

All NVS access uses the Arduino `Preferences` library.

| Namespace | Key | Value | Description |
|---|---|---|---|
| `"fb"` | `"apik"` | string (up to 79 chars) | Firebase API key |
| `"fb"` | `"url"` | string (up to 129 chars) | Firebase RTDB URL |
| `"fb"` | `"em"` | string (up to 71 chars) | Firebase Auth email |
| `"fb"` | `"pw"` | string (up to 71 chars) | Firebase Auth password |

WiFiManager stores its own WiFi credentials in NVS under a different namespace (managed internally by the library).

**Priority:** If both NVS keys `"apik"` and `"url"` are non-empty, those take priority. Otherwise, the compile-time defaults from `firebase_defaults.h` (or `secrets.h`) are used.

**Clearing NVS:** `clearFirebaseNVS()` calls `prefs.clear()` on the `"fb"` namespace. It is called when performing a full factory reset (not the normal re-provision, which only clears WiFi).

### Firebase Authentication

The firmware authenticates using **email/password** (not an anonymous account, not a service account).

```cpp
fbAuth.user.email = nvs_fb_email;     // e.g. "device@yourproject.com"
fbAuth.user.password = nvs_fb_password;
Firebase.begin(&fbConfig, &fbAuth);
```

The Firebase ESP Client library handles token acquisition and refresh internally. The device uses a dedicated Firebase Auth account whose UID does not appear in any user's `users/{uid}/devices` registry, so it has read/write access to all `devices/{mac}/*` paths (write is open to any authenticated user) but cannot read device data (read requires ownership). See section 4 for the full security rules.

**Important architectural limitation:** Every device flashed with the same credentials shares one Firebase Auth identity. If you want per-device credentials, you need to provision unique email/password pairs per device and save them via the WiFiManager portal.

---

## 4. Firebase Data Structure

The database is structured as follows. All paths are case-sensitive. The MAC address is used exactly as `WiFi.macAddress()` returns it: uppercase with colons, e.g. `24:6F:28:AA:BB:CC`.

### deviceList/{mac}/

Written by the firmware on every full sync cycle. Read by the frontend on the ClaimDevicePage to discover devices on the network.

```
deviceList/
  24:6F:28:AA:BB:CC/
    lastSeen:   1748000000    (int, Unix epoch — updated every ~3s by firmware)
    claimedBy:  "abc123uid"   (string | null — UID of the user who claimed it;
                               write-once: can only be written if currently null,
                               and only to the requester's own UID)
```

### devices/{mac}/readings

The live reading. Written by the firmware every ~3 seconds. Read by the frontend dashboard in real-time via `onValue`.

| Field | Type | Source | Description |
|---|---|---|---|
| `temperature` | float | BME280/BMP280 | Degrees Celsius; absent if NaN |
| `pressure` | float | BME280/BMP280 | Pascals (e.g. 101325); absent if NaN |
| `humidity` | float | BME280 only | Relative humidity %; absent if BMP280 or NaN |
| `soilRaw` | uint16 | ADC GPIO12 | Raw 12-bit ADC 0–4095; higher = drier |
| `lux` | float | VEML7700 | Ambient light in lux; absent if NaN |
| `tk` | int | GPIO11 float switch | 1 = tank empty, 0 = water present |
| `pumpRunning` | bool | GPIO10 readback | true = pump is physically on right now |
| `health` | string | firmware logic | "OK", "Overheat", "High humidity", or "Pump running, soil still dry" |
| `timestamp` | int | NTP time() | Unix epoch of the last successful push |
| `wifiSSID` | string | WiFi.SSID() | SSID the device is connected to |
| `wifiRSSI` | int | WiFi.RSSI() | Signal strength in dBm |

**Frontend note:** The `Readings` TypeScript type in `types.ts` maps to these fields. The frontend uses optional chaining (`readings?.temperature`) everywhere because any field can be absent.

### devices/{mac}/history/{epoch}

A compact snapshot written approximately every 36 seconds (see note in section 3). The key is the Unix epoch as an integer string, e.g. `"1748000000"`. Old entries accumulate indefinitely — there is no TTL or cleanup in the current firmware.

| Field | Type | Description |
|---|---|---|
| `t` | float | Temperature °C |
| `p` | float | Pressure Pa |
| `h` | float | Humidity %; absent if BMP280 |
| `s` | uint16 | Soil raw ADC |
| `l` | float | Light in lux |
| `pu` | int | Pump: 1 = on, 0 = off |
| `tk` | int | Tank: 1 = empty, 0 = full |

The frontend's `HistoryChart` component reads the last 288 entries via `limitToLast(288)`. The export modal calculates a dynamic fetch limit based on the requested date range (12 snapshots/hour × hours + 100 buffer, capped at 12000).

### devices/{mac}/control/

Written by the frontend. Read by the firmware every ~1 second (polling).

| Path | Type | Written by | Read by | Description |
|---|---|---|---|---|
| `control/pumpRequest` | bool | Frontend (pump button) | Firmware taskFirebaseSync | Set to true to request watering; firmware clears it when done |
| `control/targetSoil` | int | Frontend (settings) | Firmware taskPumpControl | ADC target moisture level; pump stops when soilRaw ≤ this value; default 2800 |
| `control/resetProvisioning` | bool | Frontend (reset button) | Firmware taskFirebaseSync | Set to true to trigger WiFi re-provisioning; firmware clears it before restarting |
| `control/schedule/enabled` | bool | Frontend | Firmware taskScheduleCheck | true = auto-watering is active |
| `control/schedule/hour` | int | Frontend | Firmware | Hour of day (0–23) to check soil and water (UTC, since NTP gives UTC) |
| `control/schedule/minute` | int | Frontend | Firmware | Minute (0–59) |
| `control/schedule/hysteresis` | int | Frontend | Firmware | Added to targetSoil to compute the "start watering" threshold; prevents flip-flopping |
| `control/schedule/maxSecondsPerDay` | int | Frontend | Firmware | Hard cap on total pump run time per calendar day, in seconds; default 120 |
| `control/schedule/cooldownMinutes` | int | Frontend | Firmware | Minimum minutes between scheduled waterings; default 30 |
| `control/schedule/day` | string | Firmware | Firmware | ISO date string of the last watering day, e.g. "2026-03-21"; used to reset todaySeconds |
| `control/schedule/todaySeconds` | int | Firmware | Firmware | Accumulated pump seconds today; compared against maxSecondsPerDay |
| `control/schedule/lastWateredAt` | int | Firmware | Firmware | Epoch of last watering; used for cooldown check |

**Schedule logic:** `taskScheduleCheck()` runs every 12 full-sync cycles. It only triggers if:
- `enabled` is true
- Current UTC time is within 5 minutes after `{hour}:{minute}`
- `soilRaw > (targetSoil + hysteresis)`
- `(now - lastWateredAt) >= cooldownMinutes * 60`
- `todaySeconds < maxSecondsPerDay`
- `gPumpRequest` is not already true

### devices/{mac}/waterLog/{epoch}

Written by the firmware after each pump cycle. Key is the Unix epoch. Readable only by the device owner.

| Field | Type | Description |
|---|---|---|
| `reason` | string | "manual" or "schedule" |
| `durationMs` | int | Pump on-time in milliseconds (one pulse = 1000 ms) |
| `soilBefore` | int | Soil ADC reading before the pulse |
| `soilAfter` | int | Soil ADC reading after the soak |

The frontend queries the last 50 entries with `orderByKey() + limitToLast(50)`, then sorts descending by epoch.

### devices/{mac}/diagnostics

Written by the firmware on every full sync. Readable only by the device owner.

| Field | Type | Description |
|---|---|---|
| `uptimeSec` | int | `millis() / 1000` — seconds since last reboot |
| `lastSyncAt` | int | Unix epoch of last successful Firebase push |
| `syncSuccessCount` | int | Cumulative successful push count |
| `syncFailCount` | int | Cumulative failed push count |
| `wifiRSSI` | int | WiFi signal strength, dBm |

### devices/{mac}/alerts/lastAlert

Written by the firmware when health is not OK, or when the pump is requested with an empty tank. Readable only by the device owner.

| Field | Type | Description |
|---|---|---|
| `timestamp` | int | Unix epoch |
| `type` | string | "health" or "tank_empty" |
| `message` | string | Human-readable description |

The frontend subscribes to `devices/{mac}/alerts/lastAlert` and shows an alert banner if `lastAlert.timestamp` is recent.

### users/{uid}/

Written and read only by the user with the matching UID. The Firebase security rule is `auth.uid == $uid`.

```
users/
  {uid}/
    devices/
      24:6F:28:AA:BB:CC/
        meta/
          name:   "Living Room Plant"
          room:   "Living Room"
    plantProfiles/
      {pushId}/
        name:            "My Mint"
        type:            "mint"
        createdAt:       1748000000
        soilMin:         1600
        soilMax:         2200
        tempMin:         15
        tempMax:         30
        humidityMin:     40
        humidityMax:     70
        lightPreference: "bright"
    devicePlant/
      24:6F:28:AA:BB:CC:  "{pushId}"   (links a device to a profile)
    invites/
      {pushId}/
        email:  "friend@example.com"
```

### Security Rules Summary

The rules are in `database.rules.json` and must be deployed with `firebase deploy --only database`.

| Path | Read | Write |
|---|---|---|
| `deviceList/{mac}` | Any authenticated user | — |
| `deviceList/{mac}/lastSeen` | — | Any authenticated user (firmware heartbeat) |
| `deviceList/{mac}/claimedBy` | — | Any authenticated user, but only if currently null, and only to their own UID |
| `devices/{mac}/readings` | Owner only | Any authenticated user (firmware needs write) |
| `devices/{mac}/history/{epoch}` | Owner only | Any authenticated user |
| `devices/{mac}/waterLog/{epoch}` | Owner only | Any authenticated user |
| `devices/{mac}/diagnostics` | Owner only | Any authenticated user |
| `devices/{mac}/alerts` | Owner only | Any authenticated user |
| `devices/{mac}/control` | Owner only | Owner only |
| `devices/{mac}/calibration` | Owner only | Owner only |
| `users/{uid}` | Only that UID | Only that UID |
| Everything else | Denied | Denied |

"Owner" is defined as: a user whose `users/{uid}/devices/{mac}` path exists in the database.

---

## 5. Frontend Deep-Dive

### App Routing

Defined in `frontend/src/App.tsx`. All routes are wrapped in `AnimatePresence` for fade transitions.

| Route | Component | Auth required | Description |
|---|---|---|---|
| `/login` | `LoginPage` | No | Email/password sign-in and sign-up |
| `/claim` | `ClaimDevicePage` | Yes (ProtectedRoute) | Enter or select a MAC address to link to your account |
| `/` | `DashboardPage` | Yes (ProtectedRoute) | Main dashboard — live readings, controls, history |
| `/overview` | `OverviewPage` | Yes (ProtectedRoute) | Multi-device summary |
| `*` | — | — | Redirects to `/` |

`ProtectedRoute` redirects unauthenticated users to `/login`.

### AuthContext

`frontend/src/context/AuthContext.tsx`

Wraps the Firebase Auth SDK. Exposes:
- `user: User | null` — the currently signed-in Firebase user (or null while loading or signed out)
- `loading: boolean` — true until `onAuthStateChanged` fires at least once
- `signIn(email, password)` — calls `signInWithEmailAndPassword`
- `signUp(email, password)` — calls `createUserWithEmailAndPassword`
- `signOut()` — calls Firebase `signOut`

The `onAuthStateChanged` listener is set up in a `useEffect` and cleaned up on unmount. `ProtectedRoute` checks `loading` first (shows nothing while loading) then checks `user`.

### DashboardPage — Firebase Subscriptions

`frontend/src/pages/DashboardPage.tsx` sets up the following real-time Firebase listeners via `onValue`. Each returns an unsubscribe function that is returned from the `useEffect` for cleanup.

| Listener path | State updated | Re-runs when |
|---|---|---|
| `users/{uid}/devices` | `myDevices`, `devicesMeta` | `user` changes |
| `users/{uid}/plantProfiles` | `profiles` | `user` changes |
| `users/{uid}/devicePlant/{mac}` | `linkedProfileId` | `user` or `selectedMac` changes |
| `devices/{mac}/readings` | `readings` | `selectedMac` changes |
| `devices/{mac}/control/targetSoil` | `targetSoil`, `targetSoilInput` | `selectedMac` changes |
| `devices/{mac}/calibration` | `calibration` | `selectedMac` changes |
| `devices/{mac}/alerts/lastAlert` | `lastAlert` | `selectedMac` changes |
| `devices/{mac}/readings/pumpRunning` | `pumpActive` | `selectedMac` changes |
| `devices/{mac}/diagnostics` | `diagnostics` | `selectedMac` changes |
| `devices/{mac}/control/schedule` | `schedule` | `selectedMac` changes |
| `devices/{mac}/waterLog` (last 50) | `waterLog` | `selectedMac` changes |
| `users/{uid}/invites` | `invitedList` | `user` changes |

The selected MAC is persisted to `localStorage` under the key `smart-plant-selected-device`. On load, it is read back, validated with `sanitizeMac()`, and used as the initial state.

**Device status:** The `getDeviceStatus()` utility in `utils/deviceStatus.ts` compares `readings.timestamp` against `Date.now()` to return a `DeviceStatus` string: `'live'` (< 30 s ago), `'delayed'` (30 s–5 min), `'offline'` (> 5 min), `'syncing'`, `'wifi_connected'`, or `'no_data'`.

**Pump button flow:**
1. User taps "Water now" → calls `set(ref(db, 'devices/{mac}/control/pumpRequest'), true)`.
2. The `pumpActive` state (subscribed to `readings/pumpRunning`) updates when the firmware reflects the physical relay state.
3. The button is disabled during `pumpActive` or `pumpCooldown` (8-second UI rate limit via `useRateLimit`).

### HistoryChart

`frontend/src/components/HistoryChart.tsx`

Subscribes to `devices/{mac}/history` with `orderByKey() + limitToLast(288)`. This fetches the most recent 288 history entries. With an entry roughly every 36 seconds, this covers approximately the last 3 hours in practice, but the display is filtered by a client-side time window.

**Why `limitToLast` instead of `startAt`:** Firebase RTDB orders integer keys as strings lexicographically, not numerically. So `startAt(1748000000)` may not work reliably for epoch keys. The workaround is to fetch a generous tail of entries with `limitToLast` and then filter in JavaScript.

**Client-side time filter:**
```ts
const cutoff = Math.floor(Date.now() / 1000) - hours * 3600
return raw.filter((e) => e.time >= cutoff)
```

Range options: 6 h, 12 h, 24 h. The user can toggle individual series (temperature, soilRaw, pressure, humidity) on/off. Series are only shown if the device has ever reported them (pressure is checked with `raw.some(e => e.pressure != null)`).

**Data field mapping:** Firebase history fields `t`, `p`, `h`, `s` are mapped to `temperature`, `pressure`, `humidity`, `soilRaw` for Recharts. Pressure is converted from Pa to hPa by dividing by 100.

### ExportModal and exportExcel

**ExportModal** (`frontend/src/components/dashboard/ExportModal.tsx`) is a modal dialog with start-date and end-date/time pickers (hour granularity, America/Los_Angeles timezone). On submit:

1. Converts LA-time inputs to UTC epoch bounds using `date-fns-tz fromZonedTime`.
2. Calculates `fetchLimit = min(hours * 12 + 100, 12000)`.
3. Fetches from Firebase with `get(query(..., orderByKey(), limitToLast(fetchLimit)))` (a one-time get, not a live listener).
4. Filters the results to the epoch range in JavaScript.
5. Calls `exportToExcel(rows, startUTC, endUTC)`.

**exportToExcel** (`frontend/src/utils/exportExcel.ts`):

1. Creates an ExcelJS workbook.
2. Adds sheet "Raw Data" with columns: Timestamp (LA Time), Temp (°C), Pressure (hPa), Humidity (%), Soil Raw (0–4095), Light (lx), Pump, Tank, Notes. Alternating row shading, frozen header row.
3. Adds sheet "Charts". For each of 6 metrics (Temperature, Humidity, Soil Moisture, Pressure, Light Level, Pump Activity), renders a Chart.js line chart on an invisible off-screen `<canvas>` (900×350 px), exports it as a PNG via `canvas.toDataURL`, and embeds the PNG into the Charts sheet using `workbook.addImage`. Charts are stacked vertically with 20 rows between each.
4. Writes the buffer to a Blob, creates an object URL, triggers a download link click, and revokes the URL.
5. Filename format: `plant-data_YYYY-MM-DD_to_YYYY-MM-DD.xlsx` (in LA timezone).

### PWA Setup

Configured in `frontend/vite.config.ts` using `vite-plugin-pwa`.

| Setting | Value |
|---|---|
| Register type | `autoUpdate` — new service worker activates without user prompt |
| Max file size to cache | 5 MB (raised to accommodate ExcelJS + Chart.js bundles) |
| Cache glob | `**/*.{js,css,html,ico,svg,woff2}` |
| Runtime caching | Google Fonts — CacheFirst, 1-year expiry |
| App name | "Smart Plant Pro" |
| Short name | "Plant Pro" |
| Theme color | `#3B7A57` |
| Background color | `#FAFBFA` |
| Display mode | `standalone` (no browser chrome when installed) |
| Orientation | `portrait-primary` |
| Icon | `/plant-icon.svg` (SVG, works as both standard and maskable) |

The PWA can be installed from Chrome/Edge/Safari on both desktop and mobile. The service worker caches all static assets, making the shell load offline. Live data still requires network access to Firebase.

### Vercel Deployment

The `frontend/` directory is deployed to Vercel. Vercel auto-deploys on every `git push` to the main branch.

The build command is `tsc -b && vite build`. The output directory is `frontend/dist`. All environment variables (`VITE_FIREBASE_API_KEY`, etc.) must be set in the Vercel project settings under Environment Variables. They are not committed to the repository.

Required Vercel environment variables:

| Variable | Where to find it |
|---|---|
| `VITE_FIREBASE_API_KEY` | Firebase Console → Project Settings → Web app config |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase Console → Project Settings → Web app config |
| `VITE_FIREBASE_DATABASE_URL` | Firebase Console → Realtime Database → URL |
| `VITE_FIREBASE_PROJECT_ID` | Firebase Console → Project Settings |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase Console → Project Settings → Web app config |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase Console → Project Settings → Web app config |
| `VITE_FIREBASE_APP_ID` | Firebase Console → Project Settings → Web app config |

If any of `apiKey`, `authDomain`, `databaseURL`, `projectId`, or `appId` are missing at runtime, `firebase.ts` throws an error immediately, preventing a confusing auth failure later.

---

## 6. First-Time Setup Guide

### Prerequisites

- PlatformIO IDE (VS Code extension) or PlatformIO Core CLI
- Node.js 18+ and npm
- A Firebase project with Realtime Database and Authentication enabled
- A Vercel account (free tier is fine)
- The ESP32-S3-Zero hardware, wired per section 3

### Step 1 — Clone the repository

```bash
git clone <your-repo-url>
cd ESP32_PlantMonitor
```

### Step 2 — Configure Firebase credentials for firmware

The credentials can be baked in at compile time OR entered via the WiFiManager portal at first boot.

**Option A — Compile-time (recommended for development):**

Create `src/secrets.h` (this file is gitignored):

```cpp
#pragma once
#define FIREBASE_API_KEY       "your-api-key"
#define FIREBASE_DB_URL        "https://your-project-default-rtdb.firebaseio.com"
#define FIREBASE_USER_EMAIL    "device@yourproject.com"
#define FIREBASE_USER_PASSWORD "your-device-password"
```

**Option B — WiFiManager portal:**

Leave `secrets.h` absent. After flashing, connect to the AP, tap "Advanced settings", enter PIN `1234`, and fill in the Firebase fields.

### Step 3 — Flash the firmware

In VS Code with PlatformIO extension: click the Upload button (right-pointing arrow in the PlatformIO toolbar).

From CLI:
```bash
pio run --target upload
```

The board is `lilygo-t3-s3`. The partition scheme is `huge_app.csv` (single 3 MB slot). Connect via USB before uploading.

### Step 4 — First-boot WiFi provisioning

1. Power on the device.
2. It will create an AP: `SmartPlantPro_XXXXXX` (where XXXXXX is the last 6 hex chars of the MAC).
3. Connect your phone or laptop to that AP.
4. A captive portal will appear (or navigate to `http://192.168.4.1/start` manually).
5. Tap "Configure WiFi", choose your home WiFi, enter the password.
6. If credentials are not already compiled in, unlock the Advanced section (PIN `1234`) and enter Firebase API key, DB URL, email, and password.
7. Save. The device will reboot and connect.

Open the serial monitor at 115200 baud to see connection progress, NTP sync, and Firebase auth status.

### Step 5 — Firebase console setup

1. Go to [console.firebase.google.com](https://console.firebase.google.com).
2. Create a project (or use existing).
3. Enable **Authentication** → **Email/Password** sign-in method.
4. Create a user for the device (e.g. `device@yourproject.com`) under Authentication → Users.
5. Create a user account for yourself (the person who will use the dashboard).
6. Enable **Realtime Database**. Start in locked mode.
7. Deploy the security rules:
   ```bash
   firebase deploy --only database
   ```
   This deploys `database.rules.json`.

### Step 6 — Deploy the frontend

1. Set up the local environment file:
   ```bash
   cp frontend/.env.example frontend/.env.local
   # Edit frontend/.env.local with your Firebase web app config values
   ```

2. Test locally:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
   Open `http://localhost:5173`. Sign in with your user account (not the device account).

3. Connect the Vercel project to your git repo. Set the environment variables in Vercel's dashboard (see section 5 for the full list).

4. Push to main — Vercel auto-deploys.

### Step 7 — Claim your device

1. Open the deployed app and sign in.
2. Navigate to `/claim`.
3. The page shows devices broadcasting to `deviceList/`. Your device appears there after it first syncs.
4. Click "Claim" next to your device's MAC, optionally give it a name and room, and confirm.
5. You are redirected to the dashboard with live readings.

---

## 7. How to Make Common Changes

### Add a new sensor

**Firmware (`src/main.cpp`):**

1. Add a new pin constant if needed.
2. Add the new value to `SensorState` struct.
3. In `taskReadSensors`, read the sensor and populate the new field.
4. In `taskFirebaseSync`, add a `json.set("newField", s.newValue)` call in the readings update block.
5. In the history block, add `hj.set("nf", s.newValue)` with a short key.

**Firebase:**

No schema change needed — RTDB is schemaless. The new fields just appear.

**Frontend:**

1. Add the field to `Readings` type in `frontend/src/types.ts`.
2. Add the field to `HistoryRow` in `types.ts` if you want it in exports.
3. Add a card to `SensorGrid.tsx`.
4. Add the column to `buildRawDataSheet` in `exportExcel.ts`.
5. Optionally add a chart entry in `buildChartsSheet`.

### Change pump behavior

The pump pulse/soak cycle is in `taskPumpControl` in `src/main.cpp`.

- **Change pulse duration:** modify `PUMP_PULSE_MS` (currently 1000 ms = 1 s).
- **Change soak duration:** modify `PUMP_SOAK_MS` (currently 5000 ms = 5 s).
- **Change the 60-second hard cap:** find `60000UL` in the timeout check inside `taskPumpControl`.
- **Change the default soil target:** modify the `return 2800` default in `fetchTargetSoil()`.

### Change watering schedule defaults

The schedule defaults are set in the frontend's `DashboardPage.tsx` in the `scheduleInput` state initialization (`hour: 8, minute: 0, hysteresis: 200, maxSecondsPerDay: 120, cooldownMinutes: 30`). The actual saved values live in Firebase under `devices/{mac}/control/schedule/`.

The firmware defaults (used if Firebase is unreachable) are in `taskScheduleCheck()` local variable declarations.

### Deploy new firmware

**Via USB (standard):**
```bash
pio run --target upload
```

**Via OTA (currently not functional due to partition table — see section 8):**

Once a dual-partition scheme is in place:
```bash
# In platformio.ini, add:
# upload_protocol = espota
# upload_port = 192.168.x.x  (device IP, shown in serial monitor)
pio run --target upload
```
The OTA password is `SmartPlantOTA2024!`.

**Monitor serial output during/after flash:**
```bash
pio device monitor --baud 115200
```

### Deploy frontend changes

```bash
git add frontend/src/...
git commit -m "your message"
git push origin main
```

Vercel picks up the push, runs `tsc -b && vite build` inside the `frontend/` directory, and deploys the result. Check the Vercel dashboard for build logs.

**Test locally before pushing:**
```bash
cd frontend
npm run build   # catches TypeScript errors
npm run preview # serves the production build locally
```

### Reset a device's WiFi (from the dashboard)

In the Settings tab of the dashboard, there is a "Re-provision WiFi" button. Clicking it sets `devices/{mac}/control/resetProvisioning = true`. Within ~2 seconds, the firmware detects this, clears the flag in Firebase, erases the stored WiFi credentials (but not the Firebase NVS credentials), and restarts into AP mode. The device will again broadcast `SmartPlantPro_XXXXXX`.

---

## 8. Known Issues and Quirks

### ADC2 soil sensor limitation with WiFi

`SOIL_SENSOR_PIN` is GPIO12, which is on ADC2. On the ESP32 (and ESP32-S3), ADC2 is shared with the WiFi radio. When WiFi is active (which it always is in this project), `analogRead()` on an ADC2 pin can return incorrect or unreliable values.

In practice, the readings are "good enough" — the soil moisture trends are clearly visible and thresholds work. But the absolute accuracy of the ADC reading is lower than it would be on an ADC1 pin.

If this becomes a problem, rewire the soil sensor to an ADC1-capable GPIO. On the ESP32-S3-Zero, ADC1 pins include GPIO1 through GPIO10 (verify with the Waveshare schematic before rewiring, as some are internally used).

### FreeRTOS vTaskPriorityDisinheritAfterTimeout crash

The ESP32-S3 has two cores and uses FreeRTOS with SMP support. Using `xSemaphoreCreateMutex()` (a true mutex) can trigger an assertion crash: `vTaskPriorityDisinheritAfterTimeout`. This happens when a task waiting on a cross-core mutex times out while the mutex holder has had its priority raised by priority inheritance.

The firmware works around this by using `xSemaphoreCreateBinary()` instead. Binary semaphores do not have priority inheritance, so the assertion never fires. The downside is that priority inversion can theoretically happen, but in practice the three tasks all run at the same priority (1) so this has no observable impact.

The comment in `setup()` explains this:
```cpp
// Binary semaphores instead of mutexes: avoids FreeRTOS priority-inheritance
// assertion (vTaskPriorityDisinheritAfterTimeout) that fires on ESP32-S3 SMP
// when a cross-core timeout occurs while the mutex holder's priority was raised.
```

### Firebase RTDB integer key ordering quirk

Firebase Realtime Database stores all keys as strings. When keys are integers (like Unix epoch timestamps), Firebase sorts them lexicographically as strings in some contexts, not numerically. This means `"1700000000"` sorts before `"999999999"` correctly as integers, but `startAt` and `endAt` queries on integer-keyed nodes behave unreliably across client SDKs.

The frontend works around this by always using `limitToLast(N)` to fetch the most recent entries, then filtering the results in JavaScript by comparing the parsed epoch value to the desired range. This is demonstrated in both `HistoryChart.tsx` and `ExportModal.tsx`.

### All devices share one Firebase Auth identity

The current architecture uses a single email/password pair for all ESP32 devices. Because the Firebase security rules allow any authenticated user to write to `devices/{mac}/readings`, this is fine for writes. But it means one compromised device could, in principle, read and impersonate another device's identity.

For a production multi-user deployment you would want per-device credentials provisioned through the WiFiManager portal, or a service-account-style flow. Per-device credentials are already supported by the firmware's NVS provisioning — it just requires entering unique credentials for each device during WiFiManager setup.

### ArduinoOTA does not work with the current partition table

`platformio.ini` uses `board_build.partitions = huge_app.csv`, which allocates all available flash to a single application partition. ArduinoOTA requires two application partitions: one running, one to write the update into. With a single partition, the OTA upload will fail (the device will accept the connection but there is nowhere to write the new firmware).

The ArduinoOTA code is kept in place so it is easy to re-enable. To fix this, change `board_build.partitions` to a dual-partition scheme (the default Arduino partition table for 4 MB flash, or a custom `partitions_ota.csv`). Note that a dual-partition scheme gives less space per app slot — you may need to reduce library dependencies if the binary is close to 1.5 MB.

### WiFiManager captive portal only stays open for 5 minutes

`wm.setConfigPortalTimeout(300)` means if no one connects to the setup AP within 5 minutes, the device restarts. If you see the device continuously restarting (blinking status), connect to its AP quickly after power-on. If the device has valid WiFi credentials, it will only show the AP momentarily on each boot attempt before auto-connecting.
