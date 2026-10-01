import React, { useEffect, useRef, useState } from 'react'
import { audioBufferToWavBlob, WAV_SAMPLE_RATE, wavBytesFor } from '../lib/wav'

// Record a voicemail in the Hub instead of recording it on a phone and uploading the file.
//
// John, 2026-10-01: "trying to use voice recorder but it seems it's not working". There was
// no recorder — every path was upload-only, and the one button that looked like one was a
// "coming soon" placeholder.
//
// MediaRecorder captures, then the clip is DECODED and RE-ENCODED as 16 kHz mono WAV before
// upload: /api/voicemails takes MP3 or WAV only, because that is what Twilio's <Play> plays.
// Chrome records webm/opus and Safari mp4/aac, and Twilio plays neither, so handing the raw
// recording straight to the endpoint would be rejected — and if it ever were accepted, it
// would fail silently at the moment it mattered, mid-call.

const MAX_SECONDS = 180            // 8 MB upload limit is ~4 min at 16 kHz; stop short of it
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export default function VoiceRecorder({ onReady, disabled = false, label = 'Record' }) {
  const [state, setState] = useState('idle')   // idle | recording | encoding | ready | error
  const [seconds, setSeconds] = useState(0)
  const [err, setErr] = useState('')
  const [preview, setPreview] = useState(null)

  const recRef = useRef(null)
  const chunksRef = useRef([])
  const streamRef = useRef(null)
  const timerRef = useRef(null)
  const blobRef = useRef(null)

  const stopTracks = () => { try { streamRef.current?.getTracks().forEach(t => t.stop()) } catch {} ; streamRef.current = null }
  const clearTimer = () => { clearInterval(timerRef.current); timerRef.current = null }

  // Release the mic and the preview URL even if the page is left mid-recording.
  useEffect(() => () => {
    clearTimer(); stopTracks()
    try { if (recRef.current && recRef.current.state === 'recording') recRef.current.stop() } catch {}
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  const start = async () => {
    setErr(''); setSeconds(0)
    if (preview) { URL.revokeObjectURL(preview); setPreview(null) }
    blobRef.current = null
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState('error'); setErr('This browser cannot record audio. Record on your phone and upload the file instead.'); return
    }
    let stream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }) }
    catch {
      setState('error')
      setErr('The microphone is blocked. Click the lock icon in the address bar, allow the mic, then try again.')
      return
    }
    streamRef.current = stream
    chunksRef.current = []
    let rec
    try { rec = new MediaRecorder(stream) } catch { stopTracks(); setState('error'); setErr('Could not start recording on this browser.'); return }
    recRef.current = rec
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data) }
    rec.onstop = () => { clearTimer(); stopTracks(); encode() }
    rec.start()
    setState('recording')
    timerRef.current = setInterval(() => setSeconds(s => {
      const n = s + 1
      if (n >= MAX_SECONDS) { try { rec.stop() } catch {} }
      return n
    }), 1000)
  }

  const stop = () => { try { recRef.current?.stop() } catch { clearTimer(); stopTracks(); setState('idle') } }

  const encode = async () => {
    setState('encoding')
    try {
      const raw = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || 'audio/webm' })
      if (!raw.size) { setState('error'); setErr('Nothing was recorded. Check the microphone and try again.'); return }
      const Ctx = window.AudioContext || window.webkitAudioContext
      const ctx = new Ctx()
      const decoded = await ctx.decodeAudioData(await raw.arrayBuffer())
      try { ctx.close() } catch {}
      const wav = audioBufferToWavBlob(decoded, WAV_SAMPLE_RATE)
      blobRef.current = wav
      setPreview(URL.createObjectURL(wav))
      setState('ready')
      onReady?.(wav, { seconds: decoded.duration })
    } catch {
      setState('error')
      setErr('That recording could not be converted. Try again, or record on your phone and upload the file.')
    }
  }

  const reset = () => {
    if (preview) URL.revokeObjectURL(preview)
    setPreview(null); blobRef.current = null; setSeconds(0); setState('idle'); setErr('')
    onReady?.(null)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {state !== 'recording' && state !== 'encoding' && (
        <button type="button" className="btn btn-sm btn-secondary" disabled={disabled} onClick={start}>
          {state === 'ready' ? '↻ Record again' : `🎙 ${label}`}
        </button>
      )}
      {state === 'recording' && (
        <>
          <button type="button" className="btn btn-sm btn-danger" onClick={stop}>■ Stop</button>
          <span style={{ fontSize: 14.5, color: '#ef4444', fontWeight: 600 }}>● {fmt(seconds)}</span>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {seconds >= MAX_SECONDS - 15 ? `stops at ${fmt(MAX_SECONDS)}` : 'recording'}
          </span>
        </>
      )}
      {state === 'encoding' && <span style={{ fontSize: 14.5, color: 'var(--text-muted)' }}>Preparing…</span>}
      {state === 'ready' && preview && (
        <>
          <audio controls preload="none" src={preview} style={{ height: 32, maxWidth: '100%' }} />
          <button type="button" className="btn btn-sm btn-secondary" onClick={reset}>Discard</button>
        </>
      )}
      {err && <span style={{ fontSize: 14.5, color: '#ef4444' }}>{err}</span>}
    </div>
  )
}

export { MAX_SECONDS, wavBytesFor }
