# Editorial engine (Listing Marketing Machine)

Every piece of listing copy the Hub writes (MLS remarks, website description, pre-market
blog/email/social, active email/social, Facebook, Instagram, price improvement, video
script) goes through this engine. The UI is the Marketing tab of a listing
(`src/components/EditorialStudio.jsx`) plus **Library and rules**
(`src/components/EditorialLibrary.jsx`).

## Pipeline (`engine.js`)

| Stage | What happens | Model? |
|---|---|---|
| 1 Analysis | Property type, condition with evidence, positioning, primary/supporting/minor features, photo-led features, limitations, 3 to 5 selling points, claims to avoid, questions for the agent. Reused across channels while the fact sheet is unchanged. | yes |
| 2+3 Outline and draft | Opening approach, middle grouping and ending chosen per property, then the draft. MLS always gets Versions A (Balanced Professional), B (Feature-Led), C (Warm and Conversational) built on identical facts. | yes |
| 4 Critical review | A separate editor pass, given the checker's findings, names each weak sentence, what is wrong and a concrete fix. | yes + checker |
| 5 Rewrite | Real restructuring against the review, not synonym swaps. | yes |
| 6 Fact verification | Every claim checked against the fact sheet; unsupported claims removed. | yes |
| 7 Polish | Dash scrub, sign-off guarantee, checker again, one targeted repair kept only if it reduces errors. | checker (+ model if needed) |

Version A is recommended unless it still has checker errors and another version does not.

## The fact sheet (`facts.js`)

The writer only sees property fields, listed features, the existing public remarks, and the
**Verified details for writing** box (`listings.marketing_facts`). Seller name/phone/email
and internal `notes` are never sent: that is where private seller context lives.

## The checker (`lint.js`, no model)

Errors: Fair Housing language, seller-private context, prohibited claims (best schools,
appreciation, income), claims without evidence in the facts (move-in ready, updated,
quartz, vaulted...), MLS format (one paragraph, no bullets/emoji/!/caps, character limit),
"Welcome to" openings, stock CTA endings, em/en dashes, price or street address in
pre-market channels, missing caption sign-off, team avoid-phrase rules.
Warnings: clichés, puffery density, overused verbs, repeated sentence starts, "The X
features..." pattern, flat sentence rhythm, overloaded sentences, walking-tour transitions,
spelled-out numbers, "percent", "you" in MLS remarks.

## Learning (`store.js`)

- **Reference library**: approve a listing's copy with a label (Excellent, Acceptable,
  Needs Improvement, Do Not Imitate) and the reasons. The original AI draft is captured
  from version history. Up to 3 nearest good examples and 2 "Do Not Imitate" examples are
  given to the writer as style references only.
- **Feedback**: quick chips ("Too many adjectives.", "Opening is generic." ...) or free
  text. After 3 of the same, Library and rules suggests adopting it as a rule.
- **Rules**: guidance rules go into every prompt; avoid-phrase rules are also enforced by
  the checker. Every create/edit/on/off is in `editorial_rule_history`.
- **Version history**: every AI version applied and every hand edit saved is recorded;
  any version can be restored.

## Settings

`app_settings`: `editorial_mls_char_limit` (default 1000; confirm against the MLS's public
remarks limit) and `editorial_market_context` (optional verified market figures).
Env: `EDITORIAL_MODEL` (default `claude-opus-5-5`), `ANTHROPIC_API_KEY`.

## Tests and eval

- `test/editorial.test.mjs`: offline. Checker, fact sheet, the full pipeline with a
  scripted model, and runs/apply/versions/library/rules/feedback on a throwaway DB.
- `node server/editorial/eval/run.js [fixture-id]`: live, needs the API key. 10
  representative properties (`eval/fixtures.js`); compares the old one-shot prompt, the
  revised draft and the verified final; writes `eval/reports/eval-*.md`. Roughly 6 model
  calls per fixture.

## Editorial Lab (local, nothing deployed)

Double-click `Editorial Lab.bat` in the project folder (or `node tools/editorial-lab/server.mjs`).
It serves the same studio and library on http://127.0.0.1:8790 in its own Chrome app window,
mounting ONLY the listings and editorial routes on a copy of the local database in
`tmp/editorial-lab/` (git-ignored). No scheduler, sends or syncs. The API key is entered in
the app once and kept in `tmp/editorial-lab/config.json`. `--fresh` re-copies the database.
Type an address in the top box and press "Write the MLS remarks": `POST /api/editorial/start`
(`autofill.js`) finds or creates the listing, fills EMPTY fields from the Cedar Rapids or Linn
County assessor parcel page (public record) and, when they allow it, realtor.com/zillow.com/
redfin.com, then starts the MLS run. Zillow and Realtor usually block automated requests
(403/429), so the assessor is the dependable source. Johnson County (most of Swisher, Solon,
North Liberty) is not covered yet. "Load a sample property" adds any of the 10 eval fixtures.

### Address in, marketing out (`dossier.js`, `autofill.js`, `service.startPackage`)

"Full marketing package" or "MLS remarks only" runs one job (`POST /api/editorial/start`,
poll `GET /api/editorial/jobs/:id`):

1. Find or create the listing (street match ignores ", City, IA zip").
2. In parallel: the assessor parcel page; the team's own files (`dossier.js`: folders and files
   named for the address under Listings/, seller-reports/, Social Media Post/00-READY-TO-POST,
   Videos/03 Listing Videos, blog-posts, emails and root-level files; house number plus a
   typo-tolerant street word); listing sites.
3. The dossier NEVER opens private files (offers, CMAs, comps, pricing/Profit-Driven strategy,
   presentations, seller reports, briefs, contracts, disclosures, inspections, staging guides,
   listing/sales history, "do not paste"). It reads MLS printouts/remarks, assessor/Beacon
   PDFs, feature/spec sheets, Sierra pages, captions; reviews up to 12 listing photos (never
   before/AI-edited/declutter/graphics); returns facts with source file, structured fields,
   prior remarks, and conflicts between sources (which the copy will not state). Facts that
   still look private are dropped. Stored in `listings.marketing_dossier`.
4. Fields fill in trust order: assessor, team files, listing sites; empty fields only, with
   range checks.
5. MLS is written first (its analysis is reused), then the rest of the package 3 at a time.
   Each channel's recommended version is saved only if that channel was empty.

Measured on 2416 C St SW (MLS only): 63 files found, 6 documents read, 5 private left alone,
12 photos reviewed, 26 facts, 4 conflicts caught, all 3 versions clean, about $0.70.
A full package is roughly 4 to 5 times that.

`tools/editorial-lab/import-wordings.mjs` seeded the library from the team's 70 past CRAAR
remarks (14 clean = style references, 56 "needs improvement").
