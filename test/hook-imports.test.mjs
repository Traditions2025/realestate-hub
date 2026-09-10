// Guard against the bug class that broke the lead profile twice: a React hook
// used bare (useRef(...)) without being in the `import { ... } from 'react'`
// list. Vite builds fine; the page then throws ReferenceError at runtime.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const HOOKS = ['useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useContext', 'useReducer', 'useLayoutEffect', 'useImperativeHandle']

function jsxFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) jsxFiles(p, out)
    else if (/\.jsx$/.test(name)) out.push(p)
  }
  return out
}

test('every bare React hook call is imported from react', () => {
  const problems = []
  for (const file of jsxFiles('src')) {
    const src = readFileSync(file, 'utf8')
    const m = src.match(/import\s+React(?:\s*,\s*\{([^}]*)\})?\s+from\s+['"]react['"]/)
    const imported = new Set((m?.[1] || '').split(',').map(s => s.trim()).filter(Boolean))
    for (const hook of HOOKS) {
      // bare call: not preceded by `.` (React.useRef is fine) or a word char
      const bare = new RegExp(String.raw`(?<![.\w])${hook}\s*\(`)
      if (bare.test(src) && !imported.has(hook)) problems.push(`${file}: ${hook} used but not imported`)
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})
