import React from 'react'
import { useNavigate } from 'react-router-dom'

// In-app "What's New" — a plain-English guide to everything added since Aug 3, 2026.
// Card-based (no screenshot overlays), theme-aware, with deep links to each live feature.

const GROUPS = [
  {
    heading: 'Big new features',
    items: [
      {
        icon: '🧭', accent: '#7c3aed', title: 'AI Suggested Follow-Up', date: 'Aug 7', to: '/clients', cta: 'Open Clients',
        desc: 'Open any lead and the Hub reads their full history (from the Hub + Follow Up Boss) and tells you the single best next move — then writes the email for you.',
        note: 'Open a client, and look for the purple “Suggested Follow-Up” card at the top of their profile.',
        points: [
          'The recommended next step, in plain English, with the reasoning it used (property views, last visit, text opt-out, last agent email, etc.)',
          'A warm, ready-to-send email — no salesy tone, no em dashes',
          'Refine it: Add context, Regenerate, make it Shorter / More casual / More direct, or push it into the composer',
        ],
      },
      {
        icon: '✉️', accent: '#2563eb', title: 'Unified Inbox', date: 'Aug 6–7', to: '/inbox', cta: 'Go to Inbox',
        desc: 'One place for client emails, texts, and calls — showing only conversations matched to your clients, so it’s signal, not noise.',
        points: [
          'Reply from the Hub with an AI Suggested Response you can tweak',
          'Every email you send (composer, drips, automations, campaigns) logs under Sent',
          'John gets an email notification whenever a client writes in',
        ],
      },
      {
        icon: '💧', accent: '#0891b2', title: 'Drip Campaigns', date: 'Aug 5–10', to: '/marketing', cta: 'Go to Campaigns',
        desc: 'Multi-step email sequences that send themselves on a schedule — now grouped with one-off campaigns under the Campaigns tab.',
        note: 'On the Campaigns page, click the “Drip Campaigns” sub-tab.',
        points: [
          '“The Long Game” — a 31-email, year-long buyer nurture',
          'Opens with the homes a lead viewed, then a personal touch from Day 7 to Day 365',
          'Sends automatically pause on US holidays',
        ],
      },
      {
        icon: '⚡', accent: '#d97706', title: 'Automations', date: 'Aug 5', to: '/automations', cta: 'Go to Automations',
        desc: 'Build workflows that run for each lead automatically — a trigger, an optional wait, then actions — on a drag-and-drop canvas, like Zapier for your CRM.',
        points: [
          'Triggers like “a contact views a listing” or “a new lead comes in”',
          'Actions: send email, add tag, create task, change status, start a drip',
          'Start from a ready-made recipe (New Lead Response, Hot Lead Alert…) or a blank canvas',
        ],
      },
      {
        icon: '📊', accent: '#059669', title: 'Reporting', date: 'Aug 5–6', to: '/reporting', cta: 'Go to Reporting',
        desc: 'See exactly how your batch emails performed — opens, clicks, unsubscribes, and bounces — pulled live from SendGrid.',
        points: [
          'Every send, measured (it even surfaces older pre-Hub batches)',
          'Click a subject to view the exact email that went out',
          'Click any opens/clicks number to see precisely who opened or clicked',
        ],
      },
    ],
  },
  {
    heading: 'Clients list & filters',
    items: [
      {
        icon: '🧹', accent: '#0ea5e9', title: 'A cleaner client list', date: 'Aug 10', to: '/clients', cta: 'Open Clients',
        desc: 'We stripped the clutter out of each row so the info you actually scan — name, status, type, phone, email, last visit — is front and center.',
        points: [
          'Removed the “SIERRA” badge, the tag chips, and the Buyer/Seller emoji icons',
          'Plain Buyer / Seller / Buyer-Seller labels',
        ],
      },
      {
        icon: '🔎', accent: '#4f46e5', title: 'Filter from the column headers', date: 'Aug 10', to: '/clients', cta: 'Open Clients',
        desc: 'The column headers are now instant filters — click one and pick an option to slice 45,799 leads without opening the full Filters panel.',
        points: [
          'Type → All / Buyer / Seller / Buyer-Seller (replaces the old top tabs)',
          'Phone → with / without a number',
          'Email → with / without an address',
          'Address → with / without · Source → pick any source',
        ],
      },
      {
        icon: '🎯', accent: '#c026d3', title: 'Type a Realist Score by hand', date: 'Aug 10', to: '/clients', cta: 'Open Clients',
        desc: 'Click the Score cell (or the “—”) on any lead and type a number. It auto-grades A–F — and it sticks: the Sierra sync won’t overwrite a score you entered yourself.',
        points: [],
      },
      {
        icon: '🧰', accent: '#0d9488', title: 'Smarter filters', date: 'Aug 5–10', to: '/clients', cta: 'Open Clients',
        desc: 'The Filters panel was cleaned up and given new, list-building filters.',
        note: 'Click “Filters” on the Clients page to open the panel.',
        points: [
          '“Properties viewed” — leads who actually viewed N+ listings',
          'Address (has / none) · Drip-campaign enrollment (in / not in, and which campaign)',
          'Save any filter set as a reusable list',
        ],
      },
    ],
  },
  {
    heading: 'Nicer emails & the little things',
    items: [
      {
        icon: '🔗', accent: '#db2777', title: 'Automatic link previews', date: 'Aug 10', to: '/templates', cta: 'Go to Templates',
        desc: 'Paste a link into any email composer (or type one and hit space) and it becomes a clean, compact preview card with the page’s image, title, and description.',
        points: [
          'Works for your own mattsmithteam.com listing pages',
          'Available in every composer — client email, Templates, Listings, drips, campaigns',
        ],
      },
      {
        icon: '📱', accent: '#2563eb', title: 'Install the Hub as an app', date: 'Aug 7', to: null, cta: null,
        desc: 'The Hub is now installable on your phone and desktop (look for “Install App” in the sidebar) and every page is mobile-friendly, so it works well on a phone in the field.',
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
          A quick tour of every upgrade. Hit <b>“Show me →”</b> on any card to jump straight to the live feature.
        </div>
      </div>

      {GROUPS.map(g => (
        <div key={g.heading} style={{ marginBottom: 26 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-muted)', margin: '0 0 12px' }}>
            {g.heading}
          </div>
          <div style={{ display: 'grid', gap: 14 }}>
            {g.items.map(it => (
              <div key={it.title} style={{
                display: 'flex', gap: 14, alignItems: 'flex-start',
                border: '1px solid var(--border)', borderRadius: 14, padding: 16, background: 'var(--bg-card)',
              }}>
                <div style={{
                  flex: '0 0 auto', width: 44, height: 44, borderRadius: 11, display: 'grid', placeItems: 'center',
                  fontSize: 22, background: `color-mix(in srgb, ${it.accent} 16%, transparent)`,
                }}>{it.icon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 16.5, fontWeight: 700, color: 'var(--text-primary)' }}>{it.title}</span>
                    <span style={{
                      fontSize: 11, fontWeight: 700, color: it.accent,
                      background: `color-mix(in srgb, ${it.accent} 14%, transparent)`, padding: '2px 8px', borderRadius: 999,
                    }}>{it.date}</span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 5, lineHeight: 1.5 }}>{it.desc}</div>
                  {it.points && it.points.length > 0 && (
                    <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--text-secondary)', fontSize: 13.5, lineHeight: 1.55 }}>
                      {it.points.map((p, i) => <li key={i} style={{ marginBottom: 2 }}>{p}</li>)}
                    </ul>
                  )}
                  {it.note && (
                    <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--text-muted)', fontStyle: 'italic' }}>💡 {it.note}</div>
                  )}
                  {it.to && (
                    <div style={{ marginTop: 12 }}>
                      <button className="btn btn-sm btn-primary" onClick={() => navigate(it.to)}>{it.cta || 'Show me'} →</button>
                    </div>
                  )}
                </div>
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
