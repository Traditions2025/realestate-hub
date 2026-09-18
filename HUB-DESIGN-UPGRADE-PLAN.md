# Hub Design Upgrade Plan

> **STATUS 2026-09-17:** Phases 1–4 SHIPPED (commits 9f88aa3 Phase 1, 63e66e4 Phases 2–4).
> Phase 2 device acceptance still owed: install the PWA on Matt's iPhone + one Android and
> run the mobile-native checklist on real hardware. Phase 5 items are proposals awaiting
> Matt's sign-off — do not build without it.

Audience: Claude Code implementation sessions (and John/Matt for sign-off).
Created 2026-09-17 from an audit of `src/` against the newly installed design skills
(`emil-design-eng`, `impeccable`, `mobile-native`, `ask-sonner`, `apple-design`,
`animate` / `find-animation-opportunities` / `review-animations`, `redesign-existing-projects`, `prototype`).

**How to use this doc:** each item names the skill to invoke (via the Skill tool) BEFORE
writing code for that item. Work top to bottom within a phase. One phase per session is a
good pace. Standard rules apply: small batches, check no sync/import/digest is running
before any deploy, and don't touch server code for any of this — it is all client-side.

**What the audit found is already good (don't redo):** design tokens in `src/styles/app.css:6-37`,
accent theming with light-mode variants, light/dark theme, `safe-area-inset` (16 uses),
`input font-size: 16px` iOS zoom fix (`app.css:4111`), global `:focus-visible` rule (`app.css:459`),
mobile sidebar drawer, skeleton CSS with a `prefers-reduced-motion` guard (`app.css:4337-4345`),
`.empty-state` classes used across 17 pages.

---

## Phase 1 — Feedback overhaul (highest impact, do first)

### 1.1 Replace all `alert()` with toasts — **skill: `ask-sonner`**, then **`emil-design-eng`** for tone
The codebase has **290 `alert()` calls** and no toast system. Every save, error, and
success currently throws a blocking native dialog. This is the single largest UX defect.

- Install Sonner, mount one `<Toaster />` in `App.jsx` (theme-aware: read `body[data-theme]`,
  position bottom-right desktop / top-center mobile, `richColors` off — style with our tokens).
- Sweep `src/pages/*.jsx` and `src/components/*.jsx`: success confirmations → `toast.success()`,
  errors → `toast.error()` with the actual reason, long operations (imports, bulk sends) →
  `toast.promise()` so the user sees pending → done in one element.
- Rules from `emil-design-eng`: toast copy states what happened, not "Success!" —
  "Lead saved", "Text queued to 14 people", "Sierra rejected the tag: rate limited, retrying".
  Never toast on something the user can already see happening inline.
- Do this page by page (Clients and Inbox first — highest traffic), not one giant diff.
- z-index check: toaster must sit above `Modal.jsx` overlays and the CallWidget.

### 1.2 Replace `confirm()` with the existing Modal — **skill: `impeccable`**
**63 native `confirm()` calls.** `components/Modal.jsx` already exists; add a small
`useConfirm()` hook (promise-based) rendering a danger-styled confirm dialog: title states the
action ("Delete 3 tasks?"), body states the consequence, destructive button is red and
right-aligned, Cancel is the safe default, Escape cancels, Enter does NOT confirm destructive
actions. Sweep all 63 call sites. Native `confirm()` in a PWA breaks the installed-app illusion
completely (it shows the browser chrome and origin).

### 1.3 Loading states: use the skeletons that already exist — **skill: `emil-design-eng`**
Skeleton CSS is defined (`app.css:4337`) but used by **zero pages**; only 3 "Loading..."
texts exist. Most pages render empty then pop in.
- Add skeleton rows to the list views (Clients, Transactions, Inbox, Tasks, Reporting) matching
  each list's real row shape (avatar circle + two text bars for Clients, etc.).
- Rule: skeletons only on first load of a view. Refreshes and background polls update in place —
  never blank out data the user is reading (this matters for the 10-min Sierra sync refreshes).
- Buttons that fire network calls get a disabled + spinner state so double-submits stop being
  possible (check bulk text and Power Dialer especially).

---

## Phase 2 — Mobile/PWA feel — **skill: `mobile-native`** (load once, fix all of these)

The Hub IS the mobile app (installed PWA, no native shell). These are the exact gaps the
mobile-native checklist flags in `src/styles/app.css`:

### 2.1 Sticky hover states (87 `:hover` rules, zero `(hover: hover)` guards)
On touch, every hover style sticks after a tap — rows stay highlighted, buttons stay lit.
Wrap interactive hover rules in `@media (hover: hover)`, or add
`@media (hover: none) { .data-table tr:hover td { background: none } ... }` overrides for the
big offenders: `.data-table tr:hover` (`app.css:632`), `.project-card:hover`, nav items, buttons.

### 2.2 Tap highlight flash (zero `-webkit-tap-highlight-color` in the file)
Every tap flashes the default grey/blue box on Android/iOS. Add to the base:
`html { -webkit-tap-highlight-color: transparent; }` and give real `:active` states instead
(see Phase 3 motion items — `:active { transform: scale(0.97) }` on buttons/rows).

### 2.3 Pull-to-refresh hijacking (zero `overscroll-behavior`)
Scrolling up in any list can trigger browser pull-to-refresh and reload the whole SPA
(losing an half-written note or filter state). Add `overscroll-behavior-y: none` on `body` /
the main scroll container. If we want pull-to-refresh, it should be ours, not the browser's.

### 2.4 `100vh` remnants (4 uses vs 2 `100dvh`)
Old `100vh` sizes wrong under mobile browser chrome (content hides behind the URL bar).
Convert the remaining `100vh` to `100dvh` with a `100vh` fallback line above it. Check
`.app-layout` (`app.css:137`) and the modal/drawer heights.

### 2.5 Long-press text selection on controls
Buttons, nav items, and table row action icons should have `user-select: none` so long-press
doesn't select the label (some elements have it; audit and normalize on `.btn`, `.nav-item`,
row action cells).

### 2.6 Touch targets in dense tables
Row action buttons and the `.ccm-status select` (36px) are near the floor. Everything tappable
gets min 44x44 hit area on `(pointer: coarse)` — use padding or an `::after` overlay,
not larger visuals.

Acceptance for Phase 2: install the PWA on a real phone (Matt's iPhone + one Android) and run
the skill's device checklist. Emulators don't count for this one.

---

## Phase 3 — Motion pass — **skills: `find-animation-opportunities` → `animate` → `review-animations`**

The entire app has **2 keyframes** (rowFlash, skeleton-shimmer). It works, but nothing
confirms actions or connects states. Run `find-animation-opportunities` first (it is read-only
and will reject bad ideas); expected wins it should confirm:

- **Button/row press feedback:** `:active` scale ~0.97, ~80ms — pairs with 2.2.
- **Toast enter/exit** — comes free with Sonner, but verify exit is faster than enter
  (exits ~150ms, enters ~250ms; leaving should never feel slower than arriving).
- **Modal/drawer:** overlay fade + panel rise 8-12px, ~200ms `ease-out`; drawer slides with the
  same curve it closes with; both interruptible.
- **List row add/remove:** new lead appearing from a sync, task completed, inbox message sent —
  a short height+fade so rows don't teleport. rowFlash already exists for updates; extend the
  pattern rather than inventing a second one.
- **Sidebar collapse** already transitions width (`app.css:152`); add the label fade so text
  doesn't pop.
- **Numbers on Dashboard/Reporting:** count-up ONLY on first paint, never on poll refresh.

Hard rules (`review-animations` will enforce these on the diff):
- Everything under 300ms; `transform`/`opacity` only (no `height`/`top` animations on lists
  longer than a screen — perf memory: the Hub's 0.3s feel is a feature).
- Extend the existing `prefers-reduced-motion` guard (`app.css:4345`) to cover ALL new motion,
  not just skeletons: one block that zeroes transition/animation durations.
- No motion on hover-only decoration. No parallax, no scroll-triggered anything — this is an
  ops tool, not a landing page (do NOT use `gpt-taste` or the landing-page skills here).

---

## Phase 4 — Consistency + hierarchy audit — **skills: `impeccable`** (primary), **`redesign-existing-projects`** (method)

Run per module, not app-wide. Order by traffic: Clients → Inbox → Transactions → Dashboard →
Tasks → the rest. For each module `impeccable` audits, findings go in a checklist at the top
of this file's companion `HUB-DESIGN-AUDIT-FINDINGS.md` (create on first run).

Known items to seed the audit:

### 4.1 Typography floor
**170 declarations at 10-13px.** 11px badges and 12px metadata are everywhere and strain on
phones (Matt reads this in the car between showings). Establish a scale in tokens:
`--text-xs: 12px` as the absolute floor (badges/eyebrows only), body never below 14px,
table cells 14px. Kill 10px and 11px entirely. This is a find/replace guided by the scale,
per module, verifying nothing wraps badly.

### 4.2 Data tables on phones
`.data-table` relies on `overflow-x: auto` side-scroll. For the three tables people actually
use on phones (Clients list, Tasks, Transactions) render a **card layout under 768px** —
name + status badge + one key fact + action row — instead of a scrolling table. The CSS
card patterns exist (`.project-card`); reuse them. Side-scroll is acceptable for
admin/reporting tables nobody opens on a phone.

### 4.3 Navigation density
24 nav items in 6 sections. Don't restructure IA without Matt, but two free wins:
put a "most used" state on top (Dashboard, Clients, Inbox, Transactions, Tasks pinned),
and in the mobile drawer collapse the SYSTEM and DIRECTORY sections by default.
Anything bigger: run **`prototype`** to build 2-3 nav variants and let Matt pick (see Phase 5).

### 4.4 Elevation and depth
Cards are flat 1px borders everywhere; modals, dropdowns, the account menu, and toasts need a
consistent elevation ramp. Add 3 shadow tokens (`--shadow-1/2/3`, dark-theme tuned — shadows on
dark backgrounds need higher opacity + a subtle lighter border instead) and apply by layer:
cards none, dropdowns 2, modals/toasts 3. Borrow the token discipline from
`high-end-visual-design` but NOT its agency look — no gradients, no glassmorphism.

### 4.5 Empty states that sell the next action
`.empty-state` exists in 17 pages but most are passive text. Each should state what the list
is FOR and offer the primary action: "No smart audiences yet — build one from a filter you
use a lot" + button. `impeccable` covers the copy pattern; keep Matt's plain voice, no cutesy
illustrations.

### 4.6 Error states
Errors currently mostly `alert()` (fixed by 1.1) or silent console. Every fetch in `api.js`
callers needs a visible failure path: inline retry banner for page loads, `toast.error` for
actions. Sierra 429s deserve a specific message ("Sierra is rate-limiting, retrying in 30s")
since we know they happen.

---

## Phase 5 — Bigger swings (only after 1-4, each needs Matt's sign-off)

### 5.1 Dashboard redesign — **skill: `prototype`**
The Dashboard is the landing screen and has grown organically. Use `prototype` to build
3 genuinely different layouts behind its visual picker (e.g., "today-first" agenda view,
KPI-first, pipeline-first), fed with real data shapes, and let Matt flip through live and pick.

### 5.2 Mobile detail views as bottom sheets — **skill: `apple-design`** (+ `animate`)
On phones, opening a client from the list is a full navigation. A draggable bottom sheet for
the client quick-view (name, last activity, call/text buttons; drag up for full profile) would
make the triage loop much faster. `apple-design` covers the sheet physics (interruptible
springs, rubber-banding, momentum handoff); build only after Phase 3 patterns are in.

### 5.3 Swipe actions on list rows (mobile) — **skill: `apple-design`**
Swipe a lead row for Call/Text, swipe a task to complete. High value for the daily
expired/cancelled workflow. High effort — gesture code needs real-device testing; do last.

---

## Skill quick-reference

| Task | Load this skill first |
|---|---|
| Toasts (install, wire, style, z-index, dark mode) | `ask-sonner` |
| Toast/dialog/empty-state copy, micro-polish, loading states | `emil-design-eng` |
| Any touch/PWA/mobile CSS fix | `mobile-native` |
| Any new animation or transition | `animate` (build), `review-animations` (review the diff) |
| Finding what to animate | `find-animation-opportunities` (read-only) |
| Module audit, hierarchy, typography, empty/error states, a11y | `impeccable` |
| Audit method for upgrading without breaking | `redesign-existing-projects` |
| Multiple layout candidates for a screen | `prototype` |
| Sheets, gestures, springs (Phase 5 only) | `apple-design` |

**Do not use on the Hub:** `gpt-taste`, `imagegen-frontend-*`, `image-to-code`, `brandkit`,
`stitch-design-taste`, `industrial-brutalist-ui`, `minimalist-ui`, `high-end-visual-design`
(except its token discipline), `design-taste-frontend` — these are landing-page/image-generation
skills and will push marketing-site aesthetics onto an ops tool.

## Global acceptance criteria (every phase)
1. Perf: interactions still feel ~0.3s; no animation on properties that trigger layout.
2. Both themes: every change checked in dark AND light, all 4 accent themes unaffected.
3. Real device: any Phase 2/3/5 change verified on an actual phone with the installed PWA.
4. Reduced motion: OS setting kills all new animation.
5. No server-side changes; never deploy while a sync/import/digest is running.
