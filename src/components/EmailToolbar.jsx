import React, { useRef, useState, useEffect } from 'react'
import { authFetch } from '../api'
import {
  attachImagesSmart,
  parseYoutubeId,
  buildYoutubeEmbedHtml,
  buildLinkPreviewHtml,
  insertAtCursor,
  soleUrl,
  trailingUrl,
} from './inlineImages'

/**
 * Reusable email toolbar — adds Insert Image, Insert YouTube, and Preview
 * actions above any email-body textarea.
 *
 * Props:
 *   textareaRef  – React ref pointing to the body <textarea>
 *   body         – current body string
 *   setBody      – setter that takes the new body string
 *   onPreview    – optional callback to open a preview modal
 *   showPreview  – default true; hides the Preview button if false
 *   compact      – default false; renders smaller buttons
 */
export default function EmailToolbar({ textareaRef, body, setBody, onPreview, showPreview = true, compact = false }) {
  const fileRef = useRef(null)
  const [linkLoading, setLinkLoading] = useState(false)
  // Latest body + a de-dupe guard so async auto-previews use current text and don't double-fire.
  const bodyRef = useRef(body); bodyRef.current = body
  const busyUrlRef = useRef('')

  const onPickImage = () => fileRef.current?.click()

  const fetchPreview = async (url) => {
    try { const res = await authFetch('/api/link-preview?url=' + encodeURIComponent(url)); return res.ok ? await res.json() : {} }
    catch { return {} }
  }

  // Auto-preview: replace a bare URL (already in the body) with a card, or append one.
  const autoPreviewToken = async (token, url) => {
    if (busyUrlRef.current === url) return
    busyUrlRef.current = url
    setLinkLoading(true)
    const data = await fetchPreview(url)
    setLinkLoading(false)
    busyUrlRef.current = ''
    const card = '\n' + buildLinkPreviewHtml({ url, ...data }) + '\n'
    const prev = bodyRef.current || ''
    const idx = token ? prev.lastIndexOf(token) : -1
    if (idx === -1) { setBody(prev + card); return }
    setBody(prev.slice(0, idx) + card + prev.slice(idx + token.length))
  }

  // Attach paste + type detection directly to the body textarea.
  useEffect(() => {
    const ta = textareaRef?.current
    if (!ta) return
    const onPaste = (e) => {
      const text = (e.clipboardData || window.clipboardData)?.getData('text') || ''
      const url = soleUrl(text)
      if (!url) return                 // not a lone link -> normal paste
      e.preventDefault()
      autoPreviewToken('', url)        // nothing typed yet; insert a card
    }
    const onKeyUp = (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return
      const before = String(ta.value || '').slice(0, ta.selectionStart).replace(/\s+$/, '')
      const hit = trailingUrl(before)
      if (hit) autoPreviewToken(hit.token, hit.url)
    }
    ta.addEventListener('paste', onPaste)
    ta.addEventListener('keyup', onKeyUp)
    return () => { ta.removeEventListener('paste', onPaste); ta.removeEventListener('keyup', onKeyUp) }
  }, [textareaRef])

  // Insert a rich preview card for a pasted link (fetches its Open Graph metadata).
  const onInsertLinkPreview = async () => {
    let url = window.prompt('Paste a link to preview:\n(the email will show a rich card with its image, title & description)')
    if (!url) return
    url = url.trim()
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url
    const ta = textareaRef?.current
    setLinkLoading(true)
    try {
      const res = await authFetch('/api/link-preview?url=' + encodeURIComponent(url))
      const data = res.ok ? await res.json() : {}
      const snippet = '\n' + buildLinkPreviewHtml({ url, ...data }) + '\n'
      setBody(insertAtCursor(ta, snippet, body || ''))
    } catch {
      // Network failure — insert a plain styled card with just the URL so nothing is lost.
      const snippet = '\n' + buildLinkPreviewHtml({ url }) + '\n'
      setBody(insertAtCursor(ta, snippet, body || ''))
    } finally {
      setLinkLoading(false)
    }
  }

  const onImageChosen = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    const ta = textareaRef?.current
    const r = await attachImagesSmart(body || '', files, ta)
    if (r.count > 0) setBody(r.newBody)
    e.target.value = ''
  }

  const onInsertYoutube = () => {
    const url = window.prompt('Paste a YouTube URL:\n(youtube.com/watch?v=…  or  youtu.be/…)')
    if (!url) return
    const id = parseYoutubeId(url)
    if (!id) {
      alert('Could not parse YouTube ID from that URL. Try the standard youtube.com/watch?v=… link.')
      return
    }
    const snippet = '\n' + buildYoutubeEmbedHtml(url) + '\n'
    const ta = textareaRef?.current
    setBody(insertAtCursor(ta, snippet, body || ''))
  }

  const cls = compact ? 'btn btn-sm btn-secondary' : 'btn btn-secondary'

  return (
    <div className="email-toolbar" style={{display: 'flex', gap: 6, flexWrap: 'wrap', margin: '4px 0 6px', alignItems: 'center'}}>
      <input ref={fileRef} type="file" accept="image/*" multiple style={{display: 'none'}} onChange={onImageChosen} />
      <button type="button" className={cls} onClick={onPickImage} title="Insert one or more images inline (embedded as base64 — works in Gmail/Outlook)">
        🖼 Insert Image
      </button>
      <button type="button" className={cls} onClick={onInsertYoutube} title="Insert a YouTube video — renders as a clickable thumbnail in the email">
        ▶ Insert YouTube
      </button>
      <button type="button" className={cls} onClick={onInsertLinkPreview} disabled={linkLoading} title="Paste a link and insert a rich preview card (image, title, description) into the email">
        {linkLoading ? '⏳ Fetching…' : '🔗 Link Preview'}
      </button>
      {showPreview && (
        <button
          type="button"
          className={cls}
          onClick={onPreview}
          disabled={!body}
          title="Preview how the email will render in the recipient's inbox"
        >
          👁 Preview
        </button>
      )}
      <span style={{fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto'}}>
        Body is HTML — click 👁 Preview to see how it'll render in the inbox.
      </span>
    </div>
  )
}
