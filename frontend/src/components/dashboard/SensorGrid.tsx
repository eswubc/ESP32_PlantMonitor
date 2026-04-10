import { motion } from 'framer-motion'
import type { DeviceStatus, Readings } from '../../types'
import { CircularGauge } from '../CircularGauge'
import { ThermometerIcon } from '../icons/ThermometerIcon'
import { SunIcon } from '../icons/SunIcon'
import { SkeletonCard } from '../SkeletonCard'
import { staggerContainer, cardItem, spring } from '../../lib/motion'

type Props = {
  deviceStatus: DeviceStatus
  dataUntrusted: boolean
  isDelayed: boolean
  isLoading?: boolean
  displayTemp: number
  temp: number | undefined
  displayGaugePct: number
  soilLabel: string
  readings: Readings | null
  selectedMac: string
}

function LiveDot() {
  return (
    <span
      className="absolute right-4 top-4 flex h-2 w-2"
      aria-hidden="true"
    >
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
    </span>
  )
}

function FrozenOverlay({ deviceStatus }: { deviceStatus: DeviceStatus }) {
  const text =
    deviceStatus === 'syncing' || deviceStatus === 'wifi_connected'
      ? 'Waiting for sensor data…'
      : deviceStatus === 'no_data'
        ? 'Waiting for first reading…'
        : 'Data frozen — device offline'

  return (
    <div className="pointer-events-none absolute -inset-1 z-10 flex items-start justify-center rounded-3xl">
      <div className="pointer-events-auto mt-24 rounded-2xl bg-white/95 px-5 py-3 shadow-lift backdrop-blur-sm">
        <p className="text-center text-sm font-semibold text-forest/55">{text}</p>
      </div>
    </div>
  )
}

function BarometerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
      <path d="M12 3v1M12 20v1M3 12h1M20 12h1" />
    </svg>
  )
}

function DropletIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0z" />
    </svg>
  )
}

function formatPressure(pa: number): string {
  return (pa / 100).toFixed(1)
}

export function SensorGrid({
  deviceStatus, dataUntrusted, isDelayed, isLoading = false,
  displayTemp, temp, displayGaugePct, soilLabel,
  readings, selectedMac,
}: Props) {
  const isLive      = deviceStatus === 'live'
  const hasPressure = readings?.pressure != null && !Number.isNaN(readings.pressure)
  const hasHumidity = readings?.humidity  != null && !Number.isNaN(readings.humidity)

  const gridOpacity = dataUntrusted ? 0.32 : isDelayed ? 0.68 : 1

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SkeletonCard variant="sensor" />
        <SkeletonCard variant="sensor" />
        <SkeletonCard variant="gauge" />
        <SkeletonCard variant="sensor" />
      </div>
    )
  }

  return (
    <div className="relative">
      {dataUntrusted && <FrozenOverlay deviceStatus={deviceStatus} />}

      <motion.div
        key={`gauges-${selectedMac}`}
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        style={{ opacity: gridOpacity }}
        className={`grid grid-cols-1 gap-3 sm:grid-cols-2 transition-all duration-500 ${
          dataUntrusted ? 'pointer-events-none select-none blur-[1px] grayscale-[50%]' : isDelayed ? 'grayscale-[20%]' : ''
        }`}
      >
        {/* Temperature */}
        <motion.div
          variants={cardItem}
          whileHover={dataUntrusted ? {} : { y: -3, scale: 1.01 }}
          transition={spring.snappy}
          className="sensor-card relative overflow-hidden"
        >
          {isLive && <LiveDot />}
          <div className="icon-pill mb-4 dark:bg-primary/25">
            <ThermometerIcon className="h-5 w-5 text-primary dark:text-primary-300" />
          </div>
          <p className="stat-label mb-2">Temperature</p>
          <p className="font-display text-3xl font-bold tabular-nums text-forest dark:text-slate-100 leading-none">
            {temp != null && !Number.isNaN(temp) ? `${displayTemp.toFixed(1)}°` : '—'}
            {temp != null && !Number.isNaN(temp) && (
              <span className="ml-1 text-base font-medium text-forest-400 dark:text-slate-400">C</span>
            )}
          </p>
        </motion.div>

        {/* Light */}
        <motion.div
          variants={cardItem}
          whileHover={dataUntrusted ? {} : { y: -3, scale: 1.01 }}
          transition={spring.snappy}
          className="sensor-card relative overflow-hidden"
        >
          {isLive && <LiveDot />}
          <div className="icon-pill mb-4 dark:bg-primary/25">
            <SunIcon className="h-5 w-5 text-primary dark:text-primary-300" />
          </div>
          <p className="stat-label mb-2">Light</p>
          <p className="font-display text-3xl font-bold text-forest dark:text-slate-100 leading-none">
            {readings?.lux != null ? `${Math.round(readings.lux)} lx` : '—'}
          </p>
        </motion.div>

        {/* Water Tank */}
        <motion.div
          variants={cardItem}
          whileHover={dataUntrusted ? {} : { y: -3, scale: 1.01 }}
          transition={spring.snappy}
          className="sensor-card relative overflow-hidden"
        >
          {isLive && <LiveDot />}
          <div className={`icon-pill mb-4 ${readings?.tk === 1 ? 'bg-red-100 dark:bg-red-900/40' : 'dark:bg-primary/25'}`}>
            <svg className={`h-5 w-5 ${readings?.tk === 1 ? 'text-red-500' : 'text-primary dark:text-primary-300'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18M7 6h10M7 18h10" />
            </svg>
          </div>
          <p className="stat-label mb-2">Water Tank</p>
          <p className={`font-display text-3xl font-bold leading-none ${readings?.tk === 1 ? 'text-red-500' : 'text-forest dark:text-slate-100'}`}>
            {readings?.tk == null ? '—' : readings.tk === 1 ? 'Empty' : 'OK'}
          </p>
        </motion.div>

        {/* Soil moisture — full width */}
        <motion.div
          variants={cardItem}
          whileHover={dataUntrusted ? {} : { y: -3, scale: 1.005 }}
          transition={spring.snappy}
          className="sensor-card relative overflow-hidden sm:col-span-2"
        >
          {isLive && <LiveDot />}
          <p className="stat-label mb-5 text-center">Soil moisture</p>
          <CircularGauge percentage={displayGaugePct} label={soilLabel} size={180} strokeWidth={11} />
        </motion.div>

        {/* Pressure — optional */}
        {hasPressure && (
          <motion.div
            variants={cardItem}
            whileHover={dataUntrusted ? {} : { y: -3, scale: 1.01 }}
            transition={spring.snappy}
            className="sensor-card relative overflow-hidden"
          >
            {isLive && <LiveDot />}
            <div className="icon-pill mb-4 dark:bg-primary/25">
              <BarometerIcon className="h-5 w-5 text-primary dark:text-primary-300" />
            </div>
            <p className="stat-label mb-2">Pressure</p>
            <p className="font-display text-3xl font-bold tabular-nums text-forest dark:text-slate-100 leading-none">
              {formatPressure(readings!.pressure!)}
              <span className="ml-1 text-base font-medium text-forest-400 dark:text-slate-400">hPa</span>
            </p>
          </motion.div>
        )}

        {/* Humidity — optional (BME280) */}
        {hasHumidity && (
          <motion.div
            variants={cardItem}
            whileHover={dataUntrusted ? {} : { y: -3, scale: 1.01 }}
            transition={spring.snappy}
            className="sensor-card relative overflow-hidden"
          >
            {isLive && <LiveDot />}
            <div className="icon-pill mb-4 dark:bg-primary/25">
              <DropletIcon className="h-5 w-5 text-primary dark:text-primary-300" />
            </div>
            <p className="stat-label mb-2">Humidity</p>
            <p className="font-display text-3xl font-bold tabular-nums text-forest dark:text-slate-100 leading-none">
              {readings!.humidity!.toFixed(1)}
              <span className="ml-1 text-base font-medium text-forest-400 dark:text-slate-400">%</span>
            </p>
          </motion.div>
        )}
      </motion.div>
    </div>
  )
}
