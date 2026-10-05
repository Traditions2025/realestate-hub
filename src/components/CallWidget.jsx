import { notify } from '../notify'
import React, { useEffect, useRef, useState } from 'react'
import { authFetch } from '../api'

// Browser softphone. Loads the Twilio Voice SDK (global window.Twilio from the CDN
// script in index.html), registers a Device with an access token from the Hub, and
// exposes window.hubCall(number, name) so any page can start a call. Handles incoming
// calls with Accept / Reject. Fails quietly if voice isn't set up yet.
//
// SETUP IS RETRIED, because it used to be attempted exactly once (John, 2026-10-01:
// "The Hub phone is not connected yet"). Any single hiccup left deviceRef null and the
// phone dead until someone reloaded the page by hand — and the most common hiccup is a
// deploy: Render restarts, /api/voice/token answers with an HTML error page, r.json()
// throws, and the phone never comes back even though the server is healthy seconds later.
// Now it backs off and retries, retries when the tab is looked at again or the network
// returns, and a Call button connects on demand instead of only complaining.
export default function CallWidget() {
  const deviceRef = useRef(null)
  const callRef = useRef(null)
  const timerRef = useRef(null)
  const initRef = useRef(null)      // in-flight setup, so parallel callers share one attempt
  const retryRef = useRef(null)     // pending backoff timer
  const attemptRef = useRef(0)
  // The setup effect runs once with [], so its closure would keep the FIRST regErr
  // forever. The ref is what the Call button reads to say why it could not connect.
  const regErrRef = useRef('')
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState('idle')   // idle | incoming | connecting | active | error
  const [peer, setPeer] = useState({ number: '', name: '' })
  const [muted, setMuted] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [err, setErr] = useState('')
  const [reg, setReg] = useState('connecting')   // connecting | ready | error
  const [regErr, _setRegErr] = useState('')
  const setRegErr = (v) => { regErrRef.current = v || ''; _setRegErr(v) }
  const [keypad, setKeypad] = useState(false)
  const [vms, setVms] = useState([])
  const [vmMenu, setVmMenu] = useState(false)
  const [dropping, setDropping] = useState(false)
  const parentSidRef = useRef('')

  const fmt = (n) => { const d = String(n || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (n || '') }
  const startTimer = () => { setSeconds(0); clearInterval(timerRef.current); timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000) }
  const stopTimer = () => { clearInterval(timerRef.current) }
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  const lookupName = async (number) => {
    try { const r = await authFetch(`/api/inbox/contacts?q=${encodeURIComponent(String(number).replace(/\D/g, '').slice(-10))}`); const a = await r.json(); if (Array.isArray(a) && a[0]) return `${a[0].first_name || ''} ${a[0].last_name || ''}`.trim() } catch {}
    return ''
  }

  const connectedRef = useRef(false)
  const wireCall = (call) => {
    callRef.current = call
    try { parentSidRef.current = call.parameters?.CallSid || '' } catch {}
    call.on('accept', () => { setStatus('active'); startTimer(); connectedRef.current = true; try { parentSidRef.current = call.parameters?.CallSid || parentSidRef.current } catch {}; try { window.dispatchEvent(new CustomEvent('hubcall:started')) } catch {} })
    // Outbound: the carrier is now ringing the far end — tell the user instead of dead air.
    call.on('ringing', () => { if (!connectedRef.current) setStatus('ringing') })
    call.on('disconnect', () => endLocal())
    call.on('cancel', () => endLocal())
    call.on('reject', () => endLocal())
    // Transient signaling blips (31005) recover on their own; only real failures stay red.
    call.on('reconnecting', () => setErr('Connection blip — reconnecting…'))
    call.on('reconnected', () => setErr(''))
    call.on('error', (e) => { if (e?.code === 31005) { setErr('Connection blip — reconnecting…'); return } setErr(e?.message || 'Call error'); endLocal() })
  }
  const endLocal = () => {
    stopTimer(); setStatus('idle'); setMuted(false); setKeypad(false); setVmMenu(false); setPeer({ number: '', name: '' }); callRef.current = null; parentSidRef.current = ''
    // Let the Power Dialer (or any listener) know a call finished + whether it connected.
    try { window.dispatchEvent(new CustomEvent('hubcall:ended', { detail: { connected: connectedRef.current } })) } catch {}
    connectedRef.current = false
  }

  useEffect(() => {
    let cancelled = false
    const waitForSdk = async () => {
      for (let i = 0; i < 30; i++) { if (window.Twilio && window.Twilio.Device) return true; await new Promise(r => setTimeout(r, 300)) }
      return !!(window.Twilio && window.Twilio.Device)
    }
    const primeMic = async () => {
      // Secure mic permission up front so accepting a call bridges audio instantly
      // (without this, the first accept can fail before the caller connects).
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); return true }
      catch { setRegErr('Microphone is blocked — click the 🔒 in the address bar and allow the mic, or calls won\'t have audio.'); return false }
    }
    // Throws on a failure worth retrying; resolves once the Device is registered.
    const init = async () => {
      if (!(await waitForSdk())) {
        // The script is served from the Hub's own origin, so reaching this means
        // something in the browser is blocking it, not that the network is down -
        // an extension, or a VPN exit that is filtering the request.
        setReg('error')
        setRegErr('Phone SDK did not load. An ad blocker or VPN is usually what blocks it — reload, and if it persists try without the VPN.')
        throw new Error('sdk')
      }
      const Twilio = window.Twilio
      let tok
      // A restarting server answers with HTML, so r.json() throws here. That is a blip,
      // not a configuration problem, and it must not be fatal.
      try { const r = await authFetch('/api/voice/token'); tok = await r.json() } catch { setReg('error'); setRegErr('Could not get a phone token'); throw new Error('token') }
      if (!tok || !tok.ok || !tok.token) { setReg('error'); setRegErr(tok?.error || 'Voice is not set up yet'); throw new Error(tok?.error || 'not set up') }
      if (cancelled) return
      try {
        // maxCallSignalingTimeoutMs: a dropped signaling websocket (error 31005)
        // reconnects for up to 30s instead of killing the controls mid-call.
        const device = new Twilio.Device(tok.token, { codecPreferences: ['opus', 'pcmu'], closeProtection: true, maxCallSignalingTimeoutMs: 30000 })
        deviceRef.current = device
        device.on('registered', () => { setReady(true); setReg('ready'); primeMic() })
        device.on('unregistered', () => setReg('connecting'))
        device.on('error', (e) => {
          // 31005 with a live call = the signaling socket blipped; the audio and the
          // dialed leg keep going and the SDK reconnects. Don't paint the phone red.
          if (e?.code === 31005 && callRef.current) { setErr('Connection blip — reconnecting…'); return }
          const m = e?.message || 'Phone error'; setErr(m); setRegErr(m); setReg('error'); if (e?.code === 20104 || e?.code === 31205) refreshToken()
        })
        device.on('tokenWillExpire', () => refreshToken())
        device.on('incoming', async (call) => {
          const from = call.parameters?.From || ''
          setPeer({ number: from, name: await lookupName(from) })
          setStatus('incoming')
          wireCall(call)
        })
        await device.register()
      } catch (e) {
        // a half-built Device must not look like a working one to ensureDevice()
        try { deviceRef.current?.destroy() } catch {}
        deviceRef.current = null
        setReg('error'); setRegErr(e?.message || 'Phone failed to start')
        throw e
      }
    }
    const refreshToken = async () => { try { const r = await authFetch('/api/voice/token'); const t = await r.json(); if (t?.token && deviceRef.current) deviceRef.current.updateToken(t.token) } catch {} }

    // One attempt at a time; everyone waiting shares it.
    const ensureDevice = () => {
      if (deviceRef.current) return Promise.resolve(deviceRef.current)
      if (initRef.current) return initRef.current
      setReg('connecting')
      initRef.current = init()
        .then(() => { attemptRef.current = 0; return deviceRef.current })
        .finally(() => { initRef.current = null })
      return initRef.current
    }

    // Backoff: 2s, 4s, 8s, 15s, then every 30s. It keeps trying rather than giving up,
    // because the usual cause clears itself within a minute.
    const DELAYS = [2000, 4000, 8000, 15000, 30000]
    const scheduleRetry = () => {
      if (cancelled || deviceRef.current || retryRef.current) return
      const wait = DELAYS[Math.min(attemptRef.current++, DELAYS.length - 1)]
      retryRef.current = setTimeout(() => {
        retryRef.current = null
        if (cancelled || deviceRef.current) return
        ensureDevice().catch(() => scheduleRetry())
      }, wait)
    }

    ensureDevice().catch(() => scheduleRetry())

    // Coming back to the tab, or back online, is the moment to try again immediately
    // rather than sitting out the rest of a backoff.
    const retryNow = () => {
      if (cancelled || deviceRef.current || document.visibilityState === 'hidden') return
      clearTimeout(retryRef.current); retryRef.current = null
      attemptRef.current = 0
      ensureDevice().catch(() => scheduleRetry())
    }
    window.addEventListener('online', retryNow)
    document.addEventListener('visibilitychange', retryNow)

    // Global entry point used by Call buttons across the app.
    window.hubCall = async (number, name) => {
      if (!number) return
      // Connect on demand. Pressing Call is the clearest signal that the phone is wanted
      // NOW, so it waits for one setup attempt instead of refusing outright.
      let device = deviceRef.current
      if (!device) {
        setPeer({ number, name: name || '' }); setStatus('connecting')
        try { device = await ensureDevice() } catch { device = null }
      }
      if (!device) {
        setStatus('idle')
        scheduleRetry()
        notify(regErrRef.current
          ? `The Hub phone could not connect: ${regErrRef.current}. Retrying — try again in a moment, or check Voice in Settings.`
          : 'The Hub phone is not connected yet. Retrying — try again in a moment, or check Voice in Settings.')
        return
      }
      try {
        setPeer({ number, name: name || '' }); setStatus('connecting')
        const call = await device.connect({ params: { To: number } })
        wireCall(call)
      } catch (e) { setErr(e?.message || 'Could not place call'); endLocal() }
    }

    return () => {
      cancelled = true; stopTimer()
      clearTimeout(retryRef.current); retryRef.current = null
      window.removeEventListener('online', retryNow)
      document.removeEventListener('visibilitychange', retryNow)
      try { window.hubCall = undefined; deviceRef.current?.destroy() } catch {}
      deviceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const primeMicAgain = async () => {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); setRegErr('') }
    catch { setRegErr('Microphone is still blocked. Allow it in your browser site settings, then reload.') }
  }
  useEffect(() => { authFetch('/api/voicemails').then(r => r.json()).then(a => setVms(Array.isArray(a) ? a : [])).catch(() => {}) }, [])
  const dropVoicemail = async (vmId) => {
    setDropping(true)
    try {
      const r = await authFetch('/api/inbox/drop-voicemail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_sid: parentSidRef.current, voicemail_id: vmId }) })
      const d = await r.json()
      if (!d.success) { notify(d.error || 'Could not drop voicemail'); return }
      setVmMenu(false)
      try { callRef.current?.disconnect() } catch {}   // the callee leg now plays the recording; drop our leg
    } catch (e) { notify(e.message) } finally { setDropping(false) }
  }
  const accept = () => { try { callRef.current?.accept() } catch {} }
  const reject = () => { try { callRef.current?.reject() } catch {}; endLocal() }
  const hangup = () => { try { callRef.current?.disconnect() } catch {}; endLocal() }
  const toggleMute = () => { const m = !muted; setMuted(m); try { callRef.current?.mute(m) } catch {} }

  // Idle: no persistent status chip — the softphone stays invisible until a call
  // starts (outbound via window.hubCall) or arrives (incoming). Mic is primed
  // silently on registration so audio bridges instantly when a call connects.
  if (status === 'idle') return null

  const title = peer.name || fmt(peer.number) || 'Unknown'
  const sub = peer.name ? fmt(peer.number) : ''
  const wrap = { position: 'fixed', right: 20, bottom: 20, zIndex: 4000, width: 300, background: 'var(--bg-primary, #fff)', color: 'var(--text-primary, #111)', border: '1px solid var(--border, #e5e7eb)', borderRadius: 14, boxShadow: '0 12px 40px rgba(0,0,0,.28)', padding: 16, fontFamily: 'inherit' }
  const btn = (bg) => ({ flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, color: '#fff', background: bg, fontWeight: 700, cursor: 'pointer', fontSize: 15.5 })

  return (
    <div style={wrap}>
      <div style={{ fontSize: 14.5, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted, #6b7280)', marginBottom: 6 }}>
        {status === 'incoming' ? 'Incoming call' : status === 'connecting' ? 'Connecting…' : status === 'ringing' ? 'Ringing…' : status === 'active' ? `On call · ${mmss(seconds)}` : 'Call'}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{title}</div>
      {sub && <div style={{ fontSize: 15.5, color: 'var(--text-muted, #6b7280)' }}>{sub}</div>}
      {err && <div style={{ fontSize: 14.5, color: '#ef4444', marginTop: 6 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        {status === 'incoming' ? (
          <>
            <button style={btn('#ef4444')} onClick={reject}>Reject</button>
            <button style={btn('#10b981')} onClick={accept}>Accept</button>
          </>
        ) : (
          <>
            <button style={btn(muted ? '#6b7280' : '#334155')} onClick={toggleMute} disabled={status !== 'active'}>{muted ? 'Unmute' : 'Mute'}</button>
            <button style={btn('#ef4444')} onClick={hangup}>Hang up</button>
          </>
        )}
      </div>
      {status === 'active' && vms.length > 0 && (
        <div style={{ marginTop: 10, position: 'relative' }}>
          <button onClick={() => setVmMenu(m => !m)} disabled={dropping}
            style={{ width: '100%', padding: '9px 0', borderRadius: 10, border: '1px solid var(--border, #e5e7eb)', background: 'var(--bg-secondary, #f8fafc)', color: 'var(--text-primary, #111)', fontWeight: 700, cursor: 'pointer', fontSize: 15.5 }}>
            {dropping ? 'Dropping voicemail…' : '🎙 Drop voicemail ▾'}
          </button>
          {vmMenu && (
            <div style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 6, background: 'var(--bg-primary, #fff)', border: '1px solid var(--border, #e5e7eb)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.28)', maxHeight: 200, overflowY: 'auto', zIndex: 5 }}>
              {vms.map(v => (
                <button key={v.id} onClick={() => dropVoicemail(v.id)} title="Play this recording into their voicemail, then hang up"
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', borderBottom: '1px solid var(--border, #eee)', background: 'none', color: 'var(--text-primary, #111)', cursor: 'pointer', fontSize: 15.5 }}>{v.name}</button>
              ))}
            </div>
          )}
        </div>
      )}
      {status === 'active' && (
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setKeypad(k => !k)} style={{ border: 'none', background: 'none', color: 'var(--text-muted, #6b7280)', fontSize: 14.5, cursor: 'pointer', fontWeight: 600 }}>{keypad ? '▾ Hide keypad' : '▸ Keypad'}</button>
          {keypad && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginTop: 8 }}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(dg => (
                <button key={dg} onClick={() => { try { callRef.current?.sendDigits(dg) } catch {} }}
                  style={{ padding: '11px 0', borderRadius: 8, border: '1px solid var(--border, #e5e7eb)', background: 'var(--bg-secondary, #f8fafc)', color: 'var(--text-primary, #111)', fontSize: 18.5, fontWeight: 600, cursor: 'pointer' }}>{dg}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
