// Cold-buyer nurture message bank. John's rewrite, 2026-10-13, used verbatim.
//
// WHAT CHANGED FROM THE OLD BANK
// 1. Every message now carries its own greeting and the lead's first name. The old renderer
//    bolted "Good afternoon {{first_name}}, it's John with Matt Smith Team at RE/MAX." onto
//    the front of a bare question, which is what made these read like CRM prompts.
// 2. "You can always browse the latest at MattSmithTeam.com" is gone from every message. It
//    was appended to all of them; the goal of these texts is a reply, not a click. Area-based
//    listing links replace it where they are actually relevant (see area-links.js).
// 3. "John with Matt Smith Team at RE/MAX" appears only in the Day 1 openers. After that the
//    conversation should feel continuous, not reintroduced every time.
//
// APOSTROPHES ARE DELIBERATELY STRAIGHT. A curly apostrophe is outside GSM-7, which forces
// the whole message into UCS-2 and cuts an SMS segment from 160 characters to 70 — most of
// these would silently become 3 segments instead of 1 or 2. Keep them straight.
//
// Merge fields: {{first_name}} and {{area}} only. {{area}} resolves to the lead's search
// city and is dropped to a safe phrase when unknown, so never write a message where {{area}}
// has to be present for the sentence to make sense.

/** Day 1 — reconnect naturally and learn what happened. The only stage that introduces John. */
export const DAY1 = [
  "Hi {{first_name}}! It's John with Matt Smith Team at RE/MAX. It's been a little while since we last connected, so I thought I'd check in. How did things end up going with the home search?",
  "Good morning, {{first_name}}! It's John with Matt Smith Team. I was looking back at our conversation and realized it's been a while. Did you ever end up finding a home, or did things get put on hold?",
  "Hi {{first_name}}! John here with Matt Smith Team. I was curious where things ended up for you. Were you able to find the right place, or are you still keeping an eye on things?",
  "Hi {{first_name}}! Hope you've been doing well. It's been a while since we talked about moving, and I wasn't sure if that was still in the plans or if things changed on your end.",
  "Good afternoon, {{first_name}}! Just wanted to reconnect since it's been a while. What are you thinking these days when it comes to making a move?",
  "Hi {{first_name}}! I was looking back at when we last talked about homes and wondered where things landed. Did you find something, or did you decide to take a break?",
  "Hi {{first_name}}! Hope all is well with you and the family. Is buying still somewhere on your radar, or has life taken things in a different direction for now?",
  "Good morning, {{first_name}}! It's been a while :) Did you ever end up buying, or are you still waiting for something that really feels worth making a move for?",
  "Hi {{first_name}}! Just thought I'd check in. Has what you're looking for changed at all since we last talked?",
  "Hi {{first_name}}! Curious where things ended up for you. Did you ever find a place you really liked, or did you decide to hold off for a while?",
  "Good afternoon, {{first_name}}! We connected a while back when you were looking at homes, and I realized we never really circled back. Did you ever end up making a move?",
  "Hi {{first_name}}! Hope things have been going well. Did life take you in a different direction, or is making a move still something you'd consider?",
  "Hi {{first_name}}! It's been a little while, so I thought I'd reconnect. What does the home search look like for you these days, if anything?",
  "Good morning, {{first_name}}! Are you actively looking again, or are you more in the casually-watching-the-market stage right now?",
  "Hi {{first_name}}! I wanted to check in because plans can change a lot over time. If you were to make a move now, what would that ideally look like?",
  "Hi {{first_name}}! Did you ever find what you were looking for, or are you still waiting for something that actually feels worth moving for?",
  "Good afternoon, {{first_name}}! It's been a while since we connected. Any chance a move is still somewhere in the plans this year?",
  "Hi {{first_name}}! I know it's been some time since we talked. Did buying end up going on the back burner, or is it something you're thinking about again?",
  "Hi {{first_name}}! Just wanted to reconnect and see where things stand these days. If the right home came along, would you still be open to making a move?",
  "Good morning, {{first_name}}! It's been a while :) Did you already find a home, or should we still keep you in mind if something especially good comes up?",
  "Hi {{first_name}}! We probably could've done a better job staying in touch after we last talked. A lot has changed since then, so I wanted to check in and see whether a move is still something you're considering.",
  "Hi {{first_name}}! No rush on anything. I mainly wanted to make sure you have good information whenever the timing does feel right. Is buying something you could see happening in the next year or so?",
  "Good afternoon, {{first_name}}! I came across something in {{area}} that reminded me of what you were looking for before. I wasn't sure if you're still in the market, but would you want me to send something over if it really checked the boxes?",
  "Hi {{first_name}}! Quick question. If the right home came up in {{area}} at a price that made sense, would you still want to hear about it?",
]

/** Day 4 — make it easy to tell us their status. */
export const DAY4 = [
  "Hi {{first_name}}! Just so I know how to best stay in touch, are you still looking, taking a break for now, or did you already find a home?",
  "Good morning, {{first_name}}! I wasn't sure where things landed on your end. Is buying still something you're hoping to do, or have your plans changed?",
  "Hi {{first_name}}! Quick question so I don't make assumptions. Are you actively looking, casually watching, or pretty much on hold right now?",
  "Hi {{first_name}}! Did the home search end up going on the back burner, or are you still keeping your options open?",
  "Good afternoon, {{first_name}}! If the right home came along right now, would you still be open to making a move?",
  "Hi {{first_name}}! I wasn't sure if buying was still on your radar. Are you still looking around at all, or have things gone in a different direction?",
  "Hi {{first_name}}! Are you still keeping an eye on homes here and there, or did you decide to take a break from it for now?",
  "Good morning, {{first_name}}! Just curious, did you ever end up finding something, or are you still waiting for the right one?",
  "Hi {{first_name}}! Should we still keep you in mind if something really good comes up, or are things on hold for now?",
  "Hi {{first_name}}! Has anything changed with your plans since you first started looking?",
  "Good afternoon, {{first_name}}! Do you think a move could still happen this year, or is the timing pretty open-ended now?",
  "Hi {{first_name}}! Just trying to get a better feel for where you're at so we can actually be helpful. Still looking, or taking a break for a while?",
  "Hi {{first_name}}! Did you ever get close to anything you really liked, or has nothing quite felt right yet?",
  "Good morning, {{first_name}}! Would you still be open to buying if the right opportunity came along, even if you're not actively searching every day?",
  "Hi {{first_name}}! Has the home search stayed somewhere on your radar, or have other things taken priority lately?",
  "Hi {{first_name}}! Are you still watching the market at all these days, even casually?",
  "Good afternoon, {{first_name}}! Did your plans change, or are you mostly just taking your time and waiting for the right place?",
  "Hi {{first_name}}! If something really good came up tomorrow, would you want us to make sure you knew about it?",
  "Hi {{first_name}}! Are you still considering a move at some point, even if you're not actively searching right now?",
  "Good morning, {{first_name}}! Totally fine either way, I'm just trying to understand where things stand. Is buying still somewhere in the plans?",
]

/** Day 9 — understand the actual obstacle. */
export const DAY9 = [
  "Hi {{first_name}}! I'm curious, what's been the biggest thing keeping a move from happening so far?",
  "Good morning, {{first_name}}! Has it mainly been not finding the right home, or is there something else that's made the timing difficult?",
  "Hi {{first_name}}! A lot has changed in the market. Have prices, rates, or what's available changed the way you're thinking about buying?",
  "Hi {{first_name}}! Have you mostly just not found anything you really love, or did the timing stop making sense?",
  "Good afternoon, {{first_name}}! What would you say has been the hardest part of the home search so far?",
  "Hi {{first_name}}! Is finding the right home the bigger challenge, or is it more about getting comfortable with the numbers?",
  "Hi {{first_name}}! Thinking back at the homes you've looked at, what do you feel like has been missing?",
  "Good morning, {{first_name}}! Have prices changed the range you're comfortable with, or are you still thinking around the same numbers?",
  "Hi {{first_name}}! Is there anything in particular you're waiting on before you'd feel comfortable making a move?",
  "Hi {{first_name}}! If you decided to pause the search, what was the biggest reason behind it?",
  "Good afternoon, {{first_name}}! Has anything about the market made you more hesitant about buying than you were before?",
  "Hi {{first_name}}! Are you mostly waiting for a better home to come along, or for the timing to feel better?",
  "Hi {{first_name}}! What would need to change for buying to make more sense for you right now?",
  "Good morning, {{first_name}}! Did what was available get frustrating, or are you simply in no hurry to move?",
  "Hi {{first_name}}! Are you seeing homes you like but not loving the prices, or are you just not seeing the kind of homes you want at all?",
  "Hi {{first_name}}! Has your budget or what you want in the next home changed much since you first started looking?",
  "Good afternoon, {{first_name}}! If you had to pick one thing that has held the move up the most, what would it be?",
  "Hi {{first_name}}! Are you waiting on anything specific before jumping back into the search?",
  "Hi {{first_name}}! What's been the bigger challenge lately, finding the right house or making the numbers work comfortably?",
  "Good morning, {{first_name}}! Sometimes plans just change. Was there anything in particular that made you slow down the home search?",
]

/** Day 17 — discover what would actually motivate them. */
export const DAY17 = [
  "Hi {{first_name}}! If something really good came up, what would it need to have for you to actually want to go see it?",
  "Good morning, {{first_name}}! What are the one or two things your next home absolutely has to have?",
  "Hi {{first_name}}! If I were keeping an eye out for you, what's the one thing you'd really want me watching for?",
  "Hi {{first_name}}! Is there a particular neighborhood or area where you'd still move pretty quickly if the right home came up?",
  "Good afternoon, {{first_name}}! What would make you look at a listing and say, \"Okay, that one is actually worth seeing\"?",
  "Hi {{first_name}}! If the right home showed up tomorrow, what would it ideally look like?",
  "Hi {{first_name}}! Is there an area you'd still really like to end up in if you made a move?",
  "Good morning, {{first_name}}! What's one feature you really don't want to compromise on in the next home?",
  "Hi {{first_name}}! If you could find the right home in the perfect area, where would that be?",
  "Hi {{first_name}}! Are there certain styles or types of homes you'd still be excited to see?",
  "Good afternoon, {{first_name}}! What would a home need to do differently from what you've already seen to really get your attention?",
  "Hi {{first_name}}! If I only sent you homes that were genuinely worth looking at, what should I be watching for?",
  "Hi {{first_name}}! Has what you're looking for changed much since you originally started searching?",
  "Good morning, {{first_name}}! What matters most to you these days: the location, the home itself, or getting the right price?",
  "Hi {{first_name}}! Is there an area where you'd move quickly if something especially good became available?",
  "Hi {{first_name}}! What do you feel like you haven't been seeing enough of in the homes coming on the market?",
  "Good afternoon, {{first_name}}! If you could pick just three must-haves for the next home, what would they be?",
  "Hi {{first_name}}! Are you pretty flexible on what the next home looks like, or do you have something pretty specific in mind?",
  "Hi {{first_name}}! What kind of home would actually get you excited about looking again?",
  "Good morning, {{first_name}}! If we came across something that checked most of your boxes, would you want me to send it your way?",
]

/** Day 30 — back off and become useful. */
export const DAY30 = [
  "Hi {{first_name}}! I don't want to keep bugging you about the home search. I'm happy to just keep an eye on things and reach out if something genuinely worth seeing comes up.",
  "Good morning, {{first_name}}! Rather than keep checking in with the same questions, I'm happy to just watch the market and let you know if something unusually good pops up.",
  "Hi {{first_name}}! If you're not ready right now, no worries at all. We can simply keep you posted if something comes along that looks like a really good fit.",
  "Hi {{first_name}}! Happy to stay in the background and just be a resource whenever a real estate question comes up.",
  "Good afternoon, {{first_name}}! No need to make any decisions right now. If something comes up that looks like a great fit for you, I'm happy to send it over.",
  "Hi {{first_name}}! I know timing can change. I'm happy to keep an eye on things so you don't have to constantly watch the market yourself.",
  "Hi {{first_name}}! Rather than keep filling your phone with follow-ups, I'd rather reach out when I actually have something useful to share.",
  "Good morning, {{first_name}}! If the search is on pause, that's completely fine. We can always pick things back up whenever the timing makes sense.",
  "Hi {{first_name}}! I'm happy to keep things simple and only send something when I think it's genuinely worth a look.",
  "Hi {{first_name}}! If you'd rather casually watch the market for now, that's perfectly fine. I'm here whenever something catches your eye.",
  "Good afternoon, {{first_name}}! No rush on anything. If you ever want information on a home, pricing, an area, or just what we're seeing in the market, feel free to reach out.",
  "Hi {{first_name}}! Even if buying isn't happening anytime soon, I'm always happy to be a resource if questions come up.",
  "Hi {{first_name}}! I'll keep an eye on things from our side. If something unusually good comes up, I'll make sure you know about it.",
  "Good morning, {{first_name}}! You don't have to be actively looking for us to help. If you ever want a second opinion on a home, just send it over.",
  "Hi {{first_name}}! If you're waiting for the right opportunity, I'm happy to help keep an eye out in the meantime.",
  "Hi {{first_name}}! Sometimes waiting is better than forcing the wrong move. Whenever something changes on your end, we're here.",
  "Good afternoon, {{first_name}}! If you want, we can keep this really low-key and just make sure you don't miss something unusually good.",
  "Hi {{first_name}}! Happy to be your real estate resource whether you buy next month, next year, or you're still figuring things out.",
  "Hi {{first_name}}! Whenever you're ready to start looking seriously again, we can pick things right back up from where you left off.",
  "Good morning, {{first_name}}! No pressure from us. If something eventually comes along that makes sense for you, we'll be here to help.",
]

/** Day 50 — permission-based closeout. Keep these short. */
export const DAY50 = [
  "Hi {{first_name}}! Should I keep you posted if something good comes up, or give you some space for now?",
  "Good morning, {{first_name}}! Don't want to keep chasing you :) Should I still keep you on my radar for homes?",
  "Hi {{first_name}}! Quick yes or no, would you still want to hear about a really good home if one came up?",
  "Hi {{first_name}}! Should I keep an eye out for you, or has the timing passed for now?",
  "Good afternoon, {{first_name}}! Am I safe to assume the home search is on hold for now? :)",
  "Hi {{first_name}}! Should we keep you posted occasionally, or would you rather reconnect when the timing is better?",
  "Hi {{first_name}}! Don't want to make assumptions. Is buying still somewhere on your radar?",
  "Good morning, {{first_name}}! Should I stay in touch once in a while, or give the home search a rest for now?",
  "Hi {{first_name}}! If I see something that looks like a genuinely good opportunity, still okay to send it your way?",
  "Hi {{first_name}}! Would you rather I keep you posted on good homes, or leave the ball in your court for now?",
  "Good afternoon, {{first_name}}! Is it fair to say buying is probably on the back burner right now?",
  "Hi {{first_name}}! Should we keep watching the market for you, or are you good for now?",
  "Hi {{first_name}}! Still okay if I reach out if something especially good comes up?",
  "Good morning, {{first_name}}! Don't want to overdo the follow-up. Want me to keep you in the loop occasionally or give things some time?",
  "Hi {{first_name}}! Would an occasional heads-up on a really good property still be useful?",
  "Hi {{first_name}}! Should I keep you in mind if something interesting comes up?",
  "Good afternoon, {{first_name}}! If your plans have completely changed, that's totally okay too. Just let me know so I'm not bothering you unnecessarily.",
  "Hi {{first_name}}! I'm happy to leave the ball in your court and just be here whenever you need us. Sound good?",
  "Hi {{first_name}}! Don't want to clutter your phone if the timing isn't right. Should I give things a rest for now?",
  "Good morning, {{first_name}}! Last thing I want to do is bug you. Still want us keeping an eye out for you, or should we pause for now?",
]

/** Day 80 — long-term nurture, door left open. */
export const DAY80 = [
  "Hi {{first_name}}! Hope you've been doing well. Just wanted to leave the door open if buying ever comes back onto your radar. We're here whenever the timing feels right.",
  "Good morning, {{first_name}}! Just keeping in touch. If your plans ever shift and you want to start looking again, we're always happy to help.",
  "Hi {{first_name}}! Hope all is well. No idea if buying is still in the plans, but I wanted you to know we're here anytime you need anything.",
  "Hi {{first_name}}! Just touching base after giving you some space. If the home search ever comes back around, feel free to reach out anytime.",
  "Good afternoon, {{first_name}}! Keeping this low-key, but if something changes and you want to take another look at the market, we're here.",
]

/** Day 120 — have circumstances changed? */
export const DAY120 = [
  "Hi {{first_name}}! It's been a little while. Has anything changed on your end when it comes to buying, or are you pretty comfortable where things are for now?",
  "Good morning, {{first_name}}! A few months have gone by, so I thought I'd check in. Any change in your plans around making a move?",
  "Hi {{first_name}}! Just checking in after giving things some time. Has buying come back onto your radar at all?",
  "Hi {{first_name}}! A lot can change in a few months. Is a move starting to make any more sense, or are you still pretty comfortable staying put?",
  "Good afternoon, {{first_name}}! It's been a while, so I thought I'd say hi. If anything has changed with your plans, I'm happy to help however I can.",
]

/** Day 165 — revisit preferences. */
export const DAY165 = [
  "Hi {{first_name}}! Random question. If you started looking again today, would you be looking for pretty much the same thing, or has what you want changed?",
  "Good morning, {{first_name}}! If you made a move now, would you still be looking in the same area as before?",
  "Hi {{first_name}}! If buying came back into the picture, do you think your idea of the right home would be any different now?",
  "Hi {{first_name}}! Curious if what you'd want in your next home has changed at all since you originally started looking.",
  "Good afternoon, {{first_name}}! If the right opportunity came along now, what would matter most to you?",
]

/** Day 210 — relationship maintenance. */
export const DAY210 = [
  "Hi {{first_name}}! Just wanted to keep the door open. If buying ever becomes a priority again, we're here whenever you need us.",
  "Good morning, {{first_name}}! No pressure at all, just staying in touch. If you ever want to start looking again, I'm happy to help.",
  "Hi {{first_name}}! It's been a while, but I didn't want you to feel like you couldn't reach out if real estate comes back onto your radar.",
  "Hi {{first_name}}! Whenever the timing feels right, whether that's soon or much later, we're always happy to be a resource.",
  "Good afternoon, {{first_name}}! Just keeping in touch from time to time. If anything changes with your plans, you know where to find us.",
]

/** Ongoing 45 to 60 day nurture. Rotate the PURPOSE, never just "are you still looking?". */
export const ONGOING = [
  "Hi {{first_name}}! Hope you've been doing well. Just checking in from time to time. If buying ever moves back up your list, I'm here whenever you're ready.",
  "Good morning, {{first_name}}! Hope all is well with you. If your plans around moving have shifted at all, I'm always happy to help you think through the options.",
  "Hi {{first_name}}! Random thought. If you were to make a move down the road, is there a particular area or type of home you'd want me keeping an eye out for?",
  "Hi {{first_name}}! Just wanted to remind you I'm always happy to be a real estate resource, whether it's a question about a property, value, timing, or what we're seeing in the market.",
  "Good afternoon, {{first_name}}! Whenever the timing feels right for a move, we can pick things right back up from wherever you left off.",
  "Hi {{first_name}}! Something you may find useful, if you're ever curious what your current home could realistically sell for in today's market, I'd be happy to put together an updated look for you. No pressure to move.",
  "Hi {{first_name}}! Hope things are going well. If anything has changed on your end and buying is starting to make sense again, I'm around whenever you want to talk.",
  "Good morning, {{first_name}}! No agenda here, just staying in touch. If a move ever starts making sense again, we'd be happy to help make the process easier.",
]

export const BUYER_BANKS = { DAY1, DAY4, DAY9, DAY17, DAY30, DAY50, DAY80, DAY120, DAY165, DAY210, ONGOING }

/** Every message in the bank, for the checks that have to hold across all of them. */
export const ALL_BUYER_MESSAGES = Object.values(BUYER_BANKS).flat()
