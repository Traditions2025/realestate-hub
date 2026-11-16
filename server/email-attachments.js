// Validation for outgoing email attachments.
//
// Lives on its own because BOTH send routes need it and they cannot import each other:
// routes/inbox.js already imports from routes/email.js, so putting the rule in either one
// makes a cycle. Two copies of a limit is two limits that drift apart, which is the bug this
// file exists to prevent.
//
// SendGrid takes attachments inline as base64 in the send request. The base64 is passed
// STRAIGHT through and must never be written to communications.body: inline base64 in that
// column is what grew the database to 660MB and burned a month of Render bandwidth in
// November 2026. Record filenames, never content.

export const EMAIL_MAX_FILES = 5
export const EMAIL_MAX_BYTES = 10 * 1024 * 1024      // raw bytes, before base64 inflates ~33%

// Types mail providers reject outright. Letting one through produces a send that looks fine
// in the Hub and is silently dropped before it reaches anybody.
const BAD_EXT = /\.(exe|bat|cmd|com|scr|pif|msi|msp|jar|vbs|vbe|js|jse|ps1|sh|lnk|reg)$/i

/**
 * Returns { ok, error }. `ok` is the list SendGrid should receive; `error` is a sentence to
 * show the sender. Never throws, never partially accepts: either every attachment is usable
 * or none are, because a send that quietly drops one file is worse than a refused send.
 */
export function cleanEmailAttachments(raw) {
  const list = Array.isArray(raw) ? raw : []
  if (!list.length) return { ok: [], error: null }
  if (list.length > EMAIL_MAX_FILES) {
    return { ok: [], error: `An email can carry ${EMAIL_MAX_FILES} attachments (this one has ${list.length}).` }
  }
  const ok = []
  let total = 0
  for (const a of list) {
    // A filename reaches a mail header, so strip anything that could break out of one.
    const filename = String(a?.filename || '').replace(/[\r\n"\\]/g, '').trim().slice(0, 120)
    const b64 = String(a?.content_base64 || a?.content || '').replace(/\s+/g, '')
    if (!filename) return { ok: [], error: 'An attachment arrived with no filename.' }
    if (!b64) return { ok: [], error: `${filename} arrived empty.` }
    if (BAD_EXT.test(filename)) {
      return { ok: [], error: `${filename} is a file type email providers block. Zip it, or send a link instead.` }
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: [], error: `${filename} is not valid base64.` }
    total += Math.floor(b64.length * 3 / 4)
    ok.push({
      filename,
      type: String(a?.type || 'application/octet-stream').replace(/[\r\n]/g, '').slice(0, 100),
      content_base64: b64,
      disposition: 'attachment',
    })
  }
  if (total > EMAIL_MAX_BYTES) {
    return { ok: [], error: `Attachments total ${(total / 1048576).toFixed(1)} MB and the limit is 10 MB. Send a link instead.` }
  }
  return { ok, error: null }
}
