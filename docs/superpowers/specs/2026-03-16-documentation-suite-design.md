# Documentation Suite Design

## Overview

Three interconnected Markdown documents for the Smart Plant Pro ESP32 PlantMonitor project, using Approach B (cross-referenced docs with README as entry point).

**Audience:**
- README: GitHub visitors (recruiters, devs, classmates) + personal reference
- User Manual: Anyone from hardware assembler to dashboard-only user
- Developer Guide: A classmate picking up the codebase for the first time

---

## Document 1: README.md (Project Overview)

GitHub front door. Explains what this is, shows it off, links deeper.

### Sections

1. **Hero** — Project name, one-liner, badges (PlatformIO, React, Firebase)
2. **What is Smart Plant Pro?** — 2-3 paragraph summary: IoT plant monitor with automated watering, real-time dashboard, multi-device support
3. **Features** — Bullet list: auto-watering, real-time sync, captive portal setup, history charts, plant profiles, dark mode, multi-board support
4. **Architecture Diagram** — ASCII: `[ESP32 + Sensors] → WiFi → [Firebase RTDB] ← [React Dashboard]`
5. **Tech Stack** — Table: Firmware (ESP32/Arduino, FreeRTOS, PlatformIO), Backend (Firebase Auth + RTDB), Frontend (React 19, Vite, Tailwind, Recharts, Framer Motion), Deployment (Vercel)
6. **Quick Start** — Brief steps (flash, join AP, configure WiFi, open dashboard). Links to User Manual for details.
7. **Hardware** — Supported boards table (ESP32-S3 Zero, ESP32-D) + sensor list (BME280/BMP280, capacitive soil, LDR, relay). Links to User Manual wiring section.
8. **Project Structure** — File tree (key files only)
9. **Documentation Links** — Links to User Manual and Developer Guide

---

## Document 2: docs/user-manual.md (User Manual)

End-to-end guide from assembling hardware to daily dashboard usage.

### Sections

1. **Introduction** — What you'll need (hardware list, computer/phone, home WiFi)
2. **Hardware Assembly** — Wiring tables per board (ESP32-S3 Zero, ESP32-D), sensor connections (note: BME280 provides humidity, BMP280 does not — mention how to identify which you have), relay wiring, safety notes (active-low relay)
3. **Flashing Firmware** — Install PlatformIO, clone repo, select board environment, upload, monitor serial output
4. **WiFi Setup (First Boot)** — Join SmartPlantPro AP, open 192.168.4.1, enter WiFi creds, optional Firebase config (PIN gate), what to expect on success
5. **Dashboard Setup** — Create account (sign up), claim device (enter MAC or discover), add name/room
6. **Daily Usage** — Sensor cards, soil gauge, status indicator, health alerts, history charts (6/12/24h), light/dark mode
7. **Watering** — Manual watering (button + cooldown), auto-schedule (time, hysteresis, daily cap, cooldown), how pulse watering works
8. **Calibration** — boneDry/submerged meaning, how to calibrate, when to recalibrate
9. **Plant Profiles** — Creating profiles, linking to devices, threshold meanings
10. **Multi-Device** — Adding devices, switching, overview page
11. **Troubleshooting** — Device offline, WiFi reset, sensor not detected, pump not responding, SSL failures
12. **Changing WiFi** — Reset from dashboard vs physical, what gets preserved
13. **Security & Credentials** — How credentials are stored (NVS), portal PIN gate, cross-reference to `SECURITY.md`

---

## Document 3: docs/developer-guide.md (Developer Handoff)

Get a classmate productive in the codebase fast.

### Sections

1. **Dev Environment Setup** — Clone, PlatformIO, `npm install`, `.env.local`, `secrets.h`
2. **Architecture Overview** — End-to-end data flow, why polling vs streams, why FreeRTOS tasks
3. **Firmware Walkthrough** — `main.cpp` structure: 3 tasks, shared state + mutex, WiFiManager, NVS. Line references for each block.
4. **Firebase Schema** — Full RTDB tree with types. Device-writes vs app-writes.
5. **Frontend Walkthrough** — File map: pages, components, context, utils. Routing, Firebase listeners, state flow.
6. **Common Tasks (Recipes)** — "How do I...?"
   - Add a new sensor reading
   - Add a new dashboard card
   - Add a new control command (app → device)
   - Change sync interval
   - Add a new board/pinout (note: multi-board `#ifdef` infrastructure does not yet exist — currently hardcoded per build flag)
   - Modify the WiFi portal
   - Add a new page/route
7. **Data Flow Diagrams** — Sensor → Firebase, App → Device control, Device claiming
8. **Concurrency & Safety** — Two mutexes (`gStateMutex` for shared sensor state, `gFirebaseMutex` for Firebase client), why they exist, what breaks without them, timeout values
9. **Deployment** — Vercel frontend deploy, env vars. Note: OTA is stubbed in code but non-functional (single-app partition, no OTA slot). Document what's needed to re-enable.
10. **Gotchas & Pitfalls** — Active-low relay, fake BME280, SSL auto-reset, stale flags, guest network blocking, NVS keys, rate limiting
11. **Future Work / Known TODOs** — Link to PLAN.md, improvement areas. Cross-reference `SECURITY.md` for credential handling guidelines.

---

## Notes on Existing Documentation

The repo contains `PROJECT_REPORT.md`, `TEST_AND_OVERVIEW.md`, and `PROJECT_OVERVIEW_RESUME.md` at the root. These are superseded by this documentation suite for their respective audiences but may be retained as historical artifacts. The new README will not link to them.

---

## Cross-Reference Strategy

- README links to User Manual and Developer Guide
- README "Quick Start" links to User Manual sections 2-5
- README "Hardware" links to User Manual section 2
- Developer Guide "Firebase Schema" is the canonical schema reference; User Manual references it for advanced users
- Developer Guide links to User Manual wiring tables rather than duplicating
- User Manual "Troubleshooting" is self-contained (no dev knowledge needed)

## File Locations

- `README.md` (root — replaces existing)
- `docs/user-manual.md` (new)
- `docs/developer-guide.md` (new)
