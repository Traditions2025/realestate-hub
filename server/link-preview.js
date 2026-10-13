// Link previews for the email composer.
//
// Email has no unfurling. Slack and iMessage fetch a page and build a card for you; no mail
// client ever will. So if a pasted link is going to look like anything, the card has to be
// built into the HTML before the message is sent. That is all this module does.
//
// John, 2026-10-13: "any link should preview in the email composer in clients it should also
// work with using copy for email with GIF preview", with a Dubb video link as the example.
// Dubb publishes `og:image:type: image/gif` and a GIF with the play button already drawn on
// it, so a plain Open Graph reader gets the animated preview for free — no Dubb-specific code,
// and the same path covers Vimeo, Loom, blog posts and anything else with OG tags.
//
// SECURITY. This fetches URLs that a user typed, from the server, which is textbook SSRF
// territory: without guards someone could preview `http://169.254.169.254/` and read cloud
// metadata, or probe the private network Render sits in. Hence: https only, DNS resolved and
// every resulting address checked against private ranges BEFORE connecting, redirects followed
// manually with the same check each hop, a short timeout, and a byte cap so a huge response
// cannot be used to exhaust memory.
import dns from 'node:dns/promises'
import net from 'node:net'

const TIMEOUT_MS = 8000
const MAX_BYTES = 512 * 1024      // meta tags live in the <head>; 512 KB is generous
const MAX_REDIRECTS = 3
const CACHE_TTL_MS = 24 * 3600 * 1000
const UA = 'Mozilla/5.0 (compatible; MattSmithTeamHub/1.0; +https://www.mattsmithteam.com)'

const cache = new Map()   // url -> { at, data }

/** Private, loopback, link-local and CGNAT ranges that a server must never be talked into fetching. */
export function isPrivateAddress(ip) {
  if (!ip) return true
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number)
    if (p[0] === 10) return true
    if (p[0] === 127) return true
    if (p[0] === 0) return true
    if (p[0] === 169 && p[1] === 254) return true            // link-local, incl. cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
    if (p[0] === 192 && p[1] === 168) return true
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true // CGNAT
    if (p[0] >= 224) return true                              // multicast + reserved
    return false
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase()
    if (s === '::1' || s === '::') return true
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true
    // IPv4-mapped (::ffff:10.0.0.1) must be judged on the embedded v4 address
    const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (m) return isPrivateAddress(m[1])
    return false
  }
  return true   // not an IP we understand: refuse
}

/** Resolve a hostname and refuse if ANY address is private. */
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('refusing to fetch a private address')
    return
  }
  let addrs
  try { addrs = await dns.lookup(hostname, { all: true }) }
  catch { throw new Error(`cannot resolve ${hostname}`) }
  if (!addrs.length) throw new Error(`cannot resolve ${hostname}`)
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new Error('refusing to fetch a private address')
}

/** Fetch HTML with redirects checked at every hop and a hard byte cap. */
async function fetchHtml(startUrl) {
  let url = startUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(url)
    if (u.protocol !== 'https:') throw new Error('only https links can be previewed')
    await assertPublicHost(u.hostname)

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    let res
    try {
      res = await fetch(u.toString(), {
        redirect: 'manual', signal: ac.signal,
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      })
    } finally { clearTimeout(timer) }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error(`redirect with no location (HTTP ${res.status})`)
      url = new URL(loc, u).toString()
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (!ct.includes('html')) throw new Error(`not a web page (${ct.split(';')[0] || 'unknown type'})`)

    // Read with a cap rather than res.text(), so a huge page cannot be used to exhaust memory.
    const reader = res.body?.getReader()
    if (!reader) return { html: await res.text(), finalUrl: u.toString() }
    const chunks = []
    let total = 0
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value); total += value.length
    }
    try { await reader.cancel() } catch {}
    return { html: Buffer.concat(chunks).toString('utf8'), finalUrl: u.toString() }
  }
  throw new Error('too many redirects')
}

const decodeEntities = (s) => String(s || '')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')

/** Pull one meta value, accepting property= or name= in either attribute order. */
function meta(html, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${k}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${k}["']`, 'i'),
  ]
  for (const re of patterns) { const m = re.exec(html); if (m) return decodeEntities(m[1]).trim() }
  return ''
}

/** Parse the Open Graph / Twitter card data an email preview needs. */
export function parseMeta(html, finalUrl) {
  const title = meta(html, 'og:title') || meta(html, 'twitter:title') ||
    decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '').trim()
  const image = meta(html, 'og:image:secure_url') || meta(html, 'og:image:url') ||
    meta(html, 'og:image') || meta(html, 'twitter:image')
  const imageType = meta(html, 'og:image:type')
  const w = Number(meta(html, 'og:image:width')) || null
  const h = Number(meta(html, 'og:image:height')) || null
  let site = meta(html, 'og:site_name')
  if (!site) { try { site = new URL(finalUrl).hostname.replace(/^www\./, '') } catch { site = '' } }
  return {
    url: meta(html, 'og:url') || finalUrl,
    title: title.slice(0, 160),
    description: (meta(html, 'og:description') || meta(html, 'twitter:description') || '').slice(0, 300),
    image: image || '',
    // A GIF is the thing that makes a Dubb-style video email work, so it is called out
    // explicitly rather than left for the caller to sniff from the file extension.
    is_gif: /gif/i.test(imageType) || /\.gif(\?|$)/i.test(image || ''),
    image_width: w, image_height: h,
    site_name: site,
    kind: meta(html, 'og:type') || '',
    duration: parseDuration(html),
  }
}

/**
 * Video length, for the "Watch Video (1:30)" button Dubb shows on its own card.
 * Dubb publishes it as JSON-LD ISO 8601, e.g. "duration":"PT1M30S". Not an OG tag, so it is
 * read from the page body. Returns "M:SS" or "H:MM:SS", or '' when absent.
 */
export function parseDuration(html) {
  const m = /"duration"\s*:\s*"(PT[^"]+)"/i.exec(String(html || ''))
  if (!m) return ''
  const iso = m[1]
  const h = Number((/(\d+)H/i.exec(iso) || [])[1] || 0)
  const mi = Number((/(\d+)M/i.exec(iso) || [])[1] || 0)
  const s = Math.round(Number((/([\d.]+)S/i.exec(iso) || [])[1] || 0))
  const total = h * 3600 + mi * 60 + s
  if (!total) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(mi)}:${pad(s)}` : `${mi}:${pad(s)}`
}

/** Fetch + parse one URL, cached. Never throws: returns { ok:false, error } instead. */
export async function linkPreview(rawUrl, { force = false } = {}) {
  let key
  try { key = new URL(String(rawUrl)).toString() } catch { return { ok: false, url: rawUrl, error: 'not a valid URL' } }

  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.data, cached: true }

  try {
    const { html, finalUrl } = await fetchHtml(key)
    const data = { ok: true, ...parseMeta(html, finalUrl) }
    if (!data.title && !data.image) {
      const bare = { ok: false, url: key, error: 'no preview data on that page' }
      cache.set(key, { at: Date.now(), data: bare })
      return bare
    }
    cache.set(key, { at: Date.now(), data })
    return data
  } catch (e) {
    const err = { ok: false, url: key, error: e.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : e.message }
    // Cache failures briefly too, so a dead link does not slow the composer on every keystroke.
    cache.set(key, { at: Date.now() - (CACHE_TTL_MS - 5 * 60000), data: err })
    return err
  }
}

export function clearLinkPreviewCache() { cache.clear() }

/* ---------------------------------------------------------------------------
   Card HTML
   --------------------------------------------------------------------------- */

const esc = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The card is sized by the IMAGE's own aspect, not by a fixed width. A 560px-wide card is
// fine for a landscape thumbnail and absurd for a portrait one: Matt's phone videos are
// 1080x1920, which at 560 wide renders 996px tall and swamps the email (John, 2026-10-13:
// "preview is too big it needs to be resized"). Constraining BOTH dimensions fixes it for
// every shape. Explicit width/height attributes are computed server-side because Outlook
// ignores CSS max-height on images.
const CARD_MAX_W = 340
const CARD_MAX_H = 300

export function fitImage(w, h, maxW = CARD_MAX_W, maxH = CARD_MAX_H) {
  if (!w || !h) return { w: maxW, h: null }           // unknown: fall back to width only
  const scale = Math.min(maxW / w, maxH / h, 1)
  return { w: Math.round(w * scale), h: Math.round(h * scale) }
}

/**
 * An email-safe preview card, laid out like Dubb's own: title above the thumbnail, the
 * thumbnail, then a "Watch Video (1:30)" button. Table-based for Outlook, no JS, no CSS
 * overlay (the first thing Outlook drops), whole card clickable.
 *
 * A Dubb GIF already has a play button drawn into it, so none is added on top.
 */
export function buildLinkCardHtml(d, { maxWidth = CARD_MAX_W, maxHeight = CARD_MAX_H } = {}) {
  // Reject an explicit failure, and reject data with nothing worth showing. Requiring a
  // truthy `ok` instead would refuse the output of parseMeta(), which is perfectly good data.
  if (!d || d.ok === false) return null
  if (!d.title && !d.image) return null
  const isVideo = /video/i.test(d.kind || '')
  const fit = fitImage(d.image_width, d.image_height, maxWidth, maxHeight)
  const cardW = Math.max(fit.w, 240)
  const alt = d.is_gif ? 'Animated preview of the video. Click to watch.'
    : (isVideo ? 'Video preview. Click to watch.' : (d.title || 'Link preview'))
  const cta = isVideo ? `Watch Video${d.duration ? ` (${esc(d.duration)})` : ''}` : 'Open link'
  const img = d.image
    ? `<img src="${esc(d.image)}" alt="${esc(alt)}" width="${fit.w}"${fit.h ? ` height="${fit.h}"` : ''} style="display:block;width:${fit.w}px;max-width:100%;${fit.h ? `height:${fit.h}px;` : 'height:auto;'}border:0;margin:0 auto;" />`
    : ''
  return (
`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0;border-collapse:collapse;width:${cardW}px;max-width:100%;border:1px solid #e3e6ea;background:#ffffff;">
  <tr><td style="padding:12px 12px 10px;">
    <a href="${esc(d.url)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;display:block;">
      ${d.title ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:1.3;color:#1a2330;padding-bottom:9px;">${esc(d.title)}</div>` : ''}
      ${img}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:11px auto 2px;"><tr>
        <td style="border:1px solid #B08930;padding:8px 18px;text-align:center;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#B08930;">${esc(cta)}</span>
        </td>
      </tr></table>
    </a>
  </td></tr>
</table>`
  )
}

/* ---------------------------------------------------------------------------
   Expanding bare links in a body
   --------------------------------------------------------------------------- */

// A bare http(s) URL, not already inside a tag.
const URL_RE = /(https?:\/\/[^\s<>"']+)/gi
const MAX_CARDS = 5

/** Is this URL already inside an <a> or a src/href attribute? */
function insideMarkup(full, offset) {
  const before = full.slice(Math.max(0, offset - 200), offset)
  if (/<a\b[^>]*$/i.test(before)) return true
  if (/(href|src)\s*=\s*["'][^"']*$/i.test(before)) return true
  const lastOpen = before.lastIndexOf('<')
  const lastClose = before.lastIndexOf('>')
  if (lastOpen > lastClose) return true        // sitting inside a tag
  return false
}

/**
 * Replace bare links with preview cards.
 *
 * John, 2026-10-13: "this should apply to any links it should preview on email and not just
 * pure html link so when leads receive our email it has image". So EVERY link gets a card,
 * not only the ones sitting at the end of a line.
 *
 * The one thing that must not happen is a block-level card dropped into the middle of a
 * sentence, which breaks the sentence. So:
 *   - a URL at the END of its line is replaced in place by the card (the video-email shape)
 *   - a URL mid-sentence stays an inline hyperlink AND its card is appended after the body
 * Either way the link previews and the recipient gets the image.
 *
 * Identical URLs are previewed once. `max` caps the cards, not the links.
 */
export async function expandLinksInHtml(html, { max = MAX_CARDS } = {}) {
  if (!html || !/https?:\/\//i.test(html)) return html
  const found = []
  String(html).replace(URL_RE, (m, url, offset, full) => {
    if (!insideMarkup(full, offset)) found.push({ url: url.replace(/[.,;:!?)\]]+$/, ''), offset, raw: url })
    return m
  })
  if (!found.length) return html

  // Is the URL the last VISIBLE thing on its line?
  //
  // The first version tested the next 40 characters against a whitelist of closing tags, so
  // "…from you! <URL><br><br><div>signature" failed (an OPENING <div> is not in the list) and
  // the card was treated as mid-sentence and appended right at the bottom — under the
  // signature, nowhere near the sentence it belonged to (John, 2026-10-13: "the video was not
  // positioned next to the actual text").
  //
  // The correct question is simply whether any visible text follows before the line ends. So:
  // take everything up to the next line break or block boundary, strip tags, and see if
  // anything is left.
  const endsLine = (full, after) => {
    const rest = full.slice(after)
    const stop = rest.search(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/td>|\n/i)
    const seg = stop === -1 ? rest : rest.slice(0, stop)
    return seg.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === ''
  }

  const unique = [...new Set(found.map(f => f.url))].slice(0, max)
  const results = await Promise.all(unique.map(u => linkPreview(u)))
  const byUrl = new Map(unique.map((u, i) => [u, results[i]]))

  let out = '', cursor = 0
  const trailing = []           // cards for mid-sentence links, appended after the body
  const placed = new Set()      // a URL repeated in one email gets one card, not three
  for (const f of found) {
    out += html.slice(cursor, f.offset)
    const data = byUrl.get(f.url)
    const usable = data && data.ok && !placed.has(f.url)
    const card = usable ? buildLinkCardHtml(data) : null
    if (card && endsLine(html, f.offset + f.raw.length)) {
      out += card
      placed.add(f.url)
    } else {
      out += `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.raw)}</a>`
      if (card) { trailing.push(card); placed.add(f.url) }
    }
    cursor = f.offset + f.raw.length
  }
  out += html.slice(cursor)
  if (trailing.length) out += trailing.join('')
  return out
}
