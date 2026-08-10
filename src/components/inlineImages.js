// Shared helper: replace local <img src> references with base64 data URIs
// so they render in every email client without needing a public host.

function basename(path) {
  if (!path) return ''
  const cleaned = String(path).split(/[?#]/)[0]
  const parts = cleaned.split(/[\\/]/)
  return decodeURIComponent(parts[parts.length - 1] || '').toLowerCase()
}

function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve({ filename: file.name, dataUri: r.result.toString(), size: file.size })
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

// Pick image files, read as base64 data URIs, and rewrite matching <img src=".."> tags in `body`.
// Returns { newBody, inlined: [{filename, size}], unmatched: [filenames in body that weren't supplied] }
export async function inlineImagesIntoBody(body, files) {
  if (!body) body = ''
  const fileList = await Promise.all(files.map(fileToDataUri))
  const byName = new Map()
  for (const f of fileList) byName.set(basename(f.filename), f.dataUri)

  let newBody = body
  const inlined = []
  // Replace src/srcset for any <img> whose src filename matches an uploaded file
  newBody = newBody.replace(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (tag, src) => {
    // Skip if already absolute http/https or a data: URI
    if (/^(https?:|data:)/i.test(src)) return tag
    const name = basename(src)
    const dataUri = byName.get(name)
    if (!dataUri) return tag
    inlined.push(name)
    return tag.replace(src, dataUri)
  })

  // Find all img srcs in the body that we didn't manage to replace (still local paths)
  const unmatched = []
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi
  let m
  while ((m = re.exec(newBody)) !== null) {
    if (!/^(https?:|data:)/i.test(m[1])) unmatched.push(basename(m[1]))
  }

  return { newBody, inlined, unmatched }
}

// Read a single image file and return an HTML <img> tag with a base64 data URI.
// Use to "Insert Image" directly into an email body at cursor.
export async function imageFileToImgTag(file, maxWidth = 600) {
  const { dataUri } = await fileToDataUri(file)
  return `<img src="${dataUri}" alt="${file.name.replace(/"/g, '&quot;')}" style="max-width:${maxWidth}px; width:100%; height:auto; display:block; margin:12px 0; border-radius:6px;" />`
}

// Extract a YouTube video ID from any of the common URL forms.
// Returns null if not a YouTube URL.
export function parseYoutubeId(url) {
  if (!url) return null
  const s = String(url).trim()
  // youtu.be/VIDEOID
  let m = s.match(/youtu\.be\/([A-Za-z0-9_-]{6,15})/)
  if (m) return m[1]
  // youtube.com/watch?v=VIDEOID
  m = s.match(/[?&]v=([A-Za-z0-9_-]{6,15})/)
  if (m) return m[1]
  // youtube.com/embed/VIDEOID  or  youtube.com/shorts/VIDEOID
  m = s.match(/youtube\.com\/(?:embed|shorts)\/([A-Za-z0-9_-]{6,15})/)
  if (m) return m[1]
  return null
}

// Build an email-safe YouTube preview block: a clickable thumbnail with a play overlay.
// Most email clients block <iframe>, so we ship a thumbnail + link instead.
export function buildYoutubeEmbedHtml(url, opts = {}) {
  const id = parseYoutubeId(url)
  if (!id) return null
  const watchUrl = `https://www.youtube.com/watch?v=${id}`
  const thumb = `https://img.youtube.com/vi/${id}/hqdefault.jpg`
  const width = opts.width || 560
  // Inline-styled, centered, with a red play button overlay drawn via a layered <a>
  return (
`<div style="margin:14px 0;text-align:center;">
  <a href="${watchUrl}" target="_blank" rel="noopener" style="display:inline-block;position:relative;text-decoration:none;max-width:${width}px;width:100%;">
    <img src="${thumb}" alt="Watch video on YouTube" style="display:block;width:100%;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.18);" />
    <span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(255,0,0,0.92);color:#fff;font-family:Arial,sans-serif;font-weight:700;font-size:18px;padding:10px 22px;border-radius:8px;letter-spacing:0.5px;">▶ Play</span>
  </a>
  <div style="font-family:Arial,sans-serif;font-size:12px;color:#666;margin-top:6px;">Click the image to watch on YouTube</div>
</div>`
  )
}

// Find any plain YouTube URLs in a body and replace them with an embed block.
// Skips URLs that are already inside an <a> tag or an <img src> attribute.
export function autoEmbedYoutubeLinks(body) {
  if (!body) return body
  const re = /(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[\w=&-]+|embed\/[A-Za-z0-9_-]{6,15}|shorts\/[A-Za-z0-9_-]{6,15})|youtu\.be\/[A-Za-z0-9_-]{6,15})[^\s<"']*)/gi
  return body.replace(re, (match, url, offset, full) => {
    // If immediately inside an <a> or quoted attribute, leave alone
    const before = full.slice(Math.max(0, offset - 80), offset)
    if (/<a\b[^>]*$/i.test(before)) return match
    if (/(href|src)\s*=\s*["'][^"']*$/i.test(before)) return match
    const embed = buildYoutubeEmbedHtml(url)
    return embed || match
  })
}

// Smart image attach: first tries to inline any local <img src="..."> tags in
// the body that match an uploaded file (HTML-from-file workflow). If nothing
// matches, falls back to inserting fresh <img> tags at the textarea cursor
// (or appended if no textarea ref). Returns { newBody, mode, count, message }.
export async function attachImagesSmart(body, files, textareaEl) {
  const imgFiles = files.filter(f => /^image\//.test(f.type))
  if (!imgFiles.length) {
    return { newBody: body || '', mode: 'none', count: 0, message: 'No image files were selected.' }
  }
  const r = await inlineImagesIntoBody(body || '', imgFiles)
  if (r.inlined.length) {
    let msg = `✓ Inlined ${r.inlined.length} image${r.inlined.length === 1 ? '' : 's'}: ${r.inlined.join(', ')}`
    if (r.unmatched.length) msg += `\nStill unmatched: ${[...new Set(r.unmatched)].join(', ')}`
    return { newBody: r.newBody, mode: 'inlined', count: r.inlined.length, message: msg }
  }
  // Fall back: insert each image at the cursor as a base64 <img> tag
  let snippet = ''
  for (const f of imgFiles) snippet += await imageFileToImgTag(f)
  const newBody = textareaEl ? insertAtCursor(textareaEl, snippet, body || '') : (body || '') + snippet
  return {
    newBody,
    mode: 'inserted',
    count: imgFiles.length,
    message: `Inserted ${imgFiles.length} image${imgFiles.length === 1 ? '' : 's'}. Click Preview to see how they will render.`,
  }
}

// Insert text/HTML at the textarea's caret position; returns the new value.
// Build an email-safe "link preview" card (table-based, inline styles) from unfurled
// metadata. The whole card is a single clickable link. Falls back gracefully when
// there's no image/description. Used by EmailToolbar's Link Preview action.
export function buildLinkPreviewHtml({ url, title, description, image, siteName } = {}) {
  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  let domain = siteName || ''
  if (!domain) { try { domain = new URL(url).hostname.replace(/^www\./, '') } catch { domain = '' } }
  const clamp = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trim() + '…' : s }
  // Fall back to the domain (nicer than a raw URL) when a title couldn't be fetched.
  const safeTitle = esc(clamp(title || domain || url, 120))
  const safeDesc = description ? esc(clamp(description, 180)) : ''
  const imgCell = image
    ? `<tr><td style="padding:0;"><img src="${esc(image)}" alt="" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:8px 8px 0 0;" /></td></tr>`
    : ''
  return (
`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;width:100%;max-width:600px;margin:14px 0;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#ffffff;">
  <tr><td style="padding:0;">
    <a href="${esc(url)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;display:block;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
        ${imgCell}
        <tr><td style="padding:12px 14px;font-family:Arial,Helvetica,sans-serif;">
          ${domain ? `<div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">${esc(domain)}</div>` : ''}
          <div style="font-size:16px;font-weight:700;color:#0f172a;line-height:1.3;">${safeTitle}</div>
          ${safeDesc ? `<div style="font-size:13px;color:#475569;line-height:1.45;margin-top:5px;">${safeDesc}</div>` : ''}
        </td></tr>
      </table>
    </a>
  </td></tr>
</table>`
  )
}

export function insertAtCursor(textareaEl, snippet, currentValue) {
  if (!textareaEl) return (currentValue || '') + snippet
  const start = textareaEl.selectionStart ?? currentValue.length
  const end = textareaEl.selectionEnd ?? currentValue.length
  const next = currentValue.slice(0, start) + snippet + currentValue.slice(end)
  // Move cursor after the inserted snippet on next tick
  requestAnimationFrame(() => {
    try {
      textareaEl.focus()
      const pos = start + snippet.length
      textareaEl.setSelectionRange(pos, pos)
    } catch {}
  })
  return next
}
