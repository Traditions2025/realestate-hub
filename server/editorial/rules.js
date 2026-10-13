// Editorial rulebook for listing copy: the fixed standards every channel is held to.
//
// Two layers. This file is the baseline that ships with the code. On top of it sit the
// team's own rules in the editorial_rules table (store.js), which grow out of recurring
// feedback ("too many adjectives", "don't start with Welcome to") and carry an audit
// history. The linter and the prompts read both.
//
// Matt's standing style rules apply here as everywhere: no em or en dashes, numerals from
// 2 up, % not "percent", brokerage is "RE/MAX Concepts", and nothing a seller shared
// privately ever reaches public copy.

export const POSITIONING = [
  'Practical and affordable',
  'Well-maintained and move-in ready',
  'Updated and thoughtfully improved',
  'Spacious and versatile',
  'Character-filled or architecturally distinctive',
  'Contemporary',
  'Higher-end',
  'Luxury',
  'Rural or acreage-focused',
  'Low-maintenance',
  'Investment-oriented',
  'Renovation opportunity',
]

export const OPENING_APPROACHES = {
  A: { label: 'Property character', example: 'This well-maintained ranch offers a comfortable layout with...' },
  B: { label: 'Meaningful feature', example: 'A spacious main level, updated kitchen, and finished lower level highlight...' },
  C: { label: 'Location and property', example: 'Located on a generously sized lot in Marion, this...' },
  D: { label: 'Architectural distinction', example: 'Vaulted ceilings and large windows bring an open feel to the main living area of this...' },
  E: { label: 'Improvements', example: 'Recent updates to the kitchen and bathrooms complement the practical layout of this...' },
}

export const TONES = {
  natural: { label: 'Natural and Balanced', guide: 'Even, informed and plainspoken. The default.' },
  warm: { label: 'Warm and Conversational', guide: 'A little more relaxed and human, still precise and MLS-appropriate. No sentimentality.' },
  feature: { label: 'Feature-Focused', guide: 'Leads with and is organised around the strongest verified features. Concrete nouns over adjectives.' },
  refined: { label: 'Modern and Refined', guide: 'Clean, spare sentences. Materials and design described exactly. No ornament.' },
  upscale: { label: 'Upscale and Restrained', guide: 'For genuinely higher-end property. Precision and scale carry the quality; no luxury adjectives.' },
}

export const LENGTHS = {
  short: { label: 'Short', words: [90, 140] },
  standard: { label: 'Standard', words: [150, 220] },
  full: { label: 'Full', words: [220, 300] },
}

export const ANGLES = {
  auto: 'Let the analysis decide',
  updates: 'Recent updates and improvements',
  space: 'Space and layout',
  setting: 'Lot, setting and outdoor space',
  architecture: 'Architecture and design',
  value: 'Practical value and condition',
  low_maintenance: 'Low-maintenance living',
  location: 'Location (verified nearby amenities only)',
}

// ---------------------------------------------------------------------------
// Phrase lists. Each entry: pattern, why it fails, and a suggested direction.
// severity: 'error' blocks a version from being marked clean; 'warn' is shown to the
// editor. Clichés are 'warn' because the brief allows them with a property-specific
// reason; the reviewer decides, the linter only points.
// ---------------------------------------------------------------------------

const w = (word) => new RegExp(`\\b${word}\\b`, 'i')

export const CLICHES = [
  [w('stunning'), 'stunning'], [w('breathtaking'), 'breathtaking'], [w('gorgeous'), 'gorgeous'],
  [w('incredible'), 'incredible'], [w('amazing'), 'amazing'], [w('spectacular'), 'spectacular'],
  [w('luxurious'), 'luxurious'], [w('exquisite'), 'exquisite'], [/\bdream (home|house|kitchen|backyard)\b/i, 'dream home'],
  [/\bhidden gem\b/i, 'hidden gem'], [/\brare (opportunity|find)\b/i, 'rare opportunity'], [/\bmust[- ]see\b/i, 'must-see'],
  [w('perfect'), 'perfect'], [w('unparalleled'), 'unparalleled'], [w('immaculate'), 'immaculate'],
  [w('prestigious'), 'prestigious'], [w('charming'), 'charming'], [/\bboasts?\b|\bboasting\b/i, 'boasts'],
  [/\bnestled\b/i, 'nestled'], [w('seamlessly'), 'seamlessly'], [w('effortlessly'), 'effortlessly'],
  [/\ban abundance of\b/i, 'an abundance of'], [/\ba true (retreat|oasis|sanctuary)\b/i, 'a true retreat'],
  [/\bsomething for everyone\b/i, 'something for everyone'], [/\bchecks all the boxes\b/i, 'checks all the boxes'],
  [/\bthe perfect blend of\b/i, 'the perfect blend of'], [/\bbest of both worlds\b/i, 'best of both worlds'],
  [/\boasis\b/i, 'oasis'], [/\bentertainer'?s dream\b/i, "entertainer's dream"], [/\bshowstopper\b/i, 'showstopper'],
  [/\bpride of ownership\b/i, 'pride of ownership'], [/\bmagnificent\b/i, 'magnificent'], [/\bto die for\b/i, 'to die for'],
  [/\btucked away\b/i, 'tucked away'], [/\bsun[- ]drenched\b/i, 'sun-drenched'], [/\bwow factor\b/i, 'wow factor'],
]

// Puffery adjectives: individually fine, in volume they are the "too many adjectives" note.
export const PUFFERY = ['beautiful', 'beautifully', 'lovely', 'wonderful', 'fantastic', 'gorgeous', 'stunning', 'amazing',
  'incredible', 'spectacular', 'exceptional', 'impressive', 'fabulous', 'superb', 'elegant', 'luxurious', 'exquisite',
  'pristine', 'perfect', 'ideal', 'cozy', 'inviting', 'delightful', 'dazzling', 'grand', 'sprawling']

export const GENERIC_OPENINGS = [
  [/^\s*welcome (to|home)\b/i, 'Opens with "Welcome to/home". Open with the property\'s strongest verified characteristic instead.'],
  [/^\s*(look no further|don'?t miss|have you been (looking|searching|dreaming))/i, 'Generic sales opener. Start with the property itself.'],
  [/^\s*(this|a) (beautiful|stunning|gorgeous|charming|lovely|amazing|wonderful) (home|house|property)\b/i, 'Adjective-first generic opener. Name what is actually distinctive.'],
  [/^\s*(introducing|presenting)\b/i, 'Announcement-style opener reads like an ad.'],
]

export const CTA_ENDINGS = [
  /schedule (your|a) (private )?(showing|tour)/i, /won'?t last( long)?/i, /don'?t miss (out|this)/i,
  /make (this|it) (dream home )?yours/i, /call (us |me |matt )?today/i, /book (your|a) (showing|tour)/i,
  /come see (it|for yourself)/i, /act (fast|now|quickly)/i, /before it'?s gone/i,
]

export const WALKING_TOUR = [
  /\bmoving into the\b/i, /\bstepping (into|inside|outside)\b/i, /\bstep (inside|outside|into)\b/i,
  /\bheading (downstairs|upstairs|outside)\b/i, /\bmaking your way\b/i, /\bas you (enter|walk|step|make your way)\b/i,
  /\bupon entering\b/i, /\bwalk (in|through) the front door\b/i,
]

export const OVERUSED_VERBS = ['features', 'offers', 'provides', 'includes', 'boasts', 'showcases', 'enjoy']

// Fair Housing: never describe who should live somewhere, only the property.
export const FAIR_HOUSING = [
  [/\b(perfect|ideal|great|designed|suited) for (young |growing |large |small )?(famil(y|ies)|kids|children|retirees|seniors|empty[- ]nesters|newlyweds|couples|singles|young professionals|students|bachelors?|first[- ]time buyers)\b/i, 'Describes a preferred occupant. Describe the space and its uses instead.'],
  [/\bfamily[- ]friendly\b/i, 'Implies a preferred household type. Describe the feature (fenced yard, layout) instead.'],
  [/\bbachelor pad\b/i, 'Describes a preferred occupant.'],
  [/\b(adults? only|no (kids|children)|mature (couple|person)|empty[- ]nesters?)\b/i, 'Familial status language.'],
  [/\b(christian|church|synagogue|mosque|temple)\b/i, 'Religious reference. Remove unless it is a named, verified landmark and still consider leaving it out.'],
  [/\b(safe|safest|crime[- ]free|low[- ]crime) (neighbou?rhood|area|street|community)\b/i, 'Safety claim about an area. Not verifiable and a Fair Housing risk.'],
  [/\b(exclusive|integrated|ethnic|traditional) (neighbou?rhood|community|area)\b/i, 'Steering language about who lives in an area.'],
  [/\b(handicap(ped)?|able[- ]bodied|walking distance for (the )?(elderly|seniors))\b/i, 'Disability language. Describe the physical feature (zero-step entry, wide doorways) instead.'],
  [/\bmaster (bed(room)?|suite|bath(room)?|closet)\b/i, 'Use "primary bedroom/suite/bathroom".'],
]

// Claims that need evidence in the fact sheet. If none of the evidence words appear in the
// verified facts, the claim is unsupported.
export const EVIDENCE_CLAIMS = [
  { pattern: /\bmove[- ]in ready\b/i, label: 'move-in ready', evidence: [/move[- ]in ready/i, /turn[- ]?key/i, /newly (renovated|updated)/i] },
  { pattern: /\bturn[- ]?key\b/i, label: 'turnkey', evidence: [/turn[- ]?key/i, /move[- ]in ready/i] },
  { pattern: /\bmaintenance[- ]free\b/i, label: 'maintenance-free', evidence: [/maintenance[- ]free/i, /hoa (covers|includes) (all )?(exterior|lawn|snow)/i] },
  { pattern: /\b(completely|fully|totally) (updated|renovated|remodel(l)?ed)\b/i, label: 'completely updated', evidence: [/(complete|full|total|gut) (update|renovation|remodel)/i, /(completely|fully) (updated|renovated|remodel)/i] },
  { pattern: /\binvestment (opportunity|property)\b|\bgreat investment\b/i, label: 'investment claim', evidence: [/rental|investment|tenant|lease|multi[- ]?family|duplex|triplex|fourplex|rent roll/i] },
  { pattern: /\bwell[- ]maintained\b|\bmeticulously (maintained|kept)\b/i, label: 'well-maintained', evidence: [/maint|new (roof|furnace|hvac|water heater|windows|siding)|replaced|serviced|updated|inspection/i] },
  { pattern: /\b(updated|renovated|remodel(l)?ed|new)\b/i, label: 'updated/new', evidence: [/update|renovat|remodel|new|replac|installed|refinish|20\d\d/i] },
  { pattern: /\bvaulted\b/i, label: 'vaulted', evidence: [/vault/i] },
  { pattern: /\b(waterfront|lake ?front|river ?front|water views?)\b/i, label: 'waterfront', evidence: [/water|lake|river|creek|pond/i] },
  { pattern: /\b(quartz|granite|hardwood|tile|stainless|marble|butcher ?block|solid[- ]surface|LVP|luxury vinyl)\b/i, label: 'specific material', evidence: null },
]

// Never true, never allowed, in any channel.
export const PROHIBITED_CLAIMS = [
  [/\bbest school(s| district)?\b|\btop[- ]rated schools?\b/i, 'School quality claim. Name the district only if verified.'],
  [/\b(guaranteed|sure to) (appreciat|increase|grow)/i, 'Promises appreciation.'],
  [/\bwill (only )?(appreciate|increase in value|go up)\b/i, 'Promises appreciation.'],
  [/\b(guaranteed|steady|passive) (income|return|cash ?flow)\b/i, 'Promises income or return.'],
  [/\bmost desirable\b|\beveryone wants to live\b|\bthe best (location|neighbou?rhood)\b/i, 'Unprovable superlative about location.'],
  [/\bbuilds? equity (fast|quickly)\b/i, 'Financial outcome promise.'],
]

// Things a seller tells their agent that never go in public copy (memory: seller privacy).
export const SELLER_PRIVATE = [
  [/\bmotivated seller\b/i, 'Reveals seller motivation.'],
  [/\b(must|needs? to) sell\b/i, 'Reveals seller urgency.'],
  [/\b(divorc|estate sale|bank[- ]?owned|foreclos|short sale|relocat|job transfer|passed away|deceased|health reasons|assisted living)/i, 'Personal or financial circumstance of the seller.'],
  [/\bseller (will|would|is willing to) (accept|take|consider|pay|cover|negotiate)\b/i, 'Reveals negotiating posture.'],
  [/\bbring (all|any) offers\b|\ball offers considered\b/i, 'Signals price flexibility.'],
]

// Matt's mechanics.
export const SPELLED_NUMBERS = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty)\b/i
export const NUMBER_NAMES_OK = /\bfour[- ]seasons?\b|\bthree[- ]season\b/i

// ---------------------------------------------------------------------------
// Channels. Each one has its own job, shape and limits.
// ---------------------------------------------------------------------------
export const CHANNELS = {
  mls: {
    label: 'MLS Public Remarks',
    column: 'marketing_listing_description',
    versions: ['A', 'B', 'C'],
    oneParagraph: true,
    noCTA: true,
    noEmoji: true,
    noBullets: true,
    allowAddress: true,
    allowPrice: false,
    voice: 'Third person about the property. No "I", no "we", no "you" unless unavoidable.',
    brief: `MLS public remarks. Precise and informative. ONE cohesive paragraph: no bullets, headings, capitalised words for emphasis, or emoji. No call to action at the end; finish on a property-specific sentence. Do not list every feature; MLS remarks are not an inventory. Do not repeat the price, bed/bath count and square footage the MLS fields already show unless it reads naturally. No agent contact details, no showing instructions.`,
  },
  website: {
    label: 'Website Property Description',
    column: 'marketing_website_description',
    versions: ['A'],
    allowAddress: true,
    allowPrice: true,
    voice: 'Third person about the property.',
    brief: `Website property page. More detailed than MLS. 3 to 5 short sections, each with a plain descriptive heading on its own line (e.g. "Main level", "Lower level", "Outside"). Prose under each heading; a short list is acceptable only for a run of practical specifications. Verified highlights only. No hype headings.`,
  },
  premarket_blog: {
    label: 'Pre-Market Blog Post',
    column: 'marketing_premarket_blog',
    versions: ['A'],
    allowAddress: false,
    allowPrice: false,
    html: true,
    voice: 'Authoritative local publication. Third person. Avoid addressing the reader as "you".',
    brief: `Pre-market blog post for mattsmithteam.com announcing a home that is coming to market. 450 to 650 words of HTML using only <h2>, <h3>, <p> (and <ul><li> only for a short run of specifications). Natural, descriptive headings, not clickbait. An editorial narrative about the property and how it lives, then the setting at a general level (city or part of town, never the street address). DO NOT include the asking price or the street address. Close with one plain sentence that the home is coming soon and the Matt Smith Team can share details before it reaches the MLS.`,
  },
  premarket_email: {
    label: 'Pre-Market Email',
    column: 'marketing_premarket_email',
    versions: ['A'],
    allowAddress: false,
    allowPrice: false,
    voice: 'First person, Matt writing to someone on his list. Plain, conversational.',
    json: { subject: 'string', preview: 'string', body: 'string' },
    brief: `Pre-market email from Matt. Conversational, concise and curiosity-driven without sounding like an advertisement. Subject under 60 characters, no all caps, no "JUST LISTED" style hype. Preview text under 90 characters. Body 90 to 150 words, plain text paragraphs (no HTML), 2 or 3 selective property details that make someone want to know more, then a simple invitation to reply for details before it hits the market. No street address, no asking price. Sign as Matt.`,
  },
  premarket_social: {
    label: 'Pre-Market Social (Coming Soon)',
    column: 'marketing_coming_soon',
    versions: ['A'],
    allowAddress: false,
    allowPrice: false,
    voice: 'First person Matt.',
    signoff: true,
    brief: `Coming-soon social caption. Short and visual: 50 to 90 words before the sign-off. A property-specific first line (not "Coming soon!" on its own). 2 or 3 selective details, never the whole house. No street address or asking price. At most 1 emoji, and only if it earns its place. Then the exact sign-off lines, then 6 to 10 hashtags (mix local Cedar Rapids/Marion/Iowa and general).`,
  },
  active_email: {
    label: 'Active Listing Email',
    column: 'marketing_email_blast',
    versions: ['A'],
    allowAddress: true,
    allowPrice: true,
    html: true,
    voice: 'First person Matt.',
    json: { subject: 'string', preview: 'string', html: 'string' },
    brief: `Active listing email. Subject under 65 characters, no all caps. Preview under 100 characters. HTML body using only <h2>, <h3>, <p>, <ul><li> and links: a 2 to 3 sentence introduction, the address, price and a clean bed/bath/square-foot line, 3 or 4 verified highlights as a short list, and a clear next step: <a href="tel:3194315859">Call or text (319) 431-5859</a> | <a href="mailto:matt@mattsmithteam.com">Email Matt</a>.`,
  },
  active_social: {
    label: 'Active Listing Social Caption',
    column: 'marketing_just_listed',
    versions: ['A'],
    allowAddress: true,
    allowPrice: true,
    voice: 'First person Matt.',
    signoff: true,
    brief: `Active listing social caption, written to sit under a photo carousel. 60 to 110 words before the sign-off. A natural, property-specific hook line. One clean stat line (city, beds, baths, square feet, price). 2 or 3 sentences on what genuinely distinguishes the home. Do not narrate the photos or repeat what carousel slides would show. At most 2 emoji. Then the exact sign-off lines, then 8 to 12 hashtags.`,
  },
  social_facebook: {
    label: 'Facebook Post',
    column: 'marketing_social_facebook',
    versions: ['A'],
    allowAddress: true,
    allowPrice: true,
    voice: 'First person Matt, neighbour to neighbour.',
    signoff: true,
    brief: `Facebook listing post. 120 to 200 words before the sign-off. Conversational and readable, a property-specific opening line, the address, a short stat line, the 3 or 4 most meaningful verified features in prose. No hashtags. At most 1 emoji. Then the exact sign-off lines.`,
  },
  social_instagram: {
    label: 'Instagram Caption',
    column: 'marketing_social_instagram',
    versions: ['A'],
    allowAddress: false,
    allowPrice: true,
    voice: 'First person Matt.',
    signoff: true,
    brief: `Instagram caption for a single listing photo. 120 to 200 words before the sign-off, because there is no carousel to carry the story. Hook in the first line. Short paragraphs separated by line breaks. City, not street address. At most 2 emoji. Then the exact sign-off lines, then 10 to 15 hashtags split between local and general.`,
  },
  price_reduction: {
    label: 'Price Improvement Post',
    column: 'marketing_price_reduction',
    versions: ['A'],
    allowAddress: true,
    allowPrice: true,
    voice: 'First person Matt.',
    signoff: true,
    brief: `Social post for a new price. 70 to 120 words before the sign-off. Frame as a new price or price improvement, never "reduced", "slashed" or "drop", and never imply the seller is under pressure. State the new price plainly, one stat line, and 2 sentences on what the home offers. Then the exact sign-off lines, then 8 to 12 hashtags.`,
  },
  video_script: {
    label: 'Property Video Script',
    column: 'marketing_video_script',
    versions: ['A'],
    allowAddress: false,
    allowPrice: false,
    voice: 'Spoken, first person Matt.',
    brief: `Voiceover script for a 45 to 75 second property video. Spoken language: short sentences, natural rhythm, contractions. 110 to 170 words. Format as numbered beats, each beat on its own line as "[Shot: what should be on screen] Narration." Visual references must match features that are verified and likely filmed; never describe a shot of something not in the facts. Do not read the MLS remarks aloud. No price, no street address. End on the home, not a sales line.`,
  },
}

export const SIGNOFF = 'Matt Smith | Broker Associate\nMatt Smith Team | RE/MAX Concepts'

// Map the original Hub asset keys onto channels so old buttons keep working.
export const LEGACY_ASSET_TO_CHANNEL = {
  description: 'mls',
  blog_post: 'premarket_blog',
  social_instagram: 'social_instagram',
  social_facebook: 'social_facebook',
  coming_soon: 'premarket_social',
  just_listed: 'active_social',
  email_blast: 'active_email',
  price_reduction: 'price_reduction',
}

// Quick-pick feedback chips. Each maps to a rule the team can adopt once it recurs.
export const FEEDBACK_PRESETS = [
  { key: 'too_many_adjectives', text: 'Too many adjectives.', rule: 'Cut adjectives that do not carry verified information. Prefer concrete nouns and specifics.' },
  { key: 'too_luxurious', text: 'Sounds too luxurious.', rule: 'Match the register to the actual property. Do not use upscale language unless finishes and scale justify it.' },
  { key: 'generic_opening', text: 'Opening is generic.', rule: 'The first sentence must name something specific to this property.' },
  { key: 'focus_updates', text: 'Focus more on updates.', rule: 'When verified updates exist, give them prominence and name them specifically, with years where known.' },
  { key: 'too_robotic', text: 'Too robotic.', rule: 'Vary sentence length and structure. Read it aloud; if it sounds like a template, rewrite it.' },
  { key: 'too_wordy', text: 'Too wordy.', rule: 'Shorter. Every sentence must add something new. Cut restatements and throat-clearing.' },
  { key: 'better_transition', text: 'Better transition needed.', rule: 'Connect ideas through grouping and logic, not filler transitions.' },
  { key: 'no_entertaining', text: "Don't say perfect for entertaining.", rule: 'Never write "perfect for entertaining" or similar. Describe the space itself.', avoid: 'perfect for entertaining' },
  { key: 'no_welcome', text: "Don't start with Welcome to.", rule: 'Never open with "Welcome to" or "Welcome home".', avoid: 'welcome to' },
]
