# HUB table column widths — manual resize

HUB data tables use **manual, drag-to-resize columns** (like a spreadsheet/CRM), not automatic
width guessing. Every column has a sensible **default width**; the user drags the header edge to
change it, and the width **persists**.

Reusable engine: `src/lib/columnResize.jsx`.

## How it behaves

- Hover the divider on a column header's right edge → cursor becomes `col-resize`.
- Drag → that column resizes live and smoothly; other columns **do not** redistribute.
- Release → the width is saved (per table, by column key).
- Double-click the divider → **auto-fit** that column to its header + visible cell content.
- Fixed pixel widths mean the table can exceed the viewport → it **scrolls horizontally**
  (user-chosen readability wins; columns are never auto-squeezed to fit).
- Cells truncate with `text-overflow: ellipsis` and keep a `title` for the full value.

## Persistence

Widths are stored per table in `localStorage` under `table_layout::<tableId>`, keyed by **stable
column key** (survives reorder / hide / show). To move to per-user server storage later, swap
`loadColumnWidths`/`saveColumnWidths` in `columnResize.jsx` for an API call — no caller changes.

```
table_layout::clients  ->  { "name": 180, "phone": 130, "address": 300 }
```

Each table is independent: `status` in Clients is separate from `status` in Transactions. Use a
distinct `tableId` per list (`clients`, `transactions`, `tasks`, …). Give a view its own id only
if its column **structure** differs (the Clients FSBO / Cancelled views reuse the same column
keys, so they share one `clients` layout).

## Default widths

A column's default comes from its optional `size` category (no per-field pixel rule needed):

```js
DEFAULT_WIDTH_PX = { compact: 74, normal: 132, flex: 210, wide: 280 }
```

`compact` = checkboxes/icons/short numbers/badges; `normal` = names/phones/dates; `flex` =
emails/addresses/activity; `wide` = notes/descriptions. A column may override with
`defaultWidth` (px) and set an optional `minWidth` (else the generic 60px min applies). A new
column with no metadata still gets a sensible default and is resizable automatically.

## Using it in a config-driven grid (Clients pattern)

```js
import { useColumnWidths, ResizeHandle, defaultWidthFor } from '../lib/columnResize'

const { widths, setWidthLive, commitWidth, reset } = useColumnWidths('clients')
const widthPx = (c) => widths[c.key] || defaultWidthFor(c)
const gridTemplate = `30px ${visibleColumns.map(c => widthPx(c) + 'px').join(' ')}`

// In each header cell (position: relative), render:
<ResizeHandle
  getWidth={() => widthPx(col)} min={col.minWidth || 60}
  onResizeLive={px => setWidthLive(col.key, px)}
  onCommit={px => commitWidth(col.key, px)}
  onAutoFit={() => autoFitColumn(col.key)} />
```

Key details already handled in the Clients implementation:

- **Sort vs resize:** the handle stops click/propagation, so dragging the edge never sorts;
  clicking the header body still sorts.
- **Reorder vs resize:** a `resizingRef` flag cancels the header's drag-reorder while resizing.
- **Reset / Auto-Fit** live in the Columns menu; Reset clears *widths only* (visibility untouched).
- The scroll container (`.client-list`) uses `overflow-x: auto`.

## Columns menu

The Columns control keeps show/hide + reorder, and adds:

- **Reset Column Widths** — clears saved widths for this table, restores defaults (does not
  change which columns are visible).
- **Auto-Fit Visible Columns** — sizes each visible column to its content.

## Applying to `<table>` pages later

The same hook works for HTML tables: hold widths from `useColumnWidths(tableId)`, render a
`<colgroup>` with `<col style={{width}}>` per column, and place a `ResizeHandle` in each `<th>`
(`position: relative`). Neutral helpers `.cell-center`, `.cell-num`, `.cell-truncate`, and
`.table-scroll` are available in `app.css`.

## Don't

- Don't hard-code widths by field name (`.col-status`, `th:nth-child(4){width}`).
- Don't auto-distribute/flex-grow columns to fill the viewport.
- Don't store widths by position — always by stable column key.
- Don't destroy a saved width when a column is hidden.
