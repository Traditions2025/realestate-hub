// Decide what each step should actually say, given what the homeowner already told us.
//
// John, 2026-10-29: the landing page grew to nine screens and the sequence did not notice.
// A homeowner would rate their condition, list their updates and say when they might move,
// and then be asked all three again by text. The old sequence was template-driven - it sent
// day 3's question on day 3 because it was day 3. This makes it goal-driven: before every
// step, read what is known and decide whether that message is still worth sending.
//
// Three answers, and `skip` is as important as `send`:
//   send     this message, possibly rewritten to use what they told us
//   skip     nothing useful left to say here - advance the schedule, do not send
//   handoff  stop automating; a person owns this conversation now
//
// It never invents a question. When nextBestQuestion() returns null the step either
// interprets what is known or steps aside.
import {
  latestAnswers, learnedFacts, nextBestQuestion, timeframeLane, known,
  proseForHomeowner, remodelLabel, isPastClient,
} from './home-value-answers.js'

const send = (payload) => ({ action: 'send', ...payload })
const skip = (reason) => ({ action: 'skip', reason })
const handoff = (reason) => ({ action: 'handoff', reason })

/** A short, quotable version of what they said keeps it from a 10. */
function gapPhrase(a) {
  const g = proseForHomeowner(a?.condition_gap)
  if (!g) return ''
  const one = g.split(/[.;\n]/)[0].trim()
  return one.length > 90 ? '' : one.replace(/^[A-Z]/, (m) => m.toLowerCase())
}

/** "the roof and the kitchen" from the update list, for referencing back. */
function updatePhrase(a) {
  const items = Object.keys(a?.updates || {})
  if (!items.length) return ''
  const names = items.slice(0, 2).map((i) => i.toLowerCase())
  return names.length === 2 ? `the ${names[0]} and the ${names[1]}` : `the ${names[0]}`
}

/** The updates they listed without an age, which is the only thing left to ask about them. */
function undatedUpdates(a) {
  return Object.entries(a?.updates || {})
    .filter(([, age]) => !age || /unsure/i.test(String(age)))
    .map(([item]) => item.toLowerCase())
}

/**
 * @param {object} client  the lead
 * @param {object} step    one of HV_STEPS
 * @param {object} f       merge fields: { first_name, street }
 */
export function resolveStep(client, step, f) {
  const cid = Number(client?.id)
  const a = latestAnswers(cid) || {}
  const learned = learnedFacts(cid) || {}
  const lane = timeframeLane(cid, a, learned)
  const nextQ = nextBestQuestion(cid)
  const street = f.street
  const name = f.first_name

  // PAST CLIENTS GET EMAIL, NEVER TEXT (John, 2026-11-05). They already know us and are
  // on the long-term nurture by email; a text asking them to rate their own house reads
  // as cold prospecting from the one team that should know better. Skipped rather than
  // refused, so the step advances and the EMAIL half of the sequence carries on.
  if (step.channel === 'sms' && isPastClient(client)) {
    return skip('past client - home value goes by email only')
  }

  // A stated move inside three months is not a drip problem. Whatever step is due, a
  // person takes it from here - and the generic qualification stops rather than running
  // underneath the conversation they are already having.
  if (lane === 'hot' && step.channel === 'sms') {
    return handoff('timeframe is 1-3 months - a person owns this, not a scheduled text')
  }

  switch (step.key) {
    // ---- Day 1: explain condition, but never ask for a number we already have --------
    case 'day1_email': {
      if (!known(cid, 'condition', a, learned)) return send({})   // the original copy stands
      return send({
        subject: `What the estimate can't see at ${street}`,
        paras: [
          `Thanks again for requesting the value of your home at ${street}, and for taking the time to tell us about it.`,
          `You rated the overall condition a ${a.condition_rating || learned.condition_rating} out of 10. That is genuinely useful, because condition is the one thing an automated valuation cannot see.`,
          `Two homes with similar square footage, bedrooms and location can still sell very differently depending on how they have been maintained and updated.`,
          `We will factor what you shared into the overall picture rather than relying only on the automated number.`,
          `Thanks!`,
        ],
      })
    }

    // ---- Day 3: improvements, or the next thing we genuinely do not know -------------
    case 'day3_improvements': {
      if (!known(cid, 'updates', a, learned)) return send({})     // original question stands
      const undated = undatedUpdates(a)
      if (undated.length) {
        return send({ text: `${name ? name + ', ' : ''}you mentioned work on ${undated.slice(0, 2).join(' and ')}. Roughly when was that done? A rough estimate is completely fine.` })
      }
      if (!known(cid, 'remodel_depth', a, learned)) {
        return send({ text: `${name ? name + ', ' : ''}you mentioned updating ${updatePhrase(a)}. Roughly how extensive was that work, more of a refresh or a full remodel?` })
      }
      if (!nextQ) return skip('every property question is already answered')
      return skip(`nothing left to ask about improvements (next useful question: ${nextQ})`)
    }

    // ---- Day 5: why improvements matter, using theirs -------------------------------
    case 'day5_email': {
      const phrase = updatePhrase(a)
      if (!phrase) return send({})
      const depth = remodelLabel('remodel_kitchen', a.remodel_kitchen)
      return send({
        subject: `What you've done to ${street}`,
        paras: [
          `One of the biggest limitations with online home-value estimates is that they usually do not know what has actually been improved inside a property.`,
          `You told us about ${phrase}${depth ? `, and that the kitchen work was ${depth}` : ''}. That is exactly the kind of detail an automated estimate tends to miss.`,
          `Improvements like those can affect how buyers compare one home with another, and how a home shows against others on the market at the same time.`,
          `We will use what you shared alongside current local market data and comparable sales to give a more realistic picture than the automated number on its own.`,
          `Thanks again!`,
        ],
      })
    }

    // ---- Day 8: the form never asks what is BEST about the home ---------------------
    case 'day8_buyer_notice': {
      if (known(cid, 'best_feature', a, learned)) {
        return skip('they have already told us the best feature')
      }
      return send({ text: `${name ? name + ', ' : ''}one thing that is hard to tell from public records is what makes a home stand out in person. What would you say is the best feature of ${street}?` })
    }

    // ---- Day 11: buyer perspective, referencing their answer ------------------------
    case 'day11_email': {
      const best = proseForHomeowner(learned.home_best_feature)
      if (!best) return send({})
      return send({
        subject: `How a buyer would see ${street}`,
        paras: [
          `You mentioned that ${best.replace(/^[A-Z]/, (m) => m.toLowerCase())} is one of the things that stands out about the home.`,
          `That is useful context, because buyers rarely compare homes on square footage alone. Features, condition, layout, setting and the overall feel of a home all influence how one property compares with another.`,
          `It is also the kind of thing an automated estimate has no way of accounting for.`,
          `We will keep it in mind when we look at how ${street} compares with what has recently sold nearby.`,
        ],
      })
    }

    // ---- Day 15: they already told us their timeframe -------------------------------
    case 'day15_intent': {
      if (!known(cid, 'timeframe', a, learned)) return send({})   // the original question stands
      if (lane === 'browse') {
        // no question at all: they said they are just curious, so asking about moving
        // would ignore the answer they gave us
        return send({ text: `${name ? name + ', ' : ''}one thing we will be looking at is how ${street} compares with homes that have actually sold nearby. That usually gives much better context than the automated number on its own.` })
      }
      if (lane === 'warm') return handoff('timeframe is 3-6 months - worth a person, not a scheduled text')
      return send({ text: `${name ? name + ', ' : ''}if you did eventually make a move, do you already have an idea where you would want to go next?` })
    }

    // ---- Day 19: do not re-ask which situation they are in --------------------------
    case 'day19_email': {
      if (lane === 'unknown') return send({})
      if (lane === 'browse') {
        return send({
          subject: `Why the number is worth knowing anyway`,
          paras: [
            `You mentioned you are mostly keeping an eye on things rather than planning a move, which is exactly how most people use a home value.`,
            `It is still worth knowing. Your equity position changes as the market moves and as you pay down the loan, and that affects decisions that have nothing to do with selling: refinancing, insurance cover, a renovation budget, or simply knowing where you stand.`,
            `We will keep an eye on what is happening around ${street} and let you know if something meaningful changes.`,
          ],
        })
      }
      return send({
        subject: `Knowing the value is one part of planning ahead`,
        paras: [
          `Since a move is something you are thinking about, the value of ${street} is really the starting point rather than the whole picture.`,
          `The other half is what comes next: what your equity looks like once costs are accounted for, what the next home would realistically cost, and whether a sale would need to line up with a purchase.`,
          `None of that needs deciding now. It is just the sort of thing that is much easier to work out early than in a hurry.`,
          `If it would help to talk any of it through, just reply and we will go from there.`,
        ],
      })
    }

    // ---- Day 23: where would they go, only if that is a real question ---------------
    case 'day23_where': {
      if (lane === 'browse') return skip('they told us they are just curious')
      if (known(cid, 'destination', a, learned)) return skip('they have already told us where')
      return send({})
    }

    // ---- Day 32 and 37: the estimate reaction, which the form never asks ------------
    case 'day32_expectation': {
      if (known(cid, 'valuation_reaction', a, learned)) return skip('they have already told us how it landed')
      return send({})
    }

    case 'day37_email': {
      const re = String(learned.valuation_reaction || '').toLowerCase()
      if (!re) return send({})
      const felt = /high/.test(re) ? 'higher than you expected'
        : /low/.test(re) ? 'lower than you expected' : 'about what you expected'
      return send({
        subject: `Why the estimate for ${street} may read that way`,
        paras: [
          `You mentioned the estimate felt ${felt}.`,
          `Online estimates are built from public records and nearby sales, so they tend to miss the things that actually separate one home from another: condition, improvements, where the home sits within the neighbourhood, and what else happens to be for sale at the time.`,
          `That is why we treat the automated number as a starting point rather than an answer.`,
          `If you would like a closer look at where ${street} really sits, just reply and we will put something together.`,
        ],
      })
    }

    default:
      return send({})
  }
}

/** Does this step still have a reason to exist for this lead? Used by the sweep. */
export function stepPlan(client, step, f) {
  try {
    return resolveStep(client, step, f)
  } catch (e) {
    // A resolver fault must never silence the campaign: fall back to the written copy.
    return { action: 'send', _error: e.message }
  }
}
