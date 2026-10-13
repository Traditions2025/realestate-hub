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
  assert.doesNotMatch(html, /Watch the video/, 'Dubb bakes the play button into the GIF')
})

test('a video page WITHOUT a gif says so in text rather than a CSS overlay', () => {
  const d = parseMeta(`<meta property="og:type" content="video">
    <meta property="og:title" content="X"><meta property="og:image" content="https://c.test/t.jpg">`, 'https://v.test/1')
  assert.match(buildLinkCardHtml(d), /Watch the video/)
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
