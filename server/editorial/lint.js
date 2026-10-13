// Deterministic editorial checks. No model involved: every finding points at the actual
// sentence and says what is wrong, so the reviewer pass and the person editing both get
// evidence, not a score.
//
// lintCopy(text, { channel, facts, charLimit, customRules }) -> { findings, stats, clean }
//   finding = { severity: 'error'|'warn', category, message, excerpt, suggestion? }
//
// 'error' = must be fixed before the copy is used (Fair Housing, seller privacy,
// unsupported claims, MLS format, Matt's dash rule). 'warn' = editorial weakness.
import {
  CHANNELS, CLICHES, PUFFERY, GENERIC_OPENINGS, CTA_ENDINGS, WALKING_TOUR, OVERUSED_VERBS,
  FAIR_HOUSING, EVIDENCE_CLAIMS, PROHIBITED_CLAIMS, SELLER_PRIVATE, SPELLED_NUMBERS, NUMBER_NAMES_OK,
} from './rules.js'

const ACRONYMS = new Set(['HVAC', 'MLS', 'HOA', 'RE/MAX', 'REMAX', 'LVP', 'AC', 'USB', 'EV', 'ADU', 'II', 'III', 'NE', 'NW', 'SE', 'SW', 'IA', 'CR', 'LED', 'HD', 'RV', 'ATV', 'GFCI', 'PVC', 'TV', 'HOA', 'CCRAAR', 'CRAAR', 'MATT', 'SMITH'])
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u

export function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

export function splitSentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return []
  // Split on . ! ? followed by space + capital/quote/digit. Keeps "St." and "Dr." mostly
  // intact because addresses are followed by lowercase or numbers often enough; good enough
  // for rhythm and repetition checks.
  return t.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/).map(s => s.trim()).filter(Boolean)
}

const words = (s) => (String(s).match(/[A-Za-z0-9'’-]+/g) || [])

function excerptAround(text, idx, len = 60) {
  const start = Math.max(0, idx - 25)
  return (start > 0 ? '…' : '') + text.slice(start, idx + len).trim() + (idx + len < text.length ? '…' : '')
}

function findSentence(sentences, re) {
  return sentences.find(s => re.test(s)) || ''
}

// Mechanical scrub applied to every output before it is shown or saved. Only changes that
// can never alter meaning: dashes (Matt's standing rule), stray whitespace.
export function scrubMechanics(text) {
  let t = String(text || '')
  t = t.replace(/\s*[—–]\s*/g, (m, off, str) => {
    // "word — word" -> "word, word"; a dash between digits is a range -> " to "
    const before = str.slice(Math.max(0, off - 1), off)
    const after = str.slice(off + m.length, off + m.length + 1)
    if (/\d/.test(before) && /\d/.test(after)) return ' to '
    return ', '
  })
  t = t.replace(/,\s*,/g, ',').replace(/ {2,}/g, ' ').replace(/ ([,.;:])/g, '$1')
  return t.trim()
}

/**
 * @param {string} text
 * @param {{channel?: string, facts?: string, charLimit?: number, customRules?: Array<{rule_text:string, pattern?:string, kind?:string}>}} opts
 */
export function lintCopy(text, opts = {}) {
  const channel = CHANNELS[opts.channel || 'mls'] || CHANNELS.mls
  const isMls = (opts.channel || 'mls') === 'mls'
  const raw = String(text || '')
  const plain = channel.html ? stripHtml(raw) : raw
  const facts = String(opts.facts || '')
  const sentences = splitSentences(plain)
  const findings = []
  const add = (severity, category, message, excerpt = '', suggestion) =>
    findings.push({ severity, category, message, excerpt, ...(suggestion ? { suggestion } : {}) })

  // Body = what precedes the sign-off/hashtags in social channels.
  const body = channel.signoff ? plain.split(/Matt Smith \| Broker Associate/)[0] : plain

  // --- Format ---------------------------------------------------------------
  if (/[—–]/.test(raw)) add('error', 'mechanics', 'Contains an em or en dash. Use a comma, period or "to".', excerptAround(raw, raw.search(/[—–]/)))
  if (isMls) {
    const paras = raw.split(/\n\s*\n/).filter(p => p.trim())
    if (paras.length > 1) add('error', 'format', `MLS remarks must be one paragraph; found ${paras.length}.`)
    if (/^\s*([-*•]|\d+[.)])\s+/m.test(raw)) add('error', 'format', 'Bullets or a numbered list in MLS remarks.')
    if (EMOJI.test(raw)) add('error', 'format', 'Emoji in MLS remarks.')
    if (/!/.test(raw)) add('error', 'format', 'Exclamation mark in MLS remarks.', findSentence(sentences, /!/))
  } else if ((raw.match(/!/g) || []).length > 1) {
    add('warn', 'punctuation', `${(raw.match(/!/g) || []).length} exclamation marks. One at most.`)
  }
  const caps = (body.match(/\b[A-Z][A-Z/]{3,}\b/g) || []).filter(x => !ACRONYMS.has(x))
  if (caps.length) add(isMls ? 'error' : 'warn', 'format', `Capitalised for emphasis: ${[...new Set(caps)].slice(0, 5).join(', ')}.`)

  if (opts.charLimit && isMls && raw.length > opts.charLimit) {
    add('error', 'length', `${raw.length} characters; the limit is ${opts.charLimit}. Cut ${raw.length - opts.charLimit}.`)
  }

  // --- Opening and ending ---------------------------------------------------
  const first = sentences[0] || ''
  for (const [re, msg] of GENERIC_OPENINGS) if (re.test(first)) add('error', 'opening', msg, first)
  if (channel.noCTA && sentences.length) {
    const last = sentences[sentences.length - 1]
    if (CTA_ENDINGS.some(re => re.test(last))) add('error', 'ending', 'Ends on a stock call to action. Finish with a property-specific sentence.', last)
  }
  for (const s of sentences) {
    if (CTA_ENDINGS.some(re => re.test(s)) && !channel.noCTA && /won'?t last|don'?t miss|act (fast|now)|before it'?s gone/i.test(s)) {
      add('warn', 'cliche', 'Pressure phrase. State the next step plainly instead.', s)
    }
  }

  // --- Compliance (errors in every channel) ---------------------------------
  for (const [re, msg] of FAIR_HOUSING) {
    const s = findSentence(sentences, re)
    if (s) add('error', 'fair-housing', msg, s)
  }
  for (const [re, msg] of PROHIBITED_CLAIMS) {
    const s = findSentence(sentences, re)
    if (s) add('error', 'unsupported-claim', msg, s)
  }
  for (const [re, msg] of SELLER_PRIVATE) {
    const s = findSentence(sentences, re)
    if (s) add('error', 'seller-privacy', msg, s)
  }
  if (channel.allowPrice === false && /\$\s?\d{2,3}(,\d{3}|k\b)/i.test(plain)) {
    add('error', 'channel', `${channel.label} must not include the asking price.`, findSentence(sentences, /\$\s?\d/))
  }
  if (channel.allowAddress === false && opts.address) {
    const street = String(opts.address).trim()
    const num = street.match(/^\d+/)?.[0]
    const name = street.replace(/^\d+\s*/, '').split(/\s+/)[0]
    if (num && name && new RegExp(`\\b${num}\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(plain)) {
      add('error', 'channel', `${channel.label} must not include the street address.`)
    }
  }

  // --- Evidence for claims --------------------------------------------------
  if (facts) {
    for (const c of EVIDENCE_CLAIMS) {
      const m = plain.match(c.pattern)
      if (!m) continue
      const ok = c.evidence
        ? c.evidence.some(re => re.test(facts))
        : new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]*'), 'i').test(facts)
      if (!ok) add('error', 'unsupported-claim', `"${m[0]}" is not supported by the property facts.`, findSentence(sentences, c.pattern))
    }
  }

  // --- Word choice ----------------------------------------------------------
  for (const [re, label] of CLICHES) {
    const s = findSentence(sentences, re)
    if (s) add('warn', 'cliche', `"${label}" is stock listing language. Keep it only with a property-specific reason.`, s)
  }
  const lower = body.toLowerCase()
  const wordList = words(body)
  const wc = wordList.length || 1
  const puff = PUFFERY.filter(p => new RegExp(`\\b${p}\\b`, 'i').test(lower))
  const puffCount = wordList.filter(x => PUFFERY.includes(x.toLowerCase())).length
  if (puffCount >= 3 || puffCount / wc > 0.02) {
    add('warn', 'adjectives', `${puffCount} puffery adjectives (${puff.slice(0, 6).join(', ')}). Replace with specifics.`)
  }
  for (const v of OVERUSED_VERBS) {
    const n = (lower.match(new RegExp(`\\b${v}\\b`, 'g')) || []).length
    if (n >= 2) add('warn', 'repetition', `"${v}" used ${n} times.`)
  }
  for (const re of WALKING_TOUR) {
    const s = findSentence(sentences, re)
    if (s) add('warn', 'transition', 'Walking-tour transition. Group related spaces instead of narrating a route.', s)
  }
  // Spelled numbers (Matt: numerals from 2 up). Allowed at the very start of a sentence.
  for (const s of sentences) {
    const cleaned = s.replace(NUMBER_NAMES_OK, '')
    const m = cleaned.slice(1).match(SPELLED_NUMBERS)
    if (m) { add('warn', 'mechanics', `Spelled-out number "${m[0]}". Use the numeral.`, s); break }
  }
  if (/\bpercent\b/i.test(body)) add('warn', 'mechanics', 'Use the % symbol, not "percent".')
  if (/RE\/MAX Real Estate Concepts/i.test(raw)) add('error', 'brand', 'Brokerage is "RE/MAX Concepts".')

  // --- Sentence construction ------------------------------------------------
  const starts = sentences.map(s => words(s).slice(0, 2).join(' ').toLowerCase())
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] && starts[i] === starts[i - 1]) {
      add('warn', 'rhythm', `Consecutive sentences both start with "${starts[i]}".`, sentences[i]); break
    }
  }
  const featureStarts = sentences.filter(s => /^(the|this) \w+( \w+)? (features|offers|provides|includes|boasts)\b/i.test(s))
  if (featureStarts.length >= 2) add('warn', 'rhythm', `${featureStarts.length} sentences use the "The X features..." pattern.`, featureStarts[1])
  const lens = sentences.map(s => words(s).length)
  if (lens.length >= 4) {
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length)
    if (sd < 3.5) add('warn', 'rhythm', `Sentences are all about the same length (${lens.join(', ')} words). Vary the rhythm.`)
  }
  for (const s of sentences) {
    if (words(s).length > 42) { add('warn', 'rhythm', `A ${words(s).length}-word sentence. Split it.`, s); break }
    const commas = (s.match(/,/g) || []).length
    if (commas >= 7) { add('warn', 'overloaded', 'Sentence strings together too many features. Group them.', s); break }
  }
  if (channel.signoff && !/Matt Smith \| Broker Associate\s*\n\s*Matt Smith Team \| RE\/MAX Concepts/.test(raw)) {
    add('error', 'channel', 'Missing the exact two-line sign-off "Matt Smith | Broker Associate / Matt Smith Team | RE/MAX Concepts".')
  }
  if (channel.signoff && /\(?\d{3}\)?[ .-]?\d{3}[ .-]\d{4}|\bDM (me|us)\b/i.test(body)) {
    add('warn', 'channel', 'Captions end with the sign-off only: no phone number or "DM me".')
  }
  if (isMls) {
    const you = (lower.match(/\byou(r|'ll|'re|'d)?\b/g) || []).length
    if (you >= 2) add('warn', 'voice', `MLS remarks address the reader as "you" ${you} times. Describe the property instead.`)
  }
  if (channel.voice?.includes('Avoid addressing the reader')) {
    const you = (lower.match(/\byou(r|'ll|'re)?\b/g) || []).length
    if (you > 3) add('warn', 'voice', `Addresses the reader as "you" ${you} times. Write as a publication.`)
  }

  // --- Team rules (from feedback) -------------------------------------------
  for (const r of opts.customRules || []) {
    if (r.kind !== 'avoid_phrase' || !r.pattern) continue
    let re
    try { re = new RegExp(r.pattern, 'i') } catch { re = new RegExp(r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
    const s = findSentence(sentences, re)
    if (s) add('error', 'team-rule', `Team rule: ${r.rule_text}`, s)
  }

  const errors = findings.filter(f => f.severity === 'error').length
  return {
    findings,
    clean: errors === 0,
    stats: {
      characters: raw.length,
      words: words(plain).length,
      sentences: sentences.length,
      sentence_lengths: lens,
      errors,
      warnings: findings.length - errors,
    },
  }
}

// Compact text form of findings for prompts.
export function findingsForPrompt(findings) {
  if (!findings?.length) return '(no automatic findings)'
  return findings.map(f => `- [${f.severity}/${f.category}] ${f.message}${f.excerpt ? ` | "${f.excerpt}"` : ''}`).join('\n')
}
