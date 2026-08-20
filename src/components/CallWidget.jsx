import React, { useEffect, useRef, useState } from 'react'
import { authFetch } from '../api'

// Browser softphone. Loads the Twilio Voice SDK (global window.Twilio from the CDN
// script in index.html), registers a Device with an access token from the Hub, and
// exposes window.hubCall(number, name) so any page can start a call. Handles incoming
// calls with Accept / Reject. Fails quietly if voice isn't set up yet.
export default function CallWidget() {
  const deviceRef = useRef(null)
  const callRef = useRef(null)
  const timerRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState('idle')   // idle | incoming | connecting | active | error
  const [peer, setPeer] = useState({ number: '', name: '' })
  const [muted, setMuted] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [err, setErr] = useState('')
  const [reg, setReg] = useState('connecting')   // connecting | ready | error
  const [regErr, setRegErr] = useState('')
  const [keypad, setKeypad] = useState(false)

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
    call.on('accept', () => { setStatus('active'); startTimer(); connectedRef.current = true; try { window.dispatchEvent(new CustomEvent('hubcall:started')) } catch {} })
    call.on('disconnect', () => endLocal())
    call.on('cancel', () => endLocal())
    call.on('reject', () => endLocal())
    call.on('error', (e) => { setErr(e?.message || 'Call error'); endLocal() })
  }
  const endLocal = () => {
    stopTimer(); setStatus('idle'); setMuted(false); setKeypad(false); setPeer({ number: '', name: '' }); callRef.current = null
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
    const init = async () => {
      if (!(await waitForSdk())) { setReg('error'); setRegErr('Phone SDK failed to load'); return }
      const Twilio = window.Twilio
      let tok
      try { const r = await authFetch('/api/voice/token'); tok = await r.json() } catch { setReg('error'); setRegErr('Could not get a phone token'); return }
      if (!tok || !tok.ok || !tok.token) { setReg('error'); setRegErr(tok?.error || 'Voice is not set up yet'); return }
      if (cancelled) return
      try {
        const device = new Twilio.Device(tok.token, { codecPreferences: ['opus', 'pcmu'], closeProtection: true })
        deviceRef.current = device
        device.on('registered', () => { setReady(true); setReg('ready'); primeMic() })
        device.on('unregistered', () => setReg('connecting'))
        device.on('error', (e) => { const m = e?.message || 'Phone error'; setErr(m); setRegErr(m); setReg('error'); if (e?.code === 20104 || e?.code === 31205) refreshToken() })
        device.on('tokenWillExpire', () => refreshToken())
        device.on('incoming', async (call) => {
          const from = call.parameters?.From || ''
          setPeer({ number: from, name: await lookupName(from) })
          setStatus('incoming')
          wireCall(call)
        })
        await device.register()
      } catch (e) { setReg('error'); setRegErr(e?.message || 'Phone failed to start') }
    }
    const refreshToken = async () => { try { const r = await authFetch('/api/voice/token'); const t = await r.json(); if (t?.token && deviceRef.current) deviceRef.current.updateToken(t.token) } catch {} }
    init()

    // Global entry point used by Call buttons across the app.
    window.hubCall = async (number, name) => {
      if (!deviceRef.current) { alert('The Hub phone is not connected yet. If this persists, Voice may still need setup in Settings.'); return }
      if (!number) return
      try {
        setPeer({ number, name: name || '' }); setStatus('connecting')
        const call = await deviceRef.current.connect({ params: { To: number } })
        wireCall(call)
      } catch (e) { setErr(e?.message || 'Could not place call'); endLocal() }
    }

    return () => { cancelled = true; stopTimer(); try { window.hubCall = undefined; deviceRef.current?.destroy() } catch {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const primeMicAgain = async () => {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); setRegErr('') }
    catch { setRegErr('Microphone is still blocked. Allow it in your browser site settings, then reload.') }
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
  const btn = (bg) => ({ flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, color: '#fff', background: bg, fontWeight: 700, cursor: 'pointer', fontSize: 14 })

  return (
    <div style={wrap}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted, #6b7280)', marginBottom: 6 }}>
        {status === 'incoming' ? 'Incoming call' : status === 'connecting' ? 'Calling…' : status === 'active' ? `On call · ${mmss(seconds)}` : 'Call'}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
      {sub && <div style={{ fontSize: 13, color: 'var(--text-muted, #6b7280)' }}>{sub}</div>}
      {err && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>{err}</div>}

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
      {status === 'active' && (
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setKeypad(k => !k)} style={{ border: 'none', background: 'none', color: 'var(--text-muted, #6b7280)', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>{keypad ? '▾ Hide keypad' : '▸ Keypad'}</button>
          {keypad && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginTop: 8 }}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(dg => (
                <button key={dg} onClick={() => { try { callRef.current?.sendDigits(dg) } catch {} }}
                  style={{ padding: '11px 0', borderRadius: 8, border: '1px solid var(--border, #e5e7eb)', background: 'var(--bg-secondary, #f8fafc)', color: 'var(--text-primary, #111)', fontSize: 17, fontWeight: 600, cursor: 'pointer' }}>{dg}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
