# Smart Plant Pro — Firmware Deep Dive
### Everything you need to own this project in an interview

---

## 1. What Is This Project?

Smart Plant Pro is an **IoT plant monitoring and auto-watering system**. A small microcontroller (ESP32-S3) sits next to your plant, reads sensors every 2 seconds, and streams the data to a cloud database (Firebase) in real time. A React web app on your phone shows live readings and lets you trigger the pump remotely.

**The full stack in one sentence:**  
*Sensors → ESP32 firmware (C++) → Firebase Realtime Database (cloud) → React dashboard (browser/phone)*

---

## 2. The Hardware at a Glance

| Component | What It Does | How It Connects |
|-----------|-------------|-----------------|
| **ESP32-S3 Zero** (Waveshare) | The brain — runs all the code | USB-C for programming |
| **BME280** | Reads temperature, humidity, air pressure | I2C (GPIO 5 = SDA, GPIO 9 = SCL) |
| **VEML7700** | Reads ambient light in lux | I2C (same bus as BME280) |
| **Soil moisture sensor** | Reads soil wetness (0–4095 ADC value) | Analog (GPIO 12) |
| **Float switch** | Detects if water tank is empty | Digital (GPIO 11, INPUT_PULLUP) |
| **IRLR7843 MOSFET** | Electronic switch that turns pump on/off | Digital (GPIO 10, active-HIGH) |
| **Water pump** | Waters the plant | Controlled by MOSFET, powered by 5V |

### I2C Bus — How Two Sensors Share Two Wires

I2C is a communication protocol that lets multiple sensors share the same 2 wires (SDA = data, SCL = clock). Each sensor has a unique address:
- BME280 → `0x77`
- VEML7700 → `0x10`

The ESP32 talks to each one by sending its address first, then the command.

### ADC — How Soil Moisture Is Read

ADC (Analog-to-Digital Converter) turns a voltage into a number. The soil sensor outputs a voltage based on how wet the soil is. The ESP32 reads it as a number from 0 to 4095:
- **Low number (e.g. 1000)** = wet soil (more conductive = lower resistance = lower voltage)
- **High number (e.g. 3500)** = dry soil

### MOSFET — How the Pump Is Controlled

A MOSFET is a transistor used as an electronic switch. The ESP32 GPIO can't power a pump directly (not enough current). Instead:
- GPIO 10 → Gate pin of MOSFET (control signal)
- `HIGH` (3.3V) → MOSFET turns ON → pump runs
- `LOW` (0V) → MOSFET turns OFF → pump stops

The pump is powered by its own 5V supply. The MOSFET just acts as the gate.

---

## 3. The Software — Big Picture

The firmware is written in **C++ using the Arduino framework** and runs on **FreeRTOS** (a real-time operating system for microcontrollers).

### What is FreeRTOS?

Normally a microcontroller runs one thing at a time, top to bottom. FreeRTOS lets you run **multiple tasks "simultaneously"** by rapidly switching between them. Think of it like your phone running Spotify and Maps at the same time — it's actually switching very fast.

The ESP32-S3 has **two CPU cores** (Core 0 and Core 1). FreeRTOS can pin tasks to specific cores so they truly run in parallel.

### The Three Tasks

```
┌─────────────────────────────────────────────────────────────────┐
│                        ESP32-S3 (2 cores)                       │
│                                                                  │
│   Core 0                          Core 1                        │
│   ──────────────────               ──────────────────────────   │
│   taskReadSensors                  taskFirebaseSync              │
│   (every 2 seconds)                (every 3 seconds)            │
│                                                                  │
│                        taskPumpControl                           │
│                        (Core 1, always running)                  │
└─────────────────────────────────────────────────────────────────┘
```

| Task | Core | Interval | Responsibility |
|------|------|----------|----------------|
| `taskReadSensors` | Core 0 | Every 2s | Read all sensors, store in shared state |
| `taskFirebaseSync` | Core 1 | Every 3s | Push data to Firebase, check for commands |
| `taskPumpControl` | Core 1 | Continuous | Watch for pump request, run watering cycle |

---

## 4. Shared State — How Tasks Talk to Each Other

The three tasks need to share data. For example, `taskReadSensors` reads the soil moisture and `taskPumpControl` needs that value to decide when to stop watering.

They share a global struct called `SensorState`:

```cpp
struct SensorState {
  float    temperatureC;   // e.g. 22.4
  float    pressurePa;     // e.g. 101325
  float    humidity;       // e.g. 45.2 (NAN if no BME280)
  uint16_t soilRaw;        // 0–4095 (higher = drier)
  float    lux;            // e.g. 420.5 (ambient light)
  bool     tankEmpty;      // true = no water in tank
  bool     pumpRunning;    // true = pump is on right now
};
```

### The Mutex Problem

If two tasks read/write the same memory at the exact same time, you get **corrupted data** (like two people writing on the same paper simultaneously). To prevent this, a **mutex (mutual exclusion lock)** is used:

```
Task wants to read/write gState:
  1. Try to take the mutex (lock it)
  2. If locked by another task → wait up to 50ms
  3. Once you have the lock → read/write safely
  4. Release the mutex (unlock it)
```

There are two mutexes:
- `gStateMutex` — protects `SensorState gState` (sensor readings)
- `gFirebaseMutex` — protects all Firebase calls (only one task talks to Firebase at a time)

---

## 5. Boot Sequence — What Happens When You Power On

```
Power ON
    │
    ▼
delay(3000) ──── Wait for USB serial to initialize
    │
    ▼
digitalWrite(RELAY_PIN, LOW) ──── SAFETY: ensure pump is OFF before anything else
    │
    ▼
initializeHardware()
    │   ├── Wire.begin(SDA=5, SCL=9) ──── Start I2C bus
    │   ├── Scan I2C bus (0x00–0x7F)
    │   │       ├── Found 0x10 → VEML7700
    │   │       └── Found 0x77 → BME280 (or 0x76)
    │   ├── Read chip ID register
    │   │       ├── 0x60 → BME280 (has humidity)
    │   │       └── 0x58 → BMP280 (no humidity)
    │   ├── Initialize matching Adafruit library
    │   ├── veml.begin() ──── Start VEML7700
    │   └── pinMode(TANK_SENSOR_PIN, INPUT_PULLUP)
    │
    ▼
WiFiManager.autoConnect("SmartPlantPro_XXXXXX")
    │   ├── If saved WiFi credentials exist → connect automatically
    │   └── If no credentials → open Access Point "SmartPlantPro_XXXXXX"
    │           └── User connects phone to AP → opens 192.168.4.1
    │                   └── User enters WiFi password (+ optional Firebase config)
    │                           └── Saves to flash (NVS), reboots
    │
    ▼
WiFi connected
    │
    ▼
Firebase.begin(apiKey, dbUrl) ──── Connect to Firebase
Firebase.signInWithEmailAndPassword() ──── Authenticate
    │
    ▼
Create FreeRTOS tasks:
    ├── xTaskCreatePinnedToCore(taskReadSensors,  Core 0, priority 2)
    ├── xTaskCreatePinnedToCore(taskFirebaseSync, Core 1, priority 1)
    └── xTaskCreatePinnedToCore(taskPumpControl,  Core 1, priority 3)
    │
    ▼
setup() returns → FreeRTOS scheduler takes over → tasks run forever
```

---

## 6. WiFiManager — The Access Point Setup Flow

WiFiManager is a library that handles WiFi provisioning without hardcoding credentials.

**First boot (no saved WiFi):**
1. ESP32 creates its own WiFi hotspot: `SmartPlantPro_E10E3C` (suffix = last 6 of MAC address)
2. User connects their phone to this hotspot
3. A captive portal page opens automatically at `192.168.4.1`
4. User picks their home WiFi from the list, enters password
5. WiFiManager saves credentials to **NVS** (Non-Volatile Storage = the ESP32's internal flash memory that survives reboots)
6. ESP32 restarts and connects to home WiFi automatically

**Every subsequent boot:**
- WiFiManager reads saved credentials from NVS and connects in ~3 seconds

**The PIN-protected Firebase section:**
- The portal also has an "Advanced settings" section hidden behind a 4-digit PIN (`1234`)
- This lets you configure which Firebase project the device talks to
- Saves to NVS under the `"fb"` namespace

**Blocked networks:**
The firmware has a list of captive portal WiFi networks (UBC, Xfinity, Starbucks, etc.) that it refuses to connect to. These block HTTPS, which breaks Firebase. If it detects SSL failures 15 times in a row, it wipes saved WiFi and restarts into AP mode.

---

## 7. taskReadSensors — Reading the Sensors

**Runs on:** Core 0  
**Every:** 2 seconds

```
Loop forever:
    │
    ▼
Create local SensorState (stack copy, not shared yet)
    │
    ▼
Read BME280/BMP280:
    ├── bme.readTemperature()  → local.temperatureC
    ├── bme.readPressure()     → local.pressurePa
    └── bme.readHumidity()     → local.humidity
    │
    ▼
Fake sensor detection:
    └── If first 5 humidity readings are 0, 100, or NaN
            → "BME280 clone" — downgrade to BMP280 mode
    │
    ▼
Sanity check: reject impossible values
    ├── Temperature outside -20°C to 60°C → flag as bad
    └── Pressure outside 80,000–110,000 Pa → flag as bad
    │
    ▼
analogRead(SOIL_SENSOR_PIN)     → local.soilRaw  (0–4095)
veml.readLux()                  → local.lux      (float, e.g. 420.5 lx)
digitalRead(TANK_SENSOR_PIN)    → local.tankEmpty (LOW = closed = empty)
digitalRead(RELAY_PIN) == HIGH  → local.pumpRunning
    │
    ▼
Take gStateMutex → copy local into gState → release mutex
    │
    ▼
vTaskDelay(2000ms) → sleep, yield to other tasks
```

---

## 8. taskFirebaseSync — Pushing Data to the Cloud

**Runs on:** Core 1  
**Every:** 3 seconds (with a 1-second inner loop for fast command polling)

### What Gets Pushed to Firebase

Every 3 seconds, the sync task builds a JSON object and writes it to Firebase:

**`devices/{MAC}/readings/`** — live sensor data (overwritten every 3s):
```json
{
  "temperature": 22.4,
  "pressure": 101325,
  "humidity": 45.2,
  "soilRaw": 2400,
  "lux": 420.5,
  "tk": 0,
  "pumpRunning": false,
  "health": "OK",
  "timestamp": 1742345678,
  "wifiSSID": "HomeWiFi",
  "wifiRSSI": -62
}
```

**`devices/{MAC}/history/{epoch}/`** — snapshot saved every ~60 seconds (permanent log):
```json
{
  "t": 22.4,
  "p": 101325,
  "h": 45.2,
  "s": 2400,
  "l": 420.5,
  "pu": 0,
  "tk": 0
}
```
The key is the Unix timestamp (seconds since Jan 1 1970). This is how the history chart and Excel export work — each snapshot is stored forever, keyed by time.

**`deviceList/{MAC}/lastSeen`** — timestamp updated every sync, used by dashboard to show "online/offline"

**`devices/{MAC}/diagnostics/`** — uptime, sync success/fail counts, WiFi signal strength

**`devices/{MAC}/alerts/lastAlert`** — written when health is not OK (e.g. tank empty, overheating)

### What Gets Read from Firebase (Commands)

Every 1 second, the sync task checks for commands from the app:

| Firebase Path | What It Does |
|--------------|-------------|
| `control/pumpRequest` | `true` = user tapped "Water Now" in app |
| `control/targetSoil` | Desired soil moisture level (default 2800) |
| `control/resetProvisioning` | `true` = wipe WiFi, go back to AP setup mode |
| `control/schedule/*` | Automatic watering schedule config |

### The Reset Provisioning Safety

There's a tricky edge case: if the ESP32 crashes while writing `resetProvisioning = false`, the flag stays `true` in Firebase. On the next boot it would read `true` and immediately reset again — an **infinite reset loop**.

The fix is a 15-second **grace period** on boot:
- During the first 15s: silently clear any stale `resetProvisioning` flag without acting on it
- After 15s: if the flag is `true`, it's a real user request — execute the reset

---

## 9. taskPumpControl — The Watering Logic

**Runs on:** Core 1  
**Style:** Continuous loop, sleeps 500ms when idle

```
Loop forever:
    │
    ▼
Is gPumpRequest false?
    └── YES → updateRelay(false), sleep 500ms, repeat
    │
    ▼
gPumpRequest = true → watering requested
    │
    ▼
Check tankEmpty:
    └── If tank is empty:
            → updateRelay(false)
            → gPumpRequest = false
            → Write alert to Firebase ("tank empty")
            → Sleep, loop (don't water without water!)
    │
    ▼
Record soilBefore (current soil reading)
    │
    ▼
updateRelay(true) → GPIO 10 HIGH → MOSFET ON → pump runs
    │
    ▼
Pulse loop (1s ON / 5s soak, repeat):
    ├── Run pump 1 second (PUMP_PULSE_MS)
    ├── Stop pump, wait 5 seconds (PUMP_SOAK_MS) — water soaks into soil
    ├── Read soil moisture again
    ├── If soilRaw <= targetSoil → soil is wet enough → STOP
    ├── If total time > 60 seconds → TIMEOUT SAFETY → STOP
    └── Else → run another pulse
    │
    ▼
updateRelay(false) → pump OFF
    │
    ▼
Record soilAfter
    │
    ▼
Write water log entry to Firebase:
    └── { reason, durationMs, soilBefore, soilAfter }
    │
    ▼
If triggered by schedule → update todaySeconds, lastWateredAt
    │
    ▼
gPumpRequest = false → ready for next request
```

### Why Pulse Watering?

Instead of running the pump continuously, it runs in 1-second pulses with 5-second soaks. This gives the water time to absorb into the soil before checking if more is needed. Prevents over-watering.

---

## 10. Automatic Schedule — taskScheduleCheck

Called every ~60 seconds from inside `taskFirebaseSync`.

Reads the schedule config from Firebase:
- `enabled` — is auto-watering on?
- `hour`, `minute` — what time to water (e.g. 8:00 AM)
- `targetSoil` — desired soil moisture level
- `hysteresis` — buffer to prevent flip-flopping (e.g. 200 ADC units)
- `maxSecondsPerDay` — daily pump runtime cap (safety)
- `cooldownMinutes` — minimum gap between waterings

**All four conditions must be true to trigger:**
1. Current time is within 5 minutes of scheduled time
2. Soil is dry enough (`soilRaw > targetSoil + hysteresis`)
3. Cooldown period has passed
4. Daily cap not exceeded

If all four pass: `gPumpRequest = true` with reason "schedule" → `taskPumpControl` handles the rest.

---

## 11. Firebase Architecture — How the Cloud Database Is Structured

Firebase Realtime Database stores data as a JSON tree. Here's the full structure:

```
Firebase RTDB
│
├── devices/
│   └── 3C:0F:02:E1:0E:3C/          ← device MAC address as key
│       ├── readings/                 ← LIVE data, overwritten every 3s
│       │   ├── temperature: 22.4
│       │   ├── humidity: 45.2
│       │   ├── soilRaw: 2400
│       │   ├── lux: 420.5
│       │   ├── tk: 0
│       │   ├── pumpRunning: false
│       │   └── timestamp: 1742345678
│       │
│       ├── history/                  ← permanent snapshots, ~every 60s
│       │   ├── 1742340000/           ← Unix epoch as key
│       │   │   └── { t, p, h, s, l, pu, tk }
│       │   └── 1742340060/
│       │       └── { t, p, h, s, l, pu, tk }
│       │
│       ├── control/                  ← commands FROM app TO device
│       │   ├── pumpRequest: false
│       │   ├── targetSoil: 2800
│       │   ├── resetProvisioning: false
│       │   └── schedule/
│       │       ├── enabled: true
│       │       ├── hour: 8
│       │       └── minute: 0
│       │
│       ├── diagnostics/              ← device health metrics
│       │   ├── uptimeSec: 3600
│       │   ├── syncSuccessCount: 1200
│       │   └── wifiRSSI: -62
│       │
│       ├── alerts/lastAlert          ← most recent alert
│       └── waterLog/                 ← log of all watering events
│
├── users/
│   └── {uid}/
│       └── devices/
│           └── 3C:0F:02:E1:0E:3C: true   ← which devices this user owns
│
└── deviceList/
    └── 3C:0F:02:E1:0E:3C/
        └── lastSeen: 1742345678      ← for online/offline detection
```

---

## 12. Security — Firebase Rules

The Firebase security rules ensure only authenticated users can read/write their own device's data:

```
devices/{MAC}/  →  only readable if user owns that MAC
                   (checked via users/{uid}/devices/{mac})
users/{uid}/    →  only the user themselves can read/write
deviceList/     →  any logged-in user can write (for lastSeen)
```

This means even if someone knows your device's MAC address, they can't read your sensor data unless they're logged in to your account.

---

## 13. OTA Updates — Updating Firmware Over WiFi

The firmware includes **ArduinoOTA** — Over-The-Air update support. Once the device is on your WiFi, you can flash new firmware from PlatformIO without plugging in USB. It shows up as a network port in the IDE.

---

## 14. Key Design Decisions — What to Talk About in an Interview

**"Why FreeRTOS tasks instead of one big loop?"**  
Sensor reading and Firebase sync have different timing requirements. Firebase calls can block for hundreds of milliseconds (network round trip). If done in a single loop, sensors would stop reading during that time. FreeRTOS lets both run independently so sensors always update on schedule.

**"Why mutexes?"**  
The ESP32-S3 has two cores running in true parallel. Without a mutex, Core 0 could write to `gState` while Core 1 is halfway through reading it, giving corrupt data. The mutex ensures atomic access.

**"How does the pump know when to stop?"**  
It reads `targetSoil` from Firebase (set by the user in the app). It runs in 1-second pulses until `soilRaw` drops to or below that target, with a 60-second absolute safety timeout.

**"What happens if WiFi drops?"**  
`Firebase.ready()` returns false. The sync task skips that cycle and tries again next cycle. Sensor reading continues uninterrupted. If it fails 15 times consecutively (15–45 seconds), the firmware assumes it's on a captive portal network and resets WiFi credentials.

**"How is the device identified in the cloud?"**  
By its MAC address (e.g. `3C:0F:02:E1:0E:3C`). This is hardware-unique and permanent. It becomes the key in the Firebase database and is embedded in the AP hotspot name.

**"Why is CSB on the BME280 tied to 3.3V?"**  
CSB (Chip Select Bar) selects the communication protocol. Floating = undefined behavior, might pick SPI. Tying to 3.3V forces I2C mode. Without this, the sensor won't respond on I2C.

**"What's the difference between readings and history?"**  
`readings/` is one node — overwritten every 3 seconds. It's the "right now" snapshot.  
`history/` grows forever — a new timestamped entry every ~60 seconds. Used for charts and Excel export.

---

## 15. Complete Flow Diagram

```
                    ┌─────────────┐
                    │  POWER ON   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  GPIO INIT  │ Pump OFF, I2C start
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ SENSOR INIT │ Scan I2C, detect BME/BMP,
                    │             │ init VEML7700
                    └──────┬──────┘
                           │
                    ┌──────▼──────────────────────┐
                    │      WiFiManager             │
                    │  Saved creds? → Connect      │
                    │  No creds? → Open AP portal  │
                    └──────┬───────────────────────┘
                           │ WiFi connected
                    ┌──────▼──────┐
                    │  Firebase   │ Authenticate with
                    │  Auth       │ email/password
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
    ┌─────────▼──┐  ┌──────▼──────┐  ┌─▼───────────┐
    │taskRead    │  │taskFirebase │  │taskPump     │
    │Sensors     │  │Sync         │  │Control      │
    │(Core 0)    │  │(Core 1)     │  │(Core 1)     │
    │every 2s    │  │every 3s     │  │idle 500ms   │
    └─────┬──────┘  └──────┬──────┘  └──────┬──────┘
          │                │                │
    Read BME280      Push to RTDB      Wait for
    Read VEML7700    Check commands    gPumpRequest
    Read soil ADC    Check schedule    = true
    Read float sw    Check reset flag
          │                │                │
    Lock mutex       Lock mutex        Lock mutex
    Write gState     Read gState       Read gState
    Unlock mutex     Unlock mutex      Unlock mutex
                           │                │
                    Write Firebase    Run pump pulses
                    readings/         until soil wet
                    history/          or 60s timeout
                    diagnostics/
```

---

## 16. Libraries Used

| Library | What It Does |
|---------|-------------|
| `Arduino.h` | Core Arduino functions (pinMode, digitalWrite, analogRead, delay) |
| `Wire.h` | I2C communication protocol driver |
| `WiFi.h` | ESP32 WiFi stack |
| `WiFiManager` | Captive portal for WiFi provisioning |
| `ArduinoOTA` | Over-the-air firmware updates |
| `Preferences.h` | Read/write key-value pairs to ESP32 flash (NVS) |
| `Adafruit_BME280` | Driver for BME280 temperature/humidity/pressure sensor |
| `Adafruit_BMP280` | Driver for BMP280 (no humidity version) |
| `Adafruit_VEML7700` | Driver for VEML7700 ambient light sensor |
| `Firebase_ESP_Client` | Firebase Realtime Database client for ESP32 |

---

## 17. Glossary — Terms You'll Be Asked About

| Term | Plain English |
|------|--------------|
| **FreeRTOS** | Mini operating system for microcontrollers. Runs multiple tasks "at the same time" |
| **Task** | A function that runs forever in its own loop, managed by FreeRTOS |
| **Mutex** | A lock that prevents two tasks from reading/writing the same data simultaneously |
| **I2C** | Two-wire protocol (SDA + SCL) for multiple sensors on one bus |
| **ADC** | Converts analog voltage (0–3.3V) to a digital number (0–4095) |
| **MOSFET** | Electronic transistor used as a switch. Controls high-current devices from a low-power GPIO |
| **NVS** | Non-Volatile Storage — ESP32's internal flash. Survives power cuts |
| **Firebase RTDB** | Google's cloud JSON database. Updates propagate to all clients in real time |
| **MAC address** | Hardware-unique identifier of a WiFi chip. Used as device ID |
| **GPIO** | General Purpose Input/Output — the physical pins on the microcontroller |
| **INPUT_PULLUP** | A GPIO mode with an internal resistor pulling the pin HIGH. External switch pulls it LOW |
| **Active-HIGH** | Signal is "active" (does the thing) when the pin is HIGH (3.3V) |
| **Epoch / Unix timestamp** | Seconds since January 1, 1970. Used as unique time-based keys in Firebase |
| **OTA** | Over-The-Air — updating firmware without a USB cable |
| **PWM** | Pulse Width Modulation — rapidly switching a pin ON/OFF to simulate analog output |
| **SSL** | Encrypted connection. Firebase requires HTTPS (SSL). Captive portal WiFi blocks it |
