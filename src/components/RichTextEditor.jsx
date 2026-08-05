import React, { useRef, useEffect } from 'react'

// Lightweight Gmail-style WYSIWYG editor built on a contentEditable div.
// - value/onChange keep it controlled from the outside (template load, etc.)
// - we only reset innerHTML when the incoming value differs, so typing never
//   loses the caret.
export default function RichTextEditor({ value, onChange, minHeight = 220 }) {
  const ref = useRef(null)

  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== (value || '')) {
      ref.current.innerHTML = value || ''
    }
  }, [value])

  const sync = () => onChange(ref.current ? ref.current.innerHTML : '')
  const exec = (cmd, arg) => { document.execCommand(cmd, false, arg); ref.current && ref.current.focus(); sync() }
  const addLink = () => { const url = prompt('Link URL (https://…):'); if (url) exec('createLink', url.trim()) }

  const tbBtn = { padding: '4px 9px', background: 'var(--bg-primary, #fff)', border: '1px solid var(--border, #d1d5db)', borderRadius: 4, fontSize: 13, cursor: 'pointer', color: 'var(--text-primary, #111)' }
  const B = ({ label, cmd, arg, title }) => (
    <button type="button" title={title} onMouseDown={e => e.preventDefault()} onClick={() => exec(cmd, arg)} style={tbBtn}>{label}</button>
  )

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 4, padding: 6, borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', flexWrap: 'wrap' }}>
        <B label={<b>B</b>} cmd="bold" title="Bold" />
        <B label={<i>I</i>} cmd="italic" title="Italic" />
        <B label={<u>U</u>} cmd="underline" title="Underline" />
        <B label="•" cmd="insertUnorderedList" title="Bullet list" />
        <B label="1." cmd="insertOrderedList" title="Numbered list" />
        <button type="button" title="Insert link" onMouseDown={e => e.preventDefault()} onClick={addLink} style={tbBtn}>🔗</button>
        <B label="H" cmd="formatBlock" arg="H3" title="Heading" />
        <B label="⟲" cmd="removeFormat" title="Clear formatting" />
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={sync}
        onBlur={sync}
        style={{ minHeight, maxHeight: '48vh', overflowY: 'auto', padding: '12px 14px', fontSize: 14, lineHeight: 1.6, outline: 'none', fontFamily: 'Arial, Helvetica, sans-serif', background: '#ffffff', color: '#111827' }}
      />
    </div>
  )
}
