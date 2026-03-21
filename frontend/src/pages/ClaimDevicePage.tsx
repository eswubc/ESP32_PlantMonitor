import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ref, set, get, onValue } from 'firebase/database'
import { firebaseDb } from '../lib/firebase'
import { useAuth } from '../context/AuthContext'
import { fadeSlideUp, staggerContainer, transition } from '../lib/motion'
import { ThemeToggleIcon } from '../components/icons/ThemeToggleIcon'
import { sanitizeMac, sanitizeString } from '../utils/sanitize'
import { useRateLimit } from '../hooks/useRateLimit'
import { RotatingText } from '../components/ui/rotating-text'

const ONLINE_THRESHOLD_SEC = 2 * 60

type DeviceEntry = {
  mac: string
  lastSeen: number | null
  claimedBy: string | null
}

export function ClaimDevicePage() {
  const [mac, setMac] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [justClaimedMac, setJustClaimedMac] = useState<string | null>(null)
  const [claimName, setClaimName] = useState('')
  const [claimRoom, setClaimRoom] = useState('')
  const [devices, setDevices] = useState<DeviceEntry[]>([])
  const { user } = useAuth()
  const navigate = useNavigate()
  const [canClaim, rateLimitedClaim, claimCooldown] = useRateLimit(5000)  // 5s between claims

  useEffect(() => {
    const deviceListRef = ref(firebaseDb, 'deviceList')
    const unsub = onValue(deviceListRef, (snap) => {
      const val = snap.val()
      if (!val || typeof val !== 'object') { setDevices([]); return }
      const list: DeviceEntry[] = Object.entries(val).map(([macKey, data]) => {
        const d = data as { lastSeen?: number; claimedBy?: string | null }
        return {
          mac: macKey,
          lastSeen: typeof d.lastSeen === 'number' ? d.lastSeen : null,
          claimedBy: d.claimedBy ?? null,
        }
      })
      setDevices(list)
    })
    return () => unsub()
  }, [])

  async function handleClaim(macToClaim: string) {
    await rateLimitedClaim(async () => {
      setError(''); setSuccess('')
      const normalized = sanitizeMac(macToClaim)
      if (!normalized) {
        setError('Invalid MAC address format (use XX:XX:XX:XX:XX:XX)')
        return
      }
      if (!user) return
      try {
        const userDevicesPath = `users/${user.uid}/devices/${normalized}`
        const existing = await get(ref(firebaseDb, userDevicesPath))
        if (existing.exists()) {
          setSuccess('Device already claimed.')
          setTimeout(() => navigate('/'), 1500)
          return
        }
        await set(ref(firebaseDb, userDevicesPath), { claimedAt: Date.now() })
        await set(ref(firebaseDb, `deviceList/${normalized}/claimedBy`), user.uid)
        setSuccess('Device claimed!')
        setJustClaimedMac(normalized)
        setMac('')
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Claim failed')
      }
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await handleClaim(mac)
  }

  async function handleSaveNameAndGo() {
    if (!user || !justClaimedMac) return
    const meta = {
      name: sanitizeString(claimName, 80) || undefined,
      room: sanitizeString(claimRoom, 80) || undefined,
    }
    if (meta.name || meta.room) {
      await set(ref(firebaseDb, `users/${user.uid}/devices/${justClaimedMac}/meta`), meta).catch((err) => { if (import.meta.env.DEV) console.error(err) })
    }
    setJustClaimedMac(null)
    setClaimName('')
    setClaimRoom('')
    navigate('/')
  }

  const nowSec = Math.floor(Date.now() / 1000)

  return (
    <motion.div
      className="min-h-screen px-4 py-6 md:px-6 md:py-8"
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
    >
      <div className="mx-auto max-w-2xl">
        <motion.header
          className="mb-8 flex items-center justify-between"
          variants={fadeSlideUp}
          transition={transition.section}
        >
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-forest">
              <RotatingText
                words={["Add", "Connect", "Claim"]}
                mode="slide"
                interval={3000}
                className="text-primary"
              />{" "}
              device
            </h1>
            <p className="mt-1 text-sm text-forest-400">
              <RotatingText
                words={["Claim", "Connect", "Add"]}
                mode="fade"
                interval={3000}
                className="font-medium text-primary"
              />{" "}
              an ESP32 plant monitor to your account
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggleIcon compact />
            <button type="button" onClick={() => navigate('/')} className="btn-ghost">
              Dashboard
            </button>
          </div>
        </motion.header>

        {/* Discover devices */}
        <motion.section
          className="section-card mb-6"
          variants={fadeSlideUp}
          transition={{ ...transition.section, delay: 0.06 }}
        >
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
              <svg className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-forest">Discover devices</h2>
              <p className="text-xs text-forest-400">
                Online = seen in last 2 min. Claim available devices below.
              </p>
            </div>
          </div>

          {devices.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-forest/10 bg-surface/60 p-8 text-center dark:border-forest-700 dark:bg-forest-800/40">
              <p className="text-sm text-forest-400 dark:text-forest-500">
                <RotatingText
                  words={["Searching", "Scanning", "Looking"]}
                  mode="fade"
                  interval={2000}
                  className="font-medium text-primary"
                />{" "}
                for devices… Power on an ESP32 and wait for it to sync.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {devices.map((d) => {
                const isOnline = d.lastSeen != null && nowSec - d.lastSeen <= ONLINE_THRESHOLD_SEC
                const isYours = d.claimedBy === user?.uid
                const isClaimedByOther = d.claimedBy != null && d.claimedBy !== user?.uid
                const isAvailable = !d.claimedBy
                return (
                  <motion.li
                    key={d.mac}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-forest/5 bg-white/60 px-4 py-3 transition ${
                      isClaimedByOther ? 'opacity-50' : 'hover:bg-white/80 hover:shadow-soft'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? 'bg-green-500' : 'bg-forest/20'}`} />
                      <span className="font-mono text-sm text-forest">{d.mac}</span>
                      <span className={`text-[11px] font-medium uppercase tracking-wider ${isOnline ? 'text-green-600' : 'text-forest/30'}`}>
                        {isOnline ? 'Online' : 'Offline'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {isAvailable && (
                        <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary">
                          Available
                        </span>
                      )}
                      {isYours && (
                        <span className="rounded-full bg-sage-200 px-2.5 py-0.5 text-[11px] font-semibold text-forest-600">
                          Yours
                        </span>
                      )}
                      {isClaimedByOther && (
                        <span className="text-[11px] text-forest/35">Claimed</span>
                      )}
                      {isAvailable && (
                        <button
                          type="button"
                          onClick={() => handleClaim(d.mac)}
                          disabled={!canClaim}
                          className="btn-primary !py-1.5 !px-3 !text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {canClaim ? 'Claim' : `Wait ${Math.ceil(claimCooldown / 1000)}s`}
                        </button>
                      )}
                    </div>
                  </motion.li>
                )
              })}
            </ul>
          )}
        </motion.section>

        {/* Name your device (after claim) */}
        {justClaimedMac && (
          <motion.section
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="section-card mb-6 border-2 border-primary/20 bg-primary/5"
          >
            <p className="mb-4 text-sm font-medium text-primary">Give your device a friendly name (optional)</p>
            <div className="mb-3 space-y-3">
              <input
                type="text"
                value={claimName}
                onChange={(e) => setClaimName(e.target.value)}
                placeholder="e.g. Monstera by window"
                className="input-field"
                autoFocus
              />
              <input
                type="text"
                value={claimRoom}
                onChange={(e) => setClaimRoom(e.target.value)}
                placeholder="e.g. Living room"
                className="input-field"
              />
            </div>
            <button type="button" onClick={handleSaveNameAndGo} className="btn-primary">
              Go to dashboard
            </button>
          </motion.section>
        )}

        {/* Manual entry */}
        <motion.section
          className="section-card"
          variants={fadeSlideUp}
          transition={{ ...transition.section, delay: 0.12 }}
        >
          <h2 className="stat-label mb-3">Or enter MAC manually</h2>
          <p className="mb-4 text-sm text-forest-400">
            Find the MAC in Serial Monitor: "Device ID (MAC): …"
          </p>
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="text"
              value={mac}
              onChange={(e) => setMac(e.target.value)}
              placeholder="D4:E9:F4:BD:36:CC"
              className="input-field font-mono"
            />
            {error && (
              <p className="text-sm text-terracotta" role="alert">{error}</p>
            )}
            {success && (
              <p className="text-sm font-medium text-primary" role="status">{success}</p>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!canClaim}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {canClaim ? 'Claim' : `Wait ${Math.ceil(claimCooldown / 1000)}s`}
              </button>
              <button type="button" onClick={() => navigate('/')} className="btn-ghost">Cancel</button>
            </div>
          </form>
        </motion.section>
      </div>
    </motion.div>
  )
}
