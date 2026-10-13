// What the engine found about a property in the team's own files and photos, with sources.
// Facts can be removed before writing; private files are listed (never read) so the agent can
// see exactly what was left alone.
import React, { useMemo, useState } from 'react'

export default function PropertyDossier({ value, onChange }) {
  const d = useMemo(() => { try { return value ? JSON.parse(value) : null } catch { return null } }, [value])
  const [showFiles, setShowFiles] = useState(false)
  if (!d) return null
  const save = (next) => onChange(JSON.stringify(next))
  const removeFact = (i) => save({ ...d, facts: d.facts.filter((_, j) => j !== i) })
  const removePhoto = (i) => save({ ...d, photo_features: d.photo_features.filter((_, j) => j !== i) })
  const groups = { read: [], private: [], other: [] }
  for (const f of d.files || []) (f.status === 'read' ? groups.read : f.kind === 'private' ? groups.private : groups.other).push(f)

  return (
    <details className="asset-card ed-dossier" open>
      <summary>
        <strong>What it found in your files</strong>{' '}
        <span className="muted">· {d.summary.documents_read} documents read · {d.summary.photos_reviewed} photos reviewed · {d.summary.private_skipped} private files left alone</span>
      </summary>
      {d.conflicts?.length > 0 && (
        <div className="ed-conflicts"><strong>Sources disagree, so the copy will not state these until you confirm:</strong>
          <ul>{d.conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </div>
      )}
      {d.facts?.length > 0 && (
        <>
          <h5>Facts from documents <span className="muted">(× removes one before the next Regenerate)</span></h5>
          <ul className="ed-factlist">
            {d.facts.map((f, i) => (
              <li key={i} className={f.outdated ? 'old' : ''}>
                <span>{f.text}</span> <span className="muted">· {f.source}{f.outdated ? ' · possibly outdated' : ''}</span>
                <button type="button" className="ed-x" title="Remove" onClick={() => removeFact(i)}>×</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {d.photo_features?.length > 0 && (
        <>
          <h5>Clearly visible in the photos</h5>
          <ul className="ed-factlist">
            {d.photo_features.map((f, i) => (
              <li key={i}><span>{f.text}</span> {f.photos?.length > 0 && <span className="muted">· {f.photos.slice(0, 3).join(', ')}</span>}
                <button type="button" className="ed-x" title="Remove" onClick={() => removePhoto(i)}>×</button></li>
            ))}
          </ul>
        </>
      )}
      {d.photo_error && <p className="ed-error">Photos could not be reviewed: {d.photo_error}</p>}
      <button type="button" className="btn-sm btn-secondary" onClick={() => setShowFiles(s => !s)}>{showFiles ? 'Hide' : 'Show'} the files ({d.files?.length || 0})</button>
      {showFiles && (
        <div className="ed-files">
          {[['Read', groups.read], ['Left alone: private (CMAs, comps, offers, strategy, contracts, briefs)', groups.private], ['Not used', groups.other]].map(([title, list]) => list.length > 0 && (
            <div key={title}>
              <h5>{title} ({list.length})</h5>
              <ul>{list.slice(0, 60).map((f, i) => <li key={i} className="muted">{f.path}{f.status && title === 'Not used' ? ` · ${f.status}` : ''}</li>)}</ul>
              {list.length > 60 && <div className="muted">…and {list.length - 60} more</div>}
            </div>
          ))}
        </div>
      )}
    </details>
  )
}
