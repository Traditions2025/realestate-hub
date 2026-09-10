// My Profile — the authenticated HUB user's own account page (/profile).
// Not to be confused with a lead's Client Profile. Self-service only: photo,
// display name, phone. Email + role stay admin-managed in Settings → Team & Users.
import React, { useState, useEffect, useRef } from 'react'
import { authFetch } from '../api'

export const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', agent: 'Agent', transaction_coordinator: 'TC', isa: 'ISA', marketing: 'Marketing', read_only: 'Read Only' }
export const initialsOf = (name) => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'

// Square-crop + resize a picked image to a 256px JPEG data URI so we never store
// or serve multi-megabyte originals. Center-crop keeps portraits/landscapes clean.
function processImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return reject(new Error('Use a JPG, PNG, or WEBP photo.'))
    if (file.size > 15 * 1024 * 1024) return reject(new Error('Photo is too large (max 15MB).'))
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const S = 256
        const side = Math.min(img.naturalWidth, img.naturalHeight)
        const sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2
        const canvas = document.createElement('canvas')
        canvas.width = S; canvas.height = S
        const ctx = canvas.getContext('2d')
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, sx, sy, side, side, 0, 0, S, S)
        URL.revokeObjectURL(url)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      } catch (e) { URL.revokeObjectURL(url); reject(new Error('Could not process that image.')) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')) }
    img.src = url
  })
}

export default function Profile() {
  const [me, setMe] = useState(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef(null)

  const load = () => authFetch('/api/users/me').then(r => r.json()).then(d => {
    if (d && d.id) { setMe(d); setName(d.name || ''); setPhone(d.phone || '') }
  }).catch(() => {})
  useEffect(() => { load() }, [])

  const notifyHeader = () => window.dispatchEvent(new Event('mst-me-changed'))

  const save = async () => {
    setSaving(true); setErr('')
    try {
      const r = await authFetch('/api/users/me', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, phone }) })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Save failed')
      setSaved(true); setTimeout(() => setSaved(false), 2500)
      load(); notifyHeader()
    } catch (e) { setErr(e.message) } finally { setSaving(false) }
  }

  const pickPhoto = () => fileRef.current && fileRef.current.click()
  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setPhotoBusy(true); setErr('')
    try {
      const data = await processImage(file)
      const r = await authFetch('/api/users/me/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Upload failed')
      await load(); notifyHeader()
    } catch (e2) { setErr(e2.message || 'Unable to upload photo. Please try again.') } finally { setPhotoBusy(false) }
  }
  const removePhoto = async () => {
    if (!confirm('Remove your profile photo?')) return
    setPhotoBusy(true); setErr('')
    try {
      await authFetch('/api/users/me/avatar', { method: 'DELETE' })
      await load(); notifyHeader()
    } catch (e) { setErr('Could not remove the photo.') } finally { setPhotoBusy(false) }
  }

  const fld = { padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, width: '100%' }

  if (!me) return <div className="page"><div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading profile…</div></div>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>My Profile</h1>
          <p className="page-subtitle">Your HUB account — photo, name, and contact info.</p>
        </div>
      </div>

      <div className="profile-card">
        <div className="profile-photo-row">
          <div className="profile-photo-lg" aria-hidden={!me.avatar}>
            {me.avatar
              ? <img src={me.avatar} alt={`${me.name} profile photo`} />
              : <span className="profile-initials-lg">{initialsOf(me.name)}</span>}
          </div>
          <div className="profile-photo-actions">
            <div style={{ fontWeight: 700, fontSize: 15 }}>{me.name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{ROLE_LABELS[me.role] || me.role} · {me.email}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-secondary btn-sm" onClick={pickPhoto} disabled={photoBusy}>
                {photoBusy ? 'Working…' : me.avatar ? 'Change Photo' : 'Upload Photo'}
              </button>
              {me.avatar && <button className="btn btn-sm" onClick={removePhoto} disabled={photoBusy} style={{ color: '#ef4444' }}>Remove Photo</button>}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>JPG, PNG, or WEBP. It's cropped to a square automatically.</div>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={onFile} style={{ display: 'none' }} aria-label="Choose a profile photo" />
          </div>
        </div>

        {err && <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, background: 'rgba(239,68,68,.1)', color: '#ef4444', fontSize: 13 }}>{err}</div>}

        <div className="profile-fields">
          <label>
            <span>Name</span>
            <input value={name} onChange={e => setName(e.target.value)} style={fld} />
          </label>
          <label>
            <span>Phone</span>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(319) 555-0100" style={fld} />
          </label>
          <label>
            <span>Email</span>
            <input value={me.email} disabled title="Your login email is managed in Settings → Team & Users" style={{ ...fld, opacity: 0.65, cursor: 'not-allowed' }} />
          </label>
          <label>
            <span>Role</span>
            <input value={ROLE_LABELS[me.role] || me.role} disabled title="Roles are managed in Settings → Team & Users" style={{ ...fld, opacity: 0.65, cursor: 'not-allowed' }} />
          </label>
        </div>

        <div style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving || !name.trim()}>{saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Changes'}</button>
        </div>
      </div>
    </div>
  )
}
