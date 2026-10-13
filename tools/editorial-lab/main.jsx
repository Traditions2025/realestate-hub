// Editorial Lab UI: pick or create a listing, edit its property details, and use the same
// EditorialStudio + EditorialLibrary components the Hub's Marketing tab uses.
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Toaster } from 'sonner'
import { authFetch } from '../../src/api'
import { notify, ConfirmHost } from '../../src/notify'
import EditorialStudio from '../../src/components/EditorialStudio'
import EditorialLibrary from '../../src/components/EditorialLibrary'
import PropertyDossier from '../../src/components/PropertyDossier'
import '../../src/styles/app.css'
import './lab.css'

const j = async (url, opts) => {
  const r = await authFetch(url, opts)
  const d = await r.json().catch(() => ({}))
  if (!r.ok || d?.error) throw new Error(d?.error || `HTTP ${r.status}`)
  return d
}

const FIELDS = [
  ['property_address', 'Street address'], ['city', 'City'], ['property_type', 'Property type'], ['list_price', 'List price', 'number'],
  ['bedrooms', 'Bedrooms', 'number'], ['bathrooms_full', 'Full baths', 'number'], ['bathrooms_half', 'Half baths', 'number'],
  ['square_feet', 'Finished sq ft', 'number'], ['lot_size', 'Lot size'], ['year_built', 'Year built', 'number'],
  ['garage_spaces', 'Garage spaces', 'number'], ['stories', 'Stories', 'number'], ['basement', 'Basement'],
  ['heating', 'Heating'], ['cooling', 'Cooling'], ['flooring', 'Flooring'], ['schools', 'Schools'],
  ['hoa_fee', 'HOA fee', 'number'], ['hoa_frequency', 'HOA frequency'], ['taxes', 'Annual taxes', 'number'],
]

function KeyBanner({ onSaved }) {
  const [key, setKey] = useState('')
  const save = async () => {
    try { await j('/lab/key', { method: 'POST', body: JSON.stringify({ key }) }); setKey(''); notify('API key saved on this PC.'); onSaved() } catch (e) { notify(e.message) }
  }
  return (
    <div className="lab-key">
      <strong>Connect the Anthropic API key to generate copy.</strong>
      <span className="muted"> Same key the Hub uses (Render dashboard, realestate-hub service, Environment, ANTHROPIC_API_KEY). It is saved only in realestate-hub/tmp/editorial-lab/config.json on this PC.</span>
      <div className="lab-row">
        <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="sk-ant-…" />
        <button className="btn btn-primary" disabled={!key.trim()} onClick={save}>Save key</button>
      </div>
    </div>
  )
}

const MARK = { pending: '○', running: '◌', done: '✓', missed: '–', failed: '✗' }
function JobProgress({ job }) {
  const [open, setOpen] = useState(true)
  const research = job.steps.filter(s => !s.channel)
  const writing = job.steps.filter(s => s.channel)
  const doneCount = writing.filter(s => s.status === 'done').length
  return (
    <div className="lab-job">
      <div className="lab-job-head" onClick={() => setOpen(o => !o)}>
        <strong>{job.status === 'running' ? 'Working on' : job.status === 'failed' ? 'Stopped:' : 'Finished'} {job.found?.address || job.address}</strong>
        <span className="muted">{writing.length ? `${doneCount} of ${writing.length} pieces written` : ''} {open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="lab-job-cols">
          <div><div className="muted">Research</div>{research.map(s => <div key={s.key} className={`lab-step ${s.status}`}>{MARK[s.status] || '○'} {s.label}{s.detail ? <span className="muted"> · {s.detail}</span> : null}</div>)}</div>
          <div><div className="muted">Writing</div>{writing.map(s => <div key={s.key} className={`lab-step ${s.status}`}>{MARK[s.status] || '○'} {s.label}{s.detail ? <span className="muted"> · {s.detail}</span> : null}</div>)}</div>
        </div>
      )}
      {job.error && <div className="ed-error">{job.error}</div>}
    </div>
  )
}

function Lab() {
  const [status, setStatus] = useState(null)
  const [listings, setListings] = useState([])
  const [search, setSearch] = useState('')
  const [id, setId] = useState(null)
  const [form, setForm] = useState(null)
  const [featuresText, setFeaturesText] = useState('')
  const [libOpen, setLibOpen] = useState(false)
  const [addr, setAddr] = useState('')
  const [job, setJob] = useState(null)
  const [initialRun, setInitialRun] = useState(null)
  const pollRef = React.useRef(null)
  const doneRef = React.useRef(new Set())
  const openRef = React.useRef(null)

  const loadStatus = () => j('/lab/status').then(setStatus).catch(e => notify(e.message))
  const loadListings = () => j('/api/listings' + (search ? `?search=${encodeURIComponent(search)}` : '')).then(setListings).catch(e => notify(e.message))
  useEffect(() => { loadStatus() }, [])
  useEffect(() => { const t = setTimeout(loadListings, 250); return () => clearTimeout(t) }, [search])

  const open = async (lid, run = null) => {
    const r = await j(`/api/listings/${lid}`)
    setForm(r); setFeaturesText((r.features || []).join(', ')); setId(lid)
    setInitialRun(run); openRef.current = lid
  }

  // Pull in what the job wrote without clobbering anything typed on screen.
  const refreshFromServer = async (lid) => {
    const r = await j(`/api/listings/${lid}`)
    setForm(prev => {
      if (!prev || prev.id !== r.id) return prev
      const next = { ...prev }
      for (const [k, v] of Object.entries(r)) {
        if (k.startsWith('marketing_') || prev[k] === null || prev[k] === undefined || prev[k] === '') next[k] = v
      }
      return next
    })
    setFeaturesText(t => t || (r.features || []).join(', '))
  }

  const poll = (jobId) => {
    j(`/api/editorial/jobs/${jobId}`).then(async jb => {
      setJob(jb)
      if (jb.listing_id && jb.runs?.mls && openRef.current !== jb.listing_id) {
        await loadListings(); await open(jb.listing_id, { id: jb.runs.mls, channel: 'mls' })
      }
      const newlyDone = jb.steps.filter(s => s.channel && s.status === 'done' && !doneRef.current.has(s.key))
      if (newlyDone.length && jb.listing_id) { newlyDone.forEach(s => doneRef.current.add(s.key)); refreshFromServer(jb.listing_id) }
      if (jb.status === 'running') pollRef.current = setTimeout(() => poll(jobId), 1500)
      else { loadListings(); if (jb.listing_id) refreshFromServer(jb.listing_id); if (jb.status === 'failed') notify(jb.error || 'Something went wrong') }
    }).catch(e => notify(e.message))
  }
  useEffect(() => () => clearTimeout(pollRef.current), [])

  // One address in: research everything, then write. scope 'mls' or 'package'.
  const start = async (scope) => {
    if (!addr.trim()) return
    if (!status?.configured) { notify('Save the API key first.'); return }
    clearTimeout(pollRef.current); doneRef.current = new Set(); openRef.current = null
    setForm(null); setId(null); setInitialRun(null)
    try {
      const { job_id } = await j('/api/editorial/start', { method: 'POST', body: JSON.stringify({ address: addr, scope }) })
      setJob({ id: job_id, status: 'running', steps: [], address: addr })
      setAddr('')
      poll(job_id)
    } catch (err) { notify(err.message) }
  }
  const working = job?.status === 'running'

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const payload = () => {
    const p = { ...form, features: featuresText.split(',').map(s => s.trim()).filter(Boolean) }
    for (const k of Object.keys(p)) if (p[k] === '') p[k] = null
    return p
  }
  const saveQuiet = async () => { await j(`/api/listings/${id}`, { method: 'PUT', body: JSON.stringify(payload()) }) }
  const save = async () => { try { await saveQuiet(); notify('Listing saved.'); loadListings() } catch (e) { notify(e.message) } }

  const loadFixture = async (fid) => {
    if (!fid) return
    try { const { id: nid } = await j(`/lab/fixtures/${fid}`, { method: 'POST' }); await loadListings(); open(nid) } catch (e) { notify(e.message) }
  }
  const newListing = async () => {
    try { const { id: nid } = await j('/api/listings', { method: 'POST', body: JSON.stringify({ property_address: 'New test listing', city: 'Cedar Rapids', notes: 'Editorial Lab test' }) }); await loadListings(); open(nid) } catch (e) { notify(e.message) }
  }

  return (
    <div className="lab">
      <header className="lab-head">
        <div>
          <h1>Editorial Lab</h1>
          <div className="muted">Runs on this PC against a copy of the Hub database. Nothing here is published, sent or synced.</div>
        </div>
        <div className="lab-row">
          {status && <span className="muted">Model: {status.model}</span>}
          <button className="btn btn-secondary" onClick={() => setLibOpen(true)}>Library and rules</button>
        </div>
      </header>

      {status && !status.configured && <KeyBanner onSaved={loadStatus} />}

      <form className="lab-start" onSubmit={e => { e.preventDefault(); start('package') }}>
        <input value={addr} onChange={e => setAddr(e.target.value)} disabled={working} autoFocus
          placeholder="Type a property address, e.g. 4521 Example Dr NE, Cedar Rapids" />
        <button type="submit" className="btn btn-primary" disabled={working || !addr.trim()}>Full marketing package</button>
        <button type="button" className="btn btn-secondary" disabled={working || !addr.trim()} onClick={() => start('mls')}>MLS remarks only</button>
      </form>
      <div className="lab-finding muted">It checks the assessor, your Listings and other team folders (private files like CMAs, offers and strategy are never opened), the listing photos and public listing sites, then writes.</div>

      <div className="lab-body">
        <aside className="lab-side">
          <input className="lab-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search address, city or MLS #" />
          <div className="lab-list">
            {!listings.length && <div className="muted">No listings yet. Load a test property or create one.</div>}
            {listings.map(l => (
              <button key={l.id} className={`lab-item ${l.id === id ? 'on' : ''}`} onClick={() => open(l.id)}>
                <div>{l.property_address}</div>
                <div className="muted">{[l.city, l.stage, l.marketing_listing_description ? 'has MLS copy' : null].filter(Boolean).join(' · ')}</div>
              </button>
            ))}
          </div>
          <div className="lab-other">
            <div className="muted">Other ways to start</div>
            <select defaultValue="" onChange={e => { loadFixture(e.target.value); e.target.value = '' }}>
              <option value="">Load a sample property…</option>
              {(status?.fixtures || []).map(f => <option key={f.id} value={f.id}>{f.title}</option>)}
            </select>
            <button className="btn btn-secondary" onClick={newListing}>Blank listing (type details by hand)</button>
          </div>
        </aside>

        <main className="lab-main">
          {job && <JobProgress job={job} />}
          {!form && !job && <div className="muted lab-empty">Type an address above and press Full marketing package (everything) or MLS remarks only. Or pick a listing on the left.</div>}
          {form && (
            <>
              <PropertyDossier value={form.marketing_dossier} onChange={v => setField('marketing_dossier', v)} />
              <details className="asset-card lab-details">
                <summary><strong>Property details</strong> <span className="muted">· {form.property_address}{form.city ? `, ${form.city}` : ''}</span></summary>
                <div className="lab-grid">
                  {FIELDS.map(([k, label, type]) => (
                    <label key={k}>{label}<input type={type || 'text'} value={form[k] ?? ''} onChange={e => setField(k, e.target.value)} /></label>
                  ))}
                  <label className="lab-wide">Listed features (comma-separated)<input value={featuresText} onChange={e => setFeaturesText(e.target.value)} /></label>
                  <label className="lab-wide">Existing public remarks (optional)<textarea rows={3} value={form.description || ''} onChange={e => setField('description', e.target.value)} /></label>
                </div>
                <div className="ed-actions"><button className="btn btn-primary" onClick={save}>Save details</button></div>
              </details>
              <EditorialStudio key={`${id}-${initialRun?.id || ''}`} listingId={id} form={form} setField={setField} saveQuiet={saveQuiet} onOpenLibrary={() => setLibOpen(true)} initialRun={initialRun} onRunDone={() => loadListings()} />
              <div className="ed-actions"><button className="btn btn-primary" onClick={save}>Save all</button></div>
            </>
          )}
        </main>
      </div>

      <EditorialLibrary open={libOpen} onClose={() => setLibOpen(false)} />
      <Toaster theme="dark" position="bottom-right" />
      <ConfirmHost />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<Lab />)
