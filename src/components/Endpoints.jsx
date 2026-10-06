// Who a message was actually between: which number it came from, which it went to.
//
// John, 2026-10-06: "on each text or message include where the text came from and what
// number so I know which one texted".
//
// Jacob Misener's thread is why. His WIFE replied from his number and then gave her own
// (507-251-4908). Every message in that thread was headed "Jacob Misener", so nothing on
// screen showed that two people and two numbers were involved — and the only place a
// number appeared at all was on a group text.
import React from 'react'

export const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10)

export const fmtEndpoint = (s) => {
  const v = String(s || '').trim()
  if (!v) return ''
  if (v.includes('@')) return v                      // an email address stays as it is
  const d = last10(v)
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : v
}

/** Every number on file for this lead, so a message from anywhere else stands out. */
export function knownNumbers(client) {
  const out = new Set()
  for (const p of [client?.phone, ...String(client?.alt_phones || '').split(',')]) {
    const d = last10(p)
    if (d.length === 10) out.add(d)
  }
  return out
}

export default function Endpoints({ m, client, align = 'left' }) {
  const from = fmtEndpoint(m?.from_addr), to = fmtEndpoint(m?.to_addr)
  if (!from && !to) return null
  const out = m.direction === 'outgoing'
  // the lead's side of the conversation — the one worth checking against the file
  const theirs = last10(out ? m.to_addr : m.from_addr)
  const known = knownNumbers(client)
  // With nothing on file to compare against, say nothing. Flagging every message as
  // "not on file" because the caller passed no client would be worse than silence.
  const unknown = known.size > 0 && theirs.length === 10 && !known.has(theirs)
  return (
    <div style={{ fontSize: 13.5, color: 'var(--text-muted)', textAlign: align,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-word' }}>
      {from || '?'} → {to || '?'}
      {unknown && (
        <span style={{ color: '#b45309', fontWeight: 600 }}
          title="This number is not saved on this lead — it may be someone else using it">
          {' '}· not on file
        </span>
      )}
    </div>
  )
}
