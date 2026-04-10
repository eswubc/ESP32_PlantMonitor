# Smart Plant Pro – Improvement Plan

This document is the master plan for making the project production-ready: one-time WiFi/Firebase setup, OTA, calibration, alerts, per-device auth, offline behavior, multi-slot, and re-provisioning.

---

## Implementation status

| # | Item | Status |
|---|------|--------|
| 1 | WiFiManager (one-time WiFi) | Done |
| 2 | Re-provisioning (app button + RTDB flag) | Done |
| 3 | Firebase in portal (optional) | Done – custom params + NVS; reset clears them |
| 4 | OTA (ArduinoOTA) | Done – set upload_port in platformio.ini |
| 5 | Calibration (app + RTDB, gauge uses boneDry/submerged) | Done |
| 6 | Offline / last seen in UI | Done |
| 7 | Alerts (ESP32 writes lastAlert; app shows it) | Done – FCM optional via Cloud Function |
| 8 | Per-device auth (Cloud Function + token) | Not done – see Phase 2 (requires Cloud Functions billing) |
| 9 | Multi-slot | Not done – see Phase 7 (requires hardware changes) |
| 10 | NTP timestamps (real epoch time) | Done – `configTime()` + `time(nullptr)` |
| 11 | Offline/disconnect detection (live timer) | Done – `nowSec` ticks every 5s; offline banner + dimmed cards |
| 12 | WiFi SSID display on dashboard | Done – firmware writes `wifiSSID`/`wifiRSSI`; frontend shows connection |
| 13 | Reset WiFi guided flow (phased sync) | Done – 3-phase: resetting → wifi-connected → synced |
| 14 | WiFiManager portal branding | Done – Smart Plant Pro theme, green brand bar, custom CSS |
| 15 | WiFi validation (retry on wrong password) | Done – `setConnectRetries(3)`, `setSaveConnectTimeout(15)` |
| 16 | UI/UX overhaul (sustainability theme) | Done – glassmorphism, Inter/Jakarta Sans, new design tokens |
| 17 | Alert acknowledge / dismiss | Done – "Dismiss" button writes ackAt, hides alert |
| 18 | Manual pump trigger button | Done – "Water now" with cooldown + live pump state |
| 19 | Loading skeleton screen | Done – plant icon + progress bar in ProtectedRoute |
| 20 | Button/input style consistency | Done – .btn-primary, .btn-ghost, .input-field everywhere |
| 21 | Readings history chart (24 h) | Done – ESP32 pushes to `history/{epoch}` every 5 min; Recharts line chart with 6/12/24 h tabs |
| 22 | Browser push notifications | Done – Notification API toggle; fires on new `lastAlert`; plant icon in tray |

### Double-check (verification)

- **Firmware (src/main.cpp):** WiFiManager `autoConnect("SmartPlantPro")` with custom params (Firebase API key, DB URL, email, password); no hardcoded WiFi; NVS load/save for Firebase (`loadFirebaseFromNVSAndApply`, `clearFirebaseNVS`); `fetchResetProvisioning()` + `clearFirebaseNVS()` + `wm.resetSettings()` + reboot; ArduinoOTA after WiFi; `lastAlert` write when health != OK; three tasks (ReadSensors, FirebaseSync, PumpControl).
- **platformio.ini:** `tzapu/WiFiManager@^2.0.16` in lib_deps; commented OTA lines for upload_port.
- **Frontend (DashboardPage):** Reset device WiFi button; calibration section (Mark dry/wet); `soilRawToGaugeCalibrated` for gauge; calibration + lastAlert from RTDB; offline "Last seen X ago" when stale; logged-in user in header; plant profiles + example plants.
- **Soil (utils/soil.ts):** `soilRawToGaugeCalibrated(raw, boneDry, submerged)`.
- **README:** First-time setup (WiFiManager + optional Firebase in portal, OTA, calibration, alerts); RTDB schema includes `resetProvisioning`, `calibration`, `alerts/lastAlert`.

---

## Overview

| # | Area | What | Depends on |
|---|------|------|------------|
| 1 | Provisioning | WiFiManager + optional Firebase in portal | — |
| 2 | Re-provisioning | Reset WiFi/Firebase (button or app) | 1 |
| 3 | Device auth | Per-device token, no shared password in code | 1 (+ backend/CF) |
| 4 | OTA | Over-the-air firmware updates | 1 |
| 5 | Calibration | App + RTDB calibration flow | — |
| 6 | Offline | Last-known + "last seen" in UI | — |
| 7 | Alerts | Alerts in RTDB + optional FCM | 3 or later |
| 8 | Multi-slot | Slots/relays per device, link profiles | — |

---

## Phase 1 – Provisioning & re-provisioning

### 1.1 WiFiManager (one-time WiFi)

- **ESP32**
  - Add library: **WiFiManager** (e.g. tzapu/WiFiManager for ESP32 Arduino).
  - **Boot flow:** Try load WiFi from NVS. If none or connect fails → start WiFiManager AP (e.g. "SmartPlantPro"), show captive portal. User enters SSID + password → save to NVS, connect, exit AP.
  - Remove hardcoded `WIFI_SSID` / `WIFI_PASS`; use credentials from NVS after first run.
- **Portal**
  - Optional: add custom fields for Firebase API key, DB URL, device user email, device user password (or add in 1.2).
- **Docs**
  - README: "First boot: join AP 'SmartPlantPro', open 192.168.4.1, enter WiFi (and optionally Firebase)."

### 1.2 Firebase config from provisioning (no hardcode)

- **Option A – Same portal**
  - In WiFiManager custom fields: API key, DB URL, device email, device password. ESP32 saves to NVS and uses in `Firebase.begin()`.
- **Option B – Second step**
  - After WiFi works, if NVS has no Firebase config, second AP or "config mode" page to collect Firebase config; save to NVS.
- **ESP32**
  - On boot: read API key, DB URL, auth from NVS; if missing, stay in provisioning. Single code path using NVS-backed config.

### 1.3 Re-provisioning (reset WiFi / Firebase)

- **Hardware**
  - Long-press GPIO button (e.g. 5–10 s) → clear WiFi (and optionally Firebase) in NVS, reboot → device enters WiFiManager again.
- **App**
  - Dashboard: "Reset device WiFi" / "Re-provision". Writes `devices/<MAC>/control/resetProvisioning = true`.
- **ESP32**
  - In sync or control listener: if `resetProvisioning` true → clear NVS credentials, set flag false, reboot.
- **Docs**
  - "To change WiFi: long-press button on device, or use 'Reset device WiFi' in app."

---

## Phase 2 – Per-device auth (no shared password)

- **Option A – Custom token**
  - When user claims device, Cloud Function creates custom token for `device_<MAC>`, writes to `deviceList/<MAC>/deviceToken`. ESP32 reads once (or after reset), uses custom token auth, optionally stores in NVS.
- **Option B – Device user**
  - Cloud Function creates Firebase Auth user per device + random password, writes to RTDB (secure path). ESP32 reads and uses; no email/pass in code.
- **App**
  - Claim flow calls Cloud Function with MAC; backend creates token/user and writes for device.
- **ESP32**
  - Remove hardcoded Firebase email/password. After boot, if no auth in NVS, wait for claim (poll RTDB); once present, use and optionally cache in NVS.

---

## Phase 3 – OTA updates

- **Build**
  - PlatformIO: OTA env (`upload_protocol = espota`, `upload_port` = device IP or mDNS).
- **ESP32**
  - ArduinoOTA or native OTA; register handler on boot when WiFi up.
- **Trigger**
  - (A) IDE upload to device IP. (B) RTDB `devices/<MAC>/control/firmwareURL`; device checks periodically, downloads .bin, flashes. (C) Firebase Storage URL in RTDB.
- **Safety**
  - Only when device is claimed or "OTA allowed" flag set.
- **Docs**
  - "OTA: PlatformIO Upload to device IP" or "Set firmware URL in dashboard."

---

## Phase 4 – Calibration flow (app + RTDB)

- **RTDB**
  - Use `devices/<MAC>/calibration/boneDry`, `submerged`; optional `calibration/status`.
- **App**
  - "Calibrate soil": Step 1 "Mark dry" → write current soilRaw to boneDry (or set `markDry` for device to write). Step 2 "Mark wet" → submerged.
- **ESP32**
  - Optional: on `markDry`/`markWet` true, write current `soilRaw` to calibration, clear flag.
- **Frontend**
  - Gauge/soil: compute % or labels from soilRaw and boneDry/submerged in one place.

---

## Phase 5 – Offline / last-known behavior

- **App**
  - Keep last `readings` + `timestamp` in state. If no update for 2× sync interval, show "Last seen: X min ago", keep last values, optionally grey/"Stale".
- **ESP32 (optional)**
  - Buffer last pump run in NVS; on next sync write `devices/<MAC>/lastPumpRun`.

---

## Phase 6 – Alerts / notifications

- **RTDB**
  - `devices/<MAC>/alerts/lastAlert` (timestamp, type, message); optional ack.
- **ESP32**
  - When health not OK or soil dry for N minutes → write `alerts/lastAlert`.
- **Backend**
  - Cloud Function on `alerts/lastAlert` write: send FCM (using `users/<uid>/fcmToken`) or email.
- **App**
  - Show last alert; "Acknowledge" button; optional `alerts/ackAt`.

---

## Phase 7 – Multi-slot (multiple plants per device)

- **RTDB**
  - `devices/<MAC>/slots/A`, `slots/B`: relayPin, soilPin, linkedProfileId; per-slot readings.
- **ESP32**
  - taskReadSensors reads all slots; taskFirebaseSync writes per-slot; taskPumpControl per-slot.
- **App**
  - Device → Slot A / B; separate gauges and "Use for this device, Slot A" linking profile to slot.

---

## Implementation order

1. **WiFiManager** (WiFi only first)
2. **Re-provisioning** (button + app flag)
3. **Firebase from provisioning** (optional custom fields)
4. **Calibration** (app + RTDB)
5. **Offline / last known** (app state + "Last seen")
6. **Per-device auth** (Cloud Function + RTDB)
7. **OTA** (ArduinoOTA or URL from RTDB)
8. **Alerts** (RTDB + Cloud Function + FCM/email)
9. **Multi-slot** (when hardware supports multiple probes/relays)

---

## Quick reference

| Idea | ESP32 | App | Backend / RTDB |
|------|--------|-----|----------------|
| WiFiManager | Add lib; NVS; boot flow; remove SSID/PASS | — | — |
| Firebase in portal | NVS for API key, URL, auth | — | — |
| Re-provision | Button or listen `resetProvisioning`; clear NVS; reboot | "Reset WiFi" writes flag | `control/resetProvisioning` |
| Device auth | Read token/creds from RTDB or NVS | Claim calls CF | CF: create token/user |
| OTA | ArduinoOTA or HTTP OTA; optional URL from RTDB | Optional: set firmware URL | Optional: `control/firmwareURL` |
| Calibration | Optional: markDry/markWet → write calibration | "Calibrate" UI | `calibration/*` |
| Offline | Optional: buffer pump event in NVS | Last-known; "Last seen" | — |
| Alerts | Write lastAlert when health bad / dry | Show/ack alerts | CF: on alert → FCM/email |
| Multi-slot | Multi-pin/relay; per-slot readings & pump | Slots in dashboard | `slots/<id>`, per-slot readings |
