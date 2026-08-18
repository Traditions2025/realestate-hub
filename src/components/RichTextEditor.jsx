import React, { useRef, useEffect, useState } from 'react'
import { authFetch } from '../api'
import { buildLinkPreviewHtml, soleUrl } from './inlineImages'

// Lightweight Gmail-style WYSIWYG editor built on a contentEditable div.
// - value/onChange keep it controlled from the outside (template load, etc.)
// - we only reset innerHTML when the incoming value differs, so typing never
//   loses the caret.
// Personalization fields the email merge engine (server fillTemplate) supports.
// Single source of truth for email merge fields: [token, label, description, source].
// The composer's "+ Field" menu AND the Updates → Custom Fields reference both read
// from this list, so anything added here shows up in both places automatically.
export const MERGE_FIELDS = [
  ['{{first_name}}', 'First name', "The lead's first name. Falls back to 'there' so an email never opens with 'Hi ,'.", 'Sierra / FUB'],
  ['{{last_name}}', 'Last name', "The lead's last name. Blank if not on file.", 'Sierra / FUB'],
  ['{{full_name}}', 'Full name', 'First + last name together.', 'Sierra / FUB'],
  ['{{email}}', 'Email', "The lead's email address.", 'Sierra / FUB'],
  ['{{phone}}', 'Phone', "The lead's phone number.", 'Sierra / FUB'],
  ['{{address}}', 'Street address', "The lead's street address. Falls back to 'your home'.", 'Sierra'],
  ['{{city}}', 'City', "The lead's city. Falls back to 'Cedar Rapids'.", 'Sierra'],
  ['{{state}}', 'State', "The lead's state.", 'Sierra'],
  ['{{zip}}', 'Zip code', "The lead's ZIP code.", 'Sierra'],
  ['{{city_of_interest}}', 'City of interest', 'The city of the LAST home they viewed — the freshest interest signal. Falls back to their top viewed city, then their own city.', 'Follow Up Boss'],
  ['{{listing_interest}}', 'Listing interest (areas)', 'The top 3 areas they have been viewing homes in, cleaned and joined naturally (e.g. "Cedar Rapids, Marion, and Solon").', 'Follow Up Boss'],
  ['{{last_viewed_address}}', 'Last viewed address', 'The exact last property they looked at (e.g. "419 3rd St, Nw Mt Vernon").', 'Follow Up Boss'],
  ['{{price_range}}', 'Price range', 'Self-framing budget clause: renders " in the $220,000 range" when the lead has a FUB price, and NOTHING at all when they do not, so a sentence using it reads cleanly either way. Never shows a made-up number.', 'Follow Up Boss'],
  ['{{price_point}}', 'Price (number only)', 'Just the budget number, like "$220,000". Blank when FUB has no price. Use {{price_range}} inside a sentence; use this when you only want the number.', 'Follow Up Boss'],
  ['{{search_price_range}}', 'Saved-search budget', 'The Sierra saved-search band (e.g. "$175,000 to $900,000"). Suppressed when it is the shared $200k-$600k default that 99% of leads carry, since that is not a real chosen budget.', 'Sierra'],
  ['{{lender_name}}', 'Lender name', "The lead's lender. Pulls from their transaction once under contract; blank for buyer leads with no deal yet.", 'Transaction'],
  ['{{lender_company}}', 'Lender company', 'The lending company, from their transaction. Blank until under contract.', 'Transaction'],
  ['{{agent}}', 'Agent name', "The assigned agent's name. Falls back to 'Matt Smith'.", 'Sierra'],
  ['{{greeting}}', 'Greeting', 'A time-aware greeting — "Good morning / afternoon / evening" based on when it sends.', 'System'],
  ['{{signature}}', 'Email signature', 'Your saved email signature block (name, title, phone, links).', 'Settings'],
  ['{{properties}}', 'Property cards', 'Live "homes they viewed" property cards, built into the email on send.', 'Follow Up Boss'],
  ['{{home_value_link}}', 'Home value link', 'A hyperlink reading "Get your home value here" that points to the team\'s home-value tool. The raw URL never shows. For past-client / homeowner emails.', 'Team tool'],
  ['{{cma_request_link}}', 'Home analysis (CMA) link', 'A hyperlink reading "Request your full home analysis here" to the team\'s home-value tool. The raw URL never shows. For past-client emails.', 'Team tool'],
  ['{{seasonal_maintenance}}', 'Seasonal maintenance blurb', 'A short, Iowa-accurate home-maintenance paragraph (from Matt) that changes with the current season automatically, so it is always right for the season it sends in.', 'System'],
  ['{{years_in_home}}', 'Years in the home', 'Whole years since the client\'s closing, computed from their most recent transaction closing date. Falls back to "several" when no closing date is on file. Used by the Vintage (3+ year) past-client track.', 'Transaction'],
  ['{{monthly_intro}}', 'Monthly intro line', 'A warm opening line that changes with the current calendar month (e.g. August: "The calendar says August, but somehow it feels like summer just started."). Cedar Rapids / Eastern Iowa flavored, so each monthly past-client touch opens in-season automatically — and never repeats the line month to month.', 'System'],
]

export default function RichTextEditor({ value, onChange, minHeight = 220 }) {
  const ref = useRef(null)
  const savedRange = useRef(null)
  const [linkLoading, setLinkLoading] = useState(false)

  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== (value || '')) {
      ref.current.innerHTML = value || ''
    }
  }, [value])

  const sync = () => onChange(ref.current ? ref.current.innerHTML : '')
  const exec = (cmd, arg) => { document.execCommand(cmd, false, arg); ref.current && ref.current.focus(); sync() }

  // Remember the caret inside the editor so a toolbar interaction (which steals
  // focus) can still insert a field exactly where the cursor was.
  const saveSel = () => {
    const s = window.getSelection()
    if (s && s.rangeCount && ref.current && ref.current.contains(s.anchorNode)) savedRange.current = s.getRangeAt(0).cloneRange()
  }
  const insertField = (token) => {
    if (!token || !ref.current) return
    ref.current.focus()
    const sel = window.getSelection()
    if (savedRange.current) { sel.removeAllRanges(); sel.addRange(savedRange.current) }
    else if (!sel.rangeCount || !ref.current.contains(sel.anchorNode)) {
      // no known caret — drop it at the end
      const r = document.createRange(); r.selectNodeContents(ref.current); r.collapse(false); sel.removeAllRanges(); sel.addRange(r)
    }
    document.execCommand('insertText', false, token)
    saveSel()
    sync()
  }
  const addLink = () => { const url = prompt('Link URL (https://…):'); if (url) exec('createLink', url.trim()) }

  // Fetch OG metadata and insert a preview card at the caret.
  const insertCardForUrl = async (rawUrl) => {
    let url = String(rawUrl).trim(); if (!/^https?:\/\//i.test(url)) url = 'https://' + url
    ref.current && ref.current.focus()
    setLinkLoading(true)
    let data = {}
    try { const res = await authFetch('/api/link-preview?url=' + encodeURIComponent(url)); if (res.ok) data = await res.json() } catch {}
    setLinkLoading(false)
    exec('insertHTML', '<br>' + buildLinkPreviewHtml({ url, ...data }) + '<br>')
  }

  const insertLinkPreview = async () => {
    const url = prompt('Paste a link to preview:\n(inserts a rich card with its image, title & description)')
    if (url) insertCardForUrl(url)
  }

  // Auto-preview when a lone link is pasted into the editor.
  const onPaste = (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || ''
    const url = soleUrl(text)
    if (!url) return                 // not a bare link -> let the normal paste happen
    e.preventDefault()
    insertCardForUrl(url)
  }

  const tbBtn = { padding: '4px 9px', background: 'var(--bg-primary, #fff)', border: '1px solid var(--border, #d1d5db)', borderRadius: 4, fontSize: 13, cursor: 'pointer', color: 'var(--text-primary, #111)' }
  const B = ({ label, cmd, arg, title }) => (
    <button type="button" title={title} onMouseDown={e => e.preventDefault()} onClick={() => exec(cmd, arg)} style={tbBtn}>{label}</button>
  )

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 4, padding: 6, borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', flexWrap: 'wrap' }}>
        <B label={<b>B</b>} cmd="bold" title="Bold" />
        <B label={<i>I</i>} cmd="italic" title="Italic" />
        <B label={<u>U</u>} cmd="underline" title="Underline" />
        <B label="•" cmd="insertUnorderedList" title="Bullet list" />
        <B label="1." cmd="insertOrderedList" title="Numbered list" />
        <button type="button" title="Insert link" onMouseDown={e => e.preventDefault()} onClick={addLink} style={tbBtn}>🔗</button>
        <button type="button" title="Insert a rich link preview card (image, title, description)" onMouseDown={e => e.preventDefault()} onClick={insertLinkPreview} disabled={linkLoading} style={tbBtn}>{linkLoading ? '⏳' : '🔗+ Preview'}</button>
        <B label="H" cmd="formatBlock" arg="H3" title="Heading" />
        <B label="⟲" cmd="removeFormat" title="Clear formatting" />
        <select
          title="Insert a personalization field at the cursor"
          value=""
          onMouseDown={saveSel}
          onChange={e => { insertField(e.target.value); e.target.value = '' }}
          style={{ ...tbBtn, padding: '4px 6px' }}
        >
          <option value="">+ Field</option>
          {MERGE_FIELDS.map(([tok, label]) => <option key={tok} value={tok}>{label}</option>)}
        </select>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={sync}
        onBlur={() => { saveSel(); sync() }}
        onKeyUp={saveSel}
        onMouseUp={saveSel}
        onPaste={onPaste}
        style={{ minHeight, maxHeight: '48vh', overflowY: 'auto', padding: '12px 14px', fontSize: 14, lineHeight: 1.6, outline: 'none', fontFamily: 'Arial, Helvetica, sans-serif', background: '#ffffff', color: '#111827' }}
      />
    </div>
  )
}
