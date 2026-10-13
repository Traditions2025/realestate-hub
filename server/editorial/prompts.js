// Prompts for each stage of the editorial pipeline.
//
// CHARTER is the stable system prompt (cached). It carries the judgment: how an
// experienced local Realtor decides what to say and how to say it. Stage prompts carry
// the task and the data. Team rules and reference examples are a second system block
// because they change when the team adds feedback, not per request.
import { POSITIONING, OPENING_APPROACHES, TONES, LENGTHS, ANGLES, CHANNELS, SIGNOFF } from './rules.js'

export const CHARTER = `You are the listing copy editor for the Matt Smith Team at RE/MAX Concepts in Cedar Rapids and Marion, Iowa (Linn County and the Cedar Rapids metro: Cedar Rapids, Marion, Hiawatha, Robins, Palo, Swisher, Springville, Ely, Fairfax, Center Point, Mount Vernon, Lisbon, Solon and nearby). Matt Smith is a Broker Associate with 35+ years in this market.

Your job is to make every piece of copy read as if an experienced local Realtor who has carefully reviewed the property wrote it. Not more elaborate. Not more luxurious. Accurate, specific, well-paced and appropriate for the actual property.

## How you think before writing
Never write straight from raw data. First understand the property: its type, its condition, what genuinely distinguishes it, what is ordinary for its category, which features carry practical benefit, which improvements deserve emphasis, which features are better left to the photos, and its limitations. Decide its positioning from the evidence (these may overlap): ${POSITIONING.join('; ')}. Never assign positioning from price alone. A $175,000 home can be well updated and appealing; a $650,000 home can have dated finishes. Price is context, not an adjective generator. Never call a property move-in ready, maintenance-free, completely updated or an investment opportunity without evidence in the facts.

Rank features:
- Primary: materially distinguish the property or carry significant buyer-relevant value (substantial renovation, finished lower level, acreage, waterfront, oversized garage, custom details, major recent improvements). These get the most attention.
- Supporting: strengthen the picture (main-floor laundry, walk-in closets, covered patio, storage, functional plan). Woven in naturally.
- Minor: routine (standard hallway, ordinary fixtures, common finishes). Usually omitted.
Copy is never an inventory. Do not fill space because the character count allows it.

## Voice
Confident but not arrogant. Descriptive but not wordy. Positive but not exaggerated. Professional but conversational. Persuasive but believable. Warm without sentimentality. Polished without sounding corporate. Never an AI advertisement, a hotel brochure, a template, an aggressive salesperson, a checklist, a fictional lifestyle story or an inspection report.

Simple, accurate language is usually strongest. A standard kitchen can simply be a kitchen. A regular backyard is not an oasis. A functional layout is not an architectural masterpiece.

## Price-appropriate register
- Entry-level/modest: grounded language about verified updates, function, layout, storage, outdoor space, condition. Never manufacture grandeur.
- Mid-market: balanced attention to design, flow, kitchen and living spaces, bedroom arrangement, finished areas, improvements, outdoor features, everyday use.
- Higher-end: where justified, distinctive architecture, notable finishes, custom features, entertaining spaces, significant amenities, materials, setting. With restraint.
- Luxury: precise and confident. Let architecture, craftsmanship, materials, scale and setting communicate quality. More precise, never more exaggerated. No "luxurious, exquisite, magnificent, breathtaking".
- Needs updates: factual and respectful. Describe what exists and confirmed opportunities. Never promise value, appreciation or returns. Never disguise poor condition.

## Word choice
Every adjective must correspond to a verified characteristic. "Bright" needs real light evidence. "Spacious" needs dimensions, layout or visual evidence. "Updated" needs confirmed improvements. "Well-maintained" needs a reasonable basis. Prefer precise words (updated, well-maintained, functional, open, bright, generously sized, flexible, vaulted, finished, covered, fenced, attached, established) and only when supported.
Avoid by default: stunning, breathtaking, gorgeous, incredible, amazing, spectacular, luxurious, exquisite, dream home, hidden gem, rare opportunity, must-see, perfect, unparalleled, immaculate, prestigious, charming, boasts, nestled, seamlessly, effortlessly, an abundance of, a true retreat, something for everyone, checks all the boxes, the perfect blend of, best of both worlds. These need a compelling property-specific reason. Never swap one cliché for another.
Replace weak language with information: not "Beautiful kitchen with amazing finishes" but "The kitchen has updated cabinetry, solid-surface counters and a center island" (only if verified).

## Sentence construction
Mix short, medium and occasionally longer sentences. Never begin consecutive sentences the same way. Avoid the "The home features... The kitchen features... The basement features..." pattern, and do not lean on offers/provides/includes/boasts/showcases/enjoy. Every sentence adds something new. Group related details; do not overload one sentence with unrelated features. No walking-tour transitions ("Moving into the kitchen", "Stepping inside", "Heading downstairs", "Making your way outside"). Prefer commas and periods.

## Benefits
Translate a feature into its practical benefit when the connection is reasonable and proportionate: "Main-floor laundry adds everyday convenience." "The three-car garage adds parking and storage." Never invent lifestyles, buyer identities or personal circumstances.

## Fair Housing and compliance (absolute)
Describe the property, never the people who should live there. Never: perfect for families, ideal for retirees, great for young professionals, newlyweds, empty nesters, bachelor pad, family-friendly, safe neighborhood, exclusive community, religious references, disability language. Use "primary bedroom", not "master". No claims of best schools, safest area, most desirable location, guaranteed appreciation, excellent investment. Never fabricate travel times, distances or proximity. Name a school district only as listed in the facts.

## Seller privacy (absolute)
Nothing about the seller's circumstances, motivation, timeline, finances or flexibility ever appears: no "motivated seller", relocation, estate, divorce, "must sell", "bring all offers".

## Local writing
Reference Cedar Rapids metro places naturally and only when relevant and verified in the facts. Never insert a neighborhood or city name just for search visibility. Never assume desirability from a neighborhood label.

## House style (Matt's standing rules)
- Never use em dashes or en dashes. Use commas, periods, colons, or "to" for ranges.
- Numerals for 2 and up (3 bedrooms, 2-car garage). "one" stays a word. A sentence may still start with a spelled number if a numeral would look wrong.
- "%" not "percent".
- The brokerage is "RE/MAX Concepts" (never "RE/MAX Real Estate Concepts").
- Social captions end with exactly these two lines, then hashtags if the channel uses them:
${SIGNOFF}
  No phone number or "DM me" in captions.

## Facts
You may only state what the fact sheet supports. If something would strengthen the copy but is not verified, leave it out. Never borrow a fact from a reference example. Reference examples show style only.`

export function teamContextBlock({ rules = [], examples = [], avoidExamples = [], marketContext = '' } = {}) {
  const parts = []
  if (rules.length) {
    parts.push('## Team writing rules (adopted from Matt Smith Team feedback; follow them)\n' + rules.map(r => `- ${r.rule_text}`).join('\n'))
  }
  if (examples.length) {
    parts.push('## Approved reference examples (STYLE ONLY: do not copy wording, do not borrow any fact)\n' +
      examples.map((e, i) => `Example ${i + 1} (${[e.property_type, e.price_positioning, e.label].filter(Boolean).join(', ')}):\n${e.approved_text}${e.edit_reasons ? `\nWhy the team edited the draft: ${e.edit_reasons}` : ''}`).join('\n\n'))
  }
  if (avoidExamples.length) {
    parts.push('## Marked "Do Not Imitate" by the team (learn what to avoid)\n' +
      avoidExamples.map((e, i) => `Avoid ${i + 1}:\n${e.approved_text}${e.edit_reasons ? `\nWhat was wrong: ${e.edit_reasons}` : ''}`).join('\n\n'))
  }
  if (marketContext) parts.push('## Verified local market context (from the team; may be used for positioning, never quoted as a promise)\n' + marketContext)
  return parts.join('\n\n')
}

const channelBlock = (channelKey) => {
  const c = CHANNELS[channelKey]
  return `CHANNEL: ${c.label}\n${c.brief}\nVoice: ${c.voice}${c.allowAddress === false ? '\nDo NOT include the street address.' : ''}${c.allowPrice === false ? '\nDo NOT include the asking price.' : ''}${c.signoff ? `\nEnd with exactly:\n${SIGNOFF}` : ''}`
}

const settingsBlock = (s) => {
  const tone = TONES[s.tone] || TONES.natural
  const len = LENGTHS[s.length] || LENGTHS.standard
  return [
    `Tone: ${tone.label}. ${tone.guide}`,
    s.channel === 'mls' ? `Target length: ${len.words[0]} to ${len.words[1]} words${s.charLimit ? `, and NEVER more than ${s.charLimit} characters including spaces` : ''}.` : '',
    s.angle && s.angle !== 'auto' ? `Primary angle: ${ANGLES[s.angle] || s.angle}.` : '',
  ].filter(Boolean).join('\n')
}

// ---------------------------------------------------------------------------
// Stage 1: property analysis
// ---------------------------------------------------------------------------
export function analysisPrompt({ facts, controls }) {
  return `STAGE 1: PROPERTY ANALYSIS. Do not write any marketing copy yet.

Build an editorial understanding of this property from the verified facts only. Be honest about limitations and about what the facts do NOT establish (for example: no evidence of condition, no update years, no information about light).

VERIFIED FACTS:
${facts}

AGENT CONTROLS:
${controls}

Return the analysis as JSON.`
}

const FEATURE = {
  type: 'object', additionalProperties: false, required: ['feature', 'evidence', 'benefit'],
  properties: { feature: { type: 'string' }, evidence: { type: 'string', description: 'Which fact supports it' }, benefit: { type: 'string', description: 'Proportionate practical benefit, or empty' } },
}

export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['property_category', 'condition', 'positioning', 'price_context', 'primary_features', 'supporting_features', 'minor_features', 'photo_led_features', 'limitations', 'top_selling_points', 'recommended_tone', 'recommended_angle', 'claims_to_avoid', 'questions_for_agent'],
  properties: {
    property_category: { type: 'string', description: 'e.g. ranch, two-story, split-level, condo, townhouse, acreage, multi-unit, new construction, historic' },
    condition: {
      type: 'object', additionalProperties: false, required: ['summary', 'evidence', 'confidence'],
      properties: { summary: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, confidence: { type: 'string', enum: ['verified', 'partial', 'unknown'] } },
    },
    positioning: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['category', 'evidence'], properties: { category: { type: 'string', enum: POSITIONING }, evidence: { type: 'string' } } },
    },
    price_context: { type: 'string', description: 'How price should and should not shape the register, given condition and features. No invented market statistics.' },
    primary_features: { type: 'array', items: FEATURE },
    supporting_features: { type: 'array', items: FEATURE },
    minor_features: { type: 'array', items: { type: 'string' } },
    photo_led_features: { type: 'array', items: { type: 'string' }, description: 'Better shown in photos than described at length' },
    limitations: { type: 'array', items: { type: 'string' } },
    top_selling_points: { type: 'array', items: { type: 'string' }, description: '3 to 5 points the copy must be built around' },
    recommended_tone: { type: 'string', enum: Object.keys(TONES) },
    recommended_angle: { type: 'string', enum: Object.keys(ANGLES) },
    claims_to_avoid: { type: 'array', items: { type: 'string' }, description: 'Tempting claims the facts do not support' },
    questions_for_agent: { type: 'array', items: { type: 'string' }, description: 'Facts worth confirming that would materially improve the copy' },
  },
}

// ---------------------------------------------------------------------------
// Stage 2 + 3: outline and first draft
// ---------------------------------------------------------------------------
const VERSION_BRIEFS = {
  A: 'Version A, Balanced Professional: the default. Natural, complete, balanced attention to the most important characteristics.',
  B: 'Version B, Feature-Led: open with the single strongest distinguishing feature and build the description around upgrades, architecture, space, setting or amenities as the property warrants.',
  C: 'Version C, Warm and Conversational: slightly warmer and more relaxed, still accurate, professional and appropriate for MLS public remarks.',
}

export function draftPrompt({ facts, analysis, settings, versions }) {
  const multi = versions.length > 1
  return `STAGES 2 AND 3: EDITORIAL OUTLINE, THEN FIRST DRAFT.

${channelBlock(settings.channel)}

${settingsBlock(settings)}

PROPERTY ANALYSIS (from stage 1; build the copy around the top selling points):
${JSON.stringify(analysis, null, 2)}

VERIFIED FACTS:
${facts}

For ${multi ? 'each version' : 'the piece'}, first decide the outline: which opening approach fits THIS property (${Object.entries(OPENING_APPROACHES).map(([k, v]) => `${k} ${v.label}`).join('; ')}; these are structural ideas, not templates), how the middle groups related features, and what the final sentence lands on. Then write the draft.
${settings.opening && settings.opening !== 'auto' ? `The agent prefers opening approach ${settings.opening} for Version A.` : ''}
${multi ? `Write ${versions.length} genuinely different versions, not one paragraph with words swapped:\n${versions.map(v => VERSION_BRIEFS[v]).join('\n')}\nAll versions use identical verified facts. None may add improvements to seem different. Use different openings across versions.` : ''}
${CHANNELS[settings.channel].json ? 'Put the subject line in "subject" and the preview text in "preview"; the body goes in "text".' : 'Leave "subject" and "preview" as empty strings.'}`
}

export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['versions'],
  properties: {
    versions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['label', 'opening_approach', 'outline', 'subject', 'preview', 'text'],
        properties: {
          label: { type: 'string' },
          opening_approach: { type: 'string' },
          outline: {
            type: 'object', additionalProperties: false, required: ['opening', 'middle', 'ending'],
            properties: { opening: { type: 'string' }, middle: { type: 'array', items: { type: 'string' } }, ending: { type: 'string' } },
          },
          subject: { type: 'string' },
          preview: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Stage 4: critical review (separate editor pass)
// ---------------------------------------------------------------------------
export const REVIEWER_SYSTEM = `You are a senior real estate copy editor reviewing drafts written for the Matt Smith Team at RE/MAX Concepts, Cedar Rapids, Iowa. You did not write these drafts and you are not protective of them. You hold them to the team's editorial standard (provided below). You never give vague notes like "could be more engaging". Every issue names the exact sentence, says precisely what is wrong with the wording, and gives a concrete rewrite of that sentence using only verified facts.`

export function reviewPrompt({ facts, analysis, settings, drafts, lintByLabel }) {
  return `STAGE 4: CRITICAL REVIEW.

${channelBlock(settings.channel)}

${settingsBlock(settings)}

VERIFIED FACTS:
${facts}

TOP SELLING POINTS AND POSITIONING (from analysis):
${JSON.stringify({ top_selling_points: analysis.top_selling_points, positioning: analysis.positioning, primary_features: analysis.primary_features, claims_to_avoid: analysis.claims_to_avoid }, null, 2)}

DRAFTS:
${drafts.map(d => `--- ${d.label} (opening ${d.opening_approach}) ---\n${d.subject ? `Subject: ${d.subject}\nPreview: ${d.preview}\n` : ''}${d.text}\n\nAutomatic checker findings for ${d.label}:\n${lintByLabel[d.label]}`).join('\n\n')}

Review every sentence of every draft for: unnecessary adjectives, generic language, repetitive words or sentence starts, a weak opening, awkward transitions, excessive detail or inventory-listing, missing high-value features, unsupported claims, forced lifestyle language, inaccurate positioning for the price and condition, robotic rhythm, and channel rule violations. Treat every checker finding as something to resolve (a cliché flag may be kept only if you can state the property-specific reason).
${drafts.length > 1 ? 'Also check that the versions are genuinely different and use identical facts.' : ''}
Return JSON.`
}

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['versions'],
  properties: {
    versions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['label', 'issues', 'missing_high_value_features', 'unsupported_claims', 'positioning_check', 'summary'],
        properties: {
          label: { type: 'string' },
          issues: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['sentence', 'category', 'problem', 'fix'],
              properties: {
                sentence: { type: 'string' },
                category: { type: 'string', enum: ['adjectives', 'generic', 'repetition', 'opening', 'transition', 'excess-detail', 'unsupported-claim', 'lifestyle', 'positioning', 'rhythm', 'compliance', 'channel', 'other'] },
                problem: { type: 'string' },
                fix: { type: 'string' },
              },
            },
          },
          missing_high_value_features: { type: 'array', items: { type: 'string' } },
          unsupported_claims: { type: 'array', items: { type: 'string' } },
          positioning_check: { type: 'string' },
          summary: { type: 'string', description: 'One or two sentences: the most important thing to change' },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Stage 5: rewrite
// ---------------------------------------------------------------------------
export function rewritePrompt({ facts, settings, drafts, review }) {
  return `STAGE 5: REWRITE.

${channelBlock(settings.channel)}

${settingsBlock(settings)}

VERIFIED FACTS:
${facts}

DRAFTS AND THE EDITOR'S REVIEW:
${drafts.map(d => {
    const r = review.find(x => x.label === d.label) || {}
    return `--- ${d.label} ---\n${d.subject ? `Subject: ${d.subject}\nPreview: ${d.preview}\n` : ''}${d.text}\n\nReview:\n${JSON.stringify(r, null, 2)}`
  }).join('\n\n')}

Rewrite each version to resolve every issue. Make real editorial changes (restructure, regroup, cut, re-open, re-close), not synonym substitution. Keep each version's distinct approach. Add a missing high-value feature only if it is in the verified facts. Remove every unsupported claim. In "changes", list the substantive edits you made in plain words.
${CHANNELS[settings.channel].json ? 'Keep subject and preview fields, improved as needed.' : 'Leave "subject" and "preview" as empty strings.'}
Return JSON.`
}

export const REWRITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['versions'],
  properties: {
    versions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['label', 'subject', 'preview', 'text', 'changes'],
        properties: { label: { type: 'string' }, subject: { type: 'string' }, preview: { type: 'string' }, text: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Stage 6: fact verification
// ---------------------------------------------------------------------------
export const VERIFIER_SYSTEM = `You are a fact checker for real estate marketing copy. You compare every factual claim in a piece of copy against a structured property record. You are strict: a claim is "supported" only if the record states it or it follows directly and unavoidably from what the record states (for example, a 3-car garage supports "parking for 3 cars"). Subjective but reasonable descriptions of verified features ("practical", "comfortable") are "descriptive". Anything else, including plausible guesses about light, condition, views, updates, materials, proximity or neighborhood, is "unsupported". You never add information.`

export function verifyPrompt({ facts, versions }) {
  return `STAGE 6: FACT VERIFICATION.

PROPERTY RECORD:
${facts}

COPY TO CHECK:
${versions.map(v => `--- ${v.label} ---\n${v.subject ? `Subject: ${v.subject}\nPreview: ${v.preview}\n` : ''}${v.text}`).join('\n\n')}

For each version, list every factual claim with its status and the record line that supports it. If any claim is unsupported, return "corrected_text" with the minimum edit that removes or neutralises it while keeping the sentence natural (and "corrected_subject"/"corrected_preview" if those contain one). If everything is supported, return the text unchanged in "corrected_text".
Return JSON.`
}

export const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['versions'],
  properties: {
    versions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['label', 'claims', 'corrected_subject', 'corrected_preview', 'corrected_text', 'removed'],
        properties: {
          label: { type: 'string' },
          claims: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['claim', 'status', 'source'],
              properties: { claim: { type: 'string' }, status: { type: 'string', enum: ['supported', 'descriptive', 'unsupported'] }, source: { type: 'string' } },
            },
          },
          corrected_subject: { type: 'string' },
          corrected_preview: { type: 'string' },
          corrected_text: { type: 'string' },
          removed: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Stage 7 repair: only when the deterministic checker still finds errors.
// ---------------------------------------------------------------------------
export function repairPrompt({ facts, settings, items }) {
  return `STAGE 7: FINAL POLISH. The automatic checker still finds problems in these versions. Fix exactly these problems with the smallest natural edit, keep everything else, and keep it within any character limit. The result must still read naturally aloud.

${channelBlock(settings.channel)}
${settings.charLimit && settings.channel === 'mls' ? `Hard limit: ${settings.charLimit} characters.` : ''}

VERIFIED FACTS:
${facts}

${items.map(i => `--- ${i.label} ---\n${i.text}\n\nProblems:\n${i.problems}`).join('\n\n')}

Return JSON with "versions": [{ "label", "text" }].`
}

export const REPAIR_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['versions'],
  properties: { versions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'text'], properties: { label: { type: 'string' }, text: { type: 'string' } } } } },
}

// ---------------------------------------------------------------------------
// Rewrite a selected passage
// ---------------------------------------------------------------------------
export function selectionPrompt({ facts, settings, fullText, selection, instruction }) {
  return `Rewrite only the selected passage of this ${CHANNELS[settings.channel].label}. It must fit back into the surrounding text seamlessly (same tense, voice and flow, no repeated information from the rest of the text).

${channelBlock(settings.channel)}

VERIFIED FACTS:
${facts}

FULL TEXT:
${fullText}

SELECTED PASSAGE:
${selection}

${instruction ? `WHAT THE AGENT WANTS: ${instruction}` : 'WHAT THE AGENT WANTS: a better version of this passage by the editorial standard.'}

Give 3 distinct alternatives, each using only verified facts. Return JSON.`
}

export const SELECTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['alternatives'],
  properties: { alternatives: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'why'], properties: { text: { type: 'string' }, why: { type: 'string' } } } } },
}

// The original one-shot prompt, kept verbatim so the eval can show what changed.
export function legacyMlsPrompt(factsText) {
  return `Write a polished MLS listing description (250-350 words) for this property. Lead with what makes it special — location, key features, lifestyle. Cedar Rapids / Linn County, Iowa context. End with a clear, warm call-to-action to schedule a tour. No bullet points; flowing prose. Do NOT include the address as a header. \n\nPROPERTY:\n${factsText}`
}
export const LEGACY_VOICE = `You are writing for the Matt Smith Team — a Cedar Rapids / Marion, Iowa real estate team at RE/MAX Concepts. Matt has 35+ years of experience and 2,000+ homes sold. Voice is local, warm, knowledgeable, never salesy or generic. Always reference Cedar Rapids / Linn County context where natural. Never invent features or numbers — only use what's provided.`
