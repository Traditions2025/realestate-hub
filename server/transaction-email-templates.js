// Transaction email templates — buyer & seller workflows
import db from './database.js'

// Add N business days to a YYYY-MM-DD date (skip Sat/Sun). Returns YYYY-MM-DD.
function addBusinessDays(dateStr, n) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-').map(Number)
  if (parts.length !== 3 || parts.some(isNaN)) return ''
  const d = new Date(parts[0], parts[1] - 1, parts[2])
  let added = 0
  while (added < n) {
    d.setDate(d.getDate() + 1)
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

// Format a date string (YYYY-MM-DD) as "May 22, 2026"
function fmtLongDate(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-').map(Number)
  if (parts.length !== 3 || parts.some(isNaN)) return dateStr
  const d = new Date(parts[0], parts[1] - 1, parts[2])
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}
// Merge variables available:
//   Client: {{first_name}}, {{last_name}}, {{full_name}}, {{email}}, {{phone}}, {{address}}, {{city}}
//   Transaction: {{property_address}}, {{purchase_price}}, {{purchase_price_formatted}}, {{closing_date}},
//                {{contract_date}}, {{earnest_money}}, {{earnest_money_due_date}}, {{ipi_due_date}},
//                {{mortgage_contingency_date}}, {{appraisal_contingency_date}}, {{inspection_contingency_date}},
//                {{financing_release}}, {{final_walkthrough}}, {{type_of_finance}},
//                {{lender_name}}, {{lender_company}},
//                {{closer_name}}, {{closer_email}}, {{closer_company}}

const SIG = `

— Matt Smith Team
RE/MAX Concepts
(319) 431-5859 | matt@mattsmithteam.com
5235 Buffalo Rdg Dr NE, Cedar Rapids, IA 52411
https://www.mattsmithteam.com`

export const TRANSACTION_TEMPLATES = {
  // ============== BUYER TEMPLATES ==============
  buyer_under_contract: {
    name: '🏠 Buyer — Congratulations / Under Contract / Next Steps',
    role: 'buyer',
    recipient: 'client',
    subject: 'Congratulations On Your New Home at {{property_address}}! Matt Smith Team',
    body: `Hello {{first_name}},

Congratulations on the purchase of your new home at {{property_address}}!

Purchase Price: {{purchase_price_formatted}}

Closing Date: {{closing_date_long}}

This is such an exciting step, and we are so grateful you've trusted us to help guide you through the process. Buying a home is a big milestone, and while there are a lot of moving parts between now and closing, we'll be here every step of the way to make it as smooth as possible.

At this point, you are officially under contract, which means the agreement is fully signed and legally binding. As always, please reach out to us with any questions.

Here's what to expect next:

EARNEST MONEY
Thank you for already initiating the electronic ACH transfer for your earnest money. The amount of {{earnest_money}} will be held in trust by the listing broker, RE/MAX Concepts, and credited toward your costs at closing.

Earnest Money Summary
- Amount: {{earnest_money}}
- Method: Electronic ACH Transfer (Completed)
- Held by: RE/MAX Concepts
- Applied to: Credited toward closing costs

LOAN APPLICATION
You have started the loan process with {{lender_company}} and mortgage originator {{lender_name}}, and we've sent your purchase agreement over to them. Please make sure to provide any remaining requested documents as soon as possible to avoid delays.

You will also need to receive written loan commitment, including appraisal, by {{mortgage_contingency_date_long}}, as outlined in the contract. Your lender will coordinate the appraisal as part of this process.

Important reminder: while you are in the loan process, do not make any large purchases, open new credit accounts, or make other financial changes that could impact your credit. Lenders may recheck credit before closing.

INSURANCE CONTINGENCY
Per the contract, this purchase is subject to you obtaining an acceptable insurance estimate or bid within 7 business days of the accepted offer. This makes your deadline {{insurance_contingency_date_long}}. We recommend reaching out to your insurance provider this week to ensure the property meets your coverage requirements and that the premiums fit within your budget.

INSPECTIONS
It's great to hear you've already connected with an inspector. Per the purchase contract, you have 10 business days for all inspections, making the deadline {{inspection_contingency_date_long}}.

Inspections include:
- Whole Property Inspection
- Radon Test
- Wood-Destroying Insect Inspection

Please let us know once the date and time are finalized.

HOME WARRANTY
Per the contract, a 1-year home warranty is included and paid for by the seller.

UTILITIES
Within one week of your closing date, you will want to set utilities up in your name so service begins the morning of closing day. Utility providers for this property include:
- Alliant Energy: 800-255-4268
- MidAmerican Energy: 888-427-5632
- City of Cedar Rapids (Water/Sewer/Trash): 319-286-5900

FINAL WALKTHROUGH
Your final walkthrough will be scheduled for {{final_walkthrough_long}}. As we get closer to {{closing_date_long}}, we will confirm that time with you. This gives you the opportunity to make sure the home is in the expected condition before signing final paperwork.

CLOSING DAY
Your closing is scheduled for {{closing_date_long}}. We typically meet at the lender's office to sign final paperwork, and the appointment usually takes about an hour.

Also, {{closer_name}} from our team will be assisting with the closing coordination. She will be reaching out with documents and forms moving forward. {{closer_name}} has been an essential part of our team for over 25 years, so you'll be in excellent hands.

I've also attached the complete Purchase Agreement for your reference.

Please make sure you're aware of the deadlines above, and let us know if you have any questions along the way. Congratulations again, {{first_name}}!

From all of us at The Matt Smith Team${SIG}`,
  },

  buyer_inspection: {
    name: '🔍 Buyer — Home Inspection / What to Expect',
    role: 'buyer',
    recipient: 'client',
    subject: 'Home Inspection for Your New Home at {{property_address}}: What to Expect',
    body: `{{first_name}},

As we wait for confirmation on the final inspection date, we wanted to reach out before it takes place and before the report comes back to walk you through what to expect and make sure we are prepared to move through this part of the process smoothly and confidently.

The inspection period is now your opportunity to get a thorough, professional look at exactly what you're buying. The best way to protect the position you've earned is to approach this next step with the same focus and good faith that got you here.

WHAT THE INSPECTION IS DESIGNED TO DO
A home inspection exists to identify major concerns in four specific categories: structural integrity, mechanical systems (HVAC, electrical, plumbing), safety hazards, and health-related conditions like active moisture or air quality issues. That is its purpose. It is not designed to make an older home new, to surface every item that could theoretically be improved, or to serve as a tool to renegotiate the purchase price.

THE REPORT WILL BE LONG — THAT DOESN'T MEAN THE HOME IS IN BAD SHAPE
A thorough inspector notes everything they observe, including items that are aging but functional, items that don't meet current code but were built legally under older standards, and general maintenance observations. A long report is the sign of a thorough inspector, not a troubled home. We'll go through it together and identify what actually requires attention.

HOW WE BUILD A REPAIR REQUEST THAT WORKS
The requests that hold up — and that move us toward closing efficiently — are focused on items that are genuinely non-functional, pose a safety risk, or represent a health concern. Items that typically fall outside a seller's obligation include:
- Cosmetic wear consistent with the age and condition of the home
- Components that work but that you'd prefer to have newer or upgraded
- Items the inspector recommends "monitoring" rather than addressing now
- General maintenance that comes with owning any home
- Anything that would bring the home beyond its current condition

A focused, reasonable repair request built around what genuinely matters is what moves a transaction forward. It protects the progress we've made and keeps both parties working toward the same goal — closing. We'll build it that way together, and we'll be right there with you at every step.

YOU HAVE A REAL SAFETY NET
Our job throughout this process is to make sure you have complete clarity on what you're buying — so that when we get to the closing table, you're arriving with full confidence, no surprises, and no second-guessing. That protection is real, and we will always make sure you know your options clearly. The goal is to use this process for exactly what it's designed for — getting the full picture on the home you're excited about and closing with confidence.

Please let us know if you have any questions. Come in curious, not worried — this is the process working exactly as it should, and we've got you covered.${SIG}`,
  },

  buyer_utilities_reminder: {
    name: '⚡ Buyer — Utilities Setup Reminder (1 business week out)',
    role: 'buyer',
    recipient: 'client',
    subject: 'Action needed: Set up utilities for {{property_address}} before {{closing_date}}',
    body: `Hi {{first_name}},

Quick reminder — closing on {{property_address}} is coming up on {{closing_date}}, which means it's time to set up your utilities.

You'll want everything turned on in your name so service starts the morning of closing day. Please contact each provider at least 1 business week (5 business days) before closing.

CEDAR RAPIDS / LINN COUNTY UTILITY PROVIDERS

Electric:
- Alliant Energy: 800-255-4268
- Linn County REC (rural): 800-255-4268

Gas:
- MidAmerican Energy: 888-427-5632

Water / Sewer / Trash:
- City of Cedar Rapids: 319-286-5900
- City of Marion: 319-377-1581
- City of Hiawatha: 319-393-1515

Internet / Cable (optional, schedule install):
- Mediacom: 855-633-4226
- ImOn Communications: 319-298-6484
- CenturyLink / Quantum Fiber: 800-244-1111

WHAT TO TELL EACH PROVIDER
- Service start date: {{closing_date}}
- Property address: {{property_address}}
- You're the new owner

Once everything's scheduled, just reply and let us know — we'll note it in the file. If you need help with any of these, give us a call at (319) 431-5859.

Thanks!${SIG}`,
  },

  buyer_closing_reminder: {
    name: '📅 Buyer — Closing Reminder (1 week out)',
    role: 'buyer',
    recipient: 'client',
    subject: 'Closing reminders for {{property_address}} — coming up {{closing_date}}',
    body: `Hi {{first_name}},

We're one week out from closing on {{property_address}} on {{closing_date}}. Quick reminders so everything stays on track:

UTILITIES — please set up at least 1 business week (5 business days) before closing
Set the following in your name effective {{closing_date}}:
- Electric: Alliant Energy 800-255-4268 (or Linn County REC 800-255-4268 for rural)
- Gas: MidAmerican Energy 888-427-5632
- Water/Sewer/Trash: City of Cedar Rapids 319-286-5900 (Marion 319-377-1581 / Hiawatha 319-393-1515)
- Internet: Mediacom, ImOn, or CenturyLink (at your preference)

INSURANCE
Make sure your homeowners insurance binder lists {{closing_date}} as the effective date. The lender will need a copy.

FINAL WALKTHROUGH
Scheduled for {{final_walkthrough}}. We'll confirm the exact time with you a day or two before. Plan on about 30 minutes.

CLOSING DAY
Scheduled for {{closing_date}}. We'll meet at the lender's office (or wherever {{closer_name}} confirms) — typically an hour. Please bring:
- Government-issued photo ID
- Cashier's check or wire confirmation for your closing funds
- Any final documents {{closer_name}} requested

WIRING FUNDS — IMPORTANT
If you're wiring closing funds, ALWAYS call {{closer_name}} at {{closer_company}} to verbally confirm wire instructions before sending. Wire fraud in real estate is real and rising — never trust wire instructions sent only by email.

Please reach out with any last questions. Almost there!${SIG}`,
  },

  // ============== SELLER TEMPLATES ==============
  seller_listing_live: {
    name: '🎉 Seller — Your Home Is Now Live',
    role: 'seller',
    recipient: 'client',
    subject: 'Your home is now live! {{property_address}} :) – Matt Smith Team',
    body: `Hello {{first_name}},

We are officially live! :) Your home at {{property_address}} is now active on the MLS and visible to the public.

JUST A QUICK REMINDER FOR SHOWINGS
We'll use ShowingTime to organize all showings and notifications. It's a simple app that lets you review showing requests right from your phone.

How it works:
- You'll receive a text or app notification for each showing request
- Reply with "START" when prompted to opt in for SMS alerts
- Approve or decline directly via text or the app
- You'll be notified immediately if a showing is changed or canceled

To stay fully informed, we recommend downloading the ShowingTime app and enabling text notifications so you'll get updates in real time.

SHOWINGS, OFFERS, NEGOTIATION, AND CLOSING

For every showing: We always ask feedback from the buyer's agent right away, though it usually takes about 24-48 hours to receive a response. Once we do, you will be notified.

Receiving offers: When offers come in, our team will notify you immediately. Together, we will review each one, and Matt will walk you through the best options and strategies.

Please let us know if you have any questions.${SIG}`,
  },

  seller_under_contract: {
    name: '✅ Seller — Your Home Is Under Contract',
    role: 'seller',
    recipient: 'client',
    subject: 'Congratulations {{first_name}} – Your Home Is Now Under Contract! :) | {{property_address}}',
    body: `Hi {{first_name}},

Congratulations! :)

We've officially secured an offer for your home at {{property_address}}, and it is now under contract. This is an exciting step forward. The purchase price is {{purchase_price_formatted}}.

The buyers will be completing a whole property inspection, radon test, and wood-destroying insect inspection. We will keep you updated every step of the way as we move toward closing.

Thank you for trusting the Matt Smith Team with your home sale. We are on it!

We've attached the accepted offer document for your records.

As we move from contract to closing, here's your personalized timeline and next steps:

KEY STEPS & IMPORTANT DATES
- Contract Ratification: {{contract_date}} — Both parties have agreed to the terms, and the contract is now officially in effect.
- Type of Financing: {{type_of_finance}}
- Purchase Price: {{purchase_price_formatted}}
- Earnest Money: {{earnest_money}}
- Inspections: The buyers must complete all inspection results no later than {{inspection_contingency_date}}.
- Mortgage & Appraisal Contingency: {{mortgage_contingency_date}} — The buyer's financing and appraisal will be finalized by this date.
- Final Walkthrough: {{final_walkthrough}} — The buyers will make their final walkthrough to make sure the home is in the expected condition before signing final paperwork.
- Closing Day and Possession: {{closing_date}} — Ownership officially transfers to the buyer.

CLOSING SUPPORT
You'll soon hear from {{closer_name}} with {{closer_company}}, our dedicated closing coordinator. {{closer_name}} plays a key role in bringing everything together for a smooth closing. She will help gather all required information, coordinate with the title company, and prepare the final closing documents.

{{closer_name}} will be sending a few forms for you to complete. She'll also assist with obtaining your mortgage payoff, which is required for closing. To do this, she may request details such as loan numbers, Social Security numbers, and other necessary information.

{{closer_name}} has been a trusted part of our team for more than 25 years, and her expertise ensures every step is handled with care and accuracy. You'll be in excellent hands. The sooner you return the requested documents, the smoother the process will be.

We're here every step of the way to keep this experience as smooth and stress-free as possible. Please reach out anytime with questions or if anything needs clarification.

Warm regards,${SIG}`,
  },

  seller_photo_prep: {
    name: '📸 Seller — Photo Day Prep / Get Home Ready',
    role: 'seller',
    recipient: 'client',
    subject: 'Getting your home ready – key steps before listing | Matt Smith Team',
    body: `Hi {{first_name}},

As we get closer to your move-in date, we've arranged your home photos. The photographers fill up quickly, so please confirm the time slot we sent so we can lock it in.

In the meantime, here are the key steps to help your home photograph beautifully:

KEY REMINDERS FOR PHOTO DAY
- Remove 30-40% of items from countertops, shelves, and open spaces.
- Keep all surfaces clear — less makes rooms look larger and brighter.
- Turn all lights on and open blinds for maximum light.
- Use neutral towels, bedding, and décor for a clean, fresh look.
- Hide trash cans, Kleenex boxes, cords, and paper towels.
- Double-check that windows, mirrors, and floors are spotless.

To keep everything moving smoothly, please be sure to:
- Provide a spare key for the lockbox (for showings)

MARKETING & NEXT STEPS
Once photos are complete, it typically takes about 24 hours for the images to come back. When they do, we'll:
- Review and make sure everything looks perfect
- Do any final edits or virtual staging if needed
- Make the listing active and begin a full marketing launch

SHOWINGS WILL BE BY APPOINTMENT
All showings will happen by request and with your approval — nothing will be scheduled without your okay. We'll provide at least 1 hour's notice for each showing request so you have enough time to prepare.

BE OUT DURING SHOWINGS
We recommend being out of the house during showings. This allows buyers to explore freely, speak openly with their agent, and imagine themselves living there.

KEEP THE HOME SHOWING-READY
Since you'll still be living in the home until your new place closes, it's important to keep things as tidy and neutral as possible:
- Avoid strong odors (cooking, pets, candles)
- Keep surfaces and floors clutter-free
- Make beds, turn on lights, and open blinds
- Remove personal items from bathrooms and bedrooms

Small details make a big difference — the cleaner and brighter the space, the more buyers will focus on your home's best features.

Please let us know if you have any questions. Thanks!${SIG}`,
  },

  // ============== COMBINED LENDER + CHERRYL TEMPLATE ==============
  buyer_pa_to_team: {
    name: '📎 Buyer PA → Lender + Cherryl (signed off, attached)',
    role: 'team',
    recipient: 'lender_team', // Primary: lender, auto-CC: Cherryl + team
    subject: '{{property_address}} - {{buyer_name}} | Matt Smith Team',
    body: `Hi {{lender_first_name}} and {{closer_first_name}},

We are officially under contract for our buyer, {{buyer_name}}, on {{property_address}}. Please see the attached accepted Purchase Agreement.

Purchase Price: {{purchase_price_formatted}}
Closing Date: {{closing_date}}

Please let me know if you need anything further or have any questions.

Thank you!

John | Marketing & Operations Lead
Matt Smith Team | RE/MAX
Website: www.mattsmithteam.com
Office: 5235 Buffalo Rdg Dr NE, Cedar Rapids, IA 52411`,
  },

  // ============== LENDER / CHERRYL TEMPLATES ==============
  lender_intro: {
    name: '🏦 To Lender — Transaction Intro / PA Attached',
    role: 'lender',
    recipient: 'lender',
    subject: 'Purchase Agreement — {{property_address}} ({{full_name}})',
    body: `Hi {{lender_name}},

Sending over the signed Purchase Agreement for {{full_name}} on {{property_address}}.

Key dates from the contract:
- Contract date: {{contract_date}}
- Earnest money due: {{earnest_money_due_date}}
- Mortgage contingency / loan commitment: {{mortgage_contingency_date}}
- Appraisal contingency: {{appraisal_contingency_date}}
- Closing: {{closing_date}}

Purchase price: {{purchase_price_formatted}}
Type of finance: {{type_of_finance}}

Please let us know if you need anything else from {{first_name}}, or if there's anything we can do on our end to help keep this on track.

Thanks!${SIG}`,
  },

  closer_intro: {
    name: '📋 To Cherryl — New Transaction / Loop Setup',
    role: 'closer',
    recipient: 'closer',
    subject: 'New transaction — {{property_address}} | Closing {{closing_date}}',
    body: `Hi {{closer_name}},

New one for the loop:

Property: {{property_address}}
Client: {{full_name}} ({{email}}, {{phone}})
Purchase price: {{purchase_price_formatted}}
Type of finance: {{type_of_finance}}
Lender: {{lender_name}} at {{lender_company}}

Key dates:
- Contract: {{contract_date}}
- Earnest money due: {{earnest_money_due_date}}
- Inspection contingency: {{inspection_contingency_date}}
- Mortgage/appraisal contingency: {{mortgage_contingency_date}}
- Final walkthrough: {{final_walkthrough}}
- Closing: {{closing_date}}

We've added everything to Dotloop. Let us know what else you need from us.

Thanks!${SIG}`,
  },
}

export const PRELISTING_TEMPLATES = {
  prelisting_photo_prep: {
    name: '📸 Pre-Listing — Photo Day Prep',
    recipient: 'client',
    subject: 'Getting your home ready – key steps before photo day | Matt Smith Team',
    body: TRANSACTION_TEMPLATES.seller_photo_prep.body,
  },
  prelisting_walkthrough_followup: {
    name: '🚪 Pre-Listing — Post-Walkthrough Recap',
    recipient: 'client',
    subject: 'Recap from our walkthrough at {{property_address}}',
    body: `Hi {{first_name}},

Thanks for spending time with us at {{property_address}} today. Quick recap of what we covered and the next steps:

WHAT WE DISCUSSED
- Pricing strategy based on recent comparable sales in your neighborhood
- Recommended pre-listing prep (the small things that move the needle)
- Photography timing and our marketing rollout

NEXT STEPS FROM US
- Finalize the CMA and seller netsheet, send over for review
- Schedule professional photos
- Draft the listing agreement for your signature

NEXT STEPS FROM YOU
- Address the items we walked through (no big lifts — easy wins)
- Gather any remodel/upgrade dates or warranties you have on file
- Let us know any preferred dates/times for photos

We'll be in touch shortly with the netsheet and timing. As always, reach out anytime with questions.${SIG}`,
  },
  prelisting_listing_agreement: {
    name: '📝 Pre-Listing — Listing Agreement Ready',
    recipient: 'client',
    subject: 'Listing agreement ready for your signature | {{property_address}}',
    body: `Hi {{first_name}},

The listing agreement for {{property_address}} is ready for your signature in Dotloop. You should be receiving an email from Dotloop shortly with the documents.

ONCE YOU SIGN
- We schedule professional photos
- Lockbox + sign installed at the property
- Listing prepared for MLS submission

Let me know if anything in the agreement looks off, or if you'd rather walk through it together — happy to do either.

Thanks!${SIG}`,
  },
}

export function fillMergeVars(template, vars) {
  let s = template || ''
  for (const [key, value] of Object.entries(vars || {})) {
    s = s.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value == null ? '' : String(value))
  }
  return s
}

export function buildMergeVars(client, transaction, extra = {}) {
  const v = {}
  // Client
  if (client) {
    v.first_name = client.first_name || ''
    v.last_name = client.last_name || ''
    v.full_name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
    v.email = client.email || ''
    v.phone = client.phone || ''
    v.address = client.address || ''
    v.city = client.city || 'Cedar Rapids'
  }
  // Transaction
  if (transaction) {
    v.property_address = transaction.property_address || ''
    v.purchase_price = transaction.purchase_price || ''
    v.purchase_price_formatted = transaction.purchase_price
      ? '$' + Number(transaction.purchase_price).toLocaleString()
      : ''
    v.contract_date = transaction.contract_date || ''
    v.contract_date_long = fmtLongDate(transaction.contract_date)
    v.closing_date = transaction.closing_date || ''
    v.closing_date_long = fmtLongDate(transaction.closing_date)
    v.earnest_money = transaction.earnest_money_deposit || ''
    v.earnest_money_due_date = transaction.earnest_money_due_date || ''
    v.earnest_money_due_date_long = fmtLongDate(transaction.earnest_money_due_date)
    v.ipi_due_date = transaction.ipi_due_date || ''
    v.ipi_due_date_long = fmtLongDate(transaction.ipi_due_date)
    v.mortgage_contingency_date = transaction.mortgage_contingency_date || ''
    v.mortgage_contingency_date_long = fmtLongDate(transaction.mortgage_contingency_date)
    v.appraisal_contingency_date = transaction.appraisal_contingency_date || ''
    v.appraisal_contingency_date_long = fmtLongDate(transaction.appraisal_contingency_date)
    v.inspection_contingency_date = transaction.inspection_contingency_date || ''
    v.inspection_contingency_date_long = fmtLongDate(transaction.inspection_contingency_date)
    v.financing_release = transaction.financing_release || ''
    v.final_walkthrough = transaction.final_walkthrough || ''
    v.final_walkthrough_long = fmtLongDate(transaction.final_walkthrough)
    // Insurance contingency = 7 business days after contract date
    v.insurance_contingency_date = addBusinessDays(transaction.contract_date, 7)
    v.insurance_contingency_date_long = fmtLongDate(v.insurance_contingency_date)
    v.type_of_finance = transaction.type_of_finance || ''
    v.lender_name = transaction.lender_name || ''
    v.lender_first_name = (transaction.lender_name || '').trim().split(/\s+/)[0] || ''
    v.lender_company = transaction.lender_company || ''
    v.lender_email = transaction.lender_email || ''
    v.buyer_name = transaction.buyer_name || ''
    v.seller_name = transaction.seller_name || ''
  }
  // Closer info — look up from partners table by role first, fall back to env vars
  const closer = lookupCloser()
  v.closer_name = closer.name
  v.closer_first_name = (closer.name || '').trim().split(/\s+/)[0] || 'Cherryl'
  v.closer_company = closer.company
  v.closer_email = closer.email
  v.closer_phone = closer.phone
  // Extras override
  for (const [k, val] of Object.entries(extra || {})) v[k] = val
  return v
}

// Resolve "the closer" (Cherryl) by checking partners table for a record
// flagged as Closer / Closing Coordinator / Title Company / Escrow.
// Cached for 5 min to avoid hammering the DB on every email.
let _closerCache = null
let _closerCacheTime = 0
export function lookupCloser() {
  const now = Date.now()
  if (_closerCache && (now - _closerCacheTime < 5 * 60 * 1000)) return _closerCache
  let row = null
  try {
    // Try multiple role variations — Matt may have entered any of these
    const roles = ['Closer', 'Closing Coordinator', 'Closing', 'Escrow', 'Title Company']
    for (const role of roles) {
      row = db.get(
        "SELECT * FROM partners WHERE role = ? AND email IS NOT NULL AND email != '' ORDER BY preferred DESC, id DESC LIMIT 1",
        [role]
      )
      if (row) break
    }
    // Fall back: any partner whose name or company contains "cherryl" / "at your service"
    if (!row) {
      row = db.get(
        "SELECT * FROM partners WHERE (LOWER(name) LIKE '%cherryl%' OR LOWER(company) LIKE '%at your service%') AND email IS NOT NULL AND email != '' ORDER BY preferred DESC, id DESC LIMIT 1"
      )
    }
  } catch {}
  _closerCache = {
    name: row?.name || process.env.CLOSER_NAME || 'Cherryl Kennedy',
    company: row?.company || process.env.CLOSER_COMPANY || 'At Your Service Escrow',
    email: row?.email || process.env.CLOSER_EMAIL || '',
    phone: row?.phone || process.env.CLOSER_PHONE || '',
  }
  _closerCacheTime = now
  return _closerCache
}
