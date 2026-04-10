# Plant Data Export — Design Spec
**Date:** 2026-03-16
**Status:** Approved
**Device:** MAC `3C:0F:02:DF:73:74`

---

## Context

The user wants to monitor plant behavior over multiple weeks by observing how sensor readings change under varying environmental conditions (light, watering, temperature). Currently, all sensor data is visible in real-time on the dashboard and in the serial monitor, but there is no way to export historical data for offline analysis or graphing.

This feature adds:
1. A small firmware enhancement to capture pump status in the 5-minute history snapshots
2. A dashboard export UI to download a properly formatted `.xlsx` file covering any custom date/time range

---

## Goal

Enable multi-week plant behavior testing by exporting all sensor readings to a well-structured Excel file with embedded charts — downloadable on demand from the dashboard.

---

## Scope

- **One device** for now (MAC: `3C:0F:02:DF:73:74`)
- **Data source:** Firebase RTDB `devices/{MAC}/history/{epoch}` (5-minute snapshots)
- **Frequency:** One row per 5-minute history snapshot (288 rows/day max)
- **Duration:** Any custom range — designed for multi-week exports

---

## Part 1: Firmware Change

**File:** `src/main.cpp` — inside `taskFirebaseSync`, the history snapshot write

**Change:** Add `pu` (pump status) field to the compact history JSON:

**Before:**
```cpp
json["t"] = s.temperatureC;
json["p"] = s.pressurePa;
json["h"] = s.humidity;
json["s"] = s.soilRaw;
json["l"] = s.lightBright ? 1 : 0;
```

**After:**
```cpp
json["t"] = s.temperatureC;
json["p"] = s.pressurePa;
json["h"] = s.humidity;
json["s"] = s.soilRaw;
json["l"] = s.lightBright ? 1 : 0;
json["pu"] = s.pumpRunning ? 1 : 0;
```

**Notes:**
- Requires reflash
- History entries before reflash will not have `pu` — export treats missing `pu` as `0` (OFF)
- No other firmware changes needed

---

## Part 2: Firebase Schema Update

`devices/{MAC}/history/{epoch}` gains one new field:

```
pu: int   (1 = pump ON, 0 = pump OFF)
```

**Firebase RTDB Query for export:**
Use `orderByKey()` + `startAt(String(startEpochUTC))` + `endAt(String(endEpochUTC))`.
This performs lexicographic comparison on epoch string keys — safe for Unix timestamps (same digit count until year 2286). Do NOT use numeric comparisons.

**Firebase indexing:** Confirm `.indexOn: [".key"]` is set (or `orderByKey` works by default without `.indexOn`). Verify the security rules permit range queries on the `history` path for authenticated users before shipping.

---

## Part 3: Dashboard Export UI

### Location
New **"Export Data"** button inside the existing `CollapsibleSection` for controls in `frontend/src/pages/DashboardPage.tsx`, placed after the manual watering button.

### Export Modal / Panel
Clicking "Export Data" opens a modal with:

| Field | Detail |
|---|---|
| Start date + hour | Date picker + hour dropdown |
| End date + hour | Date picker + hour dropdown |
| Timezone | Fixed label: "America/Los_Angeles (PDT/PST)" — not user-selectable |
| Export button | Triggers generation + download |

**Default range pre-fill:** Start = midnight 7 days ago (America/Los_Angeles), End = current time (America/Los_Angeles).

**Timezone conversion:** Use `Intl.DateTimeFormat` with `timeZone: 'America/Los_Angeles'` for all display conversions. For epoch computation, use:
```ts
new Date(localDateString).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
```
This correctly handles DST transitions (PDT in summer, PST in winter) automatically — do NOT hardcode UTC−7.

### Data Fetching
Fetch lives in `ExportModal.tsx`. It fetches data once and passes `HistoryRow[]` to `exportToExcel()` from `exportExcel.ts`.

1. Convert PDT/PST start/end to UTC epoch using `date-fns-tz` v3: `fromZonedTime(localDate, 'America/Los_Angeles')`
2. Query `devices/{MAC}/history/` using Firebase `get()` (one-time read, not `onValue()`):
   ```ts
   import { get, query, ref, orderByKey, startAt, endAt } from 'firebase/database';
   const q = query(ref(db, `devices/${mac}/history`), orderByKey(), startAt(String(startEpoch)), endAt(String(endEpoch)));
   const snapshot = await get(q);
   ```
3. Sort results by epoch ascending
4. Convert each epoch to America/Los_Angeles for display:
   ```ts
   import { toZonedTime } from 'date-fns-tz';
   import { format } from 'date-fns';  // format() comes from date-fns, not date-fns-tz
   const zoned = toZonedTime(new Date(epoch * 1000), 'America/Los_Angeles');
   const label = format(zoned, 'MMM d yyyy, h:mm a');
   ```
5. Show a loading spinner immediately when the user clicks Export (covers both fetch + generation time)

**Large exports:** Show spinner for any export (the fetch + Excel generation can take 1–5 seconds even for small ranges). No separate threshold needed.

### Libraries
- **`exceljs`** — for `.xlsx` generation (Raw Data sheet, formatting, freeze panes)
- **`chart.js`** — render charts to `<canvas>` elements in-browser; import via `'chart.js/auto'` to auto-register all components
- **`date-fns`** + **`date-fns-tz`** (v3) — DST-aware timezone conversion (`fromZonedTime`, `toZonedTime`); both packages required

**Vite compatibility for ExcelJS:** ExcelJS uses Node.js built-ins (`stream`, `zlib`). Add `vite-plugin-node-polyfills` to `frontend/vite.config.ts`:
```ts
import { nodePolyfills } from 'vite-plugin-node-polyfills'
// in plugins array:
nodePolyfills({ include: ['stream', 'zlib', 'buffer'] })
```
Install: `npm install --save-dev vite-plugin-node-polyfills`

---

## Part 4: Excel File Structure

### File Name
```
plant-data_YYYY-MM-DD_to_YYYY-MM-DD.xlsx
```

### TypeScript Types (new file: `frontend/src/utils/exportExcel.ts`)

```ts
export interface HistoryRow {
  epoch: number;          // Unix UTC epoch (key from Firebase)
  t: number;              // temperature °C
  p: number;              // pressure Pa
  h: number | null;       // humidity % (null if BMP280)
  s: number;              // soil raw ADC 0–4095
  l: number;              // light: 1=bright, 0=dim
  pu: number;             // pump: 1=on, 0=off
}

export async function exportToExcel(
  rows: HistoryRow[],
  startDate: Date,
  endDate: Date
): Promise<void>
```

### Sheet 1 — "Raw Data"

One row per history snapshot, sorted oldest → newest:

| Col | Header | Value | Format |
|---|---|---|---|
| A | Timestamp (LA Time) | Human-readable: `Mar 16 2026, 8:00 AM` | Text |
| B | Temp (°C) | Float, 1 decimal | Number |
| C | Pressure (hPa) | `Math.round(p / 100 * 10) / 10` — matches dashboard display | Number |
| D | Humidity (%) | Float, 1 decimal; blank if null | Number |
| E | Soil Raw (0–4095) | Integer; higher = drier | Number |
| F | Light | `Bright` or `Dim` | Text |
| G | Pump | `ON` or `OFF` | Text |
| H | Notes | Empty — user fills manually in Excel | Text |

> **Note:** Pressure exported as **hPa** (divided by 100) to match the dashboard display. Column header makes this explicit.

**Formatting:**
- Row 1: bold headers, frozen panes (freeze top row)
- Alternating row shading (white / light grey) for readability
- Auto-fit column widths

### Sheet 2 — "Charts"

Six charts, each rendered as a PNG image via `chart.js` on a hidden `<canvas>` element, then embedded into the worksheet using ExcelJS's `addImage()` API.

| # | Chart Title | Y Axis | Chart.js Type |
|---|---|---|---|
| 1 | Temperature over Time | °C | `line` |
| 2 | Humidity over Time | % | `line` |
| 3 | Soil Moisture over Time | ADC (0–4095) | `line` |
| 4 | Pressure over Time | hPa | `line` |
| 5 | Light Level over Time | 1=Bright / 0=Dim | `line` (stepped) |
| 6 | Pump Activity over Time | 1=ON / 0=OFF | `line` (stepped) |

**Implementation pattern:**
```ts
// Import: use chart.js/auto to auto-register all controllers, scales and plugins
import { Chart } from 'chart.js/auto';

// For each chart:
const canvas = document.createElement('canvas');
canvas.width = 900; canvas.height = 400;
const chart = new Chart(canvas, {
  type: 'line',
  data: { labels: timestamps, datasets: [{ data: values, stepped: true }] }, // stepped:true on dataset for charts 5 & 6
  options: { animation: false, plugins: { title: { display: true, text: 'Chart Title' } } }
});
const imageData = canvas.toDataURL('image/png');
const imageId = workbook.addImage({ base64: imageData, extension: 'png' });
chartsSheet.addImage(imageId, { tl: { col: 0, row: rowOffset }, ext: { width: 900, height: 400 } });
chart.destroy();
```

> **Note:** For stepped charts (Light and Pump — charts 5 & 6), set `stepped: true` on the **dataset object**, not on the chart type. The chart type remains `'line'`.

Charts stacked vertically with ~20-row spacing between each.

---

## Part 5: Key Files

| File | Change |
|---|---|
| `src/main.cpp` | Add `pu` field to history snapshot write |
| `frontend/src/pages/DashboardPage.tsx` | Add Export button + modal |
| `frontend/src/utils/exportExcel.ts` | New — Excel generation logic |
| `frontend/src/components/ExportModal.tsx` | New — modal component with date pickers |
| `frontend/package.json` | Add `exceljs`, `chart.js`, `date-fns`, `date-fns-tz` |
| `frontend/vite.config.ts` | Add `vite-plugin-node-polyfills` |

---

## Part 6: Error Handling

| Scenario | Behavior |
|---|---|
| No data in selected range | Inline message in modal: "No data found for this period" |
| Firebase query fails | Error toast notification |
| Humidity null (BMP280 device) | Humidity column shows blank, not "NaN" |
| Missing `pu` in old history entries | Default to `0` (OFF) |
| User selects end before start | Disable Export button, show inline validation error |

---

## Verification

1. **Firmware:** Flash updated firmware → inspect Firebase console at `devices/{MAC}/history/{recent_epoch}` → confirm `pu` field is present
2. **Export UI:** Open dashboard → click "Export Data" → modal opens with correct default range (last 7 days)
3. **Timezone:** Verify timestamps in Sheet 1 match America/Los_Angeles time (account for DST)
4. **Pressure:** Verify Column C values are in hPa (e.g. ~1013), not Pa (e.g. ~101325)
5. **Sheet 1:** All 8 columns present, header row bold + frozen, alternating shading, Light/Pump as text labels
6. **Sheet 2:** 6 chart images embedded, each with title and data plotted; verify charts update when different date ranges are exported
7. **Edge cases:** Export with no data → error message shown; export with 1 hour of data → works correctly; end-before-start → button disabled
8. **DST test:** If possible, export a range that spans a DST boundary and verify timestamps are correct on both sides
