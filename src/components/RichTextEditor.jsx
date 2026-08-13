import React, { useRef, useEffect, useState } from 'react'
import { authFetch } from '../api'
import { buildLinkPreviewHtml, soleUrl } from './inlineImages'

// Lightweight Gmail-style WYSIWYG editor built on a contentEditable div.
// - value/onChange keep it controlled from the outside (template load, etc.)
// - we only reset innerHTML when the incoming value differs, so typing never
//   loses the caret.
// Personalization fields the email merge engine (server fillTemplate) supports.
export const MERGE_FIELDS = [
  ['{{first_name}}', 'First name'],
  ['{{last_name}}', 'Last name'],
  ['{{full_name}}', 'Full name'],
  ['{{email}}', 'Email'],
  ['{{phone}}', 'Phone'],
  ['{{address}}', 'Street address'],
  ['{{city}}', 'City'],
  ['{{state}}', 'State'],
  ['{{zip}}', 'Zip code'],
  ['{{city_of_interest}}', 'City of interest — last viewed (FUB)'],
  ['{{listing_interest}}', 'Listing Interest — top areas (FUB)'],
  ['{{last_viewed_address}}', 'Last viewed address (FUB)'],
  ['{{price_point}}', 'Avg price of homes viewed (FUB)'],
  ['{{search_price_range}}', 'Saved-search budget (Sierra)'],
  ['{{lender_name}}', 'Lender name'],
  ['{{lender_company}}', 'Lender company'],
  ['{{agent}}', 'Agent name'],
  ['{{greeting}}', 'Greeting (Good morning…)'],
  ['{{signature}}', 'Email signature'],
  ['{{properties}}', 'Property cards'],
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
