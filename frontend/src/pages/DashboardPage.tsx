import { useEffect, useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { motion, animate } from 'framer-motion'
import { ref, query, orderByKey, limitToLast, onValue, set, push, remove } from 'firebase/database'
import { firebaseDb } from '../lib/firebase'
import { useAuth } from '../context/AuthContext'
import { soilStatus, soilStatusLabel, soilRawToGaugeCalibrated } from '../utils/soil'
import { getProfileTips } from '../utils/profileTips'
import { getDeviceStatus, STATUS_META, formatSecondsAgo } from '../utils/deviceStatus'
import type { Readings, PlantProfile, DeviceStatus, DeviceMeta, WateringSchedule } from '../types'
import { LogoutIcon } from '../components/icons/LogoutIcon'
import { PlusIcon } from '../components/icons/PlusIcon'
import { PlantIcon } from '../components/icons/PlantIcon'
import { PencilIcon } from '../components/icons/PencilIcon'
import { HistoryChart } from '../components/HistoryChart'
import { DeviceStatusBar } from '../components/dashboard/DeviceStatusBar'
import { StatusBanners } from '../components/dashboard/StatusBanners'
import { PlantHero } from '../components/dashboard/PlantHero'
import { SensorGrid } from '../components/dashboard/SensorGrid'
import { fadeSlideUp, fadeScale } from '../lib/motion'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { ConfirmDestructiveButton } from '../components/ConfirmDestructiveButton'
import { ThemeToggleIcon } from '../components/icons/ThemeToggleIcon'
import { sanitizeString, sanitizeEmail, sanitizeInt, sanitizeNumber } from '../utils/sanitize'
import { useRateLimit } from '../hooks/useRateLimit'
import { RotatingText } from '../components/ui/rotating-text'
import ScrollStack, { ScrollStackItem } from '../components/ui/ScrollStack'
import ExportModal from '../components/dashboard/ExportModal'

export type DashboardTab = 'dashboard' | 'settings'

const EXAMPLE_PLANTS = [
  { id: 'mint', label: 'Mint', targetSoil: 2000 },
  { id: 'sunflower', label: 'Sunflower (flower)', targetSoil: 2400 },
  { id: 'herb', label: 'Herb / Spice', targetSoil: 2200 },
  { id: 'succulent', label: 'Succulent', targetSoil: 1800 },
  { id: 'tomato', label: 'Tomato', targetSoil: 2600 },
] as const

const STORAGE_KEY = 'smart-plant-selected-device'

export function DashboardPage() {
  const { user, signOut } = useAuth()

  // ── State ──
  const [myDevices, setMyDevices] = useState<string[]>([])
  const [devicesMeta, setDevicesMeta] = useState<Record<string, DeviceMeta>>({})
  const [selectedMac, setSelectedMac] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? '')
  const [readings, setReadings] = useState<Readings | null>(null)
  const [targetSoil, setTargetSoil] = useState(2800)
  const [targetSoilInput, setTargetSoilInput] = useState('2800')
  const [inviteEmail, setInviteEmail] = useState('')
  const [invitedList, setInvitedList] = useState<string[]>([])
  const [copyOk, setCopyOk] = useState(false)
  const [displayTemp, setDisplayTemp] = useState(0)
  const [displayGaugePct, setDisplayGaugePct] = useState(0)
  const [profiles, setProfiles] = useState<Record<string, PlantProfile>>({})
  const [linkedProfileId, setLinkedProfileId] = useState<string | null>(null)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{
    name: string
    type: string
    soilMin?: number
    soilMax?: number
    tempMin?: number
    tempMax?: number
    humidityMin?: number
    humidityMax?: number
    lightPreference?: 'bright' | 'dim' | 'any'
  }>({ name: '', type: '' })
  const [editPresetId, setEditPresetId] = useState<string | null>(null)
  const [newProfileName, setNewProfileName] = useState('')
  const [newProfileType, setNewProfileType] = useState('')
  const [newProfilePresetId, setNewProfilePresetId] = useState<string | null>(null)
  const [resetRequestedAt, setResetRequestedAtRaw] = useState(() => {
    const stored = localStorage.getItem('spp_reset_at')
    if (!stored) return 0
    const ts = Number(stored)
    // Expire after 5 minutes so a stale flag never locks the UI
    if (ts > 0 && Math.floor(Date.now() / 1000) - ts > 300) {
      localStorage.removeItem('spp_reset_at')
      return 0
    }
    return ts
  })
  const setResetRequestedAt = (v: number) => {
    setResetRequestedAtRaw(v)
    if (v > 0) localStorage.setItem('spp_reset_at', String(v))
    else localStorage.removeItem('spp_reset_at')
  }
  const [showSyncedBanner, setShowSyncedBanner] = useState(false)
  const [calibration, setCalibration] = useState<{ boneDry: number | null; submerged: number | null }>({ boneDry: null, submerged: null })
  const [lastAlert, setLastAlert] = useState<{ timestamp: number; type: string; message: string } | null>(null)
  const [pumpActive, setPumpActive] = useState(false)
  const [pumpCooldown, setPumpCooldown] = useState(false)
  const [waterLog, setWaterLog] = useState<Array<{ epoch: number; reason: string; durationMs: number; soilBefore: number; soilAfter: number }>>([])
  const [schedule, setSchedule] = useState<WateringSchedule>({ enabled: false, hour: 8, minute: 0, hysteresis: 200, maxSecondsPerDay: 120, cooldownMinutes: 30 })
  const [diagnostics, setDiagnostics] = useState<{ uptimeSec?: number; lastSyncAt?: number; syncSuccessCount?: number; syncFailCount?: number; wifiRSSI?: number } | null>(null)
  const [notificationsEnabled, setNotificationsEnabled] = useState(() =>
    typeof window !== 'undefined' && localStorage.getItem('notif_enabled') === 'true'
  )
  const [activeTab, setActiveTab] = useState<DashboardTab>('dashboard')
  const [exportModalOpen, setExportModalOpen] = useState(false)
  const lastNotifiedAtRef = useRef(0)
  const prevStatusRef = useRef<DeviceStatus>('no_data')
  const appUrl = typeof window !== 'undefined' ? window.location.origin : ''
  const [canInvite, rateLimitedInvite] = useRateLimit(10000)   // 10s between invites
  const [canWater, rateLimitedWater] = useRateLimit(8000)      // 8s (in addition to pumpCooldown)

  // ── Firebase listeners ──

  useEffect(() => {
    if (!user) return
    return onValue(ref(firebaseDb, `users/${user.uid}/devices`), (snap) => {
      const val = snap.val()
      const list = val ? Object.keys(val) as string[] : []
      setMyDevices(list)
      const meta: Record<string, DeviceMeta> = {}
      if (val && typeof val === 'object') {
        for (const mac of list) {
          const d = (val as Record<string, { meta?: { name?: string; room?: string } }>)[mac]
          if (d?.meta && typeof d.meta === 'object') {
            meta[mac] = { name: d.meta.name, room: d.meta.room }
          }
        }
      }
      setDevicesMeta(meta)
      if (list.length && !list.includes(selectedMac)) {
        const next = list[0]
        setSelectedMac(next)
        localStorage.setItem(STORAGE_KEY, next)
      }
    })
  }, [user, selectedMac])

  useEffect(() => {
    if (!user) return
    return onValue(ref(firebaseDb, `users/${user.uid}/plantProfiles`), (snap) => {
      const val = snap.val()
      setProfiles((val && typeof val === 'object') ? val as Record<string, PlantProfile> : {})
    })
  }, [user])

  useEffect(() => {
    if (!user || !selectedMac) { setLinkedProfileId(null); return }
    return onValue(ref(firebaseDb, `users/${user.uid}/devicePlant/${selectedMac}`), (snap) => {
      const id = snap.val()
      setLinkedProfileId(typeof id === 'string' ? id : null)
    })
  }, [user, selectedMac])

  useEffect(() => {
    if (!selectedMac) { setReadings(null); return }
    return onValue(ref(firebaseDb, `devices/${selectedMac}/readings`), (snap) => {
      setReadings(snap.val() ?? null)
    })
  }, [selectedMac])

  useEffect(() => {
    if (!selectedMac) return
    return onValue(ref(firebaseDb, `devices/${selectedMac}/control/targetSoil`), (snap) => {
      const v = snap.val()
      if (typeof v === 'number' && v >= 0) { setTargetSoil(v); setTargetSoilInput(String(v)) }
    })
  }, [selectedMac])

  useEffect(() => {
    if (!selectedMac) { setCalibration({ boneDry: null, submerged: null }); return }
    return onValue(ref(firebaseDb, `devices/${selectedMac}/calibration`), (snap) => {
      const val = snap.val()
      if (val && typeof val === 'object') {
        const o = val as Record<string, unknown>
        setCalibration({ boneDry: typeof o.boneDry === 'number' ? o.boneDry : null, submerged: typeof o.submerged === 'number' ? o.submerged : null })
      } else { setCalibration({ boneDry: null, submerged: null }) }
    })
  }, [selectedMac])

  useEffect(() => {
    if (!selectedMac) { setLastAlert(null); return }
    return onValue(ref(firebaseDb, `devices/${selectedMac}/alerts/lastAlert`), (snap) => {
      const val = snap.val()
      if (val && typeof val === 'object') {
        const o = val as Record<string, unknown>
        setLastAlert({ timestamp: typeof o.timestamp === 'number' ? o.timestamp : 0, type: typeof o.type === 'string' ? o.type : 'alert', message: typeof o.message === 'string' ? o.message : '—' })
      } else { setLastAlert(null) }
    })
  }, [selectedMac])

  useEffect(() => {
    if (!selectedMac) { setPumpActive(false); return }
    return onValue(ref(firebaseDb, `devices/${selectedMac}/readings/pumpRunning`), (snap) => setPumpActive(snap.val() === true))
  }, [selectedMac])

  useEffect(() => {
    if (!selectedMac) { setDiagnostics(null); return }
    return onValue(ref(firebaseDb, `devices/${selectedMac}/diagnostics`), (snap) => {
      const val = snap.val()
      if (!val || typeof val !== 'object') { setDiagnostics(null); return }
      const o = val as Record<string, unknown>
      setDiagnostics({
        uptimeSec: typeof o.uptimeSec === 'number' ? o.uptimeSec : undefined,
        lastSyncAt: typeof o.lastSyncAt === 'number' ? o.lastSyncAt : undefined,
        syncSuccessCount: typeof o.syncSuccessCount === 'number' ? o.syncSuccessCount : undefined,
        syncFailCount: typeof o.syncFailCount === 'number' ? o.syncFailCount : undefined,
        wifiRSSI: typeof o.wifiRSSI === 'number' ? o.wifiRSSI : undefined,
      })
    })
  }, [selectedMac])

  useEffect(() => {
    if (!selectedMac) { setSchedule({ enabled: false, hour: 8, minute: 0, hysteresis: 200, maxSecondsPerDay: 120, cooldownMinutes: 30 }); return }
    return onValue(ref(firebaseDb, `devices/${selectedMac}/control/schedule`), (snap) => {
      const val = snap.val()
      if (!val || typeof val !== 'object') {
        setSchedule({ enabled: false, hour: 8, minute: 0, hysteresis: 200, maxSecondsPerDay: 120, cooldownMinutes: 30 })
        return
      }
      const o = val as Record<string, unknown>
      setSchedule({
        enabled: o.enabled === true,
        hour: typeof o.hour === 'number' ? o.hour : 8,
        minute: typeof o.minute === 'number' ? o.minute : 0,
        hysteresis: typeof o.hysteresis === 'number' ? o.hysteresis : 200,
        maxSecondsPerDay: typeof o.maxSecondsPerDay === 'number' ? o.maxSecondsPerDay : 120,
        cooldownMinutes: typeof o.cooldownMinutes === 'number' ? o.cooldownMinutes : 30,
        day: typeof o.day === 'string' ? o.day : undefined,
        todaySeconds: typeof o.todaySeconds === 'number' ? o.todaySeconds : undefined,
        lastWateredAt: typeof o.lastWateredAt === 'number' ? o.lastWateredAt : undefined,
      })
    })
  }, [selectedMac])

  useEffect(() => {
    if (!selectedMac) { setWaterLog([]); return }
    const waterLogRef = ref(firebaseDb, `devices/${selectedMac}/waterLog`)
    const q = query(waterLogRef, orderByKey(), limitToLast(50))
    return onValue(q, (snap) => {
      const val = snap.val()
      if (!val || typeof val !== 'object') { setWaterLog([]); return }
      const entries = Object.entries(val).map(([k, v]) => {
        const o = v as Record<string, unknown>
        return {
          epoch: parseInt(k, 10),
          reason: typeof o.reason === 'string' ? o.reason : 'manual',
          durationMs: typeof o.durationMs === 'number' ? o.durationMs : 0,
          soilBefore: typeof o.soilBefore === 'number' ? o.soilBefore : 0,
          soilAfter: typeof o.soilAfter === 'number' ? o.soilAfter : 0,
        }
      })
      entries.sort((a, b) => b.epoch - a.epoch)
      setWaterLog(entries)
    })
  }, [selectedMac])

  useEffect(() => {
    if (!user) return
    return onValue(ref(firebaseDb, `users/${user.uid}/invites`), (snap) => {
      const val = snap.val()
      if (!val || typeof val !== 'object') { setInvitedList([]); return }
      setInvitedList(
        (Object.values(val) as { email?: string }[]).map((v) => v.email).filter((e): e is string => typeof e === 'string')
      )
    })
  }, [user])

  // ── Handlers ──

  function handleSaveTarget() {
    const n = sanitizeInt(targetSoilInput, 0, 4095, -1)
    if (n < 0) return
    set(ref(firebaseDb, `devices/${selectedMac}/control/targetSoil`), n).catch(console.error)
    setTargetSoil(n)
  }

  const [scheduleInput, setScheduleInput] = useState({
    enabled: false,
    hour: 8,
    minute: 0,
    hysteresis: 200,
    maxSecondsPerDay: 120,
    cooldownMinutes: 30,
  })
  useEffect(() => {
    setScheduleInput({
      enabled: schedule.enabled ?? false,
      hour: schedule.hour ?? 8,
      minute: schedule.minute ?? 0,
      hysteresis: schedule.hysteresis ?? 200,
      maxSecondsPerDay: schedule.maxSecondsPerDay ?? 120,
      cooldownMinutes: schedule.cooldownMinutes ?? 30,
    })
  }, [schedule.enabled, schedule.hour, schedule.minute, schedule.hysteresis, schedule.maxSecondsPerDay, schedule.cooldownMinutes])

  async function handleSaveSchedule() {
    if (!selectedMac) return
    const hour = sanitizeInt(scheduleInput.hour, 0, 23, 8)
    const minute = sanitizeInt(scheduleInput.minute, 0, 59, 0)
    const hysteresis = sanitizeInt(scheduleInput.hysteresis, 0, 2000, 200)
    const maxSecondsPerDay = sanitizeInt(scheduleInput.maxSecondsPerDay, 10, 600, 120)
    const cooldownMinutes = sanitizeInt(scheduleInput.cooldownMinutes, 5, 1440, 30)
    await set(ref(firebaseDb, `devices/${selectedMac}/control/schedule/enabled`), scheduleInput.enabled).catch(console.error)
    await set(ref(firebaseDb, `devices/${selectedMac}/control/schedule/hour`), hour).catch(console.error)
    await set(ref(firebaseDb, `devices/${selectedMac}/control/schedule/minute`), minute).catch(console.error)
    await set(ref(firebaseDb, `devices/${selectedMac}/control/schedule/hysteresis`), hysteresis).catch(console.error)
    await set(ref(firebaseDb, `devices/${selectedMac}/control/schedule/maxSecondsPerDay`), maxSecondsPerDay).catch(console.error)
    await set(ref(firebaseDb, `devices/${selectedMac}/control/schedule/cooldownMinutes`), cooldownMinutes).catch(console.error)
    setSchedule((prev) => ({ ...prev, ...scheduleInput, hour, minute, hysteresis, maxSecondsPerDay, cooldownMinutes }))
  }

  async function handleSaveDeviceMeta(mac: string, meta: DeviceMeta) {
    if (!user) return
    const safe: DeviceMeta = {
      name: meta.name ? sanitizeString(meta.name, 80) : undefined,
      room: meta.room ? sanitizeString(meta.room, 80) : undefined,
    }
    await set(ref(firebaseDb, `users/${user.uid}/devices/${mac}/meta`), safe).catch(console.error)
    setDevicesMeta((prev) => ({ ...prev, [mac]: safe }))
  }

  async function handleCopyUrl() {
    try { await navigator.clipboard.writeText(appUrl); setCopyOk(true); setTimeout(() => setCopyOk(false), 2000) }
    catch { setCopyOk(false) }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    const email = sanitizeEmail(inviteEmail)
    if (!email || !user) return
    await rateLimitedInvite(async () => {
      const safeKey = email.replace(/[.#$[\]]/g, '_')
      await set(ref(firebaseDb, `users/${user.uid}/invites/${safeKey}`), { email, at: Date.now() }).catch(console.error)
      setInviteEmail('')
    })
  }

  function openEditPlant(profileId: string | null) {
    setEditPresetId(null)
    if (profileId && profiles[profileId]) {
      const p = profiles[profileId]
      setEditingProfileId(profileId)
      setEditForm({
        name: p.name,
        type: p.type,
        soilMin: p.soilMin,
        soilMax: p.soilMax,
        tempMin: p.tempMin,
        tempMax: p.tempMax,
        humidityMin: p.humidityMin,
        humidityMax: p.humidityMax,
        lightPreference: p.lightPreference ?? 'any',
      })
    } else { setEditingProfileId(null); setEditForm({ name: '', type: '' }) }
    setEditModalOpen(true)
  }

  function closeEditPlant() {
    setEditModalOpen(false)
    setEditingProfileId(null)
    setEditForm({ name: '', type: '' })
    setEditPresetId(null)
  }

  async function saveEditPlant(andLinkToDevice: boolean) {
    const name = sanitizeString(editForm.name, 80)
    const type = sanitizeString(editForm.type, 60)
    if (!name || !user) return
    const now = Date.now()
    const profilePayload: PlantProfile = {
      name,
      type: type || '—',
      createdAt: profiles[editingProfileId ?? '']?.createdAt ?? now,
    }
    if (editForm.soilMin != null && editForm.soilMax != null) {
      const smin = sanitizeNumber(editForm.soilMin, 0, 4095)
      const smax = sanitizeNumber(editForm.soilMax, 0, 4095)
      if (!Number.isNaN(smin) && !Number.isNaN(smax)) {
        profilePayload.soilMin = Math.round(smin)
        profilePayload.soilMax = Math.round(smax)
      }
    }
    if (editForm.tempMin != null && editForm.tempMax != null) {
      const tmin = sanitizeNumber(editForm.tempMin, -40, 80)
      const tmax = sanitizeNumber(editForm.tempMax, -40, 80)
      if (!Number.isNaN(tmin) && !Number.isNaN(tmax)) {
        profilePayload.tempMin = Math.round(tmin)
        profilePayload.tempMax = Math.round(tmax)
      }
    }
    if (editForm.humidityMin != null && editForm.humidityMax != null) {
      const hmin = sanitizeNumber(editForm.humidityMin, 0, 100)
      const hmax = sanitizeNumber(editForm.humidityMax, 0, 100)
      if (!Number.isNaN(hmin) && !Number.isNaN(hmax)) {
        profilePayload.humidityMin = Math.round(hmin)
        profilePayload.humidityMax = Math.round(hmax)
      }
    }
    if (editForm.lightPreference && editForm.lightPreference !== 'any') {
      profilePayload.lightPreference = editForm.lightPreference
    }
    if (editingProfileId) {
      await set(ref(firebaseDb, `users/${user.uid}/plantProfiles/${editingProfileId}`), profilePayload).catch(console.error)
      if (selectedMac && editPresetId) {
        const preset = EXAMPLE_PLANTS.find((p) => p.id === editPresetId)
        if (preset) { await set(ref(firebaseDb, `devices/${selectedMac}/control/targetSoil`), preset.targetSoil).catch(console.error); setTargetSoil(preset.targetSoil); setTargetSoilInput(String(preset.targetSoil)) }
      }
    } else {
      const newRef = push(ref(firebaseDb, `users/${user.uid}/plantProfiles`))
      const id = newRef.key
      if (!id) return
      await set(newRef, profilePayload).catch(console.error)
      if (andLinkToDevice && selectedMac) {
        await set(ref(firebaseDb, `users/${user.uid}/devicePlant/${selectedMac}`), id).catch(console.error)
        if (editPresetId) { const preset = EXAMPLE_PLANTS.find((p) => p.id === editPresetId); if (preset) { await set(ref(firebaseDb, `devices/${selectedMac}/control/targetSoil`), preset.targetSoil).catch(console.error); setTargetSoil(preset.targetSoil); setTargetSoilInput(String(preset.targetSoil)) } }
      }
    }
    closeEditPlant()
  }

  async function linkProfileToDevice(profileId: string) { if (!user || !selectedMac) return; await set(ref(firebaseDb, `users/${user.uid}/devicePlant/${selectedMac}`), profileId).catch(console.error) }

  async function deleteProfile(profileId: string) {
    if (!user) return
    await remove(ref(firebaseDb, `users/${user.uid}/plantProfiles/${profileId}`)).catch(console.error)
    if (linkedProfileId === profileId && selectedMac) await set(ref(firebaseDb, `users/${user.uid}/devicePlant/${selectedMac}`), null).catch(console.error)
  }

  async function handleResetDeviceWiFi() {
    if (!selectedMac || resetRequestedAt > 0) return
    const now = Math.floor(Date.now() / 1000)
    // Set local state FIRST so the UI transitions immediately to "syncing"
    setResetRequestedAt(now)
    await Promise.all([
      set(ref(firebaseDb, `devices/${selectedMac}/control/resetProvisioning`), true),
      set(ref(firebaseDb, `devices/${selectedMac}/readings`), null),
    ]).catch(console.error)
  }

  async function handleMarkDry() { if (!selectedMac || readings?.soilRaw == null) return; await set(ref(firebaseDb, `devices/${selectedMac}/calibration/boneDry`), readings.soilRaw).catch(console.error) }
  async function handleMarkWet() { if (!selectedMac || readings?.soilRaw == null) return; await set(ref(firebaseDb, `devices/${selectedMac}/calibration/submerged`), readings.soilRaw).catch(console.error) }

  async function handleTriggerPump() {
    if (!selectedMac || pumpCooldown) return
    await rateLimitedWater(async () => {
      await set(ref(firebaseDb, `devices/${selectedMac}/control/pumpRequest`), true).catch(console.error)
      setPumpCooldown(true)
      setTimeout(() => setPumpCooldown(false), 8000)
    })
  }

  async function handleAckAlert() { if (!selectedMac) return; await set(ref(firebaseDb, `devices/${selectedMac}/alerts/lastAlert/ackAt`), Math.floor(Date.now() / 1000)).catch(console.error); setLastAlert(null) }

  async function handleToggleNotifications() {
    if (notificationsEnabled) { setNotificationsEnabled(false); localStorage.setItem('notif_enabled', 'false'); return }
    if (!('Notification' in window)) return
    const perm = await Notification.requestPermission()
    if (perm === 'granted') { setNotificationsEnabled(true); localStorage.setItem('notif_enabled', 'true') }
  }

  useEffect(() => {
    if (!notificationsEnabled || !lastAlert) return
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    if (lastAlert.timestamp <= lastNotifiedAtRef.current) return
    lastNotifiedAtRef.current = lastAlert.timestamp
    new Notification('Smart Plant Pro', { body: lastAlert.message, icon: '/plant-icon.svg' })
  }, [lastAlert, notificationsEnabled])

  async function addNewProfile(e: React.FormEvent) {
    e.preventDefault()
    const name = sanitizeString(newProfileName, 80)
    const type = sanitizeString(newProfileType, 60)
    if (!name || !user) return
    const newRef = push(ref(firebaseDb, `users/${user.uid}/plantProfiles`)); const id = newRef.key; if (!id) return
    await set(newRef, { name, type: type || '—', createdAt: Date.now() }).catch(console.error)
    if (newProfilePresetId && selectedMac) { const preset = EXAMPLE_PLANTS.find((p) => p.id === newProfilePresetId); if (preset) { await set(ref(firebaseDb, `devices/${selectedMac}/control/targetSoil`), preset.targetSoil).catch(console.error); setTargetSoil(preset.targetSoil); setTargetSoilInput(String(preset.targetSoil)) } }
    setNewProfileName(''); setNewProfileType(''); setNewProfilePresetId(null)
  }

  // ── Derived values ──

  const currentPlant = linkedProfileId ? profiles[linkedProfileId] : null
  const soil = readings?.soilRaw != null ? soilStatus(readings.soilRaw) : null
  const soilLabel = soil != null ? soilStatusLabel(soil) : '—'
  const gaugePct = readings?.soilRaw != null ? soilRawToGaugeCalibrated(readings.soilRaw, calibration.boneDry, calibration.submerged) * 100 : 0
  const temp = readings?.temperature

  useEffect(() => { const to = temp != null && !Number.isNaN(temp) ? temp : 0; const c = animate(displayTemp, to, { duration: 0.6, onUpdate: (v) => setDisplayTemp(v) }); return () => c.stop() }, [temp])
  useEffect(() => { const c = animate(displayGaugePct, gaugePct, { duration: 0.7, onUpdate: (v) => setDisplayGaugePct(v) }); return () => c.stop() }, [gaugePct])

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => { const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 2000); return () => clearInterval(id) }, [])

  const deviceStatus = getDeviceStatus(readings, nowSec, resetRequestedAt, {
    lastSyncAt: diagnostics?.lastSyncAt ?? null,
    lastAlertTs: lastAlert?.timestamp ?? null,
  })
  const meta = STATUS_META[deviceStatus]

  useEffect(() => {
    if (resetRequestedAt > 0 && deviceStatus === 'live') {
      setShowSyncedBanner(true)
      // Show the "Back online" banner for 4s, then clear the reset state
      const timer = setTimeout(() => { setResetRequestedAt(0); setShowSyncedBanner(false) }, 4000)
      return () => clearTimeout(timer)
    }
    // Auto-expire stale reset if somehow left hanging for > 5 min
    if (resetRequestedAt > 0 && Math.floor(Date.now() / 1000) - resetRequestedAt > 300) {
      setResetRequestedAt(0)
    }
  }, [deviceStatus, resetRequestedAt])
  useEffect(() => { prevStatusRef.current = deviceStatus }, [deviceStatus])

  useEffect(() => {
    if (!editModalOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeEditPlant() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [editModalOpen])

  const isResetGuide = resetRequestedAt > 0 && deviceStatus === 'syncing'
  const dataUntrusted = deviceStatus === 'offline' || deviceStatus === 'syncing' || deviceStatus === 'wifi_connected' || deviceStatus === 'no_data'
  const isDelayed = deviceStatus === 'delayed'
  const healthOk = (readings?.health ?? '').toLowerCase() === 'ok'
  const readingsTs = readings?.timestamp ?? 0
  const readingsTsValid = readingsTs > 1577836800
  const diagTs = diagnostics?.lastSyncAt ?? 0
  const diagTsValid = diagTs > 1577836800
  const lastSeenSec = readingsTsValid ? readingsTs : (diagTsValid ? diagTs : 0)
  const tsValid = lastSeenSec > 1577836800
  const secondsAgo = tsValid ? nowSec - lastSeenSec : Infinity
  const lastSeenLabel = formatSecondsAgo(secondsAgo, tsValid)
  const lastUpdated = tsValid ? new Date(lastSeenSec * 1000).toLocaleTimeString() : null
  const showProTip = temp != null && !Number.isNaN(temp) && temp > 28

  const statusDescription: Record<DeviceStatus, React.ReactNode> = {
    live: `Receiving data — updated ${lastSeenLabel}`,
    delayed: `Last data ${lastSeenLabel} — device may be slow to respond`,
    offline: `Last seen ${lastSeenLabel} — device is not sending data`,
    syncing: resetRequestedAt > 0 ? (
      <>
        Device is <RotatingText words={["restarting", "rebooting", "resetting"]} mode="fade" interval={2000} className="font-medium text-primary" /> into setup mode…
      </>
    ) : (
      <>
        <RotatingText words={["Waiting", "Preparing", "Initializing"]} mode="fade" interval={2000} className="font-medium text-primary" /> for sensor data…
      </>
    ),
    wifi_connected: (
      <>
        Connected to WiFi — <RotatingText words={["waiting", "preparing", "readying"]} mode="fade" interval={2000} className="font-medium text-primary" /> for sensor data…
      </>
    ),
    no_data: (
      <>
        <RotatingText words={["Waiting", "Preparing", "Readying"]} mode="fade" interval={2000} className="font-medium text-primary" /> for first reading…
      </>
    ),
  }

  // ── Render ──
  return (
    <>
    <div className="min-h-screen p-4 pb-8 md:p-6 lg:p-8">
      <div className="mx-auto max-w-4xl">
        {/* Floating header — Dashboard, Settings, Theme, Add device, Sign out */}
        <motion.header
          variants={fadeSlideUp}
          initial="hidden"
          animate="visible"
          className="sticky top-4 z-20 mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-forest/[0.08] bg-white/90 px-4 py-2.5 shadow-lg backdrop-blur-xl dark:border-slate-600/40 dark:bg-slate-800/95 sm:gap-4 sm:px-5 sm:py-3"
        >
          <div className="flex items-center gap-3 sm:gap-4">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl sm:h-9 sm:w-9"
              style={{ background: 'linear-gradient(135deg, #4a9b6d 0%, #2f6347 65%, #1c3d2c 100%)' }}
            >
              <PlantIcon className="h-4 w-4 text-white sm:h-5 sm:w-5" />
            </div>
            <h1 className="font-display text-base font-bold tracking-tight text-forest dark:text-slate-100 sm:text-lg">Smart Plant Pro</h1>
            {/* Inline tabs — Dashboard | Settings */}
            <nav className="ml-2 flex items-center gap-0.5 rounded-xl bg-forest/[0.04] p-0.5 dark:bg-slate-700/50 sm:ml-4" aria-label="Main navigation">
              <button
                type="button"
                onClick={() => setActiveTab('dashboard')}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors sm:px-4 ${
                  activeTab === 'dashboard'
                    ? 'bg-white text-primary shadow-sm dark:bg-slate-600 dark:text-primary-300'
                    : 'text-forest/50 hover:text-forest/70 dark:text-slate-400 dark:hover:text-slate-300'
                }`}
                aria-current={activeTab === 'dashboard' ? 'page' : undefined}
              >
                Dashboard
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('settings')}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors sm:px-4 ${
                  activeTab === 'settings'
                    ? 'bg-white text-primary shadow-sm dark:bg-slate-600 dark:text-primary-300'
                    : 'text-forest/50 hover:text-forest/70 dark:text-slate-400 dark:hover:text-slate-300'
                }`}
                aria-current={activeTab === 'settings' ? 'page' : undefined}
              >
                Settings
              </button>
            </nav>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <ThemeToggleIcon compact />
            <Link to="/claim" className="btn-ghost flex items-center gap-1.5 !py-2 !px-2.5 !text-xs sm:!px-3"><PlusIcon className="h-3.5 w-3.5" /><span className="hidden sm:inline">Add device</span></Link>
            {user && (
              <div className="hidden items-center gap-2 rounded-xl border border-forest/5 bg-surface px-2.5 py-1.5 md:flex">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                  {(user.displayName || user.email || 'U')[0].toUpperCase()}
                </div>
                <span className="max-w-[100px] truncate text-xs text-forest-400">{user.displayName || user.email || 'Account'}</span>
              </div>
            )}
            <button onClick={() => signOut()} className="btn-ghost flex items-center gap-1.5 !py-2 !px-2.5 !text-xs text-forest/45 hover:text-red-500 sm:!px-3 dark:text-slate-400 dark:hover:text-red-400"><LogoutIcon className="h-3.5 w-3.5" /><span className="hidden sm:inline">Sign out</span></button>
          </div>
        </motion.header>

        {myDevices.length === 0 ? (
          <motion.div variants={fadeSlideUp} initial="hidden" animate="visible" className="section-card flex flex-col items-center justify-center p-14 text-center">
            <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 shadow-glow ring-1 ring-primary/10"><PlusIcon className="h-7 w-7 text-primary" /></div>
            <p className="mb-2 font-display text-lg font-bold text-forest dark:text-forest-100">
              <RotatingText
                words={["Ready", "Set", "Let's"]}
                mode="slide"
                interval={2000}
                className="text-primary"
              />{" "}
              get started
            </p>
            <p className="mb-6 text-sm text-forest-400 dark:text-forest-500">
              Add your first plant monitor to begin{" "}
              <RotatingText
                words={["monitoring", "tracking", "caring"]}
                mode="fade"
                interval={2500}
                className="font-medium text-primary"
              />{" "}
              your plants.
            </p>
            <Link to="/claim" className="btn-primary">Add a device</Link>
          </motion.div>
        ) : (
          <>
            <DeviceStatusBar
              devices={myDevices}
              devicesMeta={devicesMeta}
              selectedMac={selectedMac}
              onSelectMac={(mac) => { setSelectedMac(mac); localStorage.setItem(STORAGE_KEY, mac) }}
              onSaveDeviceMeta={handleSaveDeviceMeta}
              onResetWiFi={handleResetDeviceWiFi}
              isResetPending={resetRequestedAt > 0}
              deviceStatus={deviceStatus}
              statusMeta={meta}
              statusDescription={statusDescription[deviceStatus]}
              readings={readings}
              lastUpdated={lastUpdated}
            />

            {/* Reset guide */}
            {isResetGuide && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="rounded-[32px] bg-white p-6 shadow-card sm:p-8">
                <div className="mb-5 flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100">
                    <svg className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" /></svg>
                  </span>
                  <div>
                    <h2 className="text-lg font-semibold text-forest">Device WiFi reset</h2>
                    <p className="text-sm text-forest-400">Your device is restarting into setup mode</p>
                  </div>
                </div>
                <p className="mb-4 text-sm text-forest-500">No data will appear here until the device reconnects to WiFi. Follow these steps:</p>
                <ol className="mb-6 space-y-4">
                  {[
                    { title: 'Wait ~10 seconds', desc: 'The device is clearing its WiFi config and restarting into AP mode.' },
                    { title: <>Connect to <span className="font-mono text-primary">SmartPlantPro</span> WiFi</>, desc: 'Open WiFi settings on your phone or laptop and connect to the SmartPlantPro network.' },
                    { title: 'Open the setup portal', desc: <>A captive portal should open automatically. If not, go to <strong className="font-mono">192.168.4.1</strong> in a browser.</> },
                    { title: 'Choose WiFi and save', desc: 'Select your WiFi network, enter the password. Hit Save.' },
                    { title: 'Reconnect to your own WiFi', desc: 'Switch back to your home WiFi. The dashboard will update automatically once the device connects.' },
                  ].map((step, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">{i + 1}</span>
                      <div><p className="text-sm font-medium text-forest">{step.title}</p><p className="text-xs text-forest-400">{step.desc}</p></div>
                    </li>
                  ))}
                </ol>
                <div className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3">
                  <span className="relative flex h-3 w-3"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" /><span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500" /></span>
                  <p className="text-sm text-forest-500">Waiting for device to reconnect…</p>
                </div>
                <button type="button" onClick={() => setResetRequestedAt(0)} className="mt-4 rounded-2xl border border-forest/10 bg-white px-4 py-2 text-sm font-medium text-forest-400 transition hover:bg-sage-50 hover:text-forest">Dismiss and show dashboard</button>
              </motion.div>
            )}

            {!isResetGuide && (
              <>
                {activeTab === 'dashboard' && (
                  <>
                    <StatusBanners deviceStatus={deviceStatus} showSyncedBanner={showSyncedBanner} lastSeenLabel={lastSeenLabel} />

                    <PlantHero
                selectedMac={selectedMac}
                plantName={currentPlant?.name ?? 'Your plant'}
                plantType={currentPlant?.type ?? ''}
                deviceStatus={deviceStatus}
                dataUntrusted={dataUntrusted}
                isDelayed={isDelayed}
                isLoading={readings === null && !!selectedMac}
                health={readings?.health}
                healthOk={healthOk}
                onEditPlant={() => openEditPlant(linkedProfileId)}
                readings={readings}
                lastWateredEpoch={waterLog[0]?.epoch ?? null}
                todayTotalMs={waterLog.reduce((sum, e) => {
                  const d = new Date(e.epoch * 1000)
                  const today = new Date()
                  if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
                    return sum + e.durationMs
                  }
                  return sum
                }, 0)}
                profileTips={getProfileTips(readings, currentPlant ?? null)}
              />

              {/* Alert + notification toggle */}
              <div className="mb-3 space-y-2">
                {lastAlert && (
                  <motion.div variants={fadeSlideUp} initial="hidden" animate="visible" className="flex items-start gap-3 rounded-2xl border border-terracotta/18 bg-red-50/70 px-4 py-3 dark:border-red-800/50 dark:bg-red-900/40">
                    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-terracotta/12 dark:bg-red-500/30">
                      <svg className="h-3 w-3 text-terracotta dark:text-red-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" /><path strokeLinecap="round" strokeLinejoin="round" d="M12 15.75h.008" /></svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-forest dark:text-slate-100">{lastAlert.message}</p>
                      {lastAlert.timestamp > 0 && <p className="mt-0.5 text-xs text-forest/40 dark:text-slate-400">{new Date(lastAlert.timestamp * 1000).toLocaleString()}</p>}
                    </div>
                    <button type="button" onClick={handleAckAlert} className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium text-terracotta transition hover:bg-terracotta/10 dark:text-red-300 dark:hover:bg-red-800/50">Dismiss</button>
                  </motion.div>
                )}
                <div className="flex items-center gap-3 rounded-2xl border border-forest/5 bg-white/70 px-3 py-2.5 dark:border-slate-600 dark:bg-slate-800/80">
                  <svg className="h-3.5 w-3.5 shrink-0 text-forest/25 dark:text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" /></svg>
                  <span className="flex-1 text-xs text-forest-400 dark:text-slate-300">{'Notification' in window && Notification.permission === 'denied' ? 'Notifications blocked by browser' : 'Notify me when plant health drops'}</span>
                  <button type="button" onClick={handleToggleNotifications} disabled={'Notification' in window && Notification.permission === 'denied'} className={`relative h-6 w-11 rounded-full transition-colors duration-200 ${notificationsEnabled ? 'bg-primary shadow-glow' : 'bg-forest/12 dark:bg-slate-600'} disabled:cursor-not-allowed disabled:opacity-40`} aria-label="Toggle browser notifications">
                    <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${notificationsEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
              </div>

              <SensorGrid
                deviceStatus={deviceStatus}
                dataUntrusted={dataUntrusted}
                isDelayed={isDelayed}
                isLoading={readings === null && !!selectedMac}
                displayTemp={displayTemp}
                temp={temp}
                displayGaugePct={displayGaugePct}
                soilLabel={soilLabel}
                readings={readings}
                selectedMac={selectedMac}
              />

              {/* History chart */}
              {selectedMac && !dataUntrusted && (
                <HistoryChart deviceMac={selectedMac} />
              )}

              {/* Pump control */}
              <motion.div variants={fadeSlideUp} initial="hidden" animate="visible" className="mt-3 flex items-center gap-3 section-card !p-4">
                <div className={`icon-pill shrink-0 transition-all duration-300 ${pumpActive ? '!bg-primary/18 ring-1 ring-primary/20 dark:!bg-primary/35 dark:ring-primary/40' : ''}`}>
                  <svg className={`h-5 w-5 transition-colors duration-300 ${pumpActive ? 'text-primary dark:text-primary-300' : 'text-forest/30 dark:text-slate-500'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" /></svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-forest dark:text-slate-100">Water pump</p>
                  <p className="mt-0.5 text-xs text-forest-400 dark:text-slate-400">{pumpActive ? 'Pump is running…' : 'Manual watering pulse'}</p>
                </div>
                <button type="button" onClick={handleTriggerPump} disabled={pumpCooldown || !canWater || dataUntrusted} className={`shrink-0 rounded-xl px-4 py-2 text-sm font-semibold transition-all ${pumpActive ? 'bg-primary/12 text-primary ring-1 ring-primary/20' : pumpCooldown || !canWater ? 'bg-forest/5 text-forest/30' : 'btn-primary !rounded-xl'} disabled:opacity-50 disabled:cursor-not-allowed`}>
                  {pumpActive ? 'Running…' : pumpCooldown || !canWater ? 'Sent ✓' : 'Water now'}
                </button>
              </motion.div>

              <button
                onClick={() => setExportModalOpen(true)}
                className="flex items-center gap-2 rounded-xl border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Export Data
              </button>

              {showProTip && (
                <div className="mt-3 rounded-2xl border border-amber-200/50 bg-amber-50/60 p-3">
                  <p className="text-sm font-semibold text-amber-700">Pro tip</p>
                  <p className="mt-1 text-sm text-forest-500">Temperature is above 28 °C. Consider lowering the target moisture threshold.</p>
                </div>
              )}
                  </>
                )}

                {activeTab === 'settings' && (
              <div className="mt-2 space-y-2.5">
                <CollapsibleSection title="Target moisture" subtitle={`Current: ${targetSoil}`} defaultOpen>
                  <p className="mb-4 text-sm text-forest-400 dark:text-slate-400">Soil raw below this value = "wet enough". Drag to set.</p>
                  <div className="flex flex-wrap items-center gap-4">
                    <input type="range" min={0} max={4095} value={targetSoil} onChange={(e) => { const v = Number(e.target.value); setTargetSoil(v); setTargetSoilInput(String(v)) }} className="moisture-slider min-w-0 flex-1" aria-label="Target moisture raw value" />
                    <span className="w-16 text-right font-display text-xl font-bold tabular-nums text-forest dark:text-slate-100">{targetSoil}</span>
                    <button onClick={handleSaveTarget} className="btn-primary">Save</button>
                  </div>
                  <p className="mt-3 text-xs text-forest/35 dark:text-slate-500">Pump control is optional. When enabled, the device pulses the pump until soilRaw ≤ target.</p>
                </CollapsibleSection>

                <CollapsibleSection title="Calibrate soil sensor" subtitle={calibration.boneDry != null ? `Dry: ${calibration.boneDry} · Wet: ${calibration.submerged ?? '—'}` : 'Not calibrated'}>
                  <p className="mb-3 text-sm text-forest-400 dark:text-slate-400">Mark one dry and one wet reading so the gauge uses your exact sensor range. Current raw: <span className="font-mono font-medium text-forest dark:text-slate-100">{readings?.soilRaw ?? '—'}</span></p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" onClick={handleMarkDry} disabled={readings?.soilRaw == null} className="btn-ghost disabled:opacity-40">Mark as dry</button>
                    <button type="button" onClick={handleMarkWet} disabled={readings?.soilRaw == null} className="btn-ghost disabled:opacity-40">Mark as wet</button>
                    {(calibration.boneDry != null || calibration.submerged != null) && (
                      <span className="rounded-lg bg-surface px-2.5 py-1 text-xs text-forest-400 dark:bg-slate-700/60 dark:text-slate-400">
                        Dry: <span className="font-mono font-medium">{calibration.boneDry ?? '—'}</span> · Wet: <span className="font-mono font-medium">{calibration.submerged ?? '—'}</span>
                      </span>
                    )}
                  </div>
                </CollapsibleSection>

                <CollapsibleSection title="Auto watering schedule" subtitle={schedule.enabled ? `Daily at ${String(schedule.hour ?? 8).padStart(2, '0')}:${String(schedule.minute ?? 0).padStart(2, '0')} · Max ${schedule.maxSecondsPerDay ?? 120}s/day` : 'Off'}>
                  <p className="mb-4 text-sm text-forest-400 dark:text-slate-400">Water automatically when soil is dry at a set time. Uses hysteresis, max seconds per day, and cooldown for safety.</p>
                  <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={scheduleInput.enabled} onChange={(e) => setScheduleInput((s) => ({ ...s, enabled: e.target.checked }))} className="rounded border-forest/20 dark:border-slate-500" />
                      <span className="text-sm font-medium text-forest-600 dark:text-slate-300">Enabled</span>
                    </label>
                    <label className="block">
                      <span className="text-xs text-forest-400 dark:text-slate-400">Hour (0–23)</span>
                      <input type="number" min={0} max={23} value={scheduleInput.hour} onChange={(e) => setScheduleInput((s) => ({ ...s, hour: parseInt(e.target.value, 10) || 0 }))} className="input-field mt-0.5 w-full" />
                    </label>
                    <label className="block">
                      <span className="text-xs text-forest-400 dark:text-slate-400">Minute (0–59)</span>
                      <input type="number" min={0} max={59} value={scheduleInput.minute} onChange={(e) => setScheduleInput((s) => ({ ...s, minute: parseInt(e.target.value, 10) || 0 }))} className="input-field mt-0.5 w-full" />
                    </label>
                    <label className="block">
                      <span className="text-xs text-forest-400 dark:text-slate-400">Hysteresis (raw)</span>
                      <input type="number" min={0} max={2000} value={scheduleInput.hysteresis} onChange={(e) => setScheduleInput((s) => ({ ...s, hysteresis: parseInt(e.target.value, 10) || 0 }))} className="input-field mt-0.5 w-full" />
                    </label>
                    <label className="block">
                      <span className="text-xs text-forest-400 dark:text-slate-400">Max s/day</span>
                      <input type="number" min={10} max={600} value={scheduleInput.maxSecondsPerDay} onChange={(e) => setScheduleInput((s) => ({ ...s, maxSecondsPerDay: parseInt(e.target.value, 10) || 60 }))} className="input-field mt-0.5 w-full" />
                    </label>
                    <label className="block">
                      <span className="text-xs text-forest-400 dark:text-slate-400">Cooldown (min)</span>
                      <input type="number" min={5} max={1440} value={scheduleInput.cooldownMinutes} onChange={(e) => setScheduleInput((s) => ({ ...s, cooldownMinutes: parseInt(e.target.value, 10) || 30 }))} className="input-field mt-0.5 w-full" />
                    </label>
                  </div>
                  {schedule.todaySeconds != null && schedule.todaySeconds > 0 && (
                    <p className="mb-3 text-xs text-forest-500">Today: {schedule.todaySeconds}s used</p>
                  )}
                  <button type="button" onClick={handleSaveSchedule} className="btn-primary">Save schedule</button>
                </CollapsibleSection>

                <CollapsibleSection title="Plant profiles" subtitle={`${Object.keys(profiles).length} profile${Object.keys(profiles).length !== 1 ? 's' : ''}`}>
                  <p className="mb-4 text-sm text-forest-400 dark:text-slate-400">Add profiles for different plants. Link one to this device to track its name and type.</p>
                  <form onSubmit={addNewProfile} className="mb-4 flex flex-wrap items-center gap-2">
                    <input type="text" value={newProfileName} onChange={(e) => setNewProfileName(e.target.value)} placeholder="Plant name" className="input-field" />
                    <select value={newProfilePresetId ?? ''} onChange={(e) => { const id = e.target.value || null; setNewProfilePresetId(id); setNewProfileType(id ? EXAMPLE_PLANTS.find((p) => p.id === id)?.label ?? '' : '') }} className="input-field">
                      <option value="">— Example plant —</option>
                      {EXAMPLE_PLANTS.map((p) => <option key={p.id} value={p.id}>{p.label} (target {p.targetSoil})</option>)}
                    </select>
                    <input type="text" value={newProfileType} onChange={(e) => setNewProfileType(e.target.value)} placeholder="Type" className="min-w-[120px] input-field" />
                    <button type="submit" className="btn-primary">Add profile</button>
                  </form>
                  {Object.keys(profiles).length === 0 ? (
                    <p className="text-xs text-forest/35 dark:text-forest-500">No plant profiles yet. Add one above.</p>
                  ) : (
                    <div className="h-[500px] overflow-hidden rounded-2xl">
                      <ScrollStack
                        className="h-full"
                        itemDistance={80}
                        itemScale={0.03}
                        itemStackDistance={25}
                        stackPosition="20%"
                        scaleEndPosition="10%"
                        baseScale={0.9}
                        rotationAmount={1.5}
                        blurAmount={1}
                        useWindowScroll={false}
                      >
                        {Object.entries(profiles).sort(([, a], [, b]) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).map(([id, p]) => (
                          <ScrollStackItem
                            key={id}
                            itemClassName="bg-white dark:bg-forest-800/90 border-2 border-forest/10 dark:border-forest-700 shadow-lg"
                          >
                            <div className="flex flex-col gap-4">
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-2">
                                    <h3 className="font-display text-xl font-bold text-forest dark:text-forest-100">{p.name}</h3>
                                    {linkedProfileId === id && (
                                      <span className="rounded-full bg-primary/15 px-2.5 py-1 text-xs font-semibold text-primary dark:bg-primary/30 dark:text-primary-300">
                                        Linked
                                      </span>
                                    )}
                                  </div>
                                  {p.type && p.type !== '—' && (
                                    <span className="inline-block rounded-lg bg-sage-100 px-3 py-1 text-sm font-medium text-forest-600 dark:bg-slate-700 dark:text-slate-300">
                                      {p.type}
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
                                  {linkedProfileId !== id && selectedMac && (
                                    <button
                                      type="button"
                                      onClick={() => linkProfileToDevice(id)}
                                      className="rounded-xl bg-primary/12 px-3 py-1.5 text-xs font-semibold text-primary transition hover:bg-primary/22 dark:bg-primary/25 dark:hover:bg-primary/35"
                                    >
                                      Use
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => openEditPlant(id)}
                                    className="flex h-9 w-9 items-center justify-center rounded-full text-forest/40 transition hover:bg-sage-100 hover:text-forest dark:text-slate-500 dark:hover:bg-slate-600 dark:hover:text-slate-200"
                                    aria-label="Edit profile"
                                  >
                                    <PencilIcon className="h-4 w-4" />
                                  </button>
                                  <ConfirmDestructiveButton
                                    label="Remove"
                                    title="Remove plant profile?"
                                    message={`Delete "${p.name}"? This cannot be undone.`}
                                    confirmLabel="Remove"
                                    onConfirm={() => deleteProfile(id)}
                                    variant="danger"
                                    className="flex h-9 items-center rounded-full px-3 text-xs text-terracotta/70 transition hover:bg-red-50 hover:text-terracotta dark:text-red-400 dark:hover:bg-red-900/50"
                                  />
                                </div>
                              </div>
                              {(p.soilMin != null || p.tempMin != null || p.humidityMin != null) && (
                                <div className="grid grid-cols-3 gap-3 pt-3 border-t border-forest/10 dark:border-forest-700">
                                  {p.soilMin != null && p.soilMax != null && (
                                    <div>
                                      <p className="text-[10px] font-semibold uppercase tracking-wider text-forest/40 dark:text-forest-500 mb-1">Soil</p>
                                      <p className="text-sm font-mono font-semibold text-forest dark:text-forest-100">{p.soilMin}–{p.soilMax}</p>
                                    </div>
                                  )}
                                  {p.tempMin != null && p.tempMax != null && (
                                    <div>
                                      <p className="text-[10px] font-semibold uppercase tracking-wider text-forest/40 dark:text-forest-500 mb-1">Temp</p>
                                      <p className="text-sm font-mono font-semibold text-forest dark:text-forest-100">{p.tempMin}–{p.tempMax}°C</p>
                                    </div>
                                  )}
                                  {p.humidityMin != null && p.humidityMax != null && (
                                    <div>
                                      <p className="text-[10px] font-semibold uppercase tracking-wider text-forest/40 dark:text-forest-500 mb-1">Humidity</p>
                                      <p className="text-sm font-mono font-semibold text-forest dark:text-forest-100">{p.humidityMin}–{p.humidityMax}%</p>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </ScrollStackItem>
                        ))}
                      </ScrollStack>
                    </div>
                  )}
                </CollapsibleSection>

                <CollapsibleSection title="Device diagnostics" subtitle={diagnostics ? `Uptime ${diagnostics.uptimeSec != null ? `${Math.floor((diagnostics.uptimeSec ?? 0) / 60)}m` : '—'}` : 'Waiting…'}>
                  <p className="mb-4 text-sm text-forest-400 dark:text-forest-300">Firmware-reported stats for troubleshooting.</p>
                  {diagnostics ? (
                    <div className="overflow-hidden rounded-xl border border-forest/12 shadow-sm dark:border-slate-600/50">
                      <table className="w-full text-sm" role="grid">
                        <thead>
                          <tr className="border-b border-forest/15 bg-sage-50/80 dark:border-slate-500/40 dark:bg-slate-800/80">
                            <th className="px-4 py-3.5 text-left text-xs font-bold uppercase tracking-wider text-forest dark:text-slate-300">Metric</th>
                            <th className="px-4 py-3.5 text-right text-xs font-bold uppercase tracking-wider text-forest dark:text-slate-300">Value</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-forest/10 dark:divide-slate-600/40">
                          {diagnostics.uptimeSec != null && (
                            <tr className="hover:bg-sage-50/50 dark:hover:bg-slate-700/30">
                              <td className="px-4 py-2.5 text-forest-500 dark:text-slate-400">Uptime</td>
                              <td className="px-4 py-2.5 text-right font-mono font-semibold text-forest dark:text-slate-200">{Math.floor(diagnostics.uptimeSec / 60)} min</td>
                            </tr>
                          )}
                          {diagnostics.lastSyncAt != null && (
                            <tr className="hover:bg-sage-50/50 dark:hover:bg-slate-700/30">
                              <td className="px-4 py-2.5 text-forest-500 dark:text-slate-400">Last sync</td>
                              <td className="px-4 py-2.5 text-right font-mono font-semibold text-forest dark:text-slate-200">{new Date(diagnostics.lastSyncAt * 1000).toLocaleTimeString()}</td>
                            </tr>
                          )}
                          {diagnostics.syncSuccessCount != null && (
                            <tr className="hover:bg-sage-50/50 dark:hover:bg-slate-700/30">
                              <td className="px-4 py-2.5 text-forest-500 dark:text-slate-400">Sync success</td>
                              <td className="px-4 py-2.5 text-right font-mono font-semibold text-green-600 dark:text-green-400">{diagnostics.syncSuccessCount}</td>
                            </tr>
                          )}
                          {diagnostics.syncFailCount != null && diagnostics.syncFailCount > 0 && (
                            <tr className="hover:bg-amber-50/50 dark:hover:bg-amber-900/20">
                              <td className="px-4 py-2.5 text-amber-600 dark:text-amber-400">Sync fails</td>
                              <td className="px-4 py-2.5 text-right font-mono font-semibold text-amber-700 dark:text-amber-400">{diagnostics.syncFailCount}</td>
                            </tr>
                          )}
                          {diagnostics.wifiRSSI != null && (
                            <tr className="hover:bg-sage-50/50 dark:hover:bg-slate-700/30">
                              <td className="px-4 py-2.5 text-forest-500 dark:text-slate-400">WiFi RSSI</td>
                              <td className="px-4 py-2.5 text-right font-mono font-semibold text-forest dark:text-slate-200">{diagnostics.wifiRSSI} dBm</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-xs text-forest/35 dark:text-forest-500">No diagnostics data yet. Device may be offline or firmware is older.</p>
                  )}
                </CollapsibleSection>

                <CollapsibleSection title="Watering log" subtitle={waterLog.length > 0 ? `${waterLog.length} event${waterLog.length !== 1 ? 's' : ''}` : 'No events yet'}>
                  <p className="mb-4 text-sm text-forest-400 dark:text-forest-300">Recent watering events from pump control.</p>
                  {waterLog.length > 0 ? (
                    <div className="overflow-x-auto -mx-1 rounded-xl border border-forest/12 shadow-sm dark:border-slate-600/50">
                      <table className="w-full min-w-[420px] text-sm" role="grid">
                        <thead>
                          <tr className="border-b border-forest/15 bg-sage-50/80 dark:border-slate-500/40 dark:bg-slate-800/80">
                            <th className="px-4 py-3.5 text-left text-xs font-bold uppercase tracking-wider text-forest dark:text-slate-300">Date & time</th>
                            <th className="px-4 py-3.5 text-left text-xs font-bold uppercase tracking-wider text-forest dark:text-slate-300">Reason</th>
                            <th className="px-4 py-3.5 text-right text-xs font-bold uppercase tracking-wider text-forest dark:text-slate-300">Duration</th>
                            <th className="px-4 py-3.5 text-right text-xs font-bold uppercase tracking-wider text-forest dark:text-slate-300">Soil before</th>
                            <th className="px-4 py-3.5 text-right text-xs font-bold uppercase tracking-wider text-forest dark:text-slate-300">Soil after</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-forest/10 dark:divide-slate-600/40">
                          {[...waterLog].reverse().map((e) => (
                            <tr key={e.epoch} className="hover:bg-sage-50/50 dark:hover:bg-slate-700/30">
                              <td className="px-4 py-3 font-medium text-forest dark:text-slate-200">
                                {new Date(e.epoch * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                              </td>
                              <td className="px-4 py-3">
                                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                                  e.reason === 'schedule' ? 'bg-primary/15 text-primary dark:bg-primary/25 dark:text-primary-300' : 'bg-forest/10 text-forest-500 dark:bg-forest-700 dark:text-forest-400'
                                }`}>
                                  {e.reason === 'schedule' ? 'Schedule' : 'Manual'}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-right font-mono text-forest-600 dark:text-slate-300">{(e.durationMs / 1000).toFixed(1)}s</td>
                              <td className="px-4 py-3 text-right font-mono text-forest-600 dark:text-slate-300">{e.soilBefore}</td>
                              <td className="px-4 py-3 text-right font-mono font-medium text-primary dark:text-primary-300">{e.soilAfter}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-xs text-forest/35 dark:text-forest-500">No watering events recorded yet. Use &quot;Water now&quot; or enable the schedule.</p>
                  )}
                </CollapsibleSection>

                <CollapsibleSection title="Invite user" subtitle={invitedList.length > 0 ? `${invitedList.length} invited` : 'Share access'}>
                  <p className="mb-3 text-sm text-forest-400">Share the app link. New users sign up with email and password, then can claim their own devices.</p>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <input type="text" readOnly value={appUrl} className="min-w-0 flex-1 input-field font-mono !text-xs" />
                    <button type="button" onClick={handleCopyUrl} className="btn-ghost">{copyOk ? '✓ Copied' : 'Copy link'}</button>
                  </div>
                  <form onSubmit={handleInvite} className="mb-2 flex flex-wrap items-center gap-2">
                    <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="Email to add to invite list" className="input-field" />
                    <button type="submit" disabled={!canInvite} className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">Invite</button>
                  </form>
                  {invitedList.length > 0 && <p className="text-xs text-forest/40">Invited: {invitedList.join(', ')}</p>}
                </CollapsibleSection>
              </div>
                )}
              </>
            )}
          </>
        )}

        {/* Edit plant modal */}
        {editModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-forest/25 p-4 backdrop-blur-md" role="dialog" aria-modal="true" aria-labelledby="edit-plant-title" onClick={closeEditPlant}>
            <motion.div variants={fadeScale} initial="hidden" animate="visible" exit="exit" className="glass-card-solid w-full max-w-md rounded-3xl p-6 shadow-modal" onClick={(e) => e.stopPropagation()}>
              <h2 id="edit-plant-title" className="mb-4 text-lg font-semibold text-forest">{editingProfileId ? 'Edit plant' : 'Add plant'}</h2>
              <div className="mb-4 space-y-3">
                <label className="block text-sm font-medium text-forest-600">
                  Name
                  <input type="text" value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Living room Monstera" className="mt-1 w-full input-field" />
                </label>
                <label className="block text-sm font-medium text-forest-600">
                  Example plant (sets type & target moisture)
                  <select value={editPresetId ?? ''} onChange={(e) => { const id = e.target.value || null; setEditPresetId(id); const preset = id ? EXAMPLE_PLANTS.find((p) => p.id === id) : null; setEditForm((f) => ({ ...f, type: preset ? preset.label : f.type })) }} className="mt-1 w-full input-field">
                    <option value="">— Custom —</option>
                    {EXAMPLE_PLANTS.map((p) => <option key={p.id} value={p.id}>{p.label} (target {p.targetSoil})</option>)}
                  </select>
                </label>
                <label className="block text-sm font-medium text-forest-600">
                  Type
                  <input type="text" value={editForm.type} onChange={(e) => setEditForm((f) => ({ ...f, type: e.target.value }))} placeholder="e.g. Monstera, Succulent" className="mt-1 w-full input-field" />
                </label>
                <details className="rounded-xl border border-forest/10 bg-forest/[0.02]">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-forest-500">Ideal conditions (optional, for tips)</summary>
                  <div className="space-y-2 border-t border-forest/5 p-3">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-xs">Soil min (raw)</label>
                      <label className="text-xs">Soil max (raw)</label>
                      <input type="number" min={0} max={4095} value={editForm.soilMin ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, soilMin: e.target.value === '' ? undefined : parseInt(e.target.value, 10) }))} className="input-field !py-1.5 !text-sm" placeholder="e.g. 1800" />
                      <input type="number" min={0} max={4095} value={editForm.soilMax ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, soilMax: e.target.value === '' ? undefined : parseInt(e.target.value, 10) }))} className="input-field !py-1.5 !text-sm" placeholder="e.g. 2600" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-xs">Temp min (°C)</label>
                      <label className="text-xs">Temp max (°C)</label>
                      <input type="number" min={-10} max={50} step={0.5} value={editForm.tempMin ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, tempMin: e.target.value === '' ? undefined : parseFloat(e.target.value) }))} className="input-field !py-1.5 !text-sm" placeholder="e.g. 18" />
                      <input type="number" min={-10} max={50} step={0.5} value={editForm.tempMax ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, tempMax: e.target.value === '' ? undefined : parseFloat(e.target.value) }))} className="input-field !py-1.5 !text-sm" placeholder="e.g. 28" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-xs">Humidity min (%)</label>
                      <label className="text-xs">Humidity max (%)</label>
                      <input type="number" min={0} max={100} value={editForm.humidityMin ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, humidityMin: e.target.value === '' ? undefined : parseInt(e.target.value, 10) }))} className="input-field !py-1.5 !text-sm" placeholder="e.g. 40" />
                      <input type="number" min={0} max={100} value={editForm.humidityMax ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, humidityMax: e.target.value === '' ? undefined : parseInt(e.target.value, 10) }))} className="input-field !py-1.5 !text-sm" placeholder="e.g. 70" />
                    </div>
                    <label className="block text-xs">Light preference</label>
                    <select value={editForm.lightPreference ?? 'any'} onChange={(e) => setEditForm((f) => ({ ...f, lightPreference: e.target.value as 'bright' | 'dim' | 'any' }))} className="input-field !py-1.5 !text-sm">
                      <option value="any">Any</option>
                      <option value="bright">Bright</option>
                      <option value="dim">Dim</option>
                    </select>
                  </div>
                </details>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={closeEditPlant} className="flex-1 btn-ghost">Cancel</button>
                <button type="button" onClick={() => saveEditPlant(!editingProfileId)} className="flex-1 btn-primary">{editingProfileId ? 'Save' : 'Save & link'}</button>
              </div>
            </motion.div>
          </div>
        )}
      </div>
    </div>

    {exportModalOpen && selectedMac && (
      <ExportModal
        mac={selectedMac}
        onClose={() => setExportModalOpen(false)}
      />
    )}
    </>
  )
}
