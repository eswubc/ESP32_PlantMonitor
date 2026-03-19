import { useState } from 'react'
import { get, query, ref, orderByKey, limitToLast } from 'firebase/database'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import { format, subDays, startOfDay } from 'date-fns'
import { firebaseDb } from '../../lib/firebase'
import { exportToExcel } from '../../utils/exportExcel'
import type { HistoryRow } from '../../types'

const TZ = 'America/Los_Angeles'

interface Props {
  mac: string
  onClose: () => void
}

function defaultStart(): string {
  const d = startOfDay(subDays(toZonedTime(new Date(), TZ), 7))
  return format(d, "yyyy-MM-dd'T'HH")
}
function defaultEnd(): string {
  return format(toZonedTime(new Date(), TZ), "yyyy-MM-dd'T'HH")
}

export default function ExportModal({ mac, onClose }: Props) {
  const [startInput, setStartInput] = useState(defaultStart)
  const [endInput,   setEndInput]   = useState(defaultEnd)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const isInvalid = startInput >= endInput

  async function handleExport() {
    setLoading(true)
    setError(null)

    try {
      // Pass strings directly to fromZonedTime — avoids browser timezone
      // ambiguity that occurs when passing Date objects.
      const startUTC = fromZonedTime(`${startInput}:00`, TZ)
      const endUTC   = fromZonedTime(`${endInput}:59`, TZ) // inclusive of last minute

      const startEpoch = Math.floor(startUTC.getTime() / 1000)
      const endEpoch   = Math.floor(endUTC.getTime() / 1000)

      // Calculate a safe fetch limit: 12 snapshots/hour × hours + buffer.
      // Using limitToLast + JS filtering avoids Firebase's unreliable
      // startAt/endAt behaviour on numerically-sorted integer keys.
      const durationHours = Math.ceil((endEpoch - startEpoch) / 3600)
      const fetchLimit = Math.min(durationHours * 12 + 100, 12000)

      const histRef = ref(firebaseDb, `devices/${mac}/history`)
      const q = query(histRef, orderByKey(), limitToLast(fetchLimit))
      const snapshot = await get(q)

      if (!snapshot.exists()) {
        setError('No history data found for this device yet. The device records a snapshot every ~5 minutes while online.')
        setLoading(false)
        return
      }

      const rows: HistoryRow[] = []
      snapshot.forEach(child => {
        const epoch = parseInt(child.key ?? '0', 10)
        if (epoch < startEpoch || epoch > endEpoch) return
        const v = child.val()
        rows.push({
          epoch,
          t:  v.t  ?? NaN,
          p:  v.p  ?? NaN,
          h:  v.h  != null ? v.h : null,
          s:  v.s  ?? 0,
          l:  v.l  ?? 0,
          pu: v.pu ?? 0,
        })
      })

      if (rows.length === 0) {
        setError('No data found for this date range. Try a wider range.')
        setLoading(false)
        return
      }

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
