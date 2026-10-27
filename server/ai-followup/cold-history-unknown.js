// COLD_HISTORY_UNKNOWN (John, 2026-10-27 — Part 37 step 8).
//
// The reactivation lane for older buyers where the Hub CANNOT SEE whether a real
// conversation ever happened. A dry run over 1,500 buyers put nearly all of them here.
//
// This started out as COLD_NEVER_CONNECTED, which was wrong and dangerously so. The Hub
// holds no communication earlier than June 2026, while client records go back to
// September 2023, and most of the history lived in FUB — whose API never returned message
// bodies. Only 3,544 of 30,648 clients have any comms row at all. So "no reply on file"
// is a migration artifact for the overwhelming majority, not evidence of silence.
//
// Two failure modes, and they are not symmetrical:
//   claiming a conversation that never happened   -> "we had a relationship you forgot"
//   ignoring a conversation that DID happen       -> "they have forgotten me entirely"
// Both are bad. Neutral copy is the only thing that is safe when we cannot tell which.
//
// So nothing here asserts ANY past interaction: not a prior chat, not a prior enquiry, not
// that they were ever in our database. It reads as a fresh, low-pressure approach, which
// is true whichever way the unknown resolves. Prior-conversation language is reserved for
// COLD_KNOWN_CONNECTED, where a two-way exchange is actually visible.
//
// Smaller than the old 152-message bank on purpose. Variation is meant to come from stored
// facts and real context, not from thirty superficial rewrites of one question.
import { getProfile, factState } from '../buyer-profile.js'

// Phrases that assert a relationship we cannot evidence. Enforced by test, not trusted:
// it is far too easy to write "circling back" without noticing.
export const BANNED = [
  // asserts a conversation
  'since we last connected', 'since we last talked', 'since we talked', 'since we spoke',
  'looking back at our conversation', "we haven't talked in a while", 'we have not talked in a while',
  'when we spoke before', 'you told us', 'you mentioned', 'what you were looking for before',
  'dropped the ball', 'reconnect',
  // asserts a past interaction with US, which we equally cannot see
  'you had looked at homes with us', 'looked at homes with us', 'shown some interest in homes with us',
  'you had been looking at homes', 'you were looking at homes with us',
  'since you first', 'when you were looking', 'you had reached out', 'you reached out to us',
  'you signed up', 'you registered', 'back when you',
  // exposes the CRM or the fact that they are a record in it
  'our database', 'in our system', 'your file', 'our records', 'came into our',
  // pressure, guilt and chase language
  'circling back', 'circle back', 'following up', 'follow up', 'checking in', 'checking back',
  'touching base', "haven't heard", 'have not heard', 'you never replied',
  'bugging you', 'bug you', 'chase you', 'chasing you',
  'am i safe to assume', 'give things a rest', 'last chance',
]

export function findBanned(text) {
  const s = String(text || '').toLowerCase()
  return BANNED.filter(p => s.includes(p))
}

// Each stage names the facts it is trying to learn. If a fact is already on file and
// fresh, the stage is skipped or converted to a confirmation rather than asked again.
export const CNC_STAGES = [
  {
    key: 't1', day: 1, label: 'First approach',
    goal: 'Is a move on their radar at all, asserting nothing about any past contact',
    asks: [],
    // Every one of these is true whether or not a conversation ever happened. They
    // introduce John, ask one easy question, and claim nothing else.
    messages: [
      "{{greeting}} {{first_name}}, it's John with Matt Smith Team at RE/MAX. Just curious, if the right home came along, would you still be open to making a move, or is that more of a down-the-road idea now?",
      "{{greeting}} {{first_name}}, it's John with Matt Smith Team at RE/MAX. Is buying something you'd consider if the right place came along?",
      '{{greeting}} {{first_name}}, John with Matt Smith Team at RE/MAX here. I was curious whether a move is somewhere on your radar these days.',
      "{{greeting}} {{first_name}}, it's John with Matt Smith Team at RE/MAX. Are you keeping an eye on homes at all, even casually?",
      '{{greeting}} {{first_name}}, John with Matt Smith Team at RE/MAX. If the right opportunity came up, would buying be something you’d consider?',
      "{{greeting}} {{first_name}}, it's John with Matt Smith Team at RE/MAX. Is buying somewhere on your radar, or more of a future idea at this point?",
      '{{greeting}} {{first_name}}, John with Matt Smith Team at RE/MAX. If something came up that genuinely fit what you were after, would you want to know about it?',
      "{{greeting}} {{first_name}}, it's John with Matt Smith Team at RE/MAX. Would a move be something you'd think about this year, or is the timing further out?",
    ],
  },
  {
    key: 't2', day: 4, label: 'Where they are',
    goal: 'Let them place themselves, without re-asking T1 in different words',
    asks: ['timing'],
    messages: [
      "{{greeting}} {{first_name}}, if you had to describe things right now, would you say you're actively looking, casually watching, or not really thinking about a move yet?",
      '{{greeting}} {{first_name}}, would you say buying is something you’re considering this year, sometime later, or only if the right home happens to come along?',
      '{{greeting}} {{first_name}}, are you more in the browsing stage right now, or would you actually consider moving if the right property showed up?',
      '{{greeting}} {{first_name}}, if something really good came up tomorrow, would you want to know about it?',
    ],
  },
  {
    key: 't3', day: 9, label: 'The barrier',
    goal: 'What would have to line up. Moves past status.',
    asks: ['other_preferences'],
    messages: [
      '{{greeting}} {{first_name}}, what would probably be the biggest thing that would need to line up before a move made sense for you?',
      '{{greeting}} {{first_name}}, is the bigger challenge usually finding the right home, or making the numbers work comfortably?',
      '{{greeting}} {{first_name}}, if buying has been on the back burner, what would need to change for it to make more sense?',
      "{{greeting}} {{first_name}}, what tends to matter most before you'd seriously consider moving: the right property, the right price, or the right timing?",
    ],
  },
  {
    key: 't4', day: 17, label: 'What would get their attention',
    goal: 'Learn one useful search preference',
    asks: ['must_haves', 'property_type', 'preferred_location'],
    messages: [
      "{{greeting}} {{first_name}}, if something really good came up, what's one thing it would need to have for you to actually want to go see it?",
      '{{greeting}} {{first_name}}, what type of home would get your attention these days?',
      "{{greeting}} {{first_name}}, is there a particular area where you'd be especially interested if the right home came up?",
      '{{greeting}} {{first_name}}, if we only sent something that looked genuinely worth seeing, what would you want us watching for?',
    ],
  },
  {
    key: 't5', day: 30, label: 'Back off and be useful',
    goal: 'Reduce pressure. No question needed.',
    asks: [],
    messages: [
      "{{greeting}} {{first_name}}, no pressure on anything. We're happy to just be a resource if a property catches your eye or you ever have a real estate question.",
      '{{greeting}} {{first_name}}, we’re happy to keep things low-key. If something unusually good comes up, we can always send it your way.',
      "{{greeting}} {{first_name}}, no need to be actively searching for us to help. If a home, area or pricing question comes up, we're here.",
      "{{greeting}} {{first_name}}, sometimes the timing just isn't there yet. We're happy to be a resource whenever it makes sense.",
    ],
  },
  {
    key: 't6', day: 50, label: 'Permission',
    goal: 'Is occasional future contact useful',
    asks: ['preferred_contact'],
    messages: [
      '{{greeting}} {{first_name}}, would an occasional heads-up if something especially good comes up still be useful?',
      '{{greeting}} {{first_name}}, should we keep you in mind if something interesting comes up, or is it better to leave things open for now?',
      '{{greeting}} {{first_name}}, if we came across a really strong opportunity, would you still want us to send it your way?',
      '{{greeting}} {{first_name}}, would you rather we keep you posted once in a while, or just leave the door open for whenever the timing feels right?',
    ],
  },
  {
    key: 'ltn1', day: 80, label: 'Long-term 1',
    goal: 'Stay present without another status question',
    asks: [],
    messages: [
      '{{greeting}} {{first_name}}, just wanted to leave the door open. If real estate ever moves higher on your list, we’re here whenever you need us.',
      '{{greeting}} {{first_name}}, no pressure at all. If you ever want a second opinion on a home, an area or pricing, we’re happy to help.',
      "{{greeting}} {{first_name}}, we're always happy to be a resource if a real estate question comes up, even if you're not planning a move anytime soon.",
    ],
  },
  {
    key: 'ltn2', day: 120, label: 'Long-term 2',
    goal: 'Have circumstances changed, after real time has passed',
    asks: ['timing'],
    messages: [
      '{{greeting}} {{first_name}}, a little time has passed, so I was curious whether anything has changed with your plans around moving.',
      '{{greeting}} {{first_name}}, has buying moved any higher on your list lately, or is the timing still pretty open-ended?',
      '{{greeting}} {{first_name}}, if the right home came along now, would you be any more open to making a move than you were a few months ago?',
    ],
  },
  {
    key: 'ltn3', day: 165, label: 'Long-term 3',
    goal: 'Learn or refresh preferences',
    asks: ['property_type', 'preferred_location', 'must_haves'],
    messages: [
      '{{greeting}} {{first_name}}, if you were looking today, what type of home would probably get your attention?',
      "{{greeting}} {{first_name}}, is there a particular area you'd want us keeping an eye on if something good came up?",
      '{{greeting}} {{first_name}}, if you ever made a move, what would matter most in the next home?',
    ],
    // Used instead of the above when the fact is already on file. Never pretend it was
    // never known; ask whether it changed.
    known: {
      preferred_location: '{{greeting}} {{first_name}}, are you still mainly interested in {{value}}, or has the area you’d consider changed at all?',
      property_type: '{{greeting}} {{first_name}}, are you still leaning towards {{value}}, or has the kind of home you’d want changed at all?',
      must_haves: '{{greeting}} {{first_name}}, is {{value}} still the thing that matters most, or has that shifted at all?',
    },
  },
  {
    key: 'ltn4', day: 210, label: 'Long-term 4',
    goal: 'Relationship maintenance',
    asks: [],
    messages: [
      '{{greeting}} {{first_name}}, no agenda here. Just wanted you to know we’re always happy to help if a real estate question ever comes up.',
      '{{greeting}} {{first_name}}, whenever the timing does make sense, we’re here if you need anything related to buying, selling or understanding the market.',
      '{{greeting}} {{first_name}}, even if a move is still a ways off, we’re always happy to help you make sense of anything real estate-related along the way.',
    ],
  },
]

// The homeowner question. Asked once, at an appropriate stage, only when we do not know.
export const HOME_TO_SELL_ASK =
  '{{greeting}} {{first_name}}, if you ever did find the right home, is there a house you’d need to sell first?'

// Every ~45-60 days after the staged sequence. The PURPOSE rotates, not the wording:
// an unanswered fact first, then a stale one, then plain usefulness.
export const LOOP_PURPOSES = ['unanswered_fact', 'stale_fact', 'homeowner_opportunity', 'market_useful', 'relationship']

/**
 * Pick the message for a stage, honouring what we already know.
 *
 * Returns null when every fact the stage exists to learn is already on file and fresh —
 * there is nothing for it to ask, so it should be skipped rather than padded out.
 */
export function selectMessage(clientId, stageKey, { rotation = 0 } = {}) {
  const stage = CNC_STAGES.find(s => s.key === stageKey)
  if (!stage) return null
  const profile = getProfile(clientId)

  // A fact that exists but has gone stale is worth revisiting as a confirmation.
  if (stage.known) {
    for (const field of Object.keys(stage.known)) {
      const f = factState(clientId, field)
      if (f.state === 'stale') {
        return { stage: stage.key, kind: 'confirm', field, text: stage.known[field].replace('{{value}}', f.value) }
      }
    }
  }

  if (stage.asks.length) {
    const unknown = stage.asks.filter(f => !profile[f])
    if (!unknown.length) {
      // Everything this stage wanted is known and fresh. Offer a confirmation if we have
      // wording for one, otherwise skip the stage entirely.
      if (stage.known) {
        for (const field of stage.asks) {
          if (stage.known[field] && profile[field]) {
            return { stage: stage.key, kind: 'confirm', field, text: stage.known[field].replace('{{value}}', profile[field].value) }
          }
        }
      }
      return null
    }
  }

  const bank = stage.messages
  return { stage: stage.key, kind: 'ask', text: bank[rotation % bank.length] }
}

/** Which fact this lane should chase next for a lead. Drives the ongoing loop. */
export function nextUsefulTopic(clientId) {
  const profile = getProfile(clientId)
  const order = ['preferred_location', 'timing', 'property_type', 'must_haves', 'price_max', 'home_to_sell']
  for (const f of order) if (!profile[f]) return { purpose: 'unanswered_fact', field: f }
  for (const f of order) if (profile[f]?.stale) return { purpose: 'stale_fact', field: f }
  return { purpose: 'relationship', field: null }
}
