// The sound a new text makes.
//
// John, 2026-10-21: "a notification sound when we get a text from HUB, something like a
// tweet sound."
//
// Synthesised with WebAudio rather than shipped as a file: nothing to host, nothing for a
// content policy to block, no load delay before the first one plays, and it is a few
// hundred bytes instead of a few hundred kilobytes.
//
// A real bird chirp is a fast upward frequency sweep, not a steady tone — two short rising
// notes, the second a little higher and shorter, which is what makes it read as a chirp
// rather than a beep. Kept quiet and under a third of a second: this fires while someone is
// working, possibly many times an hour.

let ctx = null
function audio() {
  if (ctx) return ctx
  const C = window.AudioContext || window.webkitAudioContext
  if (!C) return null
  try { ctx = new C() } catch { return null }
  return ctx
}

/** One rising note. `t` is the context time to start at. */
function note(ac, out, t, fromHz, toHz, dur, peak) {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(fromHz, t)
  osc.frequency.exponentialRampToValueAtTime(toHz, t + dur)
  // A quick fade in and out. A square-edged note clicks; the ramps are what remove that.
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  osc.connect(gain).connect(out)
  osc.start(t)
  osc.stop(t + dur + 0.02)
}

/**
 * Play the chirp. Safe to call at any time: before the viewer has interacted with the page
 * browsers refuse to start audio, and that refusal is not an error worth surfacing — the
 * badge and the toast still did their job.
 */
export function chirp({ volume = 0.18 } = {}) {
  const ac = audio()
  if (!ac) return false
  try {
    // A tab restored from the background leaves the context suspended.
    if (ac.state === 'suspended') ac.resume().catch(() => {})
    const master = ac.createGain()
    master.gain.value = Math.max(0, Math.min(1, volume))
    master.connect(ac.destination)
    const t = ac.currentTime + 0.01
    note(ac, master, t, 1750, 2600, 0.085, 0.9)          // first note
    note(ac, master, t + 0.105, 2100, 3100, 0.065, 0.7)  // second, higher and shorter
    return true
  } catch { return false }
}

// ---- mute, per browser ---------------------------------------------------------------
// localStorage is per-viewer and can throw in a private window, so every access is guarded
// and the default when it fails is SOUND ON — a silent notifier is worse than an unwanted
// noise, because you do not find out it is broken.
const KEY = 'hub_text_sound'

export function soundEnabled() {
  try { return localStorage.getItem(KEY) !== 'off' } catch { return true }
}

export function setSoundEnabled(on) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off') } catch {}
  return !!on
}

/** Play only if the viewer has not muted it. Returns whether a sound was actually made. */
export function chirpIfEnabled(opts) {
  if (!soundEnabled()) return false
  return chirp(opts)
}
