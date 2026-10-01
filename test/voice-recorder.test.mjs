// Recording a voicemail in the Hub.
//
// John, 2026-10-01: "trying to use voice recorder but it seems it's not working". There was
// no recorder. Every path was upload-only, and the button that looked like one was a
// "coming soon" placeholder.
//
// The part worth testing hard is the encoding. /api/voicemails accepts MP3 or WAV ONLY,
// because that is what Twilio's <Play> plays; Chrome records webm/opus and Safari mp4/aac.
// Handing either straight to the endpoint is rejected — and a malformed WAV that slipped
// through would fail at the worst possible moment, mid-call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { encodeWav, toPcm16, toMono, resample, wavSeconds, wavBytesFor, WAV_SAMPLE_RATE } from '../src/lib/wav.js'

const rec = fs.readFileSync(new URL('../src/components/VoiceRecorder.jsx', import.meta.url), 'utf8')
const templates = fs.readFileSync(new URL('../src/pages/Templates.jsx', import.meta.url), 'utf8')
const settings = fs.readFileSync(new URL('../src/pages/Settings.jsx', import.meta.url), 'utf8')
const clients = fs.readFileSync(new URL('../src/pages/Clients.jsx', import.meta.url), 'utf8')
const route = fs.readFileSync(new URL('../server/routes/voicemails.js', import.meta.url), 'utf8')

const str = (view, off, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(off + i)))

// ── the WAV itself ───────────────────────────────────────────────────────────────────
test('the header is a canonical 16-bit mono PCM WAV', () => {
  const buf = encodeWav(new Float32Array(1000), 16000)
  const v = new DataView(buf)
  assert.equal(str(v, 0, 4), 'RIFF')
  assert.equal(str(v, 8, 4), 'WAVE')
  assert.equal(str(v, 12, 4), 'fmt ')
  assert.equal(str(v, 36, 4), 'data')
  assert.equal(v.getUint32(16, true), 16, 'PCM header length')
  assert.equal(v.getUint16(20, true), 1, 'format 1 = uncompressed PCM, which is what Twilio plays')
  assert.equal(v.getUint16(22, true), 1, 'mono')
  assert.equal(v.getUint32(24, true), 16000)
  assert.equal(v.getUint16(34, true), 16, 'bits per sample')
})

test('the declared sizes match the actual bytes', () => {
  // a wrong length here produces a file players accept but cut short, which is the kind of
  // bug that only shows up in front of a client
  const buf = encodeWav(new Float32Array(500), 16000)
  const v = new DataView(buf)
  assert.equal(buf.byteLength, 44 + 500 * 2)
  assert.equal(v.getUint32(4, true), buf.byteLength - 8, 'RIFF size is file length minus 8')
  assert.equal(v.getUint32(40, true), 500 * 2, 'data chunk size')
  assert.equal(v.getUint32(28, true), 16000 * 2, 'byte rate = rate x channels x 2')
  assert.equal(v.getUint16(32, true), 2, 'block align')
})

test('samples survive the round trip', () => {
  const input = new Float32Array([0, 0.5, -0.5, 1, -1])
  const v = new DataView(encodeWav(input, 16000))
  assert.equal(v.getInt16(44, true), 0)
  // Int16Array truncates toward zero, so 0.5 * 32767 = 16383.5 stores as 16383
  assert.equal(v.getInt16(46, true), Math.trunc(0.5 * 0x7fff))
  assert.equal(v.getInt16(48, true), -0.5 * 0x8000)
  assert.equal(v.getInt16(50, true), 0x7fff, 'full scale positive')
  assert.equal(v.getInt16(52, true), -0x8000, 'full scale negative')
})

test('a loud moment clips instead of wrapping round to silence', () => {
  // without the clamp, 1.5 overflows Int16 and a shout becomes a click
  const pcm = toPcm16(new Float32Array([2, -2, 1.5, -1.5]))
  for (const s of pcm) assert.ok(s >= -32768 && s <= 32767, `${s} is outside Int16`)
  assert.equal(pcm[0], 32767)
  assert.equal(pcm[1], -32768)
})

test('empty audio still produces a valid file', () => {
  const buf = encodeWav(new Float32Array(0), 16000)
  assert.equal(buf.byteLength, 44)
  assert.equal(new DataView(buf).getUint32(40, true), 0)
})

// ── mono + resampling ────────────────────────────────────────────────────────────────
test('stereo is averaged, not just left-channel', () => {
  const l = new Float32Array([1, 0, 0.5]), r = new Float32Array([0, 1, 0.5])
  const m = toMono([l, r], 3)
  assert.deepEqual([...m], [0.5, 0.5, 0.5])
})

test('a single channel passes through untouched', () => {
  const one = new Float32Array([0.1, 0.2])
  assert.equal(toMono([one], 2), one)
})

test('resampling changes the length by the rate ratio', () => {
  const input = new Float32Array(48000)      // one second at 48 kHz
  assert.equal(resample(input, 48000, 16000).length, 16000, 'one second at 16 kHz')
  assert.equal(resample(input, 48000, 48000), input, 'same rate is a no-op')
})

test('resampling interpolates rather than dropping samples', () => {
  // picking every Nth sample adds an audible rasp; the midpoint should be the average
  const out = resample(new Float32Array([0, 1]), 2, 3)
  assert.ok(out[1] > 0 && out[1] < 1, `expected an interpolated value, got ${out[1]}`)
})

// ── the size guard ───────────────────────────────────────────────────────────────────
test('the recording cap stays under the 8 MB upload limit', () => {
  const cap = Number(/const MAX_SECONDS = (\d+)/.exec(rec)[1])
  const bytes = wavBytesFor(cap, WAV_SAMPLE_RATE)
  assert.ok(bytes < 8 * 1024 * 1024, `${cap}s is ${(bytes / 1048576).toFixed(1)} MB, over the limit`)
  assert.ok(wavSeconds(8 * 1024 * 1024) > cap, 'the cap must be reachable')
})

test('16 kHz mono is what makes the length practical', () => {
  // 44.1 kHz stereo would blow the 8 MB limit in well under two minutes
  assert.equal(WAV_SAMPLE_RATE, 16000)
  assert.ok(wavSeconds(8 * 1024 * 1024, 44100 * 2) < 60)
})

// ── the component ────────────────────────────────────────────────────────────────────
test('the recording is re-encoded, never uploaded as the browser recorded it', () => {
  // Chrome gives webm/opus, Safari mp4/aac, and Twilio plays neither
  assert.match(rec, /decodeAudioData/)
  assert.match(rec, /audioBufferToWavBlob/)
  assert.match(route, /Please upload an MP3 or WAV file/, 'the endpoint is the reason')
})

test('the mic is released however the recording ends', () => {
  assert.match(rec, /const stopTracks = \(\) =>/)
  assert.match(rec, /rec\.onstop = \(\) => \{ clearTimer\(\); stopTracks\(\); encode\(\) \}/)
  // and on unmount, so leaving the page mid-recording does not hold the mic open
  const cleanup = rec.slice(rec.indexOf('useEffect(() => () => {'))
  assert.match(cleanup, /stopTracks\(\)/)
  assert.match(cleanup, /revokeObjectURL/)
})

test('a blocked mic explains what to do instead of failing silently', () => {
  assert.match(rec, /microphone is blocked/i)
  assert.match(rec, /lock icon/i)
})

test('a browser that cannot record says so rather than appearing broken', () => {
  assert.match(rec, /typeof MediaRecorder === 'undefined'/)
  assert.match(rec, /cannot record audio/i)
})

test('recording stops itself at the cap', () => {
  assert.match(rec, /if \(n >= MAX_SECONDS\) \{ try \{ rec\.stop\(\) \} catch \{\} \}/)
})

// ── wired in where it was missing ────────────────────────────────────────────────────
test('both upload-only places can now record', () => {
  assert.match(templates, /<VoiceRecorder/, 'Templates: voicemail drops')
  assert.match(settings, /<VoiceRecorder/, 'Settings: the greeting')
})

test('a recorded Blob is uploaded with a filename', () => {
  // Busboy reads the type from the part; a nameless Blob is rejected as the wrong type
  assert.match(templates, /new File\(\[recorded\], 'recording\.wav', \{ type: 'audio\/wav' \}\)/)
  assert.match(settings, /new File\(\[blob\], 'greeting\.wav', \{ type: 'audio\/wav' \}\)/)
})

test('the "coming soon" placeholder is gone', () => {
  assert.ok(!/Recorded voicemail drops are planned with Twilio/.test(clients),
    'this is the button John pressed looking for the recorder')
  assert.ok(!/lead-action-soon/.test(clients.slice(clients.indexOf('lead-action-voicemail'), clients.indexOf('lead-action-voicemail') + 500)),
    'it should no longer be badged "soon"')
})

test('the copy no longer sends him elsewhere to record', () => {
  assert.ok(!/record on your phone or computer\)/i.test(templates))
  assert.ok(!/Record it on your phone or computer and upload here/i.test(settings))
})
