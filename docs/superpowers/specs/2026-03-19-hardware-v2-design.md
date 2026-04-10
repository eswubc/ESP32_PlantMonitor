# Hardware v2 Design Spec — ESP32-S3 Zero Plant Monitor

**Date:** 2026-03-19
**Status:** Approved
**Goal:** Swap digital light sensor → VEML7700, mechanical relay → IRLR7843 MOSFET, add float switch water tank sensor, remove I2S mic + MAX98357A amp.

---

## 1. Hardware Changes Summary

| Component | Before | After |
|-----------|--------|-------|
| Light sensor | Digital GPIO (HIGH/LOW = bright/dim) | VEML7700 I2C ambient light sensor (lux) |
| Pump control | Mechanical relay (active-LOW) | IRLR7843 N-channel MOSFET (active-HIGH) |
| Water tank | Not monitored | Float switch on GPIO 12 (LOW = empty) |
| Audio I/O | INMP441 mic + MAX98357A amp | **Removed entirely** |

---

## 2. Final Wiring

### ESP32-S3 Zero GPIO Map

| GPIO | Function | Type | Notes |
|------|----------|------|-------|
| 8 | I2C SDA | I2C | Shared: BME280 + VEML7700 |
| 9 | I2C SCL | I2C | Shared: BME280 + VEML7700 |
| 10 | MOSFET Gate → Pump | Digital OUT | Active-HIGH (was active-LOW relay) |
| 11 | Soil Moisture | Analog IN (ADC2) | Higher ADC = drier |
| 12 | Float Switch (tank) | Digital IN | INPUT_PULLUP; LOW = tank empty |
| 1,2,3 | — | — | Freed (was MAX98357A) |
| 5,6,7 | — | — | Freed (was INMP441 mic) |

---

### I2C Bus (GPIO 8 SDA / GPIO 9 SCL)

Both sensors share the same 2-wire bus. Add 4.7kΩ pull-up resistors from SDA and SCL to 3.3V if not already on the BME280 breakout board.

| Sensor | Address | VDD |
|--------|---------|-----|
| BME280 | 0x76 | 3.3V |
| VEML7700 | 0x10 (ADDR pin → GND) | 3.3V |

---

### BME280 (unchanged)

| BME280 Pin | Connects To |
|------------|-------------|
| VCC | 3.3V |
| GND | GND |
| SDA | GPIO 8 |
| SCL | GPIO 9 |

---

### VEML7700 Ambient Light Sensor (new)

| VEML7700 Pin | Connects To | Notes |
|--------------|-------------|-------|
| VDD | 3.3V | |
| GND | GND | |
| SDA | GPIO 8 | Shared I2C bus |
| SCL | GPIO 9 | Shared I2C bus |
| ADDR | GND | Sets I2C address to 0x10 |
| INT | NC | Leave floating |

---

### Soil Moisture Sensor (unchanged)

| Sensor Pin | Connects To |
|------------|-------------|
| VCC | 3.3V |
| GND | GND |
| AOUT | GPIO 11 |

---

### Float Switch — Water Tank Level (new)

Simple 2-wire magnetic reed switch. No polarity.

| Float Switch Pin | Connects To | Notes |
|------------------|-------------|-------|
| Wire 1 | GPIO 12 | INPUT_PULLUP enabled in firmware |
| Wire 2 | GND | |

**Logic:**
- GPIO 12 HIGH = tank has water (float up, switch open, pulled HIGH by internal pull-up)
- GPIO 12 LOW = tank empty (float down, switch closed to GND)

---

### IRLR7843 MOSFET — Pump Control (replaces relay)

The IRLR7843 is a logic-level N-channel MOSFET (30V, 161A, Vgs(th) ~1–2V). Its Rds(on) is rated at Vgs = 4.5V. At Vgs = 3.3V (ESP32 GPIO HIGH), Rds(on) is 2–4× higher than the datasheet minimum — the MOSFET will conduct adequately for a small 5V pump but verify it does not get hot under full pump current. If the MOSFET runs warm, add a simple NPN transistor stage or a BSS138 level shifter to drive the gate to 4.5V from 5V.

| Connection | From | To | Notes |
|------------|------|----|-------|
| Gate resistor | GPIO 10 | Gate (G) via 100Ω | Limits charge current |
| Gate pull-down | GND | Gate (G) via 10kΩ | Prevents floating gate |
| Drain | Pump − (negative) | Drain (D) | |
| Source | Source (S) | GND (shared) | ESP32 GND and battery GND must be joined |
| Pump supply | Pump + (positive) | 5V battery | |
| Flyback diode | 1N4007 cathode | 5V | Anode to Drain — absorbs inductive kick |

**⚠️ Critical:** GND of ESP32 and GND of pump battery must be connected together. Without a common ground the MOSFET will not switch.

**⚠️ Do not skip flyback diode.** DC motors generate back-EMF when switched off. The 1N4007 across the pump (cathode to V+, anode to Drain) absorbs this safely.

**Logic change from relay:**

| | Old Relay | New MOSFET |
|---|-----------|-----------|
| Pump ON | GPIO 10 → LOW | GPIO 10 → HIGH |
| Pump OFF | GPIO 10 → HIGH | GPIO 10 → LOW |

---

## 3. Removed Components

| Component | Pins Previously Used |
|-----------|---------------------|
| INMP441 I2S Microphone | GPIO 5 (SD), 6 (BCLK), 7 (WS) |
| MAX98357A I2S Amplifier | GPIO 1 (DIN), 2 (BCLK), 3 (LRC) |
| Digital light sensor | GPIO 12 (reused for float switch) |

All associated firmware code, build flags, and library dependencies to be removed.

---

## 4. Required Firmware Changes

### 4.1 Pin Definitions (`main.cpp`)
- Remove: `LIGHT_SENSOR_PIN` (GPIO 12 digital)
- Remove: `MIC_SD_PIN`, `MIC_BCLK_PIN`, `MIC_WS_PIN`
- Remove: `SPK_DIN_PIN`, `SPK_BCLK_PIN`, `SPK_LRC_PIN`
- Add: `TANK_SENSOR_PIN = 12` (float switch, INPUT_PULLUP)

### 4.2 I2C / Sensor Init
- Add: VEML7700 begin on Wire (address 0x10)
- Remove: `pinMode(LIGHT_SENSOR_PIN, INPUT_PULLUP)`
- Add: `pinMode(TANK_SENSOR_PIN, INPUT_PULLUP)`

### 4.3 SensorState struct
- Remove: `bool lightBright`
- Add: `float lux` (VEML7700 ambient light in lx)
- Add: `bool tankEmpty` (float switch state)

### 4.4 Sensor Read Task (`taskReadSensors`)
- Remove: `digitalRead(LIGHT_SENSOR_PIN)`
- Add: `veml.readLux()` → store in `s.lux`
- Add: `digitalRead(TANK_SENSOR_PIN) == LOW` → store in `s.tankEmpty`

### 4.5 Pump Control (`updateRelay`)
- Flip logic: `on ? HIGH : LOW` (was `on ? LOW : HIGH`)
- Rename function to `updatePump` (optional, for clarity)
- **Boot safety:** In `setup()` and `initializeHardware()`, change `digitalWrite(RELAY_PIN, HIGH)` → `digitalWrite(RELAY_PIN, LOW)`. With active-HIGH MOSFET, the old `HIGH` init fires the pump immediately on boot before any task scheduler runs.
- **`pumpRunning` detection:** Update line reading pump state: `local.pumpRunning = (digitalRead(RELAY_PIN) == HIGH)` (was `== LOW`). Without this fix, pump ON/OFF status is inverted in Firebase and the dashboard.

### 4.6 Firebase Sync
- Replace `l: lightBright ? 1 : 0` with `l: lux` (float, lux value) in both readings and history
- Add `tk: tankEmpty ? 1 : 0` to both readings and history snapshots
- In the `readings/` node use key `tk` (not `tankEmpty`) to match history for frontend consistency

### 4.7 Pump safety check
- Add: if `tankEmpty == true`, disable pump and send alert regardless of schedule
- Use the existing `lastAlertTs` debounce: alert fires only when `tankEmpty` transitions from false→true, or when the standard alert repeat interval elapses, not on every 3-second sync cycle

### 4.8 `platformio.ini`
- Remove: `ESP8266SAM`, I2S mic/amp libraries from all environments
- Add: `adafruit/Adafruit VEML7700 Library` to `[env:esp32-s3-zero]`
- Remove: `esp32-s3-zero-hwtest` environment entirely (hardware test mode used mic/amp)
- Update comment on `[env:esp32-s3-zero]` from `Light=12` to `Float=12`

---

## 5. Required Dashboard/Frontend Changes

### 5.1 Light display
- Replace Bright/Dim badge with numeric lux value (e.g. `1420 lx`)
- Update HistoryChart to plot lux as a continuous line (not step)

### 5.2 Tank status
- Add tank water level indicator to dashboard (green = OK, red = EMPTY)
- Show alert when `tankEmpty == true`

### 5.3 Export (Excel)
- Replace `Light` column (Bright/Dim) with `Light (lx)` column (numeric)
- Add `Tank` column (Full / Empty)

---

## 6. Firebase Schema Changes

### `devices/{mac}/readings/`
```json
{
  "temperatureC": 22.4,
  "pressurePa": 101025,
  "humidity": 46.2,
  "soilRaw": 3044,
  "lux": 1420.5,
  "tk": 0,
  "pumpRunning": 0,
  "health": "ok",
  ...
}
```

### `devices/{mac}/history/{epoch}/`
```json
{
  "t": 22.4,
  "p": 101025,
  "h": 46.2,
  "s": 3044,
  "l": 1420.5,
  "pu": 0,
  "tk": 0
}
```

**Breaking change:** `l` was previously `0` or `1` (boolean). Now it is a float lux value. Old history entries will have `l: 0` or `l: 1` — these can be treated as approximate (0 lx = dark, 1 lx = bright) or excluded from charts.
