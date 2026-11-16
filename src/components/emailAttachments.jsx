// Attaching a real file to an outgoing email.
//
// Different from an MMS photo in every way that matters: there is no upload step and nothing
// is hosted. SendGrid takes attachments inline as base64 in the send request, so the file is
// read in the browser and rides along with the send.
//
// John, 2026-11-16: people reply to the walkthrough drip asking for the checklist, and the
// reply has to carry the PDF without leaving the Hub.
//
// This lives in one place because there are FOUR email composers (the Inbox thread reply,
// the Inbox New Message modal, the client profile, and the Clients list) and three copies of
// a size limit is three limits that drift apart.
import { notify } from '../notify'

export const EMAIL_MAX_FILES = 5
export const EMAIL_MAX_BYTES = 10 * 1024 * 1024
// Deliberately does not offer the types the server refuses (.exe, .js, .ps1 and friends):
// those send "successfully" and are dropped before they reach anyone.
export const EMAIL_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,image/*'

export const mbLabel = (n) => `${(n / 1048576).toFixed(1)} MB`

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).split(',')[1] || '')
  r.onerror = () => reject(new Error(`Could not read ${file.name}`))
  r.readAsDataURL(file)
})

// Returns the accepted attachments, or [] after saying why none came back. Limits are checked
// HERE, while the pick can still be changed, rather than surfacing later as a failed send.
// The server enforces the same limits, because a limit only in the browser is not a limit.
export async function readEmailAttachments(fileList, already = []) {
  const picked = Array.from(fileList || [])
  if (!picked.length) return []
  if (already.length + picked.length > EMAIL_MAX_FILES) {
    notify(`An email can carry ${EMAIL_MAX_FILES} attachments. You already have ${already.length}.`)
    return []
  }
  const total = already.reduce((n, a) => n + (a.bytes || 0), 0) + picked.reduce((n, f) => n + f.size, 0)
  if (total > EMAIL_MAX_BYTES) {
    notify(`Too big to email: ${mbLabel(total)} in total and the limit is 10 MB. Send a link instead.`)
    return []
  }
  try {
    return await Promise.all(picked.map(async (f) => ({
      filename: f.name,
      type: f.type || 'application/octet-stream',
      bytes: f.size,
      content_base64: await fileToBase64(f),
    })))
  } catch (e) { notify(e.message); return [] }
}

// Only the 3 fields the server wants. `bytes` is for the chip and stays in the browser.
export const attachPayload = (list) =>
  (list || []).map(({ filename, type, content_base64 }) => ({ filename, type, content_base64 }))

// What to show on a message that carried a file.
//
// The filenames live in media_url as JSON, written by several paths over several years, so
// a parse failure must never hide the fact that something was attached: the point of this
// is that John can tell at a glance, and "nothing" is the one answer that misleads.
export function attachmentLabel(m) {
  if (!m || !m.has_attachment) return ''
  try {
    const names = JSON.parse(m.media_url || '[]')
      .map(a => (typeof a === 'string' ? a : a?.filename))
      .filter(Boolean)
    return names.length ? names.join(', ') : 'file attached'
  } catch { return 'file attached' }
}

export function FileChip({ item, onRemove }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', fontSize: 14,
      background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6 }}>
      <span>{/pdf/i.test(item.type) ? '📄' : /^image\//i.test(item.type) ? '🖼' : '📎'}</span>
      <span style={{ maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.filename}</span>
      <span style={{ color: 'var(--text-muted)' }}>{mbLabel(item.bytes || 0)}</span>
      <button onClick={onRemove} title="Remove" style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--text-muted)', fontSize: 15, lineHeight: 1 }}>×</button>
    </span>
  )
}

// The whole control: the button, the hidden input and the chips. A composer adds attachments
// with one line, which is the point of putting it here.
export function EmailAttachBar({ files, setFiles, hint = 'PDF or document. Up to 5 files, 10 MB in total.' }) {
  const id = `attach-${Math.random().toString(36).slice(2, 9)}`
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input id={id} type="file" accept={EMAIL_ACCEPT} multiple style={{ display: 'none' }}
          onChange={async e => {
            const got = await readEmailAttachments(e.target.files, files)
            if (got.length) setFiles([...(files || []), ...got])
            e.target.value = ''
          }} />
        <button type="button" className="btn btn-sm btn-secondary"
          disabled={(files || []).length >= EMAIL_MAX_FILES}
          onClick={() => document.getElementById(id)?.click()}>📎 Attach file</button>
        <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>
          {(files || []).length
            ? `${files.length}/${EMAIL_MAX_FILES} attached · ${mbLabel(files.reduce((n, f) => n + (f.bytes || 0), 0))} of 10 MB`
            : hint}
        </span>
      </div>
      {(files || []).length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {files.map((f, i) => (
            <FileChip key={i} item={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}
    </div>
  )
}
