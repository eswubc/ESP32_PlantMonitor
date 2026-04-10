# Smart Plant Pro — User Manual

This guide covers everything from assembling the hardware to using the dashboard day-to-day.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Hardware Assembly](#2-hardware-assembly)
3. [Flashing Firmware](#3-flashing-firmware)
4. [WiFi Setup (First Boot)](#4-wifi-setup-first-boot)
5. [Dashboard Setup](#5-dashboard-setup)
6. [Daily Usage](#6-daily-usage)
7. [Watering](#7-watering)
8. [Calibration](#8-calibration)
9. [Plant Profiles](#9-plant-profiles)
10. [Multi-Device](#10-multi-device)
11. [Troubleshooting](#11-troubleshooting)
12. [Changing WiFi](#12-changing-wifi)
13. [Security & Credentials](#13-security--credentials)

---

## 1. Introduction

### What You'll Need

**Hardware:**
- 1x ESP32 development board (ESP32-D DevKit or ESP32-S3 Zero)
- 1x BME280 or BMP280 sensor module (I2C)
- 1x Capacitive soil moisture sensor
- 1x LDR light sensor module (digital output)
- 1x Relay module (active-low, single channel)
- 1x Small water pump + tubing
- Jumper wires, breadboard or PCB
- USB cable for programming

**Software:**
- [PlatformIO](https://platformio.org/) (VS Code extension or CLI)
- A modern web browser (Chrome, Firefox, Safari, Edge)
- A phone or laptop for WiFi setup

**Accounts:**
- A [Firebase](https://firebase.google.com/) project with Realtime Database and Authentication enabled

### BME280 vs BMP280 — Which Do You Have?

Both sensors look nearly identical. The key difference:

- **BME280** — Reads temperature, pressure, **and humidity**. Chip ID: `0x60`.
- **BMP280** — Reads temperature and pressure only. **No humidity**. Chip ID: `0x58`.

The firmware auto-detects which sensor you have at boot. If you have a BMP280 (or a cheap BME280 clone that reports bad humidity), the dashboard will simply not show the humidity reading. Check the serial monitor output at boot — it will print `Detected: BME280` or `Detected: BMP280`.

Some cheap "BME280" modules are actually BMP280 clones with a fake chip ID. The firmware detects these by checking if humidity is stuck at 0%, 100%, or NaN for the first 5 readings, and automatically downgrades to BMP280 mode.

---

## 2. Hardware Assembly

### ESP32-D (DevKit) Pinout

| Component | GPIO Pin | Connection |
|-----------|----------|------------|
| BME280/BMP280 SDA | **33** | I2C data line |
| BME280/BMP280 SCL | **32** | I2C clock line |
| Soil moisture sensor | **34** | Analog output → ADC input |
| LDR light module | **35** | Digital output (LOW = bright) |
| Relay module IN | **25** | Control signal (active-low) |

### ESP32-S3 Zero (Waveshare) Pinout

| Component | GPIO Pin | Connection |
|-----------|----------|------------|
| BME280/BMP280 SDA | **8** | I2C data line |
| BME280/BMP280 SCL | **9** | I2C clock line |
| Soil moisture sensor | **4** | Analog output → ADC input |
| LDR light module | **6** | Digital output (LOW = bright) |
| Relay module IN | **10** | Control signal (active-low) |

> **Note:** The ESP32-S3 Zero pins are set via the `-DBOARD_ESP32_S3_ZERO` build flag in `platformio.ini`. The firmware currently uses hardcoded pin values per board — there is no runtime pin selection.

### Power Connections

All sensors and the relay module need **3.3V** (or 5V if your module has a regulator) and **GND** from the ESP32.

| Component | VCC | GND |
|-----------|-----|-----|
| BME280/BMP280 | 3.3V | GND |
| Soil moisture sensor | 3.3V | GND |
| LDR module | 3.3V | GND |
| Relay module | 5V (or 3.3V) | GND |

### Relay & Pump Wiring

The relay controls the water pump. **Important safety notes:**

- The relay is **active-low**: `LOW` signal = pump **ON**, `HIGH` signal = pump **OFF**
- On boot, the firmware immediately sets the relay pin to `HIGH` (pump OFF) before anything else runs
- Wire the pump through the relay's **Normally Open (NO)** terminal so the pump stays off when the ESP32 is unpowered
- Use an appropriate power supply for your pump (usually 5V or 12V, separate from the ESP32)

```
ESP32 GPIO 25 ──→ Relay IN
                  Relay NO ──→ Pump (+)
                  Relay COM ──→ Pump power supply (+)
                  Pump (−) ──→ Pump power supply (−)
```

### I2C Sensor Address

The BME280/BMP280 is typically at I2C address **0x76** (default when SDO is connected to GND) or **0x77** (SDO connected to VCC). The firmware auto-scans both addresses at boot.

---

## 3. Flashing Firmware

### Install PlatformIO

1. Install [VS Code](https://code.visualstudio.com/)
2. Install the [PlatformIO IDE extension](https://marketplace.visualstudio.com/items?itemName=platformio.platformio-ide) from the Extensions marketplace
3. Restart VS Code

Or install the CLI:
```bash
pip install platformio
```

### Clone and Build

```bash
git clone <repository-url>
cd ESP32_PlantMonitor
```

### Select Your Board and Upload

**ESP32-D (DevKit):**
```bash
pio run -e esp32dev -t upload
```

**ESP32-S3 Zero (Waveshare):**
```bash
pio run -e esp32-s3-zero -t upload
```

### Monitor Serial Output

```bash
pio device monitor -b 115200
```

You should see:
```
========================================
Smart Plant Pro – Firebase RTDB (v2 WiFi-block)
========================================

===== Smart Plant Sensor Check =====
I2C Address: 0x76
Chip ID:     0x60
Detected:    BME280
Temperature: 23.5 C (OK)
Pressure:    101325 Pa (OK)
Humidity:    45.2 % (OK)
====================================

[AP] When in setup mode: SSID=SmartPlantPro_BD36CC  MAC=3C:0F:02:DF:73:74
```

If the device has no saved WiFi, it will enter AP mode next (see [WiFi Setup](#4-wifi-setup-first-boot)).

---

## 4. WiFi Setup (First Boot)

On first boot (or after a WiFi reset), the ESP32 starts a WiFi access point for configuration.

### Step-by-Step

1. **Look for the AP** — On your phone or laptop, find a WiFi network named **SmartPlantPro_XXXXXX** (the last 6 hex characters of the device's MAC address)
2. **Join the AP** — Connect to it. A captive portal should open automatically. If not, open a browser and go to **http://192.168.4.1**
3. **Landing page** — You'll see the Smart Plant Pro setup page with your device's MAC address. Click **Configure WiFi**
4. **Select your WiFi** — Pick your home WiFi network from the scan list and enter the password
5. **Optional: Firebase config** — Below the WiFi fields, there's an "Advanced settings" section behind a PIN gate. Enter PIN **1234** to unlock it. You can enter:
   - Firebase API Key
   - Firebase DB URL
   - Firebase user email
   - Firebase user password

   Leave these empty to use compile-time defaults (from `secrets.h` or `firebase_defaults.h`).
6. **Save** — Click Save. A "Connecting to WiFi..." spinner appears. The device connects to your WiFi and reboots

### What Happens on Success

After saving, the device:
1. Connects to your WiFi network
2. Syncs time via NTP (pool.ntp.org)
3. Authenticates with Firebase
4. Starts syncing sensor readings every 3 seconds
5. The serial monitor shows: `WiFi connected, IP: 192.168.x.x`

### What If It Fails

- **Wrong password** — The device retries once, then falls back to AP mode. Try again.
- **Guest/captive network** — Networks like `ubcvisitor`, `xfinitywifi`, `starbucks`, etc. are automatically blocked. Use a standard home or office WiFi.
- **NTP failure** — If the device can't reach NTP servers (network blocks internet), it clears WiFi and restarts in AP mode with an error message in serial.

---

## 5. Dashboard Setup

### Create an Account

1. Open the dashboard URL (local: `http://localhost:5173`, or your Vercel deployment URL)
2. Click **Sign Up**
3. Enter an email and password
4. You're now logged in

### Claim Your Device

1. From the dashboard, click **Claim Device** (or navigate to `/claim`)
2. **Enter the device MAC address** — Find it in the serial monitor output: `Device ID (MAC): 3C:0F:02:DF:73:74`
3. **Or discover online devices** — The claim page can show devices that are currently syncing to Firebase but haven't been claimed yet
4. Optionally add a **device name** (e.g., "Kitchen Herbs") and **room** (e.g., "Kitchen")
5. Click **Claim** — The device now appears in your dashboard's device dropdown

---

## 6. Daily Usage

### Reading the Dashboard

The main dashboard shows real-time data from your selected device:

- **Status indicator** — Top of page, shows device connectivity:
  - **Live** (green) — Data received within the last 10 seconds
  - **Delayed** (yellow) — Data is 10–60 seconds old
  - **Offline** (red) — No data for over 60 seconds
  - **Syncing** — Device is connecting/reconnecting

- **Soil moisture gauge** — Circular gauge showing soil moisture level:
  - **Soggy** — Very wet (may be overwatered)
  - **Ideal** — Good moisture level
  - **Dry** — Needs watering
  - **Very Dry** — Urgently needs watering

  The gauge uses raw ADC values by default. After [calibration](#8-calibration), it maps to your sensor's actual dry/wet range.

- **Sensor cards** — Temperature (°C), atmospheric pressure (Pa), humidity (% — only if BME280), and light status (bright/dim)

- **Health alerts** — When the device detects issues (overheat >45°C, humidity >95%, pump running but soil still dry), a banner appears. You can dismiss alerts.

- **History charts** — Toggle between 6h, 12h, and 24h views of temperature, pressure, humidity, and soil moisture over time

### Dark Mode

Click the theme toggle icon (top-right on login page, or in the dashboard header) to switch between light and dark mode. Your preference is saved in the browser.

---

## 7. Watering

### Manual Watering

1. On the dashboard, find the **"Water Now"** button
2. Click it — the button enters a cooldown state (8 seconds between presses)
3. The ESP32 receives the pump request within ~1 second
4. **Pulse watering runs:** pump ON for 1 second, OFF for 5 seconds (soak), repeat
5. Watering stops when soil moisture reaches the **target soil** threshold
6. The pump status indicator shows when the pump is actively running

### Setting the Target Soil

The **target soil** is the raw ADC value the pump tries to reach. Lower values = wetter soil.

- Default: **2800** (moderately dry threshold)
- Adjust in the dashboard settings section
- Example plants have preset targets (Mint: 2000, Succulent: 1800, Tomato: 2600)

### Automated Watering Schedule

Set up time-based automatic watering in the **Schedule** section:

| Setting | What It Does |
|---------|-------------|
| **Enabled** | Toggle the schedule on/off |
| **Time** | Hour and minute to check for watering (24h format) |
| **Hysteresis** | Added to target soil to determine "start watering" threshold. Prevents rapid on/off cycling. Default: 200 |
| **Max seconds/day** | Daily watering cap in seconds. Prevents overwatering even if soil stays dry. Default: 120 |
| **Cooldown (min)** | Minimum minutes between watering sessions. Default: 30 |

**How it works:** Every ~60 seconds, the ESP32 checks the schedule. If the current time is within 5 minutes of the scheduled time, the soil is dry (above target + hysteresis), cooldown has passed, and the daily cap hasn't been reached, it triggers pulse watering.

### How Pulse Watering Works

Instead of running the pump continuously (which can flood the soil), Smart Plant Pro uses pulse watering:

1. Pump **ON** for 1 second
2. Pump **OFF** for 5 seconds (let water soak into soil)
3. Read soil moisture
4. If still above target → repeat from step 1
5. If at or below target → stop, clear pump request

Each pulse is logged in the **Water Log** with: reason (manual/schedule), duration, soil before, and soil after.

---

## 8. Calibration

### What Is Calibration?

Every capacitive soil sensor has slightly different ADC readings for "completely dry" and "completely wet." Calibration tells the dashboard your sensor's specific range so the soil gauge is accurate.

- **Bone Dry** — The ADC reading when the sensor is in completely dry air (typically ~3200–3800)
- **Submerged** — The ADC reading when the sensor is submerged in water (typically ~1200–1600)

### How to Calibrate

1. Open the dashboard and select your device
2. Find the **Calibration** section in settings
3. **Mark as Dry:**
   - Remove the soil sensor from soil and let it dry (or hold it in air)
   - Wait for the soil reading to stabilize (~10 seconds)
   - Click **"Mark as Dry"** — this saves the current reading as your `boneDry` value
4. **Mark as Wet:**
   - Submerge the sensor tip in a glass of water
   - Wait for the reading to stabilize
   - Click **"Mark as Wet"** — this saves the current reading as your `submerged` value

### When to Recalibrate

- After replacing the soil sensor
- If the soil gauge seems inaccurate
- If you move the sensor to a very different soil type

Calibration values are stored per-device in Firebase at `devices/{MAC}/calibration/`.

---

## 9. Plant Profiles

Plant profiles let you store ideal conditions for different types of plants and link them to devices.

### Creating a Profile

1. In the dashboard, find the **Plant Profiles** section
2. Click **"New Profile"**
3. Enter:
   - **Name** (e.g., "My Basil")
   - **Type** (e.g., "Herb")
   - Optional thresholds: soil min/max, temperature min/max, humidity min/max, light preference (bright/dim/any)
4. Save the profile

### Example Plants

The dashboard offers quick-start presets:
- **Mint** — Target soil: 2000 (likes moist soil)
- **Sunflower** — Target soil: 2400
- **Herb/Spice** — Target soil: 2200
- **Succulent** — Target soil: 1800 (likes dry soil)
- **Tomato** — Target soil: 2600

Selecting a preset fills in the target soil value.

### Linking to a Device

After creating a profile, link it to a device. The dashboard will show the profile's name and give care tips based on the plant type.

---

## 10. Multi-Device

### Adding More Devices

Each ESP32 is a separate device identified by its unique MAC address. To add more:

1. Flash firmware to a new ESP32
2. Set up WiFi via the captive portal
3. Claim the new device in the dashboard (enter its MAC)

### Switching Between Devices

Use the **device dropdown** at the top of the dashboard to switch between your claimed devices. Your last selection is remembered in the browser.

### Overview Page

Navigate to `/overview` for a grid view showing all your devices at a glance with their current readings and status.

---

## 11. Troubleshooting

### Device Shows "Offline"

- **Check power** — Is the ESP32 powered on? Check the LED.
- **Check WiFi** — Is the device connected to WiFi? Check serial monitor.
- **Check Firebase** — Serial monitor shows `[Sync] Push #N OK` on successful syncs. If you see `RTDB update FAILED`, check your Firebase credentials.
- **Network change** — If you changed your WiFi password, you'll need to [reset WiFi](#12-changing-wifi).

### WiFi Won't Connect

- **Wrong password** — The device tries once, then falls back to AP mode. Look for the SmartPlantPro AP again.
- **Blocked network** — Guest networks (ubcvisitor, xfinitywifi, starbucks, etc.) are blocked. Use home/office WiFi.
- **Too far from router** — Move the device closer. The minimum signal quality is set to 10%.

### Sensor Not Detected

Serial monitor shows `No supported sensor detected`:
- **Check wiring** — Verify SDA/SCL connections match your board's pinout
- **Check I2C address** — The sensor should be at 0x76 or 0x77
- **Check power** — Sensor needs 3.3V
- **Try the other address** — If your sensor's SDO pin is wired differently, the address changes

### Pump Not Responding

- **Check relay wiring** — Ensure the relay IN pin is connected to the correct GPIO
- **Check relay type** — Must be active-low (LOW = ON). If yours is active-high, the logic is inverted
- **Check pump power** — The pump needs its own power supply through the relay
- **Check target soil** — If the soil reading is already at or below the target, the pump won't run
- **Cooldown** — There's an 8-second cooldown between manual pump commands

### SSL/Connection Failures

If the serial monitor shows SSL errors or connection failures:
- The device counts consecutive failures. After 15 failures, it automatically clears WiFi and restarts in AP mode
- This usually means the network is blocking HTTPS traffic (common on guest/captive networks)
- Reconnect to a standard home/office WiFi

### Dashboard Not Loading

- **Check `.env.local`** — Ensure all `VITE_FIREBASE_*` variables are set correctly
- **Check Firebase project** — Authentication must be enabled with email/password provider
- **Check RTDB URL** — Must match between frontend `.env.local` and device config
- **CORS** — Firebase RTDB doesn't have CORS issues, but check browser console for errors

---

## 12. Changing WiFi

### From the Dashboard (Recommended)

1. Open the dashboard and select the device
2. Go to **Settings** and click **"Reset Device WiFi"**
3. Confirm the action
4. The device clears its WiFi credentials and reboots into AP mode (~2 seconds)
5. Join the new SmartPlantPro AP and set up WiFi again at 192.168.4.1

**What gets preserved:** Firebase credentials (API key, DB URL, email, password) stay in NVS. Only WiFi is cleared. Your device keeps its identity and Firebase connection after reconnecting to a new network.

### Physical Reset

If you can't access the dashboard (device is offline on the old network):
1. Re-flash the firmware via USB
2. The device will boot with no saved WiFi and enter AP mode

---

## 13. Security & Credentials

### How Credentials Are Stored

- **WiFi credentials** — Stored in ESP32's flash memory by WiFiManager. Survive power cycles.
- **Firebase credentials** — Stored in NVS (Non-Volatile Storage) under the `fb` namespace. Set via the captive portal or `secrets.h`.
- **Dashboard Firebase config** — Stored in `frontend/.env.local` (never committed to git).

### Portal PIN Gate

The Firebase configuration fields in the captive portal are hidden behind a 4-digit PIN (**1234**). This prevents casual users from accidentally changing Firebase settings when they only need to set up WiFi.

### Credential Security

- Never commit `secrets.h` or `.env.local` to git (both are in `.gitignore`)
- For Vercel deployments, set environment variables in the Vercel dashboard
- See [SECURITY.md](../SECURITY.md) for what to do if credentials were accidentally exposed
