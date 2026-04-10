# Plant Data Export Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dashboard Export button that lets users download all historical sensor readings as a formatted `.xlsx` file with embedded charts, for multi-week plant behavior analysis.

**Architecture:** A small firmware patch adds pump status (`pu`) to the existing 5-minute Firebase history snapshots. A new `ExportModal` React component handles date-range selection and Firebase querying, then passes rows to a new `exportExcel.ts` utility that builds the `.xlsx` using ExcelJS (raw data sheet) and Chart.js canvas-rendered PNG images (charts sheet). No backend required.

**Tech Stack:** C++/PlatformIO (firmware), React 19 + TypeScript + Vite 7, Firebase RTDB, ExcelJS, Chart.js (auto), date-fns + date-fns-tz v3, vite-plugin-node-polyfills

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `src/main.cpp` (lines 908–918) | Add `pu` field to 5-min history snapshot |
| Modify | `frontend/vite.config.ts` | Add Node.js polyfills for ExcelJS |
| Modify | `frontend/package.json` | Add new dependencies |
| Modify | `frontend/src/types.ts` | Add `HistoryRow` type |
| **Create** | `frontend/src/utils/exportExcel.ts` | Excel generation logic (two sheets) |
| **Create** | `frontend/src/components/dashboard/ExportModal.tsx` | Date picker modal + Firebase fetch |
| Modify | `frontend/src/pages/DashboardPage.tsx` | Add Export button + wire up modal |

---

## Chunk 1: Firmware + Dev Setup

### Task 1: Add pump status to firmware history snapshots

**File:** `src/main.cpp` lines 908–918

- [ ] **Step 1.1: Edit the history snapshot block**

  Find this block (around line 913–918):
  ```cpp
  if (!isnan(s.temperatureC)) hj.set("t", s.temperatureC);
  if (!isnan(s.pressurePa))   hj.set("p", s.pressurePa);
  if (!isnan(s.humidity))     hj.set("h", s.humidity);
  hj.set("s", s.soilRaw);
  hj.set("l", s.lightBright ? 1 : 0);
  Firebase.RTDB.setJSON(&fbClient, histPath.c_str(), &hj);
  ```

  Change to:
  ```cpp
  if (!isnan(s.temperatureC)) hj.set("t", s.temperatureC);
  if (!isnan(s.pressurePa))   hj.set("p", s.pressurePa);
  if (!isnan(s.humidity))     hj.set("h", s.humidity);
  hj.set("s", s.soilRaw);
  hj.set("l", s.lightBright ? 1 : 0);
  hj.set("pu", s.pumpRunning ? 1 : 0);
  Firebase.RTDB.setJSON(&fbClient, histPath.c_str(), &hj);
  ```

- [ ] **Step 1.2: Verify field exists on struct**

  Confirm `s.pumpRunning` exists in the `SensorState` struct (it does — defined at line ~114). No struct changes needed.

- [ ] **Step 1.3: Flash the device**

  In PlatformIO, select your board environment and upload. Monitor serial output — confirm device boots and syncs. No new serial log line needed for this change; just verify the device starts successfully.

- [ ] **Step 1.4: Verify in Firebase console**

  Open Firebase console → Realtime Database → `devices/3C:0F:02:DF:73:74/history/`. Wait up to 5 minutes for the next history write. Confirm a new epoch key appears with a `pu` field (value `0` or `1`).

- [ ] **Step 1.5: Commit firmware change**

  ```bash
  cd /Users/deepak/Documents/PlatformIO/Projects/ESP32_PlantMonitor
  git add src/main.cpp
  git commit -m "feat(firmware): add pump status (pu) to 5-min history snapshots"
  ```

---

### Task 2: Install npm dependencies

**File:** `frontend/package.json`

- [ ] **Step 2.1: Install runtime dependencies**

  ```bash
  cd /Users/deepak/Documents/PlatformIO/Projects/ESP32_PlantMonitor/frontend
  npm install exceljs chart.js date-fns date-fns-tz
  ```

  Expected: packages added to `dependencies` in `package.json`. No errors.

- [ ] **Step 2.2: Install dev dependency**

  ```bash
  npm install --save-dev vite-plugin-node-polyfills
  ```

  Expected: `vite-plugin-node-polyfills` appears in `devDependencies`.

---

### Task 3: Update Vite config for ExcelJS Node polyfills

**File:** `frontend/vite.config.ts`

ExcelJS uses Node.js built-ins (`stream`, `zlib`, `buffer`) which don't exist in the browser. We need to polyfill them.

- [ ] **Step 3.1: Update vite.config.ts**

  Make two targeted edits — do NOT replace the whole file (the existing VitePWA config must stay intact):

  **Edit 1** — Add import at the top (after the existing imports):
  ```ts
  import { nodePolyfills } from 'vite-plugin-node-polyfills'
  ```

  **Edit 2** — Add the plugin inside the `plugins: [...]` array, after `react()` and before `VitePWA(...)`:
  ```ts
  nodePolyfills({ include: ['stream', 'zlib', 'buffer'] }),
  ```

  The result should look like:
  ```ts
  plugins: [
    react(),
    nodePolyfills({ include: ['stream', 'zlib', 'buffer'] }),
    VitePWA({ ...existingConfig }),
  ]
  ```

- [ ] **Step 3.2: Verify dev server still starts**

  ```bash
  cd /Users/deepak/Documents/PlatformIO/Projects/ESP32_PlantMonitor/frontend
  npm run dev
  ```

  Expected: dev server starts on `http://localhost:5173` (or similar) with no errors. Open browser and confirm dashboard loads normally.

- [ ] **Step 3.3: Commit setup changes**

  ```bash
  cd /Users/deepak/Documents/PlatformIO/Projects/ESP32_PlantMonitor/frontend
  git add package.json package-lock.json vite.config.ts
  git commit -m "feat(export): add exceljs, chart.js, date-fns, node polyfills for Excel export"
  ```

---

## Chunk 2: Core Export Logic

### Task 4: Add HistoryRow type

**File:** `frontend/src/types.ts`

- [ ] **Step 4.1: Add HistoryRow interface**

  Append to the bottom of `frontend/src/types.ts`:

  ```ts
  export interface HistoryRow {
    epoch: number       // Unix UTC epoch (the Firebase key, parsed to number)
    t: number           // temperature °C
    p: number           // pressure Pa (raw from Firebase)
    h: number | null    // humidity % (null if BMP280 / missing)
    s: number           // soil raw ADC 0–4095
    l: number           // light: 1=bright, 0=dim
    pu: number          // pump: 1=on, 0=off (0 if missing in old records)
  }
  ```

- [ ] **Step 4.2: Verify TypeScript compiles**

  ```bash
  cd /Users/deepak/Documents/PlatformIO/Projects/ESP32_PlantMonitor/frontend
  npx tsc --noEmit
  ```

  Expected: no errors.

---

### Task 5: Create exportExcel.ts utility

**File:** `frontend/src/utils/exportExcel.ts` (new file)

This is the core of the feature. It takes an array of `HistoryRow` and produces a `.xlsx` download with two sheets.

- [ ] **Step 5.1: Create the file with Sheet 1 (Raw Data)**

  Create `frontend/src/utils/exportExcel.ts`:

  ```ts
  import ExcelJS from 'exceljs'
  import { Chart } from 'chart.js/auto'
  import { toZonedTime } from 'date-fns-tz'
  import { format } from 'date-fns'
  import type { HistoryRow } from '../types'

  const TZ = 'America/Los_Angeles'

  function epochToLabel(epoch: number): string {
    const zoned = toZonedTime(new Date(epoch * 1000), TZ)
    return format(zoned, 'MMM d yyyy, h:mm a')
  }

  function buildRawDataSheet(ws: ExcelJS.Worksheet, rows: HistoryRow[]): void {
    // Header row
    ws.columns = [
      { header: 'Timestamp (LA Time)', key: 'ts',       width: 24 },
      { header: 'Temp (°C)',           key: 'temp',     width: 12 },
      { header: 'Pressure (hPa)',      key: 'pressure', width: 14 },
      { header: 'Humidity (%)',        key: 'humidity', width: 14 },
      { header: 'Soil Raw (0–4095)',   key: 'soil',     width: 16 },
      { header: 'Light',               key: 'light',    width: 10 },
      { header: 'Pump',                key: 'pump',     width: 10 },
      { header: 'Notes',               key: 'notes',    width: 20 },
    ]

    // Bold + freeze header
    ws.getRow(1).font = { bold: true }
    ws.views = [{ state: 'frozen', ySplit: 1 }]

    // Data rows
    rows.forEach((row, i) => {
      const dataRow = ws.addRow({
        ts:       epochToLabel(row.epoch),
        temp:     isNaN(row.t) ? '' : Math.round(row.t * 10) / 10,
        pressure: Math.round(row.p / 100 * 10) / 10,
        humidity: row.h == null || isNaN(row.h) ? '' : Math.round(row.h * 10) / 10,
        soil:     row.s,
        light:    row.l === 1 ? 'Bright' : 'Dim',
        pump:     row.pu === 1 ? 'ON' : 'OFF',
        notes:    '',
      })

      // Alternating row shading
      if (i % 2 === 0) {
        dataRow.eachCell(cell => {
          cell.fill = {
            type: 'pattern', pattern: 'solid',
            fgColor: { argb: 'FFF5F5F5' },
          }
        })
      }
    })
  }

  async function renderChartToPng(
    labels: string[],
    data: (number | string)[],
    title: string,
    yLabel: string,
    stepped: boolean
  ): Promise<string> {
    const canvas = document.createElement('canvas')
    canvas.width = 900
    canvas.height = 350
    document.body.appendChild(canvas) // must be in DOM for Chart.js

    let chart: Chart | null = null
    try {
      chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: title,
            data: data as number[],
            borderColor: '#3B7A57',
            backgroundColor: 'rgba(59,122,87,0.1)',
            borderWidth: 1.5,
            pointRadius: 0,
            stepped: stepped ? true : false,
            tension: stepped ? 0 : 0.3,
          }],
        },
        options: {
          animation: false,
          responsive: false,
          plugins: {
            title:  { display: true, text: title, font: { size: 14 } },
            legend: { display: false },
          },
          scales: {
            x: { ticks: { maxTicksLimit: 12, maxRotation: 30 } },
            y: { title: { display: true, text: yLabel } },
          },
        },
      })
      return canvas.toDataURL('image/png')
    } finally {
      chart?.destroy()
      document.body.removeChild(canvas)
    }
  }

  async function buildChartsSheet(ws: ExcelJS.Worksheet, workbook: ExcelJS.Workbook, rows: HistoryRow[]): Promise<void> {
    ws.getCell('A1').value = 'Charts (generated from export data)'
    ws.getCell('A1').font = { bold: true, size: 13 }

    const labels    = rows.map(r => epochToLabel(r.epoch))
    const tempData  = rows.map(r => isNaN(r.t) ? 0 : Math.round(r.t * 10) / 10)
    const humData   = rows.map(r => r.h == null ? 0 : Math.round(r.h * 10) / 10)
    const soilData  = rows.map(r => r.s)
    const presData  = rows.map(r => Math.round(r.p / 100 * 10) / 10)
    const lightData = rows.map(r => r.l)
    const pumpData  = rows.map(r => r.pu)

    const charts: Array<{ data: number[], title: string, yLabel: string, stepped: boolean }> = [
      { data: tempData,  title: 'Temperature over Time',    yLabel: '°C',          stepped: false },
      { data: humData,   title: 'Humidity over Time',       yLabel: '%',           stepped: false },
      { data: soilData,  title: 'Soil Moisture over Time',  yLabel: 'ADC (0–4095)',stepped: false },
      { data: presData,  title: 'Pressure over Time',       yLabel: 'hPa',         stepped: false },
      { data: lightData, title: 'Light Level over Time',    yLabel: '1=Bright, 0=Dim', stepped: true },
      { data: pumpData,  title: 'Pump Activity over Time',  yLabel: '1=ON, 0=OFF', stepped: true },
    ]

    let rowOffset = 2
    for (const c of charts) {
      const png = await renderChartToPng(labels, c.data, c.title, c.yLabel, c.stepped)
      const imageId = workbook.addImage({ base64: png.split(',')[1], extension: 'png' })
      ws.addImage(imageId, {
        tl: { col: 0, row: rowOffset },
        ext: { width: 900, height: 350 },
      })
      rowOffset += 20 // ~20 rows spacing between charts
    }
  }

  export async function exportToExcel(
    rows: HistoryRow[],
    startDate: Date,
    endDate: Date
  ): Promise<void> {
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'SmartPlantPro'
    workbook.created = new Date()

    const rawSheet = workbook.addWorksheet('Raw Data')
    buildRawDataSheet(rawSheet, rows)

    const chartsSheet = workbook.addWorksheet('Charts')
    await buildChartsSheet(chartsSheet, workbook, rows)

    // Generate filename from date range
    const fmt = (d: Date) => format(toZonedTime(d, TZ), 'yyyy-MM-dd')
    const filename = `plant-data_${fmt(startDate)}_to_${fmt(endDate)}.xlsx`

    // Trigger browser download
    const buffer = await workbook.xlsx.writeBuffer()
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }
  ```

- [ ] **Step 5.2: Verify TypeScript compiles**

  ```bash
  cd /Users/deepak/Documents/PlatformIO/Projects/ESP32_PlantMonitor/frontend
  npx tsc --noEmit
  ```

  Expected: no type errors. If ExcelJS types are missing, run: `npm install --save-dev @types/exceljs` (though ExcelJS ships its own types, so this is usually not needed).

- [ ] **Step 5.3: Commit**

  ```bash
  git add src/utils/exportExcel.ts src/types.ts
  git commit -m "feat(export): add HistoryRow type and exportToExcel utility (two-sheet xlsx)"
  ```

---

## Chunk 3: UI — Modal + Dashboard Integration

### Task 6: Create ExportModal component

**File:** `frontend/src/components/dashboard/ExportModal.tsx` (new file — follows existing `dashboard/` subdirectory convention)

This component owns the date picker UI and the Firebase data fetch.

- [ ] **Step 6.1: Create ExportModal.tsx**

  ```tsx
  import { useState } from 'react'
  import { get, query, ref, orderByKey, startAt, endAt } from 'firebase/database'
  import { fromZonedTime, toZonedTime } from 'date-fns-tz'
  import { format, subDays, startOfDay } from 'date-fns'
  import { firebaseDb } from '../../lib/firebase'   // matches existing DashboardPage.tsx import
  import { exportToExcel } from '../../utils/exportExcel'
  import type { HistoryRow } from '../../types'

  const TZ = 'America/Los_Angeles'

  interface Props {
    mac: string
    onClose: () => void
  }

  // Default: start = midnight 7 days ago (LA time), end = now (LA time)
  function defaultStart(): string {
    const d = startOfDay(subDays(toZonedTime(new Date(), TZ), 7))
    return format(d, "yyyy-MM-dd'T'HH")
  }
  function defaultEnd(): string {
    return format(toZonedTime(new Date(), TZ), "yyyy-MM-dd'T'HH")
  }

  export default function ExportModal({ mac, onClose }: Props) {
    const [startInput, setStartInput] = useState(defaultStart)  // "YYYY-MM-DDTHH"
    const [endInput,   setEndInput]   = useState(defaultEnd)
    const [loading,    setLoading]    = useState(false)
    const [error,      setError]      = useState<string | null>(null)

    const isInvalid = startInput >= endInput

    async function handleExport() {
      setLoading(true)
      setError(null)

      try {
        // Parse inputs as LA-timezone datetimes → UTC Date objects
        const startLocal = new Date(`${startInput}:00`)  // "YYYY-MM-DDTHH:00"
        const endLocal   = new Date(`${endInput}:00`)
        const startUTC   = fromZonedTime(startLocal, TZ)
        const endUTC     = fromZonedTime(endLocal, TZ)

        const startEpoch = Math.floor(startUTC.getTime() / 1000)
        const endEpoch   = Math.floor(endUTC.getTime() / 1000)

        // Fetch history from Firebase (one-time read, range by key)
        const histRef = ref(firebaseDb, `devices/${mac}/history`)
        const q = query(
          histRef,
          orderByKey(),
          startAt(String(startEpoch)),
          endAt(String(endEpoch))
        )
        const snapshot = await get(q)

        if (!snapshot.exists()) {
          setError('No data found for this period. Try a wider date range.')
          setLoading(false)
          return
        }

        // Convert Firebase snapshot to HistoryRow[]
        const rows: HistoryRow[] = []
        snapshot.forEach(child => {
          const epoch = parseInt(child.key ?? '0', 10)
          const v = child.val()
          rows.push({
            epoch,
            t:  v.t  ?? NaN,
            p:  v.p  ?? NaN,
            h:  v.h  != null ? v.h : null,
            s:  v.s  ?? 0,
            l:  v.l  ?? 0,
            pu: v.pu ?? 0,   // default 0 for old records without pu
          })
        })

        // Sort ascending by epoch
        rows.sort((a, b) => a.epoch - b.epoch)

        await exportToExcel(rows, startUTC, endUTC)
        onClose()
      } catch (e) {
        setError('Export failed. Please try again.')
        console.error(e)
      } finally {
        setLoading(false)
      }
    }

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-xl p-6 w-full max-w-md mx-4">
          <h2 className="text-lg font-bold mb-1 text-zinc-900 dark:text-zinc-100">
            Export Sensor Data
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-5">
            Downloads an Excel file (.xlsx) with all sensor readings and charts.
            Timezone: America/Los_Angeles (PDT/PST).
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Start (date + hour)
              </label>
              <input
                type="datetime-local"
                value={startInput + ':00'}
                onChange={e => { if (e.target.value.length >= 13) setStartInput(e.target.value.slice(0, 13)) }}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                End (date + hour)
              </label>
              <input
                type="datetime-local"
                value={endInput + ':00'}
                onChange={e => { if (e.target.value.length >= 13) setEndInput(e.target.value.slice(0, 13)) }}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              />
            </div>

            {isInvalid && (
              <p className="text-sm text-red-500">End time must be after start time.</p>
            )}
            {error && (
              <p className="text-sm text-red-500">{error}</p>
            )}
          </div>

          <div className="flex gap-3 mt-6">
            <button
              onClick={onClose}
              disabled={loading}
              className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleExport}
              disabled={loading || isInvalid}
              className="flex-1 rounded-xl bg-green-700 hover:bg-green-800 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white transition-colors"
            >
              {loading ? 'Exporting…' : 'Export .xlsx'}
            </button>
          </div>
        </div>
      </div>
    )
  }
  ```

- [ ] **Step 6.2: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit
  ```

  Expected: no errors.

- [ ] **Step 6.3: Commit**

  ```bash
  git add src/components/dashboard/ExportModal.tsx
  git commit -m "feat(export): add ExportModal component with date picker and Firebase fetch"
  ```

---

### Task 7: Wire Export button into DashboardPage

**File:** `frontend/src/pages/DashboardPage.tsx`

- [ ] **Step 7.1: Add import at the top of DashboardPage.tsx**

  Find the existing component imports (the block importing `HistoryChart`, `CollapsibleSection`, etc.) and add:

  ```ts
  import ExportModal from '../components/dashboard/ExportModal'
  ```

- [ ] **Step 7.2: Add modal state variable**

  Find the block of `useState` declarations at the top of the component (around line 44–102) and add:

  ```ts
  const [exportModalOpen, setExportModalOpen] = useState(false)
  ```

- [ ] **Step 7.3: Add the Export button**

  In the Dashboard tab JSX, find the manual watering trigger button (look for `handleTriggerPump` in the JSX). Add the Export button **after** it, in the same controls area:

  ```tsx
  <button
    onClick={() => setExportModalOpen(true)}
    className="flex items-center gap-2 rounded-xl border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
  >
    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
    Export Data
  </button>
  ```

- [ ] **Step 7.4: Add ExportModal to the render tree**

  Near the **bottom** of the component's return JSX (before the final closing tag), add:

  ```tsx
  {exportModalOpen && selectedMac && (
    <ExportModal
      mac={selectedMac}
      onClose={() => setExportModalOpen(false)}
    />
  )}
  ```

- [ ] **Step 7.5: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit
  ```

  Expected: no errors.

- [ ] **Step 7.6: Commit**

  ```bash
  git add src/pages/DashboardPage.tsx
  git commit -m "feat(export): add Export Data button and modal to dashboard"
  ```

---

## Chunk 4: End-to-End Verification

### Task 8: Full manual test

- [ ] **Step 8.1: Start dev server and open dashboard**

  ```bash
  cd /Users/deepak/Documents/PlatformIO/Projects/ESP32_PlantMonitor/frontend
  npm run dev
  ```

  Open `http://localhost:5173`, sign in, navigate to the device dashboard.

- [ ] **Step 8.2: Confirm Export button is visible**

  The "Export Data" button should appear in the controls area. If not visible, check that `exportModalOpen` state and the button JSX were added correctly in Task 7.

- [ ] **Step 8.3: Test with valid date range**

  Click "Export Data". Set start to 7 days ago, end to today. Click "Export .xlsx".
  Expected:
  - Spinner / button text changes to "Exporting…" briefly
  - A `.xlsx` file downloads named `plant-data_YYYY-MM-DD_to_YYYY-MM-DD.xlsx`

- [ ] **Step 8.4: Open the Excel file and verify Sheet 1**

  - Row 1: bold headers, frozen on scroll
  - Timestamps are human-readable in LA timezone (e.g. `Mar 10 2026, 8:00 AM`)
  - Pressure column shows values ~1013 (hPa), not ~101325 (Pa)
  - Light shows `Bright` or `Dim` (not 1/0)
  - Pump shows `ON` or `OFF` (not 1/0)
  - Humidity column blank for any rows where sensor is BMP280
  - Notes column is empty
  - Alternating row shading visible

- [ ] **Step 8.5: Open Sheet 2 and verify charts**

  - 6 chart images are embedded (Temperature, Humidity, Soil, Pressure, Light, Pump)
  - Each has a title label
  - Light and Pump charts show stepped lines (horizontal steps, not smooth curves)
  - X-axis shows timestamps (may be abbreviated)

- [ ] **Step 8.6: Test edge case — empty range**

  Set start and end to a range in the future (no data). Click Export.
  Expected: error message "No data found for this period."

- [ ] **Step 8.7: Test edge case — 1-hour range**

  Set start and end to a 1-hour window that has data (e.g., the last hour). Click Export.
  Expected: file downloads correctly; Sheet 2 charts render even with very few data points (typically 12 rows).

- [ ] **Step 8.8: Test edge case — invalid range**

  Set end before start.
  Expected: Export button is disabled and validation message shows.

- [ ] **Step 8.9: Build for production to confirm no bundle errors**

  ```bash
  npm run build
  ```

  Expected: build completes with no errors. Warnings about bundle size from ExcelJS/Chart.js are OK (they are large libraries).

- [ ] **Step 8.10: Final commit + push**

  ```bash
  cd /Users/deepak/Documents/PlatformIO/Projects/ESP32_PlantMonitor
  git add -A
  git status   # review — make sure nothing unexpected is staged
  git push origin main
  ```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `stream is not defined` at runtime | Check `vite-plugin-node-polyfills` is in `vite.config.ts` plugins array, not just installed |
| Charts sheet has blank images | Ensure `import { Chart } from 'chart.js/auto'` (not `'chart.js'`) |
| Timestamps off by 1 hour | DST transition — confirm using `fromZonedTime`/`toZonedTime` from `date-fns-tz` v3, not v2 names |
| `fromZonedTime is not a function` | You may have `date-fns-tz` v2 — run `npm install date-fns-tz@latest` |
| Firebase query returns no data | Check Firebase security rules allow `.indexOn` or `orderByKey` on the history path |
| `firebaseDb` import error in ExportModal | Confirm `frontend/src/lib/firebase.ts` exports `firebaseDb` via `export const firebaseDb = getDatabase(firebaseApp)` |
| Canvas error in exportExcel | Ensure `document.body.appendChild(canvas)` is called before `new Chart()` |
