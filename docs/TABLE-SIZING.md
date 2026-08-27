# HUB table / list column sizing

A reusable, content-behavior-based sizing convention for HUB lists and tables. It replaces
per-field width rules (`.col-status`, `th:nth-child(4){width:100px}`, hard-coded `fr` per
column) so new columns get balanced widths **without a new CSS rule each time**.

The idea: a column's width comes from **how its content behaves**, not what the field is called.

| Category | For content like | Behavior |
|---|---|---|
| `compact` | checkboxes, icons, short numbers, small badges, short status, short actions, short dates | Stays narrow. Shrinks to content. **Never absorbs extra width.** |
| `normal` | names, phones, categories, owners, agents, short labels/dates | Reasonable min, one share of leftover width. The default feel. |
| `flex` | emails, addresses, activity summaries, longer labels | Absorbs most of the extra width; truncates cleanly when squeezed. |
| `wide` | notes, descriptions, property blurbs | Absorbs the most. |

Extra horizontal space goes **preferentially to flex/wide** (they carry the `fr` weight);
compact columns carry none, so they can't stretch. Every category has a **readable minimum**,
so on narrow screens the table **scrolls horizontally** instead of squashing text.

Alignment is generic too: numbers right/tabular, badges & actions centered, text left.
Never key alignment off a field name.

---

## 1. Config-driven CSS-grid lists (e.g. Clients)

Add `size` (and optional `align`) to the column config; the grid template is built from the
categories. One shared source drives both header and body, so they stay aligned.

```js
const COLUMN_SIZES = {
  compact: 'minmax(52px, fit-content(96px))',
  normal:  'minmax(104px, 1fr)',
  flex:    'minmax(150px, 1.8fr)',
  wide:    'minmax(200px, 2.4fr)',
}
const colTrack = (c) => (c.size && COLUMN_SIZES[c.size]) || (c.fr ? `minmax(0, ${c.fr})` : COLUMN_SIZES.normal)

const LIST_COLUMNS = [
  { key: 'score',   label: 'Score',   size: 'compact', align: 'center' },
  { key: 'name',    label: 'Name',    size: 'flex' },
  { key: 'email',   label: 'Email',   size: 'flex' },
  { key: 'status',  label: 'Status',  size: 'normal' },
  { key: 'visits',  label: 'Visits',  size: 'compact', align: 'center' },
  // no `size`? -> falls back to a legacy `fr`, else defaults to `normal`.
]

// gridTemplateColumns: `30px ${visibleColumns.map(colTrack).join(' ')}`
```

The scroll container (`.client-list`) uses `overflow-x: auto`, so it only scrolls when the
minimums actually exceed the viewport.

## 2. HTML `<table>` lists (e.g. Tasks, Transactions, Reporting)

Use the shared utility classes from `src/styles/app.css`. Put the sizing class on the `<th>`
**and** its `<td>`s so header and body come from one source.

```html
<div class="table-scroll">
  <table class="data-table">
    <thead><tr>
      <th class="col-compact cell-center"></th>       <!-- checkbox -->
      <th class="col-flex">Task</th>                  <!-- long text -->
      <th class="col-compact cell-center">Status</th> <!-- badge -->
      <th class="col-normal">Assigned</th>            <!-- short text -->
      <th class="col-compact cell-num">Amount</th>    <!-- number, right-aligned -->
    </tr></thead>
    ...
  </table>
</div>
```

Classes:

- `.col-compact` — shrink-to-content, `white-space: nowrap`; never absorbs slack.
- `.col-normal` — `min-width: 96px`.
- `.col-flex` — `min-width: 150px`, absorbs extra width, truncates with ellipsis.
- `.col-wide` — `min-width: 220px`, absorbs the most, truncates with ellipsis.
- `.cell-center` — centered (badges, actions).
- `.cell-num` — right-aligned tabular numbers.
- `.cell-truncate` — ellipsis truncation for any cell.
- `.table-scroll` — wrap the table to get horizontal scrolling when it can't fit.

---

## Principles (why it behaves well)

- **Compact stays compact.** A column of `4 / 82 / Yes / Active` never gets the same flexible
  width as an address or description.
- **Long values don't distort the table.** flex/wide truncate with `text-overflow: ellipsis`
  (add a `title`/tooltip so the full value is still inspectable).
- **Readability over fitting.** If minimums exceed the viewport, scroll horizontally — don't
  squash. On wide screens, extra space goes to flex/wide, not spread evenly.
- **Survives change.** Columns can be added, removed, reordered, or differ entirely per list;
  a column with no metadata still gets a sensible default.
- **No field-name rules.** Don't reintroduce `.col-dom`, `.col-email`, or `th:nth-child(n)`
  width selectors as the layout architecture — categorize by behavior instead.

## Adding a new column

Pick the category by content behavior:

- one word / number / icon / badge / short action -> `compact` (add `cell-center` or `cell-num`)
- a name / phone / short label / date -> `normal`
- an email / address / activity / long label -> `flex`
- notes / descriptions -> `wide`

That's it — no new width rule required.
