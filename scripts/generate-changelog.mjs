// Generate public/changelog.json from `git log` at build time.
// Runs before Vite build (see package.json "build" script).
// Falls back gracefully if git isn't available so production builds never fail.
import { execSync } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = join(__dirname, '..')
const outFile = join(repoRoot, 'public', 'changelog.json')

const SEP_FIELD = '|||MST|||'
const SEP_RECORD = '===MST_END==='

function categorize(subject) {
  const s = (subject || '').toLowerCase()
  if (/^fix|^bugfix|^correct|fix:/.test(s)) return 'fix'
  if (/^add|^new |^build|^create|^introduce|^implement/.test(s)) return 'feature'
  if (/^remove|^delete|^drop/.test(s)) return 'removal'
  if (/^improve|^update|^enhance|^refine|^polish|^upgrade|^bump|^speed|^optimi/.test(s)) return 'improvement'
  if (/^refactor|^restructure|^reorganize|^rewrite|^clean/.test(s)) return 'refactor'
  if (/^migrat|^schema|^db |^database/.test(s)) return 'schema'
  if (/^doc|^readme/.test(s)) return 'docs'
  return 'other'
}

function highlightedTitle(subject) {
  // Strip a known prefix like "Add ", "Fix ", "Update " for cleaner display
  const m = subject.match(/^(Add|Fix|Update|Remove|Improve|Refactor|Build|Create|Introduce|Implement|Speed|Optimize|Polish|Enhance|Bump|Clean|Correct|Migrate)\s+(.*)/i)
  return m ? m[2] : subject
}

try {
  const fmt = `%H${SEP_FIELD}%aI${SEP_FIELD}%s${SEP_FIELD}%b${SEP_RECORD}`
  const out = execSync(`git log --pretty=format:"${fmt}" --max-count=500`, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })

  const entries = out.split(SEP_RECORD).map(raw => raw.trim()).filter(Boolean).map(raw => {
    const [hash, date, subject, body] = raw.split(SEP_FIELD).map(s => (s || '').trim())
    return {
      hash: hash?.slice(0, 7) || '',
      date,
      subject: subject || '',
      title: highlightedTitle(subject || ''),
      body: body || '',
      category: categorize(subject),
    }
  })

  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, JSON.stringify({
    generated_at: new Date().toISOString(),
    count: entries.length,
    entries,
  }, null, 2))
  console.log(`[changelog] Wrote ${entries.length} entries to ${outFile}`)
} catch (err) {
  console.error('[changelog] Generation failed (continuing build):', err.message)
  // Write an empty changelog so the frontend doesn't 404
  try {
    mkdirSync(dirname(outFile), { recursive: true })
    writeFileSync(outFile, JSON.stringify({
      generated_at: new Date().toISOString(),
      count: 0,
      entries: [],
      error: err.message,
    }, null, 2))
  } catch {}
}
