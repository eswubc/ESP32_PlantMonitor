# Smart Plant Pro — Project Overview (Resume / Portfolio)

A one-page summary of the project for resumes, portfolios, and interviews.

---

## What It Is

**Smart Plant Pro** is a full-stack IoT plant monitoring system. ESP32 microcontrollers read environmental sensors (temperature, humidity, pressure, soil moisture, light) and relay real-time data to a cloud database. A React web dashboard displays live readings and allows remote control of automated watering — you can monitor and water your plants from anywhere.

---

## What It Does

- **Monitors plant conditions** — Temperature, humidity, pressure (BME280), soil moisture (capacitive sensor), and light level (LDR). Readings stream to the cloud every 3 seconds.
- **Automated watering** — Relay-controlled water pump activates when soil is dry. Pulse watering (1s on, 5s soak) runs until the target moisture level is reached.
- **Web dashboard** — React app (Vercel-hosted) shows live sensor data, circular soil gauge, history charts, and manual “Water now” control.
- **Multi-device support** — Each ESP32 is a node with a unique MAC address. Users claim devices and manage multiple plants from a single dashboard.
- **Zero-config WiFi setup** — First boot creates a captive portal; connect to the device’s AP, enter home WiFi and Firebase credentials once — no reflashing needed.
- **Hardware test mode** — Optional firmware build with SAM text-to-speech: clap to hear spoken sensor readings (“23 degrees, 40 percent humidity”).

---

## How It Works

```
ESP32 (sensors + pump)  —WiFi—>  Firebase Realtime DB  <—HTTPS—  React Dashboard
     every 3s push                    (cloud)              real-time listener
```

1. **ESP32** runs three FreeRTOS tasks: read sensors (2s), sync to Firebase (3s), and control the pump (event-driven).
2. **Firebase Realtime Database** stores readings under `devices/{MAC}/readings`. The web app subscribes with `onValue` and updates in real time.
3. **React dashboard** shows live data, 6/12/24h history charts, soil calibration, plant profiles, and pump control. Users sign in with Firebase Auth and claim devices by MAC address.
4. **WiFiManager** handles first-time provisioning: device creates AP “SmartPlantPro”, user configures WiFi and Firebase at 192.168.4.1.
5. **Remote reset** — “Reset WiFi” in the dashboard clears stored WiFi; device reboots into AP mode so you can reconnect it to a new network.

---

## Tech Stack

| Layer | Technologies |
|-------|---------------|
| **Firmware** | ESP32 (Arduino/PlatformIO), FreeRTOS, BME280/BMP280, Firebase-ESP-Client, WiFiManager |
| **Backend** | Firebase Realtime Database, Firebase Authentication |
| **Frontend** | React 19, TypeScript, Vite, Tailwind CSS, Framer Motion, Recharts |
| **Hosting** | Vercel (auto-deploy from GitHub) |
| **IoT / Voice** | SAM text-to-speech (ESP8266SAM), I2S audio (MAX98357, INMP441) in hardware test build |

---

## Skills Demonstrated

- **Embedded systems** — FreeRTOS multitasking, I2C/ADC/Digital GPIO, mutex-protected shared state
- **IoT / cloud** — Firebase RTDB, real-time sync, device provisioning, NVS credential storage
- **Full-stack** — React dashboard, Firebase Auth, responsive UI, PWA
- **System design** — Multi-device architecture, MAC-based device identity, stream-driven pump control
- **Hardware integration** — BME280, soil moisture, LDR, relay, optional microphone/speaker for voice feedback

---

## Project Structure

- `src/main.cpp` — ESP32 firmware (sensor tasks, Firebase sync, pump control)
- `src/hardware_test_mode.cpp` — Optional diagnostic build with SAM TTS and clap detection
- `frontend/` — React dashboard (Vite, Tailwind, Recharts)
- `platformio.ini` — Build config for ESP32-S3 Zero, ESP32-D, QT Py

---

## One-Liner for Resume

**Smart Plant Pro** — Full-stack IoT plant monitor: ESP32 sensors → Firebase Realtime DB → React dashboard; FreeRTOS, Firebase, React, multi-device claiming, automated watering.

---

## Two-Sentence Version

**Smart Plant Pro** is an IoT plant monitoring system where ESP32 devices read environmental sensors and push real-time data to Firebase. A React web dashboard displays live readings, history charts, and remote control of automated watering, with multi-device support and zero-config WiFi provisioning via captive portal.
