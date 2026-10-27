// FACEBOOK LISTING LEAD — PHASE 2 (John, 2026-10-27, Part 37 step 7).
//
// Phase 1 is about ONE house: the lead clicked an ad for 1625 Ranmar or 3485 Willowridge,
// got the opener, and ran the property cadence. Phase 1 ends when the campaign completes,
// when the lead replies (a human takes over), or when the house goes under contract and
// the pivot pulls them out early.
//
// WHY THIS MODULE HAD TO EXIST. Ownership was wired before any Phase 2 lane was built, so
// `FB_BUYER_PHASE_2` could be assigned while nothing could send for it. The pre-send gate
// does its job and refuses every other campaign ("FB_BUYER_PHASE_2 owns this lead"), which
// turned a finished listing campaign into a permanent black hole: the lead was owned by a
// lane that had no voice. Every FB ad lead would have ended there.
//
// WHAT PHASE 2 MAY CLAIM. Unlike the cold lane, there is no history problem here. An
// `fb_listing_campaigns` row is proof this person asked about a specific property, and we
// know which one and when. So Phase 2 can reference that enquiry directly. What it must
// NOT do is widen that into claims about a relationship, or expose the CRM.
import db from '../database.js'
import { getProfile, factState } from '../buyer-profile.js'

// Narrower than the cold lane's list: prior contact IS provable here. What stays banned is
// exposing the machinery, and the chase tone.
export const PHASE2_BANNED = [
  'our database', 'in our system', 'our records', 'our crm', 'your file', 'your record',
  'checking in again', 'just following up again', 'circling back', 'touching base again',
  'i have not heard back', "haven't heard back", 'did you get my', 'my last few messages',
  'reaching out again', 'one last try', 'last attempt', 'before i close your',
]
export function findBannedPhase2(text) {
  const t = String(text || '').toLowerCase()
  return PHASE2_BANNED.filter(p => t.includes(p))
}

// Days after the Phase 1 campaign ends. Slower than Phase 1 on purpose: the urgency
// belonged to the house, and the house is gone.
export const PHASE2_DAYS = [7, 21, 45, 75, 110]
export const PHASE2_LOOP_GAP = 55

// Each stage learns ONE thing. `asks` lists the buyer_facts fields it exists to capture,
// so a stage whose facts are already known and fresh is skipped rather than padded out.
export const PHASE2_STAGES = [
  {
    key: 'p1', label: 'Still looking at all',
    goal: 'Whether the search outlived the one listing they clicked',
    asks: [],
    messages: [
      "{{greeting}} {{first_name}}, it's John with Matt Smith Team at RE/MAX. That home you asked about is spoken for, but are you still keeping an eye out, or did you pause the search?",
      "{{greeting}} {{first_name}}, John with Matt Smith Team at RE/MAX. The place you enquired about is off the table now. Are you still looking, or has that cooled off?",
      "{{greeting}} {{first_name}}, it's John with Matt Smith Team at RE/MAX. Now that the home you asked about is gone, is finding something else still on your mind?",
      "{{greeting}} {{first_name}}, John with Matt Smith Team at RE/MAX here. Are you still in the market, or was that one home the whole of it?",
    ],
  },
  {
    key: 'p2', label: 'What drew them',
    goal: 'Which attribute of that listing to search on',
    asks: ['preferred_location', 'property_type'],
    known: {
      preferred_location: '{{greeting}} {{first_name}}, last we had it you were focused on {{value}}. Is that still where you would want to be?',
    },
    messages: [
      '{{greeting}} {{first_name}}, out of curiosity, what was it about that home that caught your eye? The area, the layout, the price?',
      '{{greeting}} {{first_name}}, was it that particular house you liked, or the area it was in?',
      '{{greeting}} {{first_name}}, if I were looking for something close to that one, what matters most to get right? Location, size, or price?',
      '{{greeting}} {{first_name}}, what part of that listing were you drawn to? It helps me know what else to point you at.',
    ],
  },
  {
    key: 'p3', label: 'Shape of the search',
    goal: 'Beds, baths and budget, the minimum needed to send anything useful',
    asks: ['beds_min', 'price_max'],
    known: {
      price_max: '{{greeting}} {{first_name}}, I had your ceiling around {{value}}. Is that still about right?',
      beds_min: '{{greeting}} {{first_name}}, I had you needing {{value}}. Still the case?',
    },
    messages: [
      '{{greeting}} {{first_name}}, roughly how many bedrooms do you need, and is there a number you would not want to go past on price?',
      '{{greeting}} {{first_name}}, what does the right house have to have? Bedrooms and a price ceiling would help me most.',
      '{{greeting}} {{first_name}}, so I am not sending you things that miss, how many bedrooms and what budget are we working with?',
      '{{greeting}} {{first_name}}, what is the minimum that would make a house worth a look for you?',
    ],
  },
  {
    key: 'p4', label: 'Timing',
    goal: 'When, which decides whether this is a search or a someday',
    asks: ['timing'],
    known: {
      timing: '{{greeting}} {{first_name}}, you had mentioned {{value}} for timing. Has that shifted at all?',
    },
    messages: [
      '{{greeting}} {{first_name}}, is this something you would want to do in the next few months, or further out?',
      '{{greeting}} {{first_name}}, do you have a timeline in mind, or is it more whenever the right one shows up?',
      '{{greeting}} {{first_name}}, would moving this year be realistic for you, or is it more of a next-year idea?',
      '{{greeting}} {{first_name}}, is there a date you are working back from, or is the timing open?',
    ],
  },
  {
    key: 'p5', label: 'Permission',
    goal: 'Agree how to stay in touch, so the rest is wanted',
    asks: [],
    messages: [
      '{{greeting}} {{first_name}}, would it help if I sent you anything close to what you were after as it comes up, or would you rather I left you to it?',
      '{{greeting}} {{first_name}}, happy to keep an eye out and only message when something genuinely fits. Would that be useful or not really?',
      '{{greeting}} {{first_name}}, do you want me to keep watching for you, or should I leave you be for now?',
      '{{greeting}} {{first_name}}, would you want a heads up when something similar comes along, or is now not the time?',
    ],
  },
]

/**
 * Pick the Phase 2 message for a stage, honouring what we already know.
 * Mirrors the cold lane's contract: null means skip this stage entirely.
 */
export function selectPhase2Message(clientId, stageKey, { rotation = 0 } = {}) {
  const stage = PHASE2_STAGES.find(s => s.key === stageKey)
  if (!stage) return null
  const profile = getProfile(clientId)

  // A fact that has gone stale is worth confirming rather than re-asking cold.
  if (stage.known) {
    for (const field of Object.keys(stage.known)) {
      const f = factState(clientId, field)
      if (f.state === 'stale') {
        return { stage: stage.key, kind: 'confirm', field, text: stage.known[field].replace('{{value}}', f.value) }
      }
    }
  }

  // Known AND fresh means skip. This diverges from the cold lane on purpose: there, a
  // confirmation keeps a near-dead conversation alive, and the risk of asking twice is
  // worth it. Here the lead told us something recently and a "you mentioned 3 months, has
  // that shifted?" two days later reads as not having listened. Staleness is handled
  // above; a stage with nothing fresh to learn stays quiet and the chain moves on.
  if (stage.asks.length && stage.asks.every(f => profile[f])) return null

  const bank = stage.messages
  return { stage: stage.key, kind: 'ask', text: bank[rotation % bank.length] }
}

/** The stage key for a Phase 2 step index; past the staged run it loops on what is missing. */
export function phase2StageForIndex(clientId, idx) {
  if (idx < PHASE2_STAGES.length) return PHASE2_STAGES[idx].key
  const profile = getProfile(clientId)
  for (const s of PHASE2_STAGES) {
    if (s.asks.some(f => !profile[f])) return s.key
  }
  return 'p5'
}
