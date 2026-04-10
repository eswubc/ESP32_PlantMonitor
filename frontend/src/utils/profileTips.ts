import type { Readings, PlantProfile } from '../types'

export type ProfileTip = {
  id: string
  message: string
  severity: 'info' | 'warning' | 'ok'
}

/**
 * Compute plant care tips from current readings vs the profile's ideal ranges.
 * Returns tips when readings are outside the profile's preferred ranges.
 */
export function getProfileTips(readings: Readings | null, profile: PlantProfile | null): ProfileTip[] {
  const tips: ProfileTip[] = []
  if (!readings || !profile) return tips

  const soil = readings.soilRaw
  if (soil != null && !Number.isNaN(soil)) {
    let min = profile.soilMin
    let max = profile.soilMax
    if (min != null && max != null && min !== max) {
      if (min > max) [min, max] = [max, min]
      if (soil < min) {
        tips.push({
          id: 'soil-wet',
          message: `Soil is wetter than ideal for ${profile.name} (prefers ${min}–${max})`,
          severity: 'info',
        })
      } else if (soil > max) {
        tips.push({
          id: 'soil-dry',
          message: `Soil is drier than ideal for ${profile.name} (prefers ${min}–${max})`,
          severity: 'warning',
        })
      } else {
        tips.push({ id: 'soil-ok', message: `Soil in ideal range for ${profile.name}`, severity: 'ok' })
      }
    }
  }

  const temp = readings.temperature
  if (temp != null && !Number.isNaN(temp)) {
    const tMin = profile.tempMin
    const tMax = profile.tempMax
    if (tMin != null && tMax != null) {
      if (temp < tMin) {
        tips.push({
          id: 'temp-low',
          message: `Temperature (${temp.toFixed(1)}°C) is below ideal for ${profile.name} (${tMin}–${tMax}°C)`,
          severity: 'warning',
        })
      } else if (temp > tMax) {
        tips.push({
          id: 'temp-high',
          message: `Temperature (${temp.toFixed(1)}°C) is above ideal for ${profile.name} (${tMin}–${tMax}°C)`,
          severity: 'warning',
        })
      } else {
        tips.push({ id: 'temp-ok', message: `Temperature ideal for ${profile.name}`, severity: 'ok' })
      }
    }
  }

  const hum = readings.humidity
  if (hum != null && !Number.isNaN(hum)) {
    const hMin = profile.humidityMin
    const hMax = profile.humidityMax
    if (hMin != null && hMax != null) {
      if (hum < hMin) {
        tips.push({
          id: 'hum-low',
          message: `Humidity (${hum.toFixed(0)}%) is below ideal for ${profile.name} (${hMin}–${hMax}%)`,
          severity: 'info',
        })
      } else if (hum > hMax) {
        tips.push({
          id: 'hum-high',
          message: `Humidity (${hum.toFixed(0)}%) is above ideal for ${profile.name} (${hMin}–${hMax}%)`,
          severity: 'info',
        })
      }
    }
  }

  const pref = profile.lightPreference
  if (pref && pref !== 'any' && readings.lux != null && !Number.isNaN(readings.lux)) {
    // >1000 lx = bright (near window / indirect daylight); ≤1000 lx = dim
    const bright = readings.lux > 1000
    if (pref === 'bright' && !bright) {
      tips.push({
        id: 'light-dim',
        message: `${profile.name} prefers bright light — current: dim (${Math.round(readings.lux)} lx)`,
        severity: 'info',
      })
    } else if (pref === 'dim' && bright) {
      tips.push({
        id: 'light-bright',
        message: `${profile.name} prefers dim light — current: bright (${Math.round(readings.lux)} lx)`,
        severity: 'info',
      })
    }
  }

  return tips
}
