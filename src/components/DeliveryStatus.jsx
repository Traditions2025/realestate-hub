// Did that text actually go out?
//
// John, 2026-10-08: "we need to have a status to show on each text we sent to know where
// it's delivered or failed or what so we know it went out also I think we would know if
// text is detected as SPAM or blocked?"
//
// The Hub has recorded all of this since the Twilio status callback was wired up —
// communications.delivery_status and error_message — it was simply never shown. Nothing
// new is collected here; this puts what we already know on screen.
import React from 'react'

// Twilio's message lifecycle. `queued` and `sent` mean it left us; only `delivered` means
// a handset took it, and `undelivered` / `failed` mean it did not arrive.
const STATES = {
  queued:      { label: 'Queued',    tone: 'muted', title: 'Handed to Twilio, not sent yet' },
  accepted:    { label: 'Queued',    tone: 'muted', title: 'Accepted by Twilio' },
  scheduled:   { label: 'Scheduled', tone: 'muted', title: 'Scheduled to send later' },
  sending:     { label: 'Sending',   tone: 'muted', title: 'On its way to the carrier' },
  sent:        { label: 'Sent',      tone: 'muted', title: 'The carrier took it; no delivery receipt yet' },
  delivered:   { label: 'Delivered', tone: 'good',  title: 'The carrier confirmed it reached the handset' },
  read:        { label: 'Read',      tone: 'good',  title: 'Opened by the recipient' },
  receiving:   { label: 'Receiving', tone: 'muted', title: 'Inbound, still arriving' },
  received:    { label: 'Received',  tone: 'good',  title: 'Inbound message received' },
  undelivered: { label: 'Not delivered', tone: 'bad', title: 'The carrier refused it' },
  failed:      { label: 'Failed',    tone: 'bad',   title: 'The message did not send' },
  canceled:    { label: 'Canceled',  tone: 'bad',   title: 'Canceled before it sent' },
}

const COLOR = { good: '#15803d', bad: '#b91c1c', muted: 'var(--text-muted)' }

/** A failure the carrier attributes to filtering rather than to the number being bad. */
export const isSpamOrBlocked = (m) =>
  /filtered as spam|blocked by the carrier|30007|30004/i.test(String(m?.error_message || ''))

export default function DeliveryStatus({ m }) {
  // Only an outgoing message has a delivery outcome; an inbound one is here by definition.
  if (!m || m.direction !== 'outgoing') return null
  if (m.channel !== 'text' && m.channel !== 'email') return null
  const raw = String(m.delivery_status || '').toLowerCase().trim()
  // An older row has no status because it predates the callback. Say that, rather than
  // showing nothing and letting it read as though the message never went.
  if (!raw) {
    return (
      <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }} title="Sent before the Hub recorded delivery receipts">
        {' · '}no receipt
      </span>
    )
  }
  const s = STATES[raw] || { label: raw, tone: 'muted', title: raw }
  const spam = isSpamOrBlocked(m)
  return (
    <span style={{ color: COLOR[s.tone], fontWeight: s.tone === 'muted' ? 400 : 600 }}
      title={m.error_message ? `${s.title} — ${m.error_message}` : s.title}>
      {' · '}{s.label}
      {/* The reason matters more than the word "failed": a blocked number and a spam
          filter need completely different responses from a person. */}
      {m.error_message && <span style={{ fontWeight: 400 }}>{' — '}{m.error_message}</span>}
      {spam && <span style={{ color: '#b45309', fontWeight: 700 }}>{' ⚠'}</span>}
    </span>
  )
}
