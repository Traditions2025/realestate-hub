// Shared logger for FSBO / Cancelled-Expired master-file syncs: every change the
// sync makes to a lead (status change, junked because relisted/pending, new lead,
// removed from the file) is recorded in master_file_updates (dashboard feed) AND
// written as a dated note on the lead profile so the WHY is visible right there.
import db from './database.js'
import { prependNote } from './client-notes.js'

export function logMasterUpdate(clientId, list, change, detail, extra = {}) {
  try {
    const c = db.get('SELECT first_name, last_name, notes FROM clients WHERE id=?', [Number(clientId)])
    const name = c ? `${c.first_name || ''} ${c.last_name || ''}`.trim() : `#${clientId}`
    db.run('INSERT INTO master_file_updates (client_id, client_name, list, change, detail, label, address, dom, url, sub, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [Number(clientId), name, list, change, detail, extra.label || null, extra.address || null, extra.dom != null ? String(extra.dom) : null, extra.url || null, extra.sub || null, new Date().toISOString()])
    // Profile note, newest first. The stamp format lives in client-notes.js so every
    // writer produces the same thing (John, 2026-10-05).
    if (c && !String(c.notes || '').includes(detail)) {
      db.run('UPDATE clients SET notes=? WHERE id=?', [prependNote(c.notes, detail, { by: 'master file' }), Number(clientId)])
    }
  } catch (e) { console.error('[master-file-log]', e.message) }
}
