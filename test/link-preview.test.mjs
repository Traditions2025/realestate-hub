// Link previews in email (John, 2026-10-13: "any link should preview ... so when leads
// receive our email it has image").
//
// Email has no unfurling, so the card must be built into the HTML before sending. These
// tests cover the two things that can go badly wrong with that: a server that fetches
// user-supplied URLs (SSRF), and a card that breaks the copy it was meant to decorate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  isPrivateAddress, parseMeta, buildLinkCardHtml, expandLinksInHtml, linkPreview, clearLinkPreviewCache,
  fitImage, parseDuration,
} from '../server/link-preview.js'

/* ---------- SSRF: the part that must not be wrong ---------- */

test('private, loopback, link-local and CGNAT addresses are refused', () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.169.254',           // cloud metadata, the classic SSRF target
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1',
    '::ffff:10.0.0.1',           // IPv4-mapped IPv6 must be judged on the v4 part
  ]) assert.equal(isPrivateAddress(ip), true, `${ip} must be blocked`)
})

test('ordinary public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '142.250.72.14', '2606:4700::1111'])
    assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`)
})

test('anything that is not an address at all is refused', () => {
  for (const v of ['', null, undefined, 'localhost', 'not-an-ip']) assert.equal(isPrivateAddress(v), true)
})

test('plain http and non-URLs are rejected without a network call', async () => {
  assert.equal((await linkPreview('http://example.com')).ok, false)
  assert.match((await linkPreview('http://example.com')).error, /https/)
  assert.equal((await linkPreview('not a url')).ok, false)
})

test('a private host is refused even when spelled as a URL', async () => {
  for (const u of ['https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data/']) {
    const r = await linkPreview(u)
    assert.equal(r.ok, false)
    assert.match(r.error, /private address/)
  }
})

/* ---------- parsing ---------- */

const DUBB_HTML = `<html><head>
<meta property="og:site_name" content="Dubb" />
<meta property="og:type" content="video.other"/>
<meta property="og:title" content="A Busy Day at the Office: Quick Update"/>
<meta property="og:image:type" content="image/gif"/>
<meta property="og:image:url" content="https://cdn.example.com/x/1790720252_gif_with_play.gif"/>
<meta name="twitter:description" content="Video from Matt Smith" />
</head><body></body></html>`

test('a Dubb page yields the animated GIF, not a static thumbnail', () => {
  const d = parseMeta(DUBB_HTML, 'https://matt-smith-team.dubb.com/v/v1irs4')
  assert.equal(d.title, 'A Busy Day at the Office: Quick Update')
  assert.equal(d.site_name, 'Dubb')
  assert.match(d.image, /\.gif$/)
  assert.equal(d.is_gif, true, 'the GIF is the whole point of a video email')
  assert.match(d.kind, /video/)
})

test('meta tags parse with the attributes in either order', () => {
  const d = parseMeta('<meta content="Reversed" property="og:title">', 'https://x.test/')
  assert.equal(d.title, 'Reversed')
})

test('HTML entities in a title are decoded, not shown raw', () => {
  const d = parseMeta('<meta property="og:title" content="Tom &amp; Jerry&#39;s">', 'https://x.test/')
  assert.equal(d.title, "Tom & Jerry's")
})

test('with no OG tags it falls back to <title> and the hostname', () => {
  const d = parseMeta('<html><head><title>Plain Page</title></head></html>', 'https://www.example.com/a')
  assert.equal(d.title, 'Plain Page')
  assert.equal(d.site_name, 'example.com')
})

/* ---------- the card ---------- */

test('the card is table-based and fully clickable, for Outlook', () => {
  const html = buildLinkCardHtml(parseMeta(DUBB_HTML, 'https://matt-smith-team.dubb.com/v/v1irs4'))
  assert.match(html, /<table role="presentation"/)
  assert.match(html, /<a href="https:\/\/matt-smith-team\.dubb\.com/)
  assert.match(html, /<img src="https:\/\/cdn\.example\.com[^"]+\.gif"/)
  assert.doesNotMatch(html, /<script|onclick=/i, 'no JS may reach an inbox')
})

test('a GIF card gets no play overlay, because the GIF already has one drawn in', () => {
  const html = buildLinkCardHtml(parseMeta(DUBB_HTML, 'https://d.test/v/1'))
  assert.doesNotMatch(html, /position:\s*absolute|<svg|play-overlay/i,
    'Dubb bakes the play button into the GIF; a CSS overlay is the first thing Outlook drops')
})

test('a video card carries a Watch Video button, with the length when it is known', () => {
  const withLen = parseMeta(DUBB_HTML + '<script>{"duration":"PT1M30S"}</script>', 'https://v.test/1')
  assert.match(buildLinkCardHtml(withLen), /Watch Video \(1:30\)/)
  // and degrades to a plain label when the page does not publish a duration
  assert.match(buildLinkCardHtml(parseMeta(DUBB_HTML, 'https://v.test/1')), />Watch Video</)
})

test('a non-video page gets a neutral button, not "Watch Video"', () => {
  const d = parseMeta('<meta property="og:title" content="A blog post"><meta property="og:image" content="https://c.test/a.jpg">', 'https://b.test/p')
  const html = buildLinkCardHtml(d)
  assert.match(html, />Open link</)
  assert.doesNotMatch(html, /Watch Video/)
})

/* ---------- sizing: the bug that made a portrait video swamp the email ---------- */

test('a portrait video is constrained by HEIGHT, not width', () => {
  // 1080x1920 at the old fixed 560 wide rendered 996px tall and swamped the message.
  const fit = fitImage(1080, 1920)
  assert.ok(fit.h <= 300, `portrait height ${fit.h} must be capped`)
  assert.ok(fit.w < 200, `portrait width ${fit.w} follows the aspect`)
  assert.equal(Math.round((fit.w / fit.h) * 100), Math.round((1080 / 1920) * 100), 'aspect preserved')
})

test('a landscape video is constrained by width', () => {
  const fit = fitImage(3342, 1504)
  assert.ok(fit.w <= 340)
  assert.ok(fit.h <= 300)
  assert.equal(Math.round((fit.w / fit.h) * 10), Math.round((3342 / 1504) * 10), 'aspect preserved')
})

test('a small image is never blown UP past its natural size', () => {
  const fit = fitImage(120, 90)
  assert.deepEqual(fit, { w: 120, h: 90 })
})

test('unknown dimensions fall back to a width cap rather than guessing a height', () => {
  const fit = fitImage(null, null)
  assert.equal(fit.h, null)
  assert.ok(fit.w > 0)
})

test('the card writes explicit width and height attributes, because Outlook ignores CSS', () => {
  const d = { ...parseMeta(DUBB_HTML, 'https://d.test/v/1'), image_width: 1080, image_height: 1920 }
  const html = buildLinkCardHtml(d)
  assert.match(html, /<img [^>]*width="169"[^>]*height="300"/, 'computed server-side, not left to CSS')
})

/* ---------- duration ---------- */

test('ISO 8601 durations become M:SS', () => {
  assert.equal(parseDuration('"duration":"PT1M30S"'), '1:30')
  assert.equal(parseDuration('"duration":"PT45S"'), '0:45')
  assert.equal(parseDuration('"duration":"PT1H2M3S"'), '1:02:03')
  assert.equal(parseDuration('no duration here'), '')
  assert.equal(parseDuration('"duration":"PT0S"'), '')
})

test('card text is escaped, so a hostile title cannot inject markup', () => {
  const d = parseMeta('<meta property="og:title" content="&lt;script&gt;alert(1)&lt;/script&gt;">', 'https://x.test/')
  const html = buildLinkCardHtml(d)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})

test('a failed preview builds no card at all', () => {
  assert.equal(buildLinkCardHtml({ ok: false }), null)
  assert.equal(buildLinkCardHtml(null), null)
})

/* ---------- expansion rules ---------- */

const stub = (urls) => {
  // expandLinksInHtml calls linkPreview, which caches. Seed the cache by previewing a data
  // shape directly is not possible, so these tests use the offline rules only.
  return urls
}

test('a body with no links is returned untouched and makes no network call', async () => {
  const body = '<p>No links here at all.</p>'
  assert.equal(await expandLinksInHtml(body), body)
})

test('a URL already inside an href is left alone', async () => {
  const body = '<a href="https://matt-smith-team.dubb.com/v/v1irs4">watch</a>'
  const out = await expandLinksInHtml(body)
  assert.equal(out, body, 'an existing link must not be rewritten or doubled')
})

test('a URL inside an img src is left alone', async () => {
  const body = '<img src="https://cdn.test/a.gif">'
  assert.equal(await expandLinksInHtml(body), body)
})

test('trailing punctuation is not swallowed into the link', async () => {
  const out = await expandLinksInHtml('See https://example.com/page. Thanks')
  assert.match(out, /href="https:\/\/example\.com\/page"/, 'the full stop belongs to the sentence')
})

/* ---------- the live Dubb link, the actual thing asked for ---------- */

test('the real Dubb link produces one card carrying the animated GIF', async (t) => {
  clearLinkPreviewCache()
  const d = await linkPreview('https://matt-smith-team.dubb.com/v/v1irs4')
  if (!d.ok) return t.skip(`network unavailable: ${d.error}`)
  assert.equal(d.is_gif, true)
  assert.match(d.image, /\.gif/)

  const body = "Hey it's Matt Smith with RE/MAX Concepts. I made a quick video, as I thought it "
    + "might be easier than texting it all out. Looking forward to hearing back from you!  "
    + 'https://matt-smith-team.dubb.com/v/v1irs4'
  const out = await expandLinksInHtml(body)
  assert.equal((out.match(/<img /g) || []).length, 1, 'exactly one preview image')
  assert.match(out, /\.gif/, 'and it is the GIF')
  assert.match(out, /Hey it's Matt Smith/, 'the copy survives')
})

test('a mid-sentence link stays inline and its card is appended, so no sentence is broken', async (t) => {
  const d = await linkPreview('https://matt-smith-team.dubb.com/v/v1irs4')
  if (!d.ok) return t.skip('network unavailable')
  const out = await expandLinksInHtml('Watch https://matt-smith-team.dubb.com/v/v1irs4 and tell me.')
  assert.match(out, /Watch <a href[^>]+>https:\/\/matt-smith-team[^<]*<\/a> and tell me\./,
    'the sentence must read normally')
  assert.equal((out.match(/<img /g) || []).length, 1, 'the card still appears, after the body')
  assert.ok(out.indexOf('and tell me.') < out.lastIndexOf('<table'), 'card comes after the copy')
})

test('the same link twice yields one card, not two', async (t) => {
  const d = await linkPreview('https://matt-smith-team.dubb.com/v/v1irs4')
  if (!d.ok) return t.skip('network unavailable')
  const u = 'https://matt-smith-team.dubb.com/v/v1irs4'
  const out = await expandLinksInHtml(`${u} and again ${u}`)
  assert.equal((out.match(/<img /g) || []).length, 1)
})

/* ---------- wiring ---------- */

test('the send pipeline expands links, so the LEAD receives the image', () => {
  const src = fs.readFileSync(new URL('../server/routes/email.js', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export async function sendViaSendGrid'))
  assert.match(fn.slice(0, 3000), /expandLinksInHtml/,
    'without this the preview shows a card and the recipient gets a bare URL')
})

test('there is exactly ONE /preview route', () => {
  const src = fs.readFileSync(new URL('../server/routes/email.js', import.meta.url), 'utf8')
  const defs = (src.match(/^router\.post\('\/preview'/gm) || []).length
  assert.equal(defs, 1, 'a duplicate route is dead code: Express only ever matches the first')
})

test('the live /preview route applies the same pipeline as the send path', () => {
  const src = fs.readFileSync(new URL('../server/routes/email.js', import.meta.url), 'utf8')
  const i = src.indexOf("router.post('/preview'")
  const route = src.slice(i, i + 1400)
  assert.match(route, /autoEmbedYoutubeLinks/)
  assert.match(route, /expandLinksInHtml/)
})

/* ---------- placement: the card must sit with its sentence ---------- */

test('a card lands with its paragraph, NOT after the signature', async (t) => {
  const d = await linkPreview('https://matt-smith-team.dubb.com/v/tA6G02')
  if (!d.ok) return t.skip('network unavailable')
  // The real shape: copy, link, <br><br>, then the signature block. The first version tested
  // the next 40 chars against a whitelist of CLOSING tags, so an opening <div> for the
  // signature made it look mid-sentence and the card was dumped at the very bottom.
  const body = 'Looking forward to hearing back from you!  '
    + 'https://matt-smith-team.dubb.com/v/tA6G02<br><br><div class="sig">Matt Smith</div>'
  const out = await expandLinksInHtml(body)
  const card = out.indexOf('<table role')
  const sig = out.indexOf('class="sig"')
  assert.ok(card > -1, 'a card should be built')
  assert.ok(card < sig, 'the card belongs above the signature, next to the copy it illustrates')
})

/* ---------- the plain-text ordering bug ---------- */
// Shipped 2026-10-13: /preview ran plainToHtml AFTER appending the signature. The signature
// is already HTML, so it came out escaped as visible "&lt;br&gt;", and because the escaped
// text ran straight on from the URL with no whitespace, the link matcher swallowed it into
// the href and produced nested <a> tags. HTML bodies were unaffected, which is exactly why
// the composer looked fine while the API was broken.
test('/preview converts a plain-text body to HTML BEFORE appending the signature', () => {
  const src = fs.readFileSync(new URL('../server/routes/email.js', import.meta.url), 'utf8')
  const i = src.indexOf("router.post('/preview'")
  const route = src.slice(i, i + 1600)
  const toHtml = route.indexOf('plainToHtml')
  const sig = route.indexOf('{{signature}}')
  assert.ok(toHtml > -1 && sig > -1, 'both steps must be present')
  assert.ok(toHtml < sig, 'plainToHtml must run before the signature is appended, never after')
})

test('a URL followed by HTML does not swallow that HTML into its href', async () => {
  // The exact shape that broke: URL, then markup, with no space between them.
  const out = await expandLinksInHtml('See https://example.com/x<br><div>Matt</div>')
  const hrefs = [...out.matchAll(/href="([^"]*)"/g)].map(m => m[1])
  for (const h of hrefs) {
    assert.doesNotMatch(h, /&lt;|<br|<div/i, `href swallowed markup: ${h}`)
  }
  assert.doesNotMatch(out, /<a[^>]*>\s*<a/i, 'no nested anchors')
})
