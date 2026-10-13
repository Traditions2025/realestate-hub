// Listing Marketing Machine: editorial studio for one listing.
// Every channel runs through the editorial engine (server/editorial): analysis, outline,
// draft, critical review, rewrite, fact verification, polish. The agent picks a version,
// edits it with the live checker beside it, rewrites a selected passage, restores an
// earlier version, gives feedback, and approves good copy into the reference library.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { authFetch } from '../api'
import { notify } from '../notify'

const api = async (url, opts = {}) => {
  const r = await authFetch(url, opts)
  const d = await r.json().catch(() => ({}))
  if (!r.ok || d?.error) throw new Error(d?.error || `HTTP ${r.status}`)
  return d
}
const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body || {}) })

const CHANNEL_ORDER = ['mls', 'website', 'premarket_blog', 'premarket_email', 'premarket_social', 'active_email', 'active_social', 'social_facebook', 'social_instagram', 'price_reduction', 'video_script']
const LABEL_NAMES = { excellent: 'Excellent', acceptable: 'Acceptable', needs_improvement: 'Needs Improvement', do_not_imitate: 'Do Not Imitate' }
const VERSION_NAMES = { A: 'A · Balanced Professional', B: 'B · Feature-Led', C: 'C · Warm and Conversational' }

function Findings({ lint, compact }) {
  if (!lint) return null
  const f = lint.findings || []
  if (!f.length) return <div className="ed-ok">No checker findings.</div>
  return (
    <ul className={`ed-findings ${compact ? 'compact' : ''}`}>
      {f.map((x, i) => (
        <li key={i} className={x.severity}>
          <span className="ed-tag">{x.severity === 'error' ? 'Fix' : 'Note'} · {x.category}</span> {x.message}
          {x.excerpt && !compact && <div className="ed-excerpt">“{x.excerpt}”</div>}
        </li>
      ))}
    </ul>
  )
}

function StageProgress({ stages, run }) {
  const idx = stages.findIndex(s => s.key === run?.stage)
  return (
    <ol className="ed-stages">
      {stages.map((s, i) => {
        const state = run?.status === 'failed' ? (i === idx ? 'failed' : i < idx ? 'done' : '') : run?.stage === 'done' || i < idx ? 'done' : i === idx ? 'active' : ''
        return <li key={s.key} className={state}>{s.label}</li>
      })}
    </ol>
  )
}

function Analysis({ a }) {
  if (!a) return null
  return (
    <details className="ed-analysis" open>
      <summary>How the engine read this property</summary>
      <div className="ed-chips">{(a.positioning || []).map((p, i) => <span key={i} className="ed-chip" title={p.evidence}>{p.category}</span>)}</div>
      {a.top_selling_points?.length > 0 && <p><strong>Built around:</strong> {a.top_selling_points.join(' · ')}</p>}
      {a.condition?.summary && <p><strong>Condition:</strong> {a.condition.summary} <span className="muted">({a.condition.confidence})</span></p>}
      {a.photo_led_features?.length > 0 && <p><strong>Left to the photos:</strong> {a.photo_led_features.join(', ')}</p>}
      {a.limitations?.length > 0 && <p><strong>Limitations noted:</strong> {a.limitations.join('; ')}</p>}
      {a.claims_to_avoid?.length > 0 && <p><strong>Deliberately not claimed:</strong> {a.claims_to_avoid.join('; ')}</p>}
      {a.questions_for_agent?.length > 0 && (
        <div className="ed-questions"><strong>Confirm these to strengthen the copy</strong> (add answers to Verified details):
          <ul>{a.questions_for_agent.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </div>
      )}
    </details>
  )
}

function ChannelPanel({ meta, channel, listingId, form, setField, saveQuiet, onLibraryChanged, initialRunId, onRunDone }) {
  const ch = meta.channels.find(c => c.key === channel)
  const isMls = channel === 'mls'
  const saved = form[ch.column] || ''
  const [settings, setSettings] = useState(() => {
    let s = {}
    try { s = JSON.parse(form.marketing_editorial_settings || '{}') } catch {}
    return { tone: s.tone || 'natural', length: s.length || 'standard', angle: s.angle || 'auto', opening: s.opening || 'auto', emphasize: s.emphasize || '', exclude: s.exclude || '', instructions: '', charLimit: s.charLimit || meta.settings.mls_char_limit, alternatives: false }
  })
  const [more, setMore] = useState(false)
  const [run, setRun] = useState(null)
  const [active, setActive] = useState(null)
  const [pickedText, setPickedText] = useState('')
  const [liveLint, setLiveLint] = useState(null)
  const [versions, setVersions] = useState(null)
  const [sel, setSel] = useState({ start: 0, end: 0 })
  const [selInstr, setSelInstr] = useState('')
  const [alts, setAlts] = useState(null)
  const [busy, setBusy] = useState('')
  const [fbText, setFbText] = useState('')
  const [approve, setApprove] = useState(null)
  const pollRef = useRef(null)
  const taRef = useRef(null)
  const set = (k, v) => setSettings(p => ({ ...p, [k]: v }))

  // A run already in progress (started from an address), else the latest finished run
  useEffect(() => {
    let off = false
    if (initialRunId) {
      setRun({ id: initialRunId, status: 'running', stage: 'analysis' }); setBusy('run'); poll(initialRunId)
      return () => { off = true; clearTimeout(pollRef.current) }
    }
    api(`/api/editorial/listings/${listingId}/runs/latest?channel=${channel}`).then(r => {
      if (off || !r) return
      setRun(r); setActive(r.final?.recommended || null)
    }).catch(() => {})
    return () => { off = true; clearTimeout(pollRef.current) }
  }, [listingId, channel])

  // Live checker on the saved/edited copy (debounced, no model)
  useEffect(() => {
    if (!saved) { setLiveLint(null); return }
    const t = setTimeout(() => {
      post('/api/editorial/lint', { text: saved, channel, listing_id: listingId }).then(setLiveLint).catch(() => {})
    }, 500)
    return () => clearTimeout(t)
  }, [saved, channel, listingId])

  const poll = (id) => {
    api(`/api/editorial/runs/${id}`).then(r => {
      setRun(r)
      if (r.status === 'running') { pollRef.current = setTimeout(() => poll(id), 2000); return }
      setBusy('')
      if (r.status === 'done') { setActive(r.final.recommended); setPickedText(''); onRunDone?.(r) }
      if (r.status === 'failed') notify('Generation failed: ' + (r.error || 'unknown error'))
    }).catch(e => { setBusy(''); notify(e.message) })
  }

  const generate = async () => {
    if (!meta.configured) { notify('AI is not configured. Set ANTHROPIC_API_KEY.'); return }
    setBusy('run'); setAlts(null)
    try {
      await saveQuiet()
      const body = { channel, settings: { ...settings, emphasize: settings.emphasize, exclude: settings.exclude } }
      if (!isMls) delete body.settings.charLimit
      const { run_id } = await post(`/api/editorial/listings/${listingId}/runs`, body)
      setRun({ id: run_id, status: 'running', stage: 'analysis' })
      poll(run_id)
    } catch (e) { setBusy(''); notify('Generation failed: ' + e.message) }
  }

  const finalVersions = run?.status === 'done' ? run.final.versions : []
  const current = finalVersions.find(v => v.label === active) || finalVersions[0]
  const reviewFor = (label) => (run?.review || []).find(r => r.label === label)

  const useVersion = async () => {
    if (!current) return
    setBusy('apply')
    try {
      const d = await post(`/api/editorial/runs/${run.id}/apply`, { label: current.label, text: pickedText || undefined })
      setField(ch.column, d.content)
      setVersions(null)
      notify(`Version ${d.label} saved to ${ch.label}.`)
    } catch (e) { notify(e.message) } finally { setBusy('') }
  }

  const loadVersions = () => api(`/api/editorial/listings/${listingId}/versions?channel=${channel}`).then(setVersions).catch(e => notify(e.message))
  const restore = async (v) => {
    try {
      const d = await post(`/api/editorial/listings/${listingId}/versions/${v.id}/restore`)
      setField(ch.column, d.content); loadVersions(); notify('Restored.')
    } catch (e) { notify(e.message) }
  }

  const selection = saved.slice(sel.start, sel.end)
  const rewriteSel = async () => {
    if (!selection.trim()) { notify('Select a sentence or passage in the box first.'); return }
    setBusy('sel'); setAlts(null)
    try {
      const d = await post(`/api/editorial/listings/${listingId}/rewrite-selection`, { channel, full_text: saved, selection, instruction: selInstr, settings: isMls ? { charLimit: settings.charLimit } : {} })
      setAlts(d.alternatives)
    } catch (e) { notify(e.message) } finally { setBusy('') }
  }
  const takeAlt = (a) => { setField(ch.column, a.full_text); setAlts(null); setSel({ start: 0, end: 0 }) }

  const sendFeedback = async (text) => {
    if (!text?.trim()) return
    try {
      const d = await post('/api/editorial/feedback', { listing_id: listingId, run_id: run?.id, channel, text })
      setFbText('')
      if (d.summary?.suggest_rule) notify(`"${d.summary.text}" has come up ${d.summary.n} times. Adopt it as a team rule under Library & Rules.`)
      else notify('Feedback recorded.')
    } catch (e) { notify(e.message) }
  }

  const submitApprove = async () => {
    try {
      await saveQuiet()
      await post('/api/editorial/library', { listing_id: listingId, channel, approved_text: saved, label: approve.label, edit_reasons: approve.reasons, tone: settings.tone })
      setApprove(null); onLibraryChanged?.(); notify('Added to the writing reference library.')
    } catch (e) { notify(e.message) }
  }

  const running = run?.status === 'running'

  return (
    <div className="ed-panel">
      <div className="ed-controls">
        <label>Tone
          <select value={settings.tone} onChange={e => set('tone', e.target.value)}>{meta.tones.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
        </label>
        {isMls && (
          <label>Length
            <select value={settings.length} onChange={e => set('length', e.target.value)}>{meta.lengths.map(l => <option key={l.key} value={l.key}>{l.label} ({l.words[0]} to {l.words[1]} words)</option>)}</select>
          </label>
        )}
        {!isMls && (
          <label className="ed-inline"><input type="checkbox" checked={settings.alternatives} onChange={e => set('alternatives', e.target.checked)} /> Generate alternatives</label>
        )}
        <button type="button" className="btn-sm btn-secondary" onClick={() => setMore(m => !m)}>{more ? 'Fewer options' : 'More options'}</button>
        <button type="button" className="btn-sm btn-primary" disabled={!!busy || running} onClick={generate}>
          {running ? 'Working…' : saved ? 'Regenerate' : 'Generate'}
        </button>
      </div>
      {more && (
        <div className="ed-more">
          <label>Primary angle
            <select value={settings.angle} onChange={e => set('angle', e.target.value)}>{meta.angles.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select>
          </label>
          <label>Opening approach
            <select value={settings.opening} onChange={e => set('opening', e.target.value)}>
              <option value="auto">Let the engine choose</option>
              {meta.openings.map(o => <option key={o.key} value={o.key}>{o.key} · {o.label}</option>)}
            </select>
          </label>
          {isMls && <label>MLS character limit<input type="number" min="200" max="5000" value={settings.charLimit} onChange={e => set('charLimit', e.target.value)} /></label>}
          <label className="ed-wide">Features to emphasize<input value={settings.emphasize} onChange={e => set('emphasize', e.target.value)} placeholder="Comma-separated, e.g. 2023 kitchen, walkout" /></label>
          <label className="ed-wide">Features to leave out<input value={settings.exclude} onChange={e => set('exclude', e.target.value)} placeholder="Comma-separated" /></label>
          <label className="ed-wide">Note for this run<input value={settings.instructions} onChange={e => set('instructions', e.target.value)} placeholder="Optional, e.g. lead with the lot" /></label>
        </div>
      )}

      {run && (running || run.status === 'failed') && <StageProgress stages={meta.stages} run={run} />}
      {run?.status === 'failed' && <div className="ed-error">{run.error}</div>}

      {run?.status === 'done' && (
        <div className="ed-result">
          <Analysis a={run.analysis} />
          {finalVersions.length > 1 && (
            <div className="ed-vtabs">
              {finalVersions.map(v => (
                <button key={v.label} type="button" className={`ed-vtab ${v.label === active ? 'on' : ''}`} onClick={() => { setActive(v.label); setPickedText('') }}>
                  {VERSION_NAMES[v.label] || v.label}{v.label === run.final.recommended ? ' · recommended' : ''}
                  <span className={`ed-dot ${v.lint.clean ? 'ok' : 'bad'}`} />
                </button>
              ))}
            </div>
          )}
          {current && (
            <div className="ed-version">
              {run.final.recommended === current.label && run.final.recommended_reason && <div className="muted ed-why">{run.final.recommended_reason}</div>}
              <textarea rows={isMls ? 7 : 10} value={pickedText || current.output} onChange={e => setPickedText(e.target.value)} />
              <div className="ed-meta">
                {current.lint.stats.characters} characters{isMls && run.settings?.charLimit ? ` of ${run.settings.charLimit}` : ''} · {current.lint.stats.words} words
              </div>
              <Findings lint={current.lint} compact />
              {reviewFor(current.label)?.summary && <p className="ed-review"><strong>Editor's note on the first draft:</strong> {reviewFor(current.label).summary}</p>}
              {current.changes?.length > 0 && <details><summary>What the rewrite changed</summary><ul>{current.changes.map((c, i) => <li key={i}>{c}</li>)}</ul></details>}
              {current.removed?.length > 0 && <p className="ed-review"><strong>Removed by fact check:</strong> {current.removed.join('; ')}</p>}
              <div className="ed-actions">
                <button type="button" className="btn-sm btn-primary" disabled={busy === 'apply'} onClick={useVersion}>Use this version</button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="ed-current">
        <div className="ed-current-head">
          <h5>Current {ch.label}</h5>
          <div className="asset-actions">
            <button type="button" className="btn-sm btn-secondary" disabled={!saved} onClick={() => navigator.clipboard?.writeText(saved).then(() => notify('Copied.'))}>Copy</button>
            <button type="button" className="btn-sm btn-secondary" onClick={() => (versions ? setVersions(null) : loadVersions())}>{versions ? 'Hide history' : 'History'}</button>
            <button type="button" className="btn-sm btn-secondary" disabled={!saved} onClick={() => setApprove({ label: 'excellent', reasons: '' })}>Approve to library</button>
          </div>
        </div>
        <textarea
          ref={taRef}
          rows={isMls ? 7 : 10}
          value={saved}
          onChange={e => setField(ch.column, e.target.value)}
          onSelect={e => setSel({ start: e.target.selectionStart, end: e.target.selectionEnd })}
          placeholder={`(empty: click Generate to write the ${ch.label.toLowerCase()})`}
        />
        {saved && <div className="ed-meta">{saved.length} characters{isMls ? ` of ${settings.charLimit}` : ''}</div>}
        {saved && <Findings lint={liveLint} />}

        {saved && (
          <div className="ed-selrow">
            <input value={selInstr} onChange={e => setSelInstr(e.target.value)} placeholder={selection.trim() ? 'Optional: what should change in the selected text?' : 'Select text in the box above to rewrite just that part'} />
            <button type="button" className="btn-sm btn-secondary" disabled={!selection.trim() || busy === 'sel'} onClick={rewriteSel}>{busy === 'sel' ? 'Rewriting…' : 'Rewrite selection'}</button>
          </div>
        )}
        {alts && (
          <div className="ed-alts">
            {alts.map((a, i) => (
              <div key={i} className="ed-alt">
                <div>{a.text}</div>
                <div className="muted">{a.why}</div>
                {!a.lint.clean && <Findings lint={{ findings: a.lint.findings.filter(f => f.severity === 'error') }} compact />}
                <button type="button" className="btn-sm btn-secondary" onClick={() => takeAlt(a)}>Use this</button>
              </div>
            ))}
          </div>
        )}

        {versions && (
          <div className="ed-history">
            {!versions.length && <div className="muted">No earlier versions yet.</div>}
            {versions.map(v => (
              <div key={v.id} className="ed-hrow">
                <div className="ed-hmeta">{new Date(v.created_at.replace(' ', 'T') + (v.created_at.endsWith('Z') ? '' : 'Z')).toLocaleString()} · {v.source}{v.version_label ? ` · ${v.version_label}` : ''}{v.created_by ? ` · ${v.created_by}` : ''}</div>
                <div className="ed-htext">{v.content.slice(0, 220)}{v.content.length > 220 ? '…' : ''}</div>
                <button type="button" className="btn-sm btn-secondary" disabled={v.content === saved} onClick={() => restore(v)}>Restore</button>
              </div>
            ))}
          </div>
        )}

        {approve && (
          <div className="ed-approve">
            <label>Label
              <select value={approve.label} onChange={e => setApprove(a => ({ ...a, label: e.target.value }))}>{meta.library_labels.map(l => <option key={l} value={l}>{LABEL_NAMES[l]}</option>)}</select>
            </label>
            <label className="ed-wide">Why (what was edited and why, or what makes it good or bad)
              <input value={approve.reasons} onChange={e => setApprove(a => ({ ...a, reasons: e.target.value }))} placeholder="e.g. Cut the adjectives, led with the 2023 kitchen" />
            </label>
            <div className="ed-actions">
              <button type="button" className="btn-sm btn-secondary" onClick={() => setApprove(null)}>Cancel</button>
              <button type="button" className="btn-sm btn-primary" onClick={submitApprove}>Save to library</button>
            </div>
          </div>
        )}

        <div className="ed-feedback">
          <span className="muted">Feedback on this writing:</span>
          {meta.feedback_presets.map(p => <button key={p.key} type="button" className="ed-fb" onClick={() => sendFeedback(p.text)}>{p.text}</button>)}
          <input value={fbText} onChange={e => setFbText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); sendFeedback(fbText) } }} placeholder="Other feedback, Enter to send" />
        </div>
      </div>
    </div>
  )
}

export default function EditorialStudio({ listingId, form, setField, saveQuiet, onOpenLibrary, initialRun, onRunDone }) {
  const [meta, setMeta] = useState(null)
  const [channel, setChannel] = useState(initialRun?.channel || 'mls')
  useEffect(() => { api('/api/editorial/meta').then(setMeta).catch(e => notify('Editorial engine unavailable: ' + e.message)) }, [])
  const channels = useMemo(() => meta ? CHANNEL_ORDER.map(k => meta.channels.find(c => c.key === k)).filter(Boolean) : [], [meta])
  if (!meta) return <p className="muted">Loading the editorial engine…</p>

  return (
    <div className="ed-studio">
      <div className="asset-card">
        <div className="asset-header">
          <h4>Verified details for writing</h4>
          <button type="button" className="btn-sm btn-secondary" onClick={onOpenLibrary}>Library and rules</button>
        </div>
        <p className="muted ed-help">
          The writer may only use the property details on the Details tab plus what you put here: updates with years, materials, condition, setting, anything you have confirmed.
          Never put anything the seller told you privately (their reasons, timeline, bottom line) here. Internal notes are never sent to the writer.
        </p>
        <textarea rows={4} value={form.marketing_facts || ''} onChange={e => setField('marketing_facts', e.target.value)} placeholder="e.g. Kitchen remodeled 2023: new cabinets, quartz counters, island. Roof 2019. Backs to a tree line." />
      </div>

      <div className="ed-channels">
        {channels.map(c => (
          <button key={c.key} type="button" className={`ed-ch ${channel === c.key ? 'on' : ''} ${form[c.column] ? 'has' : ''}`} onClick={() => setChannel(c.key)}>{c.label}</button>
        ))}
      </div>

      {!listingId ? (
        <div className="warning-banner ed-error">Save the listing first to enable marketing generation.</div>
      ) : (
        <ChannelPanel key={channel} meta={meta} channel={channel} listingId={listingId} form={form} setField={setField} saveQuiet={saveQuiet}
          initialRunId={initialRun && initialRun.channel === channel ? initialRun.id : null} onRunDone={onRunDone} />
      )}
    </div>
  )
}
