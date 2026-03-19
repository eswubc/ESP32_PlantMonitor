# Smart Plant Pro – Firebase RTDB (Capstone)

ESP32 plant monitor with **Firebase Realtime Database (RTDB)** for multi-user support + unique device pairing:

- BMP280 temperature (I2C)
- Capacitive soil moisture (ADC)
- LDR light sensor (digital)
- Relay-controlled water pump (active-low)

The device writes readings to `devices/<MAC_ADDRESS>/...` and the web app uses Firebase Auth + RTDB to claim devices and display dashboards.

---

## 1. First-time setup (WiFi + Firebase)

### WiFi (one-time, no code change)

**First boot:** The ESP32 has no WiFi saved. It starts an access point named **SmartPlantPro**. Join it from your phone or laptop, then open a browser to **http://192.168.4.1**. Enter your home WiFi SSID and password. You can also enter **Firebase API Key**, **DB URL**, **Firebase user email**, and **Firebase user password** in the same form; if provided, they are saved to NVS and used instead of compile-time defaults. Click Save. The device connects and uses the saved credentials for future boots.

**To change WiFi (or Firebase) later:** In the web app dashboard, select the device and click **Reset device WiFi**. The device clears both WiFi and Firebase config from NVS and restarts in AP mode so you can enter a new network (and optionally new Firebase settings) at 192.168.4.1 again.

### Firebase (portal or optional secrets.h)

**Recommended – Portal:** At first WiFi setup (192.168.4.1) enter Firebase API Key, DB URL, and device user email/password. They are stored in NVS and used on every boot. No credentials in source code.

**Optional – Pre-fill for development:** Copy `src/secrets.h.example` to `src/secrets.h` (gitignored) and fill in your values. The portal form will be pre-filled. Never commit `secrets.h`.

```bash
cp src/secrets.h.example src/secrets.h
# Edit src/secrets.h with your Firebase credentials
```

- **API_KEY**: Firebase Project → Project Settings → General → “Web API Key”.
- **DB_URL**: Firebase Realtime Database URL, e.g. `https://your-project-id-default-rtdb.firebaseio.com/`
- **FIREBASE_USER_EMAIL / FIREBASE_USER_PASSWORD**: Create a dedicated “device user” in Firebase Auth (Email/Password) or use your own during development.

### OTA (Over-the-air updates)

After the device is on WiFi, you can upload new firmware without USB. In `platformio.ini` uncomment and set:

```ini
upload_protocol = espota
upload_port = 192.168.1.XXX   ; your device’s IP
```

Then use **Upload** in PlatformIO; the device must be powered and on the same network.

### Calibration and alerts

- **Calibration:** In the dashboard, use “Calibrate soil sensor” → **Mark as dry** and **Mark as wet** so the soil gauge uses your sensor’s range. Values are stored in `devices/<MAC>/calibration/`.
- **Alerts:** When device health is not OK, the ESP32 writes to `devices/<MAC>/alerts/lastAlert`. The dashboard shows “Last alert” when present. Optional: add a Firebase Cloud Function to send FCM/email (see PLAN.md).

---

## 2. ESP32 firmware architecture (what it does)

The ESP32 runs three independent FreeRTOS tasks:

- **taskReadSensors** (Core 1, every 5s)
  - reads BMP280 temperature, soil ADC, and LDR
  - stores values in a shared `SensorState` struct

- **taskFirebaseSync** (Core 0, every 10s)
  - pushes `devices/<MAC>/readings`:
    - `temperature`, `soilRaw`, `lightBright`, `pumpRunning`, `health`, `timestamp`
  - `health` example: pump running but soil remains dry

- **taskPumpControl** (Core 0, stream-driven)
  - listens to `devices/<MAC>/control/pumpRequest` using an RTDB stream
  - runs **pulse watering**:
    - pump ON for 1s
    - wait 5s to soak
    - repeat until `soilRaw <= targetSoil`

Important: RTDB calls are protected by a mutex so tasks don’t corrupt the Firebase client.

---

## 3. RTDB paths (schema)

Device identity is the **MAC address** from `WiFi.macAddress()` and is used as:

```text
devices/<MAC_ADDRESS>/
  readings/
    temperature: number | null
    soilRaw: number
    lightBright: boolean
    pumpRunning: boolean
    health: string
    timestamp: number
  control/
    pumpRequest: boolean
    targetSoil: number
    resetProvisioning: boolean   # true = device clears WiFi and restarts in AP mode (set from app)
  calibration/
    boneDry: number
    submerged: number
  alerts/
    lastAlert: { timestamp, type, message }   # Written by ESP32 when health != OK
users/<uid>/devices/<MAC_ADDRESS>: true
users/<uid>/invites/<key>: { email: string, at: number }   # Invite list (web app)
deviceList/<MAC_ADDRESS>/
  lastSeen: number    # Updated by ESP32 on each sync (for “Discover devices”)
  claimedBy: uid      # Set by web app when user claims; unclaimed if absent
```

To test quickly, create these defaults in RTDB for your device:

```text
devices/<MAC_ADDRESS>/control/pumpRequest = false
devices/<MAC_ADDRESS>/control/targetSoil = 2800
```

---

## 4. Hardware wiring

### ESP32-S3 Zero (default env `esp32-s3-zero`)

Pins 1–10 in use; sensors on 11, 12. Relay on 10.

| Function | GPIO | Wiring |
|----------|------|--------|
| BME280 SDA | 8 | I2C data |
| BME280 SCL | 9 | I2C clock |
| Soil (analog) | **11** | SIG → GP11 (higher = drier) |
| Light (digital) | **12** | OUT → GP12 (LOW = bright) |
| Relay (pump) | 10 | Active LOW: LOW = pump ON |

- **Soil**: Capacitive sensor; VCC→3.3V, GND→GND, SIG→GP11.
- **Light**: Digital LDR module; OUT→GP12.
- **Relay**: Active-low; LOW = pump ON.

### ESP32-D (DevKit, env `esp32dev`)

| Function | GPIO | Notes |
|----------|------|--------|
| I2C SDA | 33 | BME280 data |
| I2C SCL | 32 | BME280 clock |
| Soil (analog) | 34 | ~1325 wet, ~3000 dry |
| Light (digital) | 35 | LOW = bright |
| Relay (pump) | 25 | Active LOW: LOW = pump ON |

---

## 5. Safety

- In **`setup()`**, the relay is set to **HIGH (OFF)** before any other init or the RainMaker agent. The pump stays off until the app turns it on or auto-watering runs.
- Pulse watering is handled in `taskPumpControl`.

---

## 6. Build, upload, and monitor

**Requirements**: PlatformIO (VS Code extension or CLI).

1. Open the project in PlatformIO.
2. Connect the ESP32 via USB.
3. **Build**: `pio run` (or **Build** in the PlatformIO IDE).
4. **Upload**: `pio run --target upload` (or **Upload**).
5. **Serial Monitor**: `pio device monitor` (or **Monitor**), at **115200** baud.

Once credentials are filled, you should see:

- Wi‑Fi connect logs + IP
- `Device ID (MAC): <...>`
- RTDB update results (or error reasons)

---

## 6a. Bringing up each ESP32-S3 Zero node (multi-device)

To add another plant monitor as a node for the frontend:

### 1. Wire the board

- BME280: SDA→8, SCL→9, VCC→3.3V, GND→GND
- Soil: SIG→GP11, VCC→3.3V, GND→GND
- Light: OUT→GP12, VCC→3.3V, GND→GND
- Relay: IN→GP10, VCC→3.3V, GND→GND (for pump)

### 2. Flash the firmware

```bash
pio run -e esp32-s3-zero -t upload
```

Use `esp32-s3-zero` (main app), not `esp32-s3-zero-hwtest`.

### 3. First boot – WiFi + Firebase

1. Power the board. It creates AP **SmartPlantPro_&lt;MAC6&gt;**.
2. Join that WiFi from phone/laptop.
3. Open **http://192.168.4.1**.
4. Enter:
   - WiFi SSID and password
   - Firebase API Key, DB URL, user email, user password (from your Firebase project)
5. Save. The device connects and syncs to RTDB.

### 4. Claim the device in the frontend

1. Open serial monitor, note **Device ID (MAC)**: e.g. `3C:0F:02:DF:73:74`.
2. In the web app → **Claim device** → enter that MAC.
3. The node appears in the dashboard and you can view readings, set target soil, control pump.

### 5. Repeat for more nodes

Each ESP32-S3 Zero has a unique MAC. Flash the same firmware on each, go through WiFi/Firebase setup, then claim each MAC in the app. They will show as separate devices.

---

## 7. Web app (React + Tailwind + Firebase)

The frontend lives in **`frontend/`** (Vite + React + TypeScript + Tailwind).

### One-time setup

1. **Firebase Web config**  
   Firebase Console → Project settings → General → “Your apps” → add a Web app (or use existing). Copy the `firebaseConfig` object.

2. **Env file**  
   In `frontend/`, copy `.env.example` to `.env.local` and fill in the Web app values:

   ```bash
   cd frontend
   cp .env.example .env.local
   # Edit .env.local: VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN,
   # VITE_FIREBASE_DATABASE_URL, VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_APP_ID
   ```

3. **Install and run**

   ```bash
   npm install
   npm run dev
   ```

   Open the URL shown (e.g. `http://localhost:5173`).

### What the app does

- **Login** (`/login`): Email/password sign-in or sign-up (Firebase Auth).
- **Claim device** (`/claim`): Enter device MAC (from Serial Monitor “Device ID (MAC): …”). Writes `users/<uid>/devices/<MAC>` so the dashboard can list your devices.
- **Dashboard** (`/`): Device dropdown, live readings from `devices/<MAC>/readings` (temperature, soil raw, soil status Soggy/Ideal/Dry/Very dry, light, health), and target moisture (raw threshold) with Save. Pump control is optional (no hardware required for dashboard to work).

### Build for production

```bash
cd frontend
npm run build
```

Output is in `frontend/dist/`. Serve with any static host or Firebase Hosting.

### Deploy to Vercel (no localhost)

1. **Push your project to GitHub** (if not already), including the `frontend/` folder.

2. **Go to [vercel.com](https://vercel.com)** → Sign in → **Add New** → **Project** → Import your repo.

3. **Configure the project**:
   - **Root Directory**: set to `frontend` (so Vercel builds from that folder).
   - **Build Command**: `npm run build` (default).
   - **Output Directory**: `dist` (Vite default).
   - **Install Command**: `npm install` (default).

4. **Environment variables** (Vercel → Project → Settings → Environment Variables). Add these for **Production** (and Preview if you want):
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_DATABASE_URL`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_APP_ID`  
   Use the same values as in your `frontend/.env.local`. Vercel will inject them at build time.

5. **Deploy**: Click **Deploy**. Vercel will build and give you a URL (e.g. `https://your-project.vercel.app`). All routes (`/`, `/login`, `/claim`) work because `frontend/vercel.json` rewrites them to `index.html`.

**Optional**: Connect a custom domain in Vercel → Project → Settings → Domains.

---

## 8. Next steps (improvements & capstone)

- **Calibration wizard**: UI to set “bone dry” and “submerged” soil values; store in `devices/<MAC>/calibration` and optionally use them to map raw → percentage in the dashboard.
- **Plant profiles**: Dropdown (e.g. Cactus, Monstera, Fern) that sets a suggested `targetSoil` (or presets) per device.
- **Manual pump toggle**: Button in the dashboard to set `devices/<MAC>/control/pumpRequest` to `true` for on-demand watering (when you have relay hardware).
- **Stricter Firebase rules**: When you lock down auth, restrict RTDB so users can only read/write their own `users/<uid>/devices` and the corresponding `devices/<MAC>` nodes (e.g. by checking `auth.uid` and a `users/<uid>/devices/<MAC>` claim).
- **Deploy frontend**: `npm run build` in `frontend/`, then deploy `frontend/dist/` to Firebase Hosting or another static host and point your domain at it.

---

## 9. Security

Credentials are not stored in the repo. See **SECURITY.md** for credential handling and what to do if secrets were exposed in git history.
# Plant-Monitor
