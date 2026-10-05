// Is this a real email between people, or an automated blast?
//
// John, 2026-10-05: "we don't need to get automated listing alerts emails, only those
// actual emails coming from lead or a reply". A conversation history is worth having; a
// marketing archive is noise that would also dominate the storage.
//
// WHEN IN DOUBT, KEEP. A marketing email wrongly kept is clutter. A real conversation
// wrongly dropped is history nobody can get back, and it is the whole point of the import.
// So the drop rules are deliberately narrow and evidence-led.

// Bulk senders announce themselves in the headers. These are the strong signals, far more
// reliable than reading subject lines: a human writing from Gmail sends none of them.
const BULK_HEADERS = [
  'list-unsubscribe',          // every compliant bulk sender sets this
  'list-id',
  'auto-submitted',            // RFC 3834: auto-generated / auto-replied
  'x-auto-response-suppress',
  'x-campaign-id',
  'x-mailer-sid',              // SendGrid
  'x-sg-eid',                  // SendGrid
  'x-ses-outgoing',            // SES
]

// Precedence: bulk / list / junk is the old convention for "do not reply to this".
const BULK_PRECEDENCE = /^(bulk|list|junk|auto_reply)$/i

// Addresses that are machines by definition. Anchored on the WHOLE local part, because
// "donna.updates@gmail.com" is a person and an over-eager pattern drops her history.
// A hyphen-joined suffix (listing-alerts@, property-updates@) is still a machine; a
// dot-separated one reads as firstname.lastname and is left alone.
const ROBOT_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|noreply|notifications?|alerts?|mailer-daemon|postmaster|bounces?|updates?|auto|automated|newsletter)$/i
const ROBOT_ANYWHERE = /(^|[-_.])(no-?reply|do-?not-?reply|donotreply)([-_.]|$)/i
const ROBOT_SUFFIX = /-(alerts?|notifications?|updates?|noreply|bot)$/i

function isRobotAddress(addr) {
  const local = String(addr || '').split('@')[0]
  if (!local) return false
  return ROBOT_LOCAL.test(local) || ROBOT_ANYWHERE.test(local) || ROBOT_SUFFIX.test(local)
}

// The platforms that send this team's listing alerts and market reports. A message FROM
// one of these is a system message even when the display name says "Matt Smith".
const ROBOT_DOMAIN = /@([a-z0-9-]+\.)?(ylopo|sierrainteractive|listingsproject|kvcore|boomtown|realscout|homebot|fello|smartalto|followupboss)\./i

// The system that generated the Message-ID, read off the real messages in
// mattsmithremax@gmail.com. This is the strongest signal available and it beats reading
// subject lines, which was wrong six times out of six on Niki Morris's history:
//
//   mail.gmail.com          Matt or John typed it in Gmail          -> a person
//   gprodcdra*              Matrix MLS listing alert                -> a machine
//   followupboss.com        FUB action-plan send (16-38 links)      -> a template
//   sierra-vm-*             Sierra drip campaign                    -> a campaign
//
// A lead's own reply always arrives with a real mail-client Message-ID, so the reply rule
// above catches it before any of this runs.
const SENDING_PLATFORM = [
  [/@gprod[a-z0-9]*|@.*matrixmail\./i, 'Matrix MLS listing alert', true],
  [/@(.*\.)?sierra-vm|@.*sierrainteractive/i, 'Sierra drip campaign', true],
  [/@(.*\.)?followupboss\.com/i, 'FUB template send', false],
  [/@(.*\.)?(sendgrid|mailgun|mandrillapp|amazonses|sparkpostmail)\./i, 'bulk mail service', false],
]

// A mass template carries its apparatus with it: property cards, tracking links, an
// unsubscribe footer. A typed one-to-one email does not.
function looksMassTemplate(body) {
  const text = String(body || '')
  if (/unsubscribe|opt[- ]out|manage (your )?(email )?preferences/i.test(text)) return true
  return (text.match(/https?:\/\//g) || []).length >= 8
}

// Subject shapes used by listing alerts and reports. Only consulted as a WEAK signal -
// never enough on its own, because a person can legitimately write "Homes to consider".
const ALERT_SUBJECT = /\b(homes? to consider|new listings?|just listed|price (change|drop|reduced)|open house(s)? (this|near)|your saved search|market (report|update|snapshot)|listing alert|new match(es)?|properties? (you|matching))\b/i

const headerGet = (headers, name) => {
  if (!headers) return ''
  try {
    if (typeof headers.get === 'function') {           // mailparser Map
      const v = headers.get(name)
      if (v == null) return ''
      return typeof v === 'string' ? v : (v.value || JSON.stringify(v))
    }
    const k = Object.keys(headers).find(x => x.toLowerCase() === name)
    return k ? String(headers[k]) : ''
  } catch { return '' }
}

/**
 * Decide whether one parsed message is a real human email.
 *
 * Returns { human: boolean, why: string }. `why` is kept so a sample can be reviewed
 * before anything is imported, rather than trusting the classifier blind.
 */
export function classifyEmail({ headers, from = '', subject = '', body = '', inReplyTo = '', references = '', messageId = '' } = {}) {
  const fromAddr = String(from || '').toLowerCase()

  // A reply is a conversation by definition, whatever else it looks like.
  if (inReplyTo || references) return { human: true, why: 'part of a thread (In-Reply-To/References)' }

  for (const h of BULK_HEADERS) {
    if (headerGet(headers, h)) return { human: false, why: `bulk header ${h}` }
  }
  const prec = headerGet(headers, 'precedence').trim()
  if (prec && BULK_PRECEDENCE.test(prec)) return { human: false, why: `Precedence: ${prec}` }

  if (isRobotAddress(fromAddr)) return { human: false, why: `machine sender ${fromAddr}` }
  if (ROBOT_DOMAIN.test(fromAddr)) return { human: false, why: `platform sender ${fromAddr}` }

  // Which system sent it. An alert engine is never a conversation; a one-to-one tool is,
  // unless the message carries a mass template with it.
  const mid = String(messageId || headerGet(headers, 'message-id') || '')
  for (const [re, label, alwaysMachine] of SENDING_PLATFORM) {
    if (!re.test(mid)) continue
    if (alwaysMachine) return { human: false, why: label }
    if (looksMassTemplate(body)) return { human: false, why: `${label}, mass template body` }
    return { human: true, why: `sent through ${label} but reads as a one-to-one email` }
  }

  // Subject alone is never enough. It only decides when the body also looks like a
  // template - no greeting, and a stack of listing links.
  if (ALERT_SUBJECT.test(String(subject))) {
    const text = String(body || '')
    const manyLinks = (text.match(/https?:\/\//g) || []).length >= 4
    const noGreeting = !/^\s*(hi|hello|hey|good (morning|afternoon|evening)|dear)\b/im.test(text.slice(0, 400))
    if (manyLinks && noGreeting) return { human: false, why: 'listing-alert subject with a template body' }
    return { human: true, why: 'alert-style subject but the body reads like a person wrote it' }
  }

  return { human: true, why: 'no automation markers' }
}

/**
 * A thread whose opening message is missing is not history.
 *
 * Niki Morris replied twice to "Market changes for your home on 7009 Springwood Pl Nw".
 * Her replies are kept, but the message she was replying to is a FUB template and was
 * dropped - leaving an answer with no question. So after the batch is judged, any dropped
 * message that a KEPT one actually points at is brought back. It runs until nothing more
 * changes, because the rescued parent may itself be a reply to something earlier.
 *
 * This only ever keeps more, never less, and it needs real In-Reply-To / References
 * linkage: a template nobody replied to stays dropped.
 */
export function rescueThreadParents(messages = []) {
  const idOf = (m) => String(m.messageId || '').trim()
  const byId = new Map()
  for (const m of messages) if (idOf(m)) byId.set(idOf(m), m)

  for (let pass = 0; pass < 10; pass++) {
    let changed = 0
    for (const m of messages) {
      if (m.human === false) continue
      const refs = `${m.inReplyTo || ''} ${m.references || ''}`.match(/<[^<>\s]+>/g) || []
      for (const ref of refs) {
        const parent = byId.get(ref)
        if (!parent || parent.human !== false) continue
        parent.human = true
        parent.why = 'a kept reply points at this message (' + (parent.why || 'automated') + ')'
        changed++
      }
    }
    if (!changed) break
  }
  return messages
}

/** Convenience for filtering a batch, keeping the reason on each message. */
export function splitHumanEmails(messages = []) {
  const kept = [], dropped = []
  for (const m of messages) {
    const v = classifyEmail(m)
    ;(v.human ? kept : dropped).push({ ...m, _why: v.why })
  }
  return { kept, dropped }
}
