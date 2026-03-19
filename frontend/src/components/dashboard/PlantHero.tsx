import { motion } from 'framer-motion'
import type { DeviceStatus, Readings } from '../../types'
import type { ProfileTip } from '../../utils/profileTips'
import { PlantIcon } from '../icons/PlantIcon'
import { PencilIcon } from '../icons/PencilIcon'
import { SkeletonCard } from '../SkeletonCard'
import { spring } from '../../lib/motion'

type Props = {
  selectedMac: string
  plantName: string
  plantType: string
  deviceStatus: DeviceStatus
  dataUntrusted: boolean
  isDelayed: boolean
  isLoading?: boolean
  health: string | undefined
  healthOk: boolean
  onEditPlant: () => void
  readings?: Readings | null
  lastWateredEpoch?: number | null
  todayTotalMs?: number
  profileTips?: ProfileTip[]
}

const statusChip: Partial<Record<DeviceStatus, { text: string; dot: string }>> = {
  live:           { text: 'Live',    dot: 'bg-green-400' },
  delayed:        { text: 'Delayed', dot: 'bg-amber-400' },
  offline:        { text: 'Offline', dot: 'bg-red-400' },
  wifi_connected: { text: 'Syncing', dot: 'bg-amber-400' },
}

function formatPressureHpa(pa: number): string {
  return (pa / 100).toFixed(0)
}

function formatSecondsAgo(epoch: number): string {
  const d = Math.floor(Date.now() / 1000) - epoch
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return `${Math.floor(d / 86400)}d ago`
}

export function PlantHero({
  selectedMac, plantName, plantType, deviceStatus,
  dataUntrusted, isDelayed, isLoading = false, health, healthOk, onEditPlant, readings,
  lastWateredEpoch, todayTotalMs = 0, profileTips = [],
}: Props) {
  const chip = statusChip[deviceStatus]

  if (isLoading) {
    return <SkeletonCard variant="hero" />
  }

  const healthVariant = dataUntrusted
    ? { bg: 'bg-forest/5 dark:bg-slate-700/50', border: 'border-forest/10 dark:border-slate-600', text: 'text-forest/25 dark:text-slate-400' }
    : isDelayed
    ? { bg: 'bg-amber-50 dark:bg-amber-900/30', border: 'border-amber-200 dark:border-amber-700/50', text: 'text-amber-600 dark:text-amber-300' }
    : healthOk
    ? { bg: 'bg-primary/10 dark:bg-primary/25', border: 'border-primary/25 dark:border-primary/40', text: 'text-primary dark:text-primary-300' }
    : { bg: 'bg-terracotta/10 dark:bg-red-900/30', border: 'border-terracotta/25 dark:border-red-800/50', text: 'text-terracotta dark:text-red-300' }

  const hasLiveData = !dataUntrusted && readings
  const temp = hasLiveData && readings.temperature != null && !Number.isNaN(readings.temperature)
    ? `${readings.temperature.toFixed(1)}°C` : null
  const pressure = hasLiveData && readings.pressure != null && !Number.isNaN(readings.pressure)
    ? `${formatPressureHpa(readings.pressure)} hPa` : null
  const soil = hasLiveData && readings.soilRaw != null
    ? `Soil ${readings.soilRaw}` : null
  const light = hasLiveData && readings.lux != null
    ? `${Math.round(readings.lux)} lx`
    : null

  const quickStats = [temp, soil, pressure, light].filter(Boolean)

  return (
    <motion.div
      key={selectedMac}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.gentle}
      className="section-card mb-3 !p-4 sm:!p-5"
    >
      <div className="flex items-center gap-3 sm:gap-4">
        {/* Plant icon */}
        <div
          className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition-all duration-500 sm:h-14 sm:w-14 sm:rounded-2xl ${
            dataUntrusted ? 'bg-forest/5 dark:bg-slate-700/50' : ''
          }`}
          style={dataUntrusted ? {} : {
            background: 'linear-gradient(135deg, rgba(59,122,87,0.18) 0%, rgba(59,122,87,0.08) 100%)',
            boxShadow: '0 0 0 1px rgba(59,122,87,0.12)',
          }}
        >
          <PlantIcon
            className={`h-6 w-6 transition-colors duration-500 sm:h-7 sm:w-7 ${
              dataUntrusted ? 'text-forest/25 dark:text-slate-500' : 'text-primary dark:text-primary-300'
            }`}
          />
        </div>

        {/* Name + type + status */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p
              className={`font-display text-base font-bold leading-tight transition-colors duration-300 sm:text-lg ${
                dataUntrusted ? 'text-forest/40 dark:text-slate-400' : 'text-forest dark:text-slate-100'
              }`}
            >
              {plantName}
            </p>
            <button
              type="button"
              onClick={onEditPlant}
              className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full text-forest/35 transition hover:bg-sage-100 hover:text-forest dark:text-slate-500 dark:hover:bg-slate-600 dark:hover:text-slate-200"
              aria-label="Edit plant name and type"
            >
              <PencilIcon className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {plantType && (
              <span className="text-xs text-forest-400 dark:text-slate-400">{plantType}</span>
            )}
            {chip && !dataUntrusted && (
              <span className="flex items-center gap-1 rounded-full bg-forest/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-forest/50 dark:bg-slate-600/60 dark:text-slate-300">
                <span className={`h-1.5 w-1.5 rounded-full ${chip.dot} ${deviceStatus === 'live' ? 'animate-pulse' : ''}`} />
                {chip.text}
              </span>
            )}
            {!plantType && !chip && (
              <span className="text-xs text-forest/35 dark:text-slate-500">No plant type set</span>
            )}
          </div>
        </div>

        {/* Health badge */}
        <div className="shrink-0 text-right">
          <p className="mb-1 stat-label">Health</p>
          <span
            className={`inline-block rounded-full border px-3 py-1 text-sm font-semibold transition-all duration-500 sm:px-4 ${healthVariant.bg} ${healthVariant.border} ${healthVariant.text}`}
          >
            {dataUntrusted
              ? (deviceStatus === 'wifi_connected' || deviceStatus === 'syncing' ? '…' : '—')
              : (health ?? '—')}
          </span>
        </div>
      </div>

      {/* Profile-based tips */}
      {profileTips.length > 0 && !dataUntrusted && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-forest/5 dark:border-slate-600/50 pt-3">
          {profileTips.filter((t) => t.severity !== 'ok').map((t) => (
            <span
              key={t.id}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                t.severity === 'warning' ? 'bg-amber-500/10 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' : 'bg-sky-500/10 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300'
              }`}
            >
              {t.message}
            </span>
          ))}
        </div>
      )}

      {/* Live quick stats */}
      {(quickStats.length > 0 || lastWateredEpoch != null || todayTotalMs > 0) && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-forest/5 dark:border-slate-600/50 pt-3">
          {quickStats.map((s) => (
            <span key={s} className="rounded-lg bg-forest/[0.03] px-2.5 py-1 text-xs font-medium tabular-nums text-forest-500 dark:bg-slate-600/50 dark:text-slate-300">
              {s}
            </span>
          ))}
          {lastWateredEpoch != null && lastWateredEpoch > 0 && (
            <span className="rounded-lg bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-700 dark:bg-sky-500/25 dark:text-sky-300">
              Last watered {formatSecondsAgo(lastWateredEpoch)}
            </span>
          )}
          {todayTotalMs > 0 && (
            <span className="rounded-lg bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-700 dark:bg-sky-500/25 dark:text-sky-300">
              Today: {(todayTotalMs / 1000).toFixed(0)}s total
            </span>
          )}
        </div>
      )}
    </motion.div>
  )
}
