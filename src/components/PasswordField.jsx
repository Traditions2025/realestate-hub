import React, { useState } from 'react'

// Password input with a show/hide eye toggle. Inherits surrounding input styling;
// pass inputStyle for admin forms, or leave default for the login screen.
export default function PasswordField({ value, onChange, onKeyDown, placeholder = 'Password', autoFocus, autoComplete = 'current-password', inputStyle, wrapStyle, required }) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ position: 'relative', ...wrapStyle }}>
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        required={required}
        style={{ width: '100%', boxSizing: 'border-box', paddingRight: 40, ...inputStyle }}
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        tabIndex={-1}
        aria-label={show ? 'Hide password' : 'Show password'}
        title={show ? 'Hide password' : 'Show password'}
        style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1, opacity: 0.75, padding: 2 }}
      >
        {show ? '🙈' : '👁'}
      </button>
    </div>
  )
}
