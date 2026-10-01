// Turn recorded audio into a WAV the Hub will accept.
//
// Why WAV and not what the browser hands you: /api/voicemails takes MP3 or WAV only,
// because those are what Twilio's <Play> plays reliably. MediaRecorder produces webm/opus
// on Chrome and mp4/aac on Safari, and Twilio plays neither. So the recording is decoded
// back to raw samples and re-encoded here.
//
// 16-bit PCM, mono, 16 kHz. That is plenty for a voice drop, and it matters for size: the
// upload limit is 8 MB, which at 16 kHz is about four minutes, where 44.1 kHz stereo would
// have been under a minute.

export const WAV_SAMPLE_RATE = 16000

/** Average the channels down to one, so a stereo mic does not halve the recording time. */
export function toMono(channels, length) {
  if (!channels.length) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    let sum = 0
    for (const ch of channels) sum += ch[i] || 0
    out[i] = sum / channels.length
  }
  return out
}

/**
 * Resample by linear interpolation. Voice at 16 kHz does not need anything cleverer, and
 * dropping samples outright (picking every Nth) adds an audible rasp.
 */
export function resample(input, fromRate, toRate) {
  if (!input.length || fromRate === toRate) return input
  const ratio = fromRate / toRate
  const out = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio
    const lo = Math.floor(at)
    const hi = Math.min(lo + 1, input.length - 1)
    const frac = at - lo
    out[i] = input[lo] * (1 - frac) + input[hi] * frac
  }
  return out
}

/** Float samples (-1..1) to 16-bit PCM, clamped so a loud moment does not wrap around. */
export function toPcm16(samples) {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** A 44-byte canonical WAV header followed by the samples. */
export function encodeWav(samples, sampleRate = WAV_SAMPLE_RATE) {
  const pcm = toPcm16(samples)
  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buf)
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }

  str(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)   // file size - 8
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)                   // PCM header length
  view.setUint16(20, 1, true)                    // format 1 = PCM
  view.setUint16(22, 1, true)                    // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)       // byte rate: rate * channels * 2
  view.setUint16(32, 2, true)                    // block align
  view.setUint16(34, 16, true)                   // bits per sample
  str(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true)
  return buf
}

/**
 * A decoded AudioBuffer to a WAV blob the upload endpoint accepts.
 * Kept separate from encodeWav so the maths is testable without a browser.
 */
export function audioBufferToWavBlob(audioBuffer, targetRate = WAV_SAMPLE_RATE) {
  const channels = []
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c))
  const mono = toMono(channels, audioBuffer.length)
  const resampled = resample(mono, audioBuffer.sampleRate, targetRate)
  return new Blob([encodeWav(resampled, targetRate)], { type: 'audio/wav' })
}

/** Seconds of audio a WAV of this many bytes holds, for the size guard in the UI. */
export const wavSeconds = (bytes, rate = WAV_SAMPLE_RATE) => Math.max(0, (bytes - 44) / (rate * 2))
export const wavBytesFor = (seconds, rate = WAV_SAMPLE_RATE) => 44 + Math.round(seconds * rate * 2)
