# Smart Plant Pro – Overview & Testing Guide

## 1. What the project is

**Smart Plant Pro** is an IoT plant monitoring system. An ESP32 reads sensors, sends data to the cloud, and can run a water pump — all controlled from a modern web dashboard.

- **Device (ESP32):** Reads temperature (BMP280), soil moisture (ADC), light (LDR), and reports WiFi SSID + signal strength. Sends readings to **Firebase Realtime Database** every 10s. Listens for pump commands and health alerts. First-time WiFi/Firebase setup is done via a branded **captive portal** at 192.168.4.1 — no credentials hardcoded.
- **Cloud (Firebase):** Realtime Database holds all device and user data. Data paths: `devices/<MAC>/...` (readings, control, calibration, alerts) and `users/<uid>/...` (claimed devices, plant profiles).
- **Web app (React + Tailwind + Vite):** Modern green susssssstainability-themed UI with glassmorphism cards. Login, claim devices, live dashboard with circular gauge, manual pump trigger, soil calibration, plant profiles, WiFi status indicator, offline detection, and guided reset flow.

**Flow:** ESP32 → WiFi (provisioned once) → Firebase ← Web app

---

## 2. Provisioning flow

### First boot (no WiFi saved)

1. Power on the ESP32. It starts an AP named **SmartPlantPro**.
2. On your phone/laptop, connect to **SmartPlantPro** WiFi.
3. A branded portal opens (or go to **192.168.4.1**).
4. Enter your **WiFi SSID + password**. Optionally fill Firebase credentials (API key, DB URL, email, password) — leave empty to use compiled defaults.
5. Click Save. ESP32 connects to WiFi, syncs NTP, authenticates with Firebase, and starts streaming sensor data.

### Re-provisioning (changing WiFi later)

1. In the web dashboard, click **"Reset device WiFi"**.
2. A step-by-step guide appears. The device clears its config and restarts into AP mode.
3. Connect to **SmartPlantPro** again, enter new WiFi, save.
4. Dashboard auto-detects reconnection: "Connected to WiFi → Syncing → Sync complete."

WiFi validation: if you enter the wrong password, the device retries 3 times then re-opens the portal — no reboot needed.

---

## 3. Dashboard features

| Feature | Description |
|---------|-------------|
| **WiFi status** | Green/red dot showing SSID name + signal strength (dBm) |
| **Offline detection** | Timer ticks every 5s; after 2min shows "Device offline" with dimmed cards |
| **Sensor cards** | Temperature (°C), soil moisture (circular gauge with gradient), light (bright/dim) |
| **Pump control** | "Water now" button triggers a manual watering pulse with 8s cooldown |
| **Target moisture** | Slider (0–4095 raw) — device pumps until soil ≤ target |
| **Soil calibration** | Mark dry + Mark wet to calibrate the 0–100% gauge to your sensor |
| **Plant profiles** | Create profiles (name + type), link to device, preset example plants |
| **Alerts** | Auto-generated when health ≠ OK; dismiss button writes ack timestamp |
| **Reset WiFi** | Guided 5-step flow with phased sync detection |
| **Health pill** | Shows OK / Offline / Syncing based on device state |

---

## 4. Testing checklist

### Prerequisites

- ESP32 board + USB cable
- WiFi network
- Firebase project with Realtime Database + Auth (Email/Password)

### Step 1: Flash firmware

1. Open project in PlatformIO.
2. Optionally set Firebase defaults in `src/main.cpp` (API_KEY, DB_URL, email, password).
3. Build & upload: `pio run -t upload`
4. Open Serial Monitor (115200).

### Step 2: WiFi portal

1. Join **SmartPlantPro** WiFi on your phone/laptop.
2. Open **192.168.4.1** — you should see the branded green portal.
3. Enter WiFi credentials, optionally Firebase fields, save.
4. Serial should show: WiFi connected → NTP synced → Firebase ready.

### Step 3: Web app

1. `cd frontend && npm install && npm run dev`
2. Open http://localhost:5173 (or Vercel deployment URL).
3. Sign up / log in.
4. Go to **Add device** → your ESP32 should appear in "Discover devices" → Claim it.
5. Dashboard should show live data with green WiFi indicator.

### Step 4: Test features

- **Pump:** Click "Water now" — device should pulse the relay. Button shows "Running…" while active.
- **Calibration:** Mark dry (sensor in air), Mark wet (sensor in water). Gauge should adjust.
- **Target moisture:** Drag slider, click Save. Device will use the new threshold.
- **Plant profiles:** Add a profile, select an example plant (e.g. Mint), link to device.
- **Alerts:** If health ≠ OK, an alert banner appears with a Dismiss button.

### Step 5: Test reset flow

1. Click **"Reset device WiFi"** — button goes gray, guide appears.
2. WiFi indicator shows "Device is restarting…"
3. ESP32 restarts into AP mode. Connect to **SmartPlantPro**, configure new WiFi.
4. Dashboard transitions: "Connected to WiFi — syncing…" → "Sync complete" → live data.

### Step 6: Test offline detection

1. Unplug the ESP32.
2. Within ~2 minutes, dashboard should show "Device offline" banner, dimmed sensor cards, "Offline" health pill.
3. Plug back in — data resumes, indicators go green.

### Step 7: OTA (optional)

1. Note ESP32 IP from Serial.
2. In `platformio.ini`, uncomment `upload_protocol = espota` and set `upload_port`.
3. Upload via PlatformIO over WiFi.

---

## 5. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  YOU (phone/laptop)                                          │
│  • First time: join SmartPlantPro WiFi → 192.168.4.1         │
│  • Enter WiFi + (optional) Firebase credentials              │
│  • Later: "Reset device WiFi" in app to re-provision         │
└──────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────────────┐
│  ESP32 (Smart Plant Pro)                                     │
│  FreeRTOS tasks:                                             │
│    • taskReadSensors  (5s)  — BMP280, soil ADC, LDR         │
│    • taskFirebaseSync (10s) — push readings + WiFi SSID/RSSI│
│    • taskPumpControl        — pulse relay on pumpRequest     │
│  Features: NTP, ArduinoOTA, WiFiManager, NVS config          │
│  Writes: readings, deviceList/lastSeen, alerts/lastAlert     │
│  Reads:  control/targetSoil, pumpRequest, resetProvisioning  │
└──────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────────────┐
│  Firebase (Realtime Database + Auth)                         │
│  devices/<MAC>/ — readings, control, calibration, alerts     │
│  deviceList/<MAC>/ — lastSeen, claimedBy                     │
│  users/<uid>/ — devices, plantProfiles, devicePlant, invites │
└──────────────────────────────────────────────────────────────┘
                    ▲
                    │
┌──────────────────────────────────────────────────────────────┐
│  Web App (React + TypeScript + Tailwind + Vite)              │
│  Theme: Green sustainability, glassmorphism, Inter font      │
│  Pages: Login → Claim Device → Dashboard                     │
│  Live: sensor readings, WiFi status, pump control, alerts    │
│  Deploy: Vercel (root = frontend/)                           │
└──────────────────────────────────────────────────────────────┘
```
