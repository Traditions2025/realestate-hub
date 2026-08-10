import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { authFetch } from '../api'

// In-app "What's New" — a visual, plain-English guide to everything added since
// Aug 3, 2026. Real screenshots (served auth-only) with outline-box annotations
// that FRAME each feature (never cover it) + a numbered legend beneath.

// Auth-gated screenshot with outline-box annotations + hover-synced legend.
function AnnotatedShot({ name, accent = '#2563eb', annos = [], caption }) {
  const [src, setSrc] = useState('')
  const [hot, setHot] = useState(null)
  useEffect(() => {
    let url, alive = true
    authFetch('/api/whatsnew/' + name).then(r => r.ok ? r.blob() : null).then(b => {
      if (b && alive) { url = URL.createObjectURL(b); setSrc(url) }
    }).catch(() => {})
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [name])
  const tint = (a) => `color-mix(in srgb, ${accent} ${a}%, transparent)`
  return (
    <div style={{ margin: '14px 0 4px' }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-secondary)', boxShadow: '0 12px 30px -20px rgba(0,0,0,.5)' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}>
          <i style={{ width: 10, height: 10, borderRadius: '50%', background: '#e5837a' }} />
          <i style={{ width: 10, height: 10, borderRadius: '50%', background: '#e6c17a' }} />
          <i style={{ width: 10, height: 10, borderRadius: '50%', background: '#8fc98f' }} />
          {caption && <span style={{ marginLeft: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>{caption}</span>}
        </div>
        <div style={{ position: 'relative', lineHeight: 0, background: '#fff' }}>
          {src
            ? <img src={src} alt="" style={{ width: '100%', display: 'block' }} />
            : <div style={{ width: '100%', paddingTop: '62%', background: 'linear-gradient(100deg,var(--bg-secondary),var(--bg-elevated),var(--bg-secondary))' }} />}
          {src && annos.map(a => (
            <div key={a.n}
              onMouseEnter={() => setHot(a.n)} onMouseLeave={() => setHot(null)}
              style={{
                position: 'absolute', left: a.box.x + '%', top: a.box.y + '%', width: a.box.w + '%', height: a.box.h + '%',
                border: `2px solid ${accent}`, borderRadius: 7, cursor: 'default',
                background: hot === a.n ? tint(14) : 'transparent',
                boxShadow: hot === a.n ? `0 0 0 3px ${tint(22)}` : 'none', transition: 'background .12s,box-shadow .12s',
              }}>
              <span style={{
                position: 'absolute', left: -11, top: -11, width: 22, height: 22, borderRadius: '50%',
                background: accent, color: '#fff', fontSize: 12, fontWeight: 800, display: 'grid', placeItems: 'center',
                boxShadow: '0 1px 4px rgba(0,0,0,.35)',
              }}>{a.n}</span>
            </div>
          ))}
        </div>
      </div>
      <ol style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 8 }}>
        {annos.map(a => (
          <li key={a.n}
            onMouseEnter={() => setHot(a.n)} onMouseLeave={() => setHot(null)}
            style={{
              display: 'flex', gap: 10, padding: '9px 11px', borderRadius: 10, alignItems: 'flex-start',
              border: '1px solid ' + (hot === a.n ? accent : 'var(--border)'),
              background: hot === a.n ? tint(8) : 'transparent', transition: 'background .12s,border-color .12s',
            }}>
            <span style={{ flex: '0 0 auto', width: 22, height: 22, borderRadius: '50%', background: accent, color: '#fff', fontSize: 12, fontWeight: 800, display: 'grid', placeItems: 'center' }}>{a.n}</span>
            <div><b style={{ color: 'var(--text-primary)', fontSize: 14 }}>{a.h}</b>{a.t ? <span style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}> — {a.t}</span> : null}</div>
          </li>
        ))}
      </ol>
    </div>
  )
}

const GROUPS = [
  {
    heading: 'Big new features',
    items: [
      {
        icon: '🧭', accent: '#7c3aed', title: 'AI Suggested Follow-Up', date: 'Aug 7', to: '/clients', cta: 'Open Clients',
        desc: 'Open any lead and the Hub reads their full history (Hub + Follow Up Boss) and tells you the single best next move — then writes the email for you.',
        shot: '18-ai-followup-active.png', caption: 'Client profile → Suggested Follow-Up',
        annos: [
          { n: 1, box: { x: 9, y: 11, w: 80, h: 9 }, h: 'The recommended next step', t: 'In plain English, with a one-line why.' },
          { n: 2, box: { x: 9, y: 21.5, w: 80, h: 13 }, h: 'Why it says so', t: 'The real signals it used — property views, last visit, text opt-out, last agent email.' },
          { n: 3, box: { x: 9, y: 46, w: 80, h: 21.5 }, h: 'A ready-to-send email', t: 'Warm and natural, merged with the lead’s details. No salesy tone, no em dashes.' },
          { n: 4, box: { x: 9, y: 71.5, w: 80, h: 6 }, h: 'Make it yours', t: 'Add context, Regenerate, Shorter / More casual / More direct, or send to the composer.' },
        ],
      },
      {
        icon: '✉️', accent: '#2563eb', title: 'Unified Inbox', date: 'Aug 6–7', to: '/inbox', cta: 'Go to Inbox',
        desc: 'One place for client emails, texts, and calls — showing only conversations matched to your clients, so it’s signal, not noise.',
        shot: '06-inbox.png', caption: 'Inbox',
        annos: [
          { n: 1, box: { x: 20, y: 15.5, w: 16, h: 12.5 }, h: 'Inbox / Sent / Closed', t: 'Every email you send now logs under Sent — not just replies.' },
          { n: 2, box: { x: 20, y: 30.5, w: 17, h: 14 }, h: 'Filter by channel', t: 'Emails, texts, calls. Connect a mailbox with a Gmail App Password (no DNS).' },
          { n: 3, box: { x: 85.5, y: 3, w: 13.5, h: 6.5 }, h: 'Reply & compose', t: 'Reply with an AI Suggested Response. When a client writes in, John gets an email alert.' },
        ],
      },
      {
        icon: '💧', accent: '#0891b2', title: 'Drip Campaigns', date: 'Aug 5–10', to: '/marketing', cta: 'Go to Campaigns',
        desc: 'Multi-step email sequences that send themselves on a schedule — now grouped with one-off campaigns under the Campaigns tab.',
        shot: '08-drip-campaigns.png', caption: 'Campaigns → Drip Campaigns',
        annos: [
          { n: 1, box: { x: 18.5, y: 11, w: 30, h: 5.5 }, h: 'Two campaign types', t: 'One-off "Marketing Campaigns" and automated "Drip Campaigns."' },
          { n: 2, box: { x: 18.5, y: 20, w: 46, h: 13 }, h: '“The Long Game”', t: 'A 31-email, year-long buyer nurture that pauses on holidays.' },
          { n: 3, box: { x: 18.5, y: 37, w: 24, h: 9 }, h: 'Live progress', t: 'How many leads are in the sequence and how many emails have gone out.' },
        ],
      },
      {
        icon: '⚡', accent: '#d97706', title: 'Automations', date: 'Aug 5', to: '/automations', cta: 'Go to Automations',
        desc: 'Build workflows that run for each lead automatically — a trigger, an optional wait, then actions — on a drag-and-drop canvas, like Zapier for your CRM.',
        shot: '19-automations-builder.png', caption: 'Automations → visual builder',
        annos: [
          { n: 1, box: { x: 41, y: 8, w: 22.5, h: 9 }, h: 'A trigger starts it', t: 'e.g. when a contact views a listing.' },
          { n: 2, box: { x: 41, y: 19, w: 22.5, h: 8 }, h: 'Add a delay', t: 'Wait a set amount of time before the next step.' },
          { n: 3, box: { x: 41, y: 29.5, w: 22.5, h: 12 }, h: 'Then take action', t: 'Send email, add tag, create task, change status, start a drip.' },
          { n: 4, box: { x: 1, y: 16, w: 19, h: 62 }, h: 'Drag in blocks', t: 'Triggers and steps — or start from a ready-made recipe.' },
        ],
      },
      {
        icon: '📊', accent: '#059669', title: 'Reporting', date: 'Aug 5–6', to: '/reporting', cta: 'Go to Reporting',
        desc: 'See exactly how your batch emails performed — opens, clicks, unsubscribes, and bounces — pulled live from SendGrid.',
        shot: '10-reporting.png', caption: 'Reporting',
        annos: [
          { n: 1, box: { x: 55.5, y: 17.5, w: 42, h: 12 }, h: 'Every send, measured', t: 'Opens, clicks, unsubscribes, bounces — live from SendGrid.' },
          { n: 2, box: { x: 18.5, y: 22, w: 33, h: 6.5 }, h: 'Drill into the people', t: 'Click the subject to view the email, or a number to see who opened/clicked.' },
        ],
      },
      {
        icon: '📝', accent: '#16a34a', title: 'Blog posts published', date: 'Aug', to: '/blog-posts', cta: 'Open Blog Posts',
        desc: 'We researched, wrote, and published a large batch of local, SEO-friendly blog posts to mattsmithteam.com — and the Blog Post Calendar tracks them all.',
        shot: '20-blog-posts.png', caption: 'Blog Post Calendar',
        annos: [
          { n: 1, box: { x: 18.5, y: 13.5, w: 15, h: 5.5 }, h: 'Every post, tracked', t: '198 posts across posted, scheduled and planned.' },
          { n: 2, box: { x: 18.5, y: 24, w: 68, h: 5.5 }, h: 'Real, local topics', t: 'Cedar Rapids homes, neighborhoods, local guides, buyer/seller how-tos.' },
          { n: 3, box: { x: 73.5, y: 23, w: 14.5, h: 18 }, h: 'Live on the site', t: '“View post” opens the published article on mattsmithteam.com.' },
        ],
      },
    ],
  },
  {
    heading: 'Clients list & filters',
    items: [
      {
        icon: '🧹', accent: '#0ea5e9', title: 'A cleaner client list', date: 'Aug 10', to: '/clients', cta: 'Open Clients',
        desc: 'We stripped the clutter out of each row and turned the column headers into instant filters, so the info you scan is front and center.',
        shot: '02-clients-list.png', caption: 'Clients',
        annos: [
          { n: 1, box: { x: 41, y: 40, w: 42, h: 5 }, h: 'Every header filters', t: 'Click Type, Phone, Email, Address or Source to filter instantly.' },
          { n: 2, box: { x: 17, y: 45.5, w: 40, h: 9 }, h: 'Clean rows', t: 'No SIERRA badge, tag chips, or Buyer/Seller emojis.' },
          { n: 3, box: { x: 20, y: 52.5, w: 9, h: 15 }, h: 'Type a Realist Score', t: 'Click the score cell to enter it — it auto-grades A–F and survives Sierra syncs.' },
        ],
      },
      {
        icon: '🔎', accent: '#4f46e5', title: 'Filter from the column headers', date: 'Aug 10', to: '/clients', cta: 'Open Clients',
        desc: 'The Buyer/Seller tabs moved into the TYPE header, and Phone / Email / Address / Source each became a one-click filter.',
        shot: '04-clients-type-header.png', caption: 'Clients → Type header',
        annos: [
          { n: 1, box: { x: 41, y: 40, w: 8, h: 5 }, h: 'Click the header', t: 'A little menu drops down.' },
          { n: 2, box: { x: 41, y: 44, w: 14, h: 15 }, h: 'Pick one', t: 'All / Buyer / Seller / Buyer-Seller — your choice shows in the header.' },
        ],
      },
      {
        icon: '🧰', accent: '#0d9488', title: 'Smarter filters', date: 'Aug 5–10', to: '/clients', cta: 'Open Clients',
        desc: 'The Filters panel was cleaned up and given new, list-building filters — including a couple below the fold (Address, and drip-campaign enrollment).',
        shot: '03-clients-filters.png', caption: 'Clients → Filters',
        annos: [
          { n: 1, box: { x: 18.5, y: 60, w: 61, h: 10 }, h: 'Cleaner, aligned controls', t: 'Everything lines up on one row; sections are separated.' },
          { n: 2, box: { x: 18.5, y: 74.5, w: 23, h: 9.5 }, h: '“Properties viewed”', t: 'Leads who actually viewed N+ listings — so a "homes you looked at" email always has homes.' },
        ],
      },
    ],
  },
  {
    heading: 'Nicer emails & the little things',
    items: [
      {
        icon: '🔗', accent: '#db2777', title: 'Automatic link previews', date: 'Aug 10', to: '/templates', cta: 'Go to Templates',
        desc: 'Paste a link into any email composer (or type one and hit space) and it becomes a clean, compact preview card — image, title, and description.',
        shot: '12-templates-composer.png', caption: 'Any email composer',
        annos: [
          { n: 1, box: { x: 9, y: 45, w: 40, h: 5 }, h: 'Link Preview', t: 'Auto on paste/type, or use the button. Works for your own mattsmithteam.com pages too.' },
        ],
      },
      {
        icon: '📱', accent: '#2563eb', title: 'Install the Hub as an app', date: 'Aug 7', to: null, cta: null,
        desc: 'The Hub is now installable on your phone and desktop (look for “Install App” in the sidebar) and every page is mobile-friendly — so it works well on a phone in the field.',
        points: [],
      },
      {
        icon: '🛡️', accent: '#475569', title: 'Faster & far more stable', date: 'Aug 10', to: null, cta: null,
        desc: 'Behind the scenes we rebuilt the storage engine so the Hub reads/writes straight to disk instead of holding all 45k leads in memory — the root-cause fix for the “app crashed” emails. Plus crash-proofing, automatic hourly + nightly backups, and more server power.',
        points: [],
      },
    ],
  },
]

export default function WhatsNew() {
  const navigate = useNavigate()
  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{
        border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px', marginBottom: 22,
        background: 'linear-gradient(120deg, color-mix(in srgb, var(--accent, #2563eb) 10%, var(--bg-card)), var(--bg-card))',
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--accent, #2563eb)' }}>
          What’s new · since August 3, 2026
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, margin: '6px 0 4px', color: 'var(--text-primary)' }}>
          Everything we added to the Hub
        </div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 14.5 }}>
          A visual tour of every upgrade. The numbered boxes on each screen point to the new bits — the note under each screen explains it. Hit <b>“Show me →”</b> to jump to the live feature.
        </div>
      </div>

      {GROUPS.map(g => (
        <div key={g.heading} style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-muted)', margin: '0 0 12px' }}>
            {g.heading}
          </div>
          <div style={{ display: 'grid', gap: 18 }}>
            {g.items.map(it => (
              <div key={it.title} style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 18, background: 'var(--bg-card)' }}>
                <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  <div style={{ flex: '0 0 auto', width: 44, height: 44, borderRadius: 11, display: 'grid', placeItems: 'center', fontSize: 22, background: `color-mix(in srgb, ${it.accent} 16%, transparent)` }}>{it.icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{it.title}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: it.accent, background: `color-mix(in srgb, ${it.accent} 14%, transparent)`, padding: '2px 8px', borderRadius: 999 }}>{it.date}</span>
                    </div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 5, lineHeight: 1.5 }}>{it.desc}</div>
                    {it.points && it.points.length > 0 && (
                      <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--text-secondary)', fontSize: 13.5, lineHeight: 1.55 }}>
                        {it.points.map((p, i) => <li key={i}>{p}</li>)}
                      </ul>
                    )}
                  </div>
                  {it.to && (
                    <button className="btn btn-sm btn-secondary" style={{ flex: '0 0 auto' }} onClick={() => navigate(it.to)}>{it.cta || 'Show me'} →</button>
                  )}
                </div>
                {it.shot && <AnnotatedShot name={it.shot} accent={it.accent} annos={it.annos} caption={it.caption} />}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '6px 0 20px' }}>
        That’s the tour. The full development history is under <b>Hub Updates</b>.
      </div>
    </div>
  )
}
