import React from 'react'

// Reusable manual column-resize system for HUB data tables. Widths are keyed by STABLE column
// key (never by position), scoped per table id, and persisted. Swap load/save for a server
// call later (e.g. a table_layout_preferences endpoint) without changing any caller.

const LS_KEY = (tableId) => `table_layout::${tableId}`

export function loadColumnWidths(tableId) {
  try { return JSON.parse(localStorage.getItem(LS_KEY(tableId)) || '{}') || {} } catch { return {} }
}
export function saveColumnWidths(tableId, widths) {
  try { localStorage.setItem(LS_KEY(tableId), JSON.stringify(widths || {})) } catch {}
}

// Default width (px) from a column's optional sizing category, so new columns get a sensible
// width automatically and become resizable with no extra code. Explicit defaultWidth wins.
export const DEFAULT_WIDTH_PX = { compact: 74, normal: 132, flex: 210, wide: 280 }
export function defaultWidthFor(col) {
  return Number(col.defaultWidth) || DEFAULT_WIDTH_PX[col.size] || DEFAULT_WIDTH_PX.normal
}

// State hook: current widths (key -> px), live setter (during drag), commit (persist), reset.
export function useColumnWidths(tableId) {
  const [widths, setWidths] = React.useState(() => loadColumnWidths(tableId))
  React.useEffect(() => { setWidths(loadColumnWidths(tableId)) }, [tableId])
  const setWidthLive = React.useCallback((key, px) => setWidths(prev => ({ ...prev, [key]: px })), [])
  const commit = React.useCallback((updater) => {
    setWidths(prev => { const next = typeof updater === 'function' ? updater(prev) : updater; saveColumnWidths(tableId, next); return next })
  }, [tableId])
  const commitWidth = React.useCallback((key, px) => commit(prev => ({ ...prev, [key]: px })), [commit])
  const reset = React.useCallback(() => commit({}), [commit])
  return { widths, setWidths, setWidthLive, commit, commitWidth, reset }
}

// A subtle 8px drag target on a column's right edge. Resizes live during drag, persists on
// release. Stops propagation so it never triggers header sort or column-drag-reorder.
// Double-click calls onAutoFit (optional).
export function ResizeHandle({ getWidth, min = 60, onResizeLive, onCommit, onAutoFit }) {
  const onMouseDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    const startX = e.clientX, startW = getWidth()
    const clamp = (x) => Math.max(min, Math.round(startW + (x - startX)))
    const move = (ev) => onResizeLive(clamp(ev.clientX))
    const up = (ev) => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''; document.body.style.userSelect = ''
      onCommit(clamp(ev.clientX))
    }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  }
  return <span
    className="col-resize-handle"
    onMouseDown={onMouseDown}
    onClick={e => e.stopPropagation()}
    onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); onAutoFit && onAutoFit() }}
    title="Drag to resize • double-click to auto-fit"
    draggable={false}
  />
}
