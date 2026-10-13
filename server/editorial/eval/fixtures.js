// Writing evaluation suite: 10 representative Cedar Rapids metro properties.
// Synthetic records (fictional streets), shaped like real Hub listings. Each carries the
// property-specific expectations a good description must meet beyond the general checker:
//   must_not   wording that would misrepresent THIS property (tone/positioning mismatch)
//   must_cover at least one match per group: the selling points it must not miss
//   reference  an approved human-written description, when the team has one
export const FIXTURES = [
  {
    id: 'affordable-ranch',
    title: 'Affordable ranch with modest updates',
    listing: {
      property_address: '1418 Fixture Ave NE', city: 'Cedar Rapids', property_type: 'Single Family / Ranch', list_price: 184900,
      bedrooms: 3, bathrooms_full: 1, bathrooms_half: 0, square_feet: 1040, lot_size: '0.17 acres', year_built: 1962, garage_spaces: 1,
      basement: 'Full, unfinished', heating: 'Forced air gas', cooling: 'Central air',
      features: ['Fenced backyard', 'Detached 1-car garage', 'Hardwood floors in bedrooms', 'Storage shed'],
      marketing_facts: 'Furnace and central air replaced 2021. Interior painted 2024. Original hardwood under bedroom carpet was refinished 2024. Kitchen is original but clean.',
    },
    expect: {
      must_not: [/\bluxur|\belegan|\bestate\b|\bgourmet\b|\bchef'?s\b|updated kitchen|renovated kitchen|move[- ]in ready/i],
      must_cover: [[/2021|furnace|central air|mechanical/i], [/hardwood/i], [/fenced/i]],
    },
  },
  {
    id: 'older-well-maintained',
    title: 'Well-maintained older home',
    listing: {
      property_address: '2207 Fixture St SE', city: 'Cedar Rapids', property_type: 'Single Family / 1.5 Story', list_price: 229000,
      bedrooms: 3, bathrooms_full: 2, square_feet: 1520, lot_size: '0.21 acres', year_built: 1938, garage_spaces: 2, stories: 1.5,
      basement: 'Full, partially finished', heating: 'Boiler, hot water', cooling: 'Window units',
      features: ['Built-in bookcases', 'Arched doorways', 'Front porch', 'Detached 2-car garage', 'Mature trees'],
      marketing_facts: 'Same owners 31 years. Roof 2019, boiler serviced annually with records, windows replaced 2016, sewer line replaced 2020. Original built-ins and arched doorways intact. No central air.',
    },
    expect: {
      must_not: [/\bfully updated|completely updated|\bmodern kitchen|central air|move[- ]in ready/i],
      must_cover: [[/built[- ]?in|arched/i], [/roof|windows|sewer|2019|2016|2020/i], [/porch/i]],
    },
  },
  {
    id: 'renovated-mid',
    title: 'Renovated mid-market property',
    listing: {
      property_address: '960 Fixture Dr', city: 'Marion', property_type: 'Single Family / Split Level', list_price: 309900,
      bedrooms: 4, bathrooms_full: 2, bathrooms_half: 1, square_feet: 1980, lot_size: '0.26 acres', year_built: 1994, garage_spaces: 2,
      basement: 'Finished lower level, walkout', heating: 'Forced air gas', cooling: 'Central air', schools: 'Linn-Mar',
      features: ['Quartz countertops', 'Center island', 'LVP flooring main level', 'Walkout lower level', 'Deck', 'Primary bath with tiled shower'],
      marketing_facts: '2023 renovation: kitchen (new cabinets, quartz counters, island), all three full/half baths, LVP flooring on main level, new interior doors and trim. Deck rebuilt 2022.',
    },
    expect: {
      must_not: [/\bluxur|\bmansion|\bestate\b/i],
      must_cover: [[/2023|renovat/i], [/quartz|island/i], [/walkout|lower level/i]],
    },
  },
  {
    id: 'suburban-two-story',
    title: 'Standard suburban two-story',
    listing: {
      property_address: '5530 Fixture Ln NE', city: 'Cedar Rapids', property_type: 'Single Family / Two Story', list_price: 339000,
      bedrooms: 4, bathrooms_full: 2, bathrooms_half: 1, square_feet: 2240, lot_size: '0.24 acres', year_built: 2006, garage_spaces: 3, stories: 2,
      basement: 'Full, unfinished, egress window', heating: 'Forced air gas', cooling: 'Central air',
      features: ['Main-floor laundry', '3-car attached garage', 'Patio', 'Walk-in closet in primary', 'Pantry'],
      marketing_facts: 'All 4 bedrooms upstairs. Unfinished basement has an egress window and a rough-in for a bathroom. Water heater 2022.',
    },
    expect: {
      must_not: [/\bluxur|\bstunning|\bgourmet|finished (basement|lower level)/i],
      must_cover: [[/upstairs|upper level|second (floor|level)/i], [/3-car|three-car/i], [/rough[- ]in|egress|unfinished/i]],
    },
  },
  {
    id: 'executive-upgrades',
    title: 'Executive home with significant upgrades',
    listing: {
      property_address: '7110 Fixture Ridge Ct NE', city: 'Cedar Rapids', property_type: 'Single Family / Ranch', list_price: 649000,
      bedrooms: 5, bathrooms_full: 3, bathrooms_half: 1, square_feet: 3860, lot_size: '0.52 acres', year_built: 2012, garage_spaces: 3,
      basement: 'Finished walkout with wet bar', heating: 'Forced air gas, 2 zones', cooling: 'Central air',
      features: ['Vaulted great room', 'Stone fireplace', 'Wet bar', 'Covered deck', 'Irrigation system', 'Heated garage', 'Primary suite on main level'],
      marketing_facts: '2022 kitchen remodel: custom cabinetry to ceiling, quartzite counters, 48-inch range, butler pantry. Covered composite deck added 2021. Lower level has wet bar, theater area and 2 bedrooms. Backs to a tree line.',
    },
    expect: {
      must_not: [/\bbreathtaking|\bexquisite|\bmagnificent|\bunparalleled|\bluxurious\b/i],
      must_cover: [[/2022|remodel|quartzite|butler/i], [/vault|fireplace/i], [/walkout|lower level/i], [/main[- ]level|main[- ]floor/i]],
    },
  },
  {
    id: 'luxury-custom',
    title: 'Luxury custom home',
    listing: {
      property_address: '300 Fixture Bluff Rd', city: 'Marion', property_type: 'Single Family / 1.5 Story', list_price: 1185000,
      bedrooms: 5, bathrooms_full: 4, bathrooms_half: 2, square_feet: 5720, lot_size: '2.8 acres', year_built: 2018, garage_spaces: 4,
      basement: 'Finished walkout', heating: 'Geothermal', cooling: 'Geothermal',
      features: ['Geothermal HVAC', 'White oak floors', 'Steel-framed windows', 'Indoor-outdoor fireplace', 'Wine room', 'Sport court', '4-car garage', 'Primary suite with sitting room'],
      marketing_facts: 'Custom build 2018 by a local builder. 2.8 wooded acres. Great room has 20-foot ceilings and a wall of steel-framed windows facing the woods. Indoor-outdoor fireplace shared with a screened porch. Geothermal heating and cooling. Lower level: sport court, wine room, guest suite.',
    },
    expect: {
      must_not: [/\bluxurious|\bexquisite|\bbreathtaking|\bopulent|\bdream home|\bstunning/i],
      must_cover: [[/geothermal/i], [/2\.8|acre|wooded|woods/i], [/steel[- ]framed|20-foot|white oak/i]],
    },
  },
  {
    id: 'rural-acreage',
    title: 'Rural acreage',
    listing: {
      property_address: '2950 Fixture Rd', city: 'Center Point', property_type: 'Acreage', list_price: 489000,
      bedrooms: 3, bathrooms_full: 2, square_feet: 1880, lot_size: '9.4 acres', year_built: 1978, garage_spaces: 2,
      basement: 'Full, finished family room', heating: 'LP forced air', cooling: 'Central air',
      features: ['40x60 machine shed with concrete floor', 'Fenced pasture', 'Private well', 'Septic', 'Wood stove', 'Gravel drive'],
      marketing_facts: '9.4 acres total, about 5 fenced pasture. 40x60 shed built 2015 with 200-amp service and concrete floor. Septic inspected 2025. Well. LP heat. Zoned agricultural (Linn County).',
    },
    expect: {
      must_not: [/\bfarm(ing)? (income|operation)|\bdevelop(ment)? potential|\bsubdivide|\bhorse property/i],
      must_cover: [[/9\.4|acre/i], [/40x60|shed|outbuilding/i], [/pasture|fenced/i]],
    },
  },
  {
    id: 'townhouse-condo',
    title: 'Townhouse / condo',
    listing: {
      property_address: '845 Fixture Way Unit 4', city: 'Hiawatha', property_type: 'Townhouse', list_price: 238500,
      bedrooms: 2, bathrooms_full: 2, bathrooms_half: 1, square_feet: 1420, year_built: 2009, garage_spaces: 2, stories: 2,
      basement: 'None', heating: 'Forced air gas', cooling: 'Central air', hoa_fee: 210, hoa_frequency: 'month',
      features: ['Attached 2-car garage', 'Patio', 'Gas fireplace', 'Both bedrooms have private baths'],
      marketing_facts: 'HOA covers lawn care, snow removal and exterior building insurance. Owner responsible for roof per association documents. End unit.',
    },
    expect: {
      must_not: [/maintenance[- ]free|\bno maintenance|\block and leave/i],
      must_cover: [[/lawn|snow|HOA|association/i], [/private bath|own bath|each bedroom/i], [/end unit/i]],
    },
  },
  {
    id: 'investment-duplex',
    title: 'Investment property',
    listing: {
      property_address: '1630 Fixture Ave SW', city: 'Cedar Rapids', property_type: 'Multi-Family / Duplex', list_price: 259000,
      bedrooms: 4, bathrooms_full: 2, square_feet: 1960, lot_size: '0.15 acres', year_built: 1955, garage_spaces: 2,
      basement: 'Shared, unfinished, laundry hookups for each unit', heating: 'Separate furnaces', cooling: 'Central air, both units',
      features: ['Side-by-side duplex', 'Separate gas and electric meters', 'Off-street parking', 'Detached 2-car garage'],
      marketing_facts: 'Each unit 2 bed, 1 bath. Separate utilities. Both units currently leased, rents and lease terms available to qualified buyers on request. Roof 2018.',
    },
    expect: {
      must_not: [/\bcash ?flow|\bpassive income|\bgreat (return|investment)|\bROI\b|\bpays for itself|\$\d[\d,]* ?(\/| per )mo/i],
      must_cover: [[/separate (utilit|meters|furnace)|separately metered/i], [/2 bed|two-bedroom|2-bedroom/i], [/leased|lease|rent/i]],
    },
  },
  {
    id: 'fixer-upper',
    title: 'Fixer-upper',
    listing: {
      property_address: '412 Fixture St', city: 'Palo', property_type: 'Single Family / 1.5 Story', list_price: 119000,
      bedrooms: 3, bathrooms_full: 1, square_feet: 1260, lot_size: '0.33 acres', year_built: 1920, garage_spaces: 1,
      basement: 'Partial, stone foundation', heating: 'Forced air gas', cooling: 'None',
      features: ['Large lot', 'Original woodwork', 'Detached garage'],
      marketing_facts: 'Sold as-is. Needs updating throughout: kitchen and bath dated, windows original, no central air. Roof age unknown. Original woodwork in living and dining rooms. One-third acre lot.',
    },
    expect: {
      must_not: [/move[- ]in ready|turn[- ]?key|\b(recently|newly|fully|nicely|tastefully) updated\b|\brenovated|\bcharming\b|\bhidden gem|\bpotential (equity|profit)|\bbuild equity|\binvestment opportunity/i],
      must_cover: [[/as[- ]is|needs updat|updating|renovation|opportunity to update|bring/i], [/woodwork/i], [/lot|acre/i]],
    },
  },
]

// Scores one output against the fixture's own expectations (on top of the checker).
export function scoreAgainstFixture(text, fixture) {
  const problems = []
  for (const re of fixture.expect.must_not || []) {
    const m = String(text).match(re)
    if (m) problems.push(`misrepresents the property: "${m[0]}"`)
  }
  const covered = (fixture.expect.must_cover || []).map(group => group.some(re => re.test(text)))
  covered.forEach((ok, i) => { if (!ok) problems.push(`misses a selling point (${fixture.expect.must_cover[i].map(r => r.source).join(' or ')})`) })
  return { pass: problems.length === 0, problems, coverage: `${covered.filter(Boolean).length}/${covered.length}` }
}
