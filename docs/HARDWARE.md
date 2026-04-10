# Hardware Wiring & Pinout — ESP32 Plant Monitor (Hardware v2)

This document covers the complete bill of materials, pin assignments, wiring tables,
power architecture, and assembly notes for building the ESP32 Plant Monitor on a
perfboard using the Waveshare ESP32-S3 Zero.

---

## 1. Component List

| # | Component | Qty | Purpose | Notes |
|---|-----------|-----|---------|-------|
| 1 | Waveshare ESP32-S3 Zero | 1 | Main microcontroller | 4 MB flash, 2 MB PSRAM; USB-C; onboard 3.3 V regulator |
| 2 | BME280 breakout | 1 | Temperature, pressure, humidity | I2C address 0x77; SDO and CSB must be wired high |
| 3 | VEML7700 breakout | 1 | Ambient light (lux) | I2C address 0x10; ADDR pin must be wired to GND |
| 4 | Capacitive soil moisture sensor | 1 | Soil moisture (raw ADC) | Analog output; 3.3 V supply; no corrosion vs resistive type |
| 5 | Magnetic reed float switch | 1 | Water tank level detection | Normally open; pulled up internally; LOW = tank empty |
| 6 | IRLR7843 N-channel MOSFET | 1 | Switching 5 V pump | Logic-level gate; Vgs(th) ~1 V; 3.3 V GPIO is sufficient |
| 7 | 5 V DC water pump | 1 | Watering | Controlled via MOSFET; draws up to ~500 mA |
| 8 | 100 Ω resistor | 1 | MOSFET gate series resistor | Limits inrush/ringing on gate trace |
| 9 | 1N4001 (or similar) flyback diode | 1 | Pump back-EMF protection | Across pump terminals, cathode to + |
| 10 | USB-C power supply / cable | 1 | Powers ESP32 + sensors | Any 5 V USB source |
| 11 | 5 V battery / power bank | 1 | Powers pump independently | Separate rail; GND shared with ESP32 |
| 12 | Perfboard | 1 | Assembly substrate | — |
| 13 | Hookup wire (various colours) | — | Interconnects | See colour conventions in wiring tables |

---

## 2. ESP32-S3 Zero Pinout Used

All firmware pin assignments are defined as compile-time constants at the top of
`src/main.cpp`.

| GPIO | Direction | Function | Connected to | Notes |
|------|-----------|----------|--------------|-------|
| GPIO 5 | Bidirectional | I2C SDA | BME280 SDA, VEML7700 SDA | ADC1-safe; shared bus |
| GPIO 9 | Bidirectional | I2C SCL | BME280 SCL, VEML7700 SCL | Shared bus |
| GPIO 10 | Output | MOSFET gate (pump) | IRLR7843 gate via 100 Ω | Active-HIGH; LOW on boot (safe) |
| GPIO 11 | Input | Float switch (tank level) | Reed switch → GND | INPUT_PULLUP; LOW = tank empty |
| GPIO 12 | ADC input | Soil moisture AOUT | Capacitive sensor AOUT | ADC2 ch11; slight noise during WiFi TX |
| 3.3 V | Power out | Sensor supply | VEML7700 Vin | Regulator output; ~500 mA max total |
| GND | Common ground | Ground reference | All components | Shared with pump battery negative |
| USB-C | Power in | 5 V input | USB power supply | Feeds onboard 3.3 V regulator |

---

## 3. Wiring Tables

### 3.1 VEML7700 Light Sensor

The VEML7700 breakout is wired first in the sensor chain because its 3Vo pin provides
a regulated 3.3 V output used to daisy-chain power to the BME280.

| VEML7700 Pin | Connects to | Wire colour (convention) | Notes |
|--------------|-------------|--------------------------|-------|
| Vin | ESP32 3.3 V | Red | 3.3 V supply |
| GND | GND rail | Black | Common ground |
| SDA | GPIO 5 | Yellow | I2C data |
| SCL | GPIO 9 | Green | I2C clock |
| ADDR | GND rail | Black | Sets I2C address to 0x10 |
| 3Vo | BME280 VCC | Red | Regulated 3.3 V out → daisy-chain to BME280 |

### 3.2 BME280 Temperature / Pressure / Humidity Sensor

Powered from the VEML7700 3Vo pin. SDO and CSB **must** be tied; do not leave floating.

| BME280 Pin | Connects to | Wire colour (convention) | Notes |
|------------|-------------|--------------------------|-------|
| VCC | VEML7700 3Vo | Red | Daisy-chained 3.3 V |
| GND | GND rail | Black | Common ground |
| SDA | GPIO 5 | Yellow | Shared I2C bus with VEML7700 |
| SCL | GPIO 9 | Green | Shared I2C bus with VEML7700 |
| SDO | 3.3 V rail | Red | Sets I2C address to 0x77 (HIGH = 0x77) |
| CSB | 3.3 V rail | Red | Forces I2C mode (SPI disabled) |

### 3.3 Capacitive Soil Moisture Sensor

| Sensor Pin | Connects to | Wire colour (convention) | Notes |
|------------|-------------|--------------------------|-------|
| VCC | ESP32 3.3 V | Red | 3.3 V supply |
| GND | GND rail | Black | Common ground |
| AOUT | GPIO 12 | Blue | Analog voltage output; ADC reads 0–4095 |

### 3.4 Float Switch (Water Tank Level)

The reed switch is a simple two-terminal device; polarity does not matter.

| Switch Terminal | Connects to | Wire colour (convention) | Notes |
|-----------------|-------------|--------------------------|-------|
| Terminal A | GPIO 11 | Orange | Internal INPUT_PULLUP pulls to 3.3 V |
| Terminal B | GND rail | Black | Closes circuit to GND when float is down |

Logic: float UP (water present) → switch open → GPIO reads HIGH.
Float DOWN (tank empty) → switch closed → GPIO reads LOW → firmware stops pump.

### 3.5 IRLR7843 MOSFET + Water Pump

The MOSFET is a D-PAK (TO-252) package: Gate (left pin), Drain (centre/tab), Source (right pin).
Keep pump wiring short and physically separate from sensor traces.

| Connection | From | To | Notes |
|------------|------|----|-------|
| Gate | GPIO 10 | IRLR7843 Gate | Via 100 Ω series resistor |
| Source | IRLR7843 Source | GND rail | Common ground with ESP32 |
| Drain | IRLR7843 Drain | Pump negative (−) terminal | Switched path |
| Pump positive (+) | 5 V battery + | Pump + terminal | Unswitched supply |
| Battery negative (−) | 5 V battery − | GND rail | Shared ground — critical for switching to work |
| Flyback diode | Pump + terminal | Pump − terminal | 1N4001 cathode to +; suppresses back-EMF spike |

---

## 4. Power Architecture

```
USB-C 5 V ──► ESP32-S3-Zero ──► 3.3 V regulator ──► VEML7700 Vin
  (sensor power)                                          │
                                                     VEML7700 3Vo ──► BME280 VCC
                                                          │
                                              GPIO 5/9 ──► I2C SDA/SCL (both sensors)
                                              GPIO 12  ──► Soil sensor AOUT
                                              GPIO 11  ──► Float switch

5 V battery + ──► Pump (+) terminal
5 V battery − ──► GND rail (shared)    ← must be connected
                      │
                 IRLR7843 Source ──► Drain ──► Pump (−) terminal
                      │
                 GPIO 10 ──► 100 Ω ──► IRLR7843 Gate
```

Key points:
- The ESP32 and the pump share a **common GND**. Without this the MOSFET cannot switch.
- Sensor current draw: BME280 ~1 mA, VEML7700 ~0.5 mA, soil sensor ~5 mA — well within the 3.3 V rail limit.
- The pump draws up to ~500 mA from the 5 V battery and does **not** load the USB supply.

---

## 5. I2C Bus

| Parameter | Value |
|-----------|-------|
| SDA pin | GPIO 5 |
| SCL pin | GPIO 9 |
| Bus speed | 100 kHz (standard mode, default in Wire library) |
| BME280 address | 0x77 (SDO tied HIGH to 3.3 V) |
| VEML7700 address | 0x10 (ADDR tied LOW to GND) |
| Address conflict | None |
| Pull-up resistors | Typically provided on breakout boards (4.7 kΩ) |

Both sensors share the same two wires. An I2C scanner runs on every boot and prints
detected addresses to the serial monitor (115200 baud). Use this to confirm both
0x10 and 0x77 appear before deploying.

---

## 6. MOSFET Operation (IRLR7843)

| Condition | GPIO 10 | Gate voltage | MOSFET state | Pump |
|-----------|---------|--------------|--------------|------|
| Boot / idle | LOW | 0 V | OFF (open drain) | Off |
| Pump requested | HIGH | 3.3 V | ON (conducting) | Running |

Details:
- The IRLR7843 is a logic-level N-channel MOSFET (Vgs(th) ~1 V typical).
- At Vgs = 3.3 V, Rds(on) is slightly higher than the datasheet 4.5 V spec (~5 mΩ vs ~3.3 mΩ) but fully adequate for a 500 mA pump load.
- GPIO 10 defaults LOW on ESP32 boot, keeping the pump off during startup.
- The 100 Ω gate series resistor damps oscillation on the gate trace at turn-on/off.
- The 1N4001 flyback diode across the pump clamps the inductive kick when the MOSFET turns off, protecting the MOSFET from Vds overvoltage.
- Firmware uses pulse watering: 1 s ON pulses with 5 s soak pauses, controlled by a dedicated FreeRTOS task on Core 1.

---

## 7. Float Switch Operation

- GPIO 11 is configured as `INPUT_PULLUP` — the internal 45 kΩ pull-up holds the pin HIGH when the switch is open.
- The reed switch is **normally open** (contacts open when the float is in mid/upper position).
- When the water tank is full or partially full, the float rises, the switch stays open, GPIO reads **HIGH**.
- When the water level drops, the float falls, the magnet closes the reed contacts, the pin is pulled to GND, GPIO reads **LOW**.
- The firmware maps `LOW` → tank empty → pump is inhibited regardless of any watering request.
- No external pull-up resistor is needed; the ESP32's internal pull-up is sufficient for a reed switch.

---

## 8. Sensor Calibration

### Soil Moisture Sensor

The raw ADC reading (`soilRaw`) ranges from 0 to 4095 (12-bit ADC).

| Condition | Approximate `soilRaw` |
|-----------|----------------------|
| Dry air (sensor out of soil) | ~3800 |
| Very dry soil | ~3200–3500 |
| Moist soil (normal) | ~1800–2500 |
| Saturated / wet soil | ~1200 |

These values vary by sensor unit, supply voltage stability, and soil composition.
Calibrate by recording readings in dry air and fully saturated soil for your specific
sensor, then map to a 0–100 % scale in firmware if desired.

Note: GPIO 12 is on ADC2, which shares resources with the WiFi radio. Readings taken
while WiFi is actively transmitting may be slightly noisier. The firmware reads soil
after WiFi connects but during normal operation the noise is typically within ±50 counts.

### VEML7700 (Light)

Returns calibrated lux values via the Adafruit library. No user calibration is required.
The sensor auto-ranges gain and integration time internally.

### BME280 (Temperature / Pressure / Humidity)

Factory calibrated. Compensation coefficients are stored in the sensor's OTP memory
and applied automatically by the Adafruit library. No user calibration is required.
Allow ~2 minutes after powering on for temperature readings to stabilise if the sensor
has been near heat sources (e.g., immediately after soldering).

---

## 9. Assembly Notes and Tips

1. **Wire SDO and CSB on the BME280.** Leaving either pin floating causes unreliable
   I2C behaviour. SDO floating → address may read as 0x76 or 0x77 unpredictably.
   CSB floating → sensor may randomly enter SPI mode.

2. **Run the I2C scanner on first boot.** The firmware prints detected I2C addresses
   at startup (serial monitor, 115200 baud). You should see `0x10` (VEML7700) and
   `0x77` (BME280). If an address is missing, check solder joints and pull-up resistors.

3. **Shared GND between ESP32 and pump battery is mandatory.** Without a shared ground
   the MOSFET gate voltage has no reference and the pump will not switch reliably.

4. **Flyback diode orientation.** The cathode (band) of the 1N4001 connects to the
   pump's positive terminal. Reverse polarity will short the supply through the diode.

5. **Keep pump wiring short and physically away from sensor wiring.** The pump motor
   induces noise. Routing pump wires alongside I2C or ADC traces can cause spurious
   sensor readings or I2C errors.

6. **ADC2 and WiFi.** GPIO 12 (soil sensor) uses ADC2. On ESP32-S3 the ADC2 / WiFi
   interaction is less severe than on original ESP32, but minor noise is still possible.
   If soil readings are erratic while WiFi is active, add a 100 nF decoupling capacitor
   from the sensor AOUT pin to GND close to the ESP32 pad.

7. **Perfboard layout suggestion.** Place the ESP32-S3 Zero centrally. Group VEML7700
   and BME280 together near the I2C pads (GPIO 5, 9). Place the MOSFET near GPIO 10
   at the board edge, closest to the pump connector. Place the float switch connector
   near GPIO 11 at another edge.

8. **Power-on sequence.** On USB-C connect: 3.3 V rail comes up, WiFiManager starts
   (AP mode if unconfigured), then Firebase connects, then FreeRTOS tasks start.
   The pump is never activated during the boot sequence.

---

## 10. ASCII Wiring Diagram

```
                        ESP32-S3 Zero (Waveshare)
                   ┌────────────────────────────────┐
          USB-C ──►│ USB-C                  3.3V out │──────────────────────────┐
                   │                                 │                          │
                   │  GPIO 5 (SDA) ─────────────────►├─────────────────────┐   │
                   │  GPIO 9 (SCL) ─────────────────►├──────────────────┐  │   │
                   │                                 │                  │  │   │
                   │  GPIO 10 ──► 100Ω ─────────────►│ MOSFET Gate      │  │   │
                   │  GPIO 11 ◄── Float Switch        │                  │  │   │
                   │  GPIO 12 ◄── Soil AOUT           │                  │  │   │
                   │  GND ────────────────────────────┤                  │  │   │
                   └────────────────────────────────┘                  │  │   │
                              │ GND                                     │  │   │
                              │                                         │  │   │
          ┌───────────────────┴────────────────────────────────┐       │  │   │
          │                  Common GND Rail                    │       │  │   │
          └───┬──────────┬──────────┬──────────┬───────────────┘       │  │   │
              │          │          │          │                        │  │   │
              │          │          │          │                        │  │   │
    ┌─────────┴──┐  ┌────┴───┐  ┌──┴──────┐  ┌┴──────────────┐       │  │   │
    │  VEML7700  │  │ BME280 │  │  Soil   │  │  IRLR7843      │       │  │   │
    │            │  │        │  │ Sensor  │  │  N-ch MOSFET   │       │  │   │
    │ Vin ───────┼──┼────────┼──┼─────────┼──┼───────────  3.3V (above)│  │
    │ GND  (rail)│  │GND(rl) │  │GND(rl)  │  │Source (GND rl) │       │  │   │
    │ SDA ───────┼──┼────────┼──┼─────────┼──┼─────────────── ┤───────┘  │   │
    │ SCL ───────┼──┼────────┼──┼─────────┼──┼─────────────── ┤──────────┘   │
    │ ADDR─►GND  │  │SDO─►3V3│  │AOUT─►G12│  │Gate◄─100Ω─G10  │             │
    │ 3Vo ───────┼──► BME VCC│  │VCC ─►3V3│  │Drain──►Pump(−) │             │
    └────────────┘  └────────┘  └─────────┘  └────────────────┘             │
                                                       │  Pump (+)           │
    Float Switch:                            ┌─────────┴──────────┐          │
    ┌─────────────┐                          │   5V DC Water Pump  │          │
    │  Reed Switch│                          │   + flyback diode   │          │
    │ Term A─►G11 │                          │   (1N4001 across)   │          │
    │ Term B─►GND │                          └──────────┬──────────┘          │
    └─────────────┘                                     │ Pump (+)             │
                                              ┌──────────┴──────────┐         │
                                              │   5V Battery / Bank  │         │
                                              │  (+) ── Pump (+)     │         │
                                              │  (−) ── GND Rail ───►┘         │
                                              └──────────────────────┘         │
                                                                               │
                                              3.3V rail (from ESP32) ──────────┘
                                              (feeds VEML7700 Vin, Soil VCC)
```

### Simplified per-component connection summary

```
VEML7700:  Vin→3V3  GND→GND  SDA→G5  SCL→G9  ADDR→GND  3Vo→BME_VCC
BME280:    VCC→VEML_3Vo  GND→GND  SDA→G5  SCL→G9  SDO→3V3  CSB→3V3
Soil:      VCC→3V3  GND→GND  AOUT→G12
Float:     TermA→G11  TermB→GND   (INPUT_PULLUP; LOW=empty)
MOSFET:    Gate→100Ω→G10  Source→GND  Drain→Pump(-)
Pump:      (+)→5V_batt(+)  (-)→MOSFET_Drain  [flyback diode across terminals]
```

---

*Last updated: 2026-03-21. Pin assignments verified against `src/main.cpp` constants:*
*`I2C_SDA_PIN=5`, `I2C_SCL_PIN=9`, `SOIL_SENSOR_PIN=12`, `TANK_SENSOR_PIN=11`, `RELAY_PIN=10`.*
