# FSBO and Cancelled/Expired Follow-Up Plan
_Matt Smith Team Hub — as built, 2026-09-23. Source of truth: `server/fsbo-followup.js`,
`server/cx-connect.js`, `server/fsbo-master.js`, `server/expired-master.js`._

Both campaigns run on the same doctrine: **make contact, never apply pressure.**
Text ten reads like text one. The moment a seller replies, automation stops and a
human owns the conversation — the AI never writes a reply to either audience.

---

## 1. FSBO Campaign

**Goal:** no eligible FSBO reaches 14 days on market and then gets forgotten.

### How a lead gets in
Zillow FSBO pull → FSBO master sheet → Hub sync (`fsbo-master.js`, matched on phone).
The lead carries `fsbo_status` (Available / Off Market), list date, DOM, price and link.

### Trigger
Auto-enrolls when the listing's **live DOM reaches 14** (`fsbo_campaign_dom_threshold`).
DOM is the listing's real days-on-market from the master file, not "days since the Hub
saw it" — a property imported at DOM 27 qualifies immediately.

### Cadence
| Step | When | Message |
|---|---|---|
| Text 1 | at DOM 14 | Availability check: noticed the home at {address}, still available? |
| Text 2 | +7 days | Still-available check (references Zillow still showing active) |
| Text 3 | +7 days | The 35-years / first-2-weeks message, split into 3 short texts so it is never a wall of text |
| Text 4+ | every 40-47 days | Availability-only rotation while the listing stays Available |

The 40+ day rotation uses 4 approved angles (availability recheck, still for sale,
contact preference, general check-in). No angle repeats within the last 3 sends.
No "we have a buyer", no "how has activity been", no manufactured urgency.

### Stop conditions
- **Any reply** → status `responded`, high-priority FSBO Response task, team notified. No automated reply, ever.
- Listing goes Off Market / sold / listed with an agent / drops off the master file
- STOP or opt-out, wrong number, do-not-contact
- Manual pause or remove (a human's decision always wins; sweeps never silently resume)
- Recent manual human contact defers the next send

Eligibility is re-verified before **every single send**, not just at enrollment.

---

## 2. Cancelled / Expired Campaign ("CX Connect")

**Goal:** make contact with cold Cancelled/Expired sellers and keep gently offering
chances to respond. Persistence means more opportunities to reply, never more pressure.

### How a lead gets in
Daily MLS pull → Expired/Cancelled master sheet → Hub (`expired-master.js`), tagged
`MLS: Cancelled` / `MLS: Expired`, moved New → Watch, assigned to Matt. The campaign
auto-enrolls from the Cancelled/Expired list hourly.

### Language adapts to how long the property has been off market
| Bucket | Off market | Tone |
|---|---|---|
| recent | 0-30 days | "recently came off the market" |
| mid | 31-90 days | "the previous listing" |
| old | 91-365 days | "from a while back… did it ever sell?" |
| ancient | 365+ days | "I know it's been quite a while…" |

An unknown off-market date uses the `old` wording, so we never claim recency we can't back up.

### Cadence
| Step | When |
|---|---|
| Text 1 | on enrollment — initial, worded by age bucket |
| Text 2 | day 2 or 3 (randomised) |
| Text 3 | ~day 7 |
| Text 4+ | roughly weekly, 6-8 day gaps, **no attempt cap** |

Gaps are deliberately varied so sends never settle into one fixed day or time: the
weekday drifts across the campaign, a weekend landing resolves to Friday or Monday,
and the time is random inside the window. Every send logs its timestamp, attempt
number and angle so we can analyse which days and times actually produce replies.

**17 rotating angles** (did it sell, plans changed, current plans, has anything
changed, future possibility, hold vs move, right offer, old listing, and more), each
gated to the age buckets it suits. No angle repeats within the last 3 sends.

### Stop conditions
- **Any reply** → status `response_received`, classified, human review flagged. The AI never replies to these leads.
- MLS status goes Sold / Pending / Active (relisted)
- Status becomes Junk / DNC / Closed / Not in Market
- STOP or opt-out, no phone, no property address
- Another automation owns the lead (HUB AI managing it)
- Recent manual human contact defers the next send

---

## 3. Rules both campaigns share

**Send window:** weekdays only, **9:00 AM - 4:00 PM Central**. Never weekends, never
evenings. Sends trickle 1-2.5 minutes apart — never a burst.

**Identity safety in cold texts:** always "the home at {address}", never "your home"
until they establish ownership, and no first names in cold prospecting.

**Compliance gates before every send:** STOP/opt-out, landline/undeliverable check,
quiet hours, holiday, duplicate-number collision, and a same-day dedup.

**Replies are never answered by AI.** Both campaigns exist to start a human
conversation; the automation's job ends the moment one starts.

**Manual enrolment is a human override (2026-09-23).** Enrolling by hand means "I have
a good number now", so it clears a stale bad-number verdict and forgives an old wrong
number reply, then fires immediately instead of waiting for the next sweep. It still
respects STOP, junk/DNC status, a missing number or address, and anything the lead
actually said (sold, rented, has an agent, not interested, already replied).

**Master switches:** `fsbo_followup_enabled` and `cx_campaign_enabled` — both ship OFF
so a deploy can never trigger a mass text.

---

## 4. Email drips (built, separate from the texts)

| Drip | Audience | Emails |
|---|---|---|
| The Ally (0-30 / 31-90 / 90+ days) | FSBO | 30 each |
| The Second Act (0-30 / 31-90 / 90+ days) | Cancelled/Expired | 30 each |

These are built and available but were showing **no active enrolments** when last
checked (2026-09-21) — the text campaigns are what's carrying these two audiences today.
