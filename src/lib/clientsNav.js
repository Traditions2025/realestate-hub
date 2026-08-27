// Preserve the Clients list state across profile navigation, and drive Prev/Next through the
// exact matched result set the user was reviewing. Stored in sessionStorage (survives refresh
// within the tab); large id lists stay out of the URL. Column widths/visibility/order live in
// their own localStorage (the Clients table owns those) and are untouched here.
const KEY = 'clients_nav_context_v1'
const RETURN_FLAG = 'clients_return_restore'

export function saveClientsNav(ctx) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ ...ctx, savedAt: Date.now() })) } catch {}
}
export function loadClientsNav() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || 'null') } catch { return null }
}
// Set just before navigating back to /clients, so the list restores its exact prior state once.
export function markClientsReturn() { try { sessionStorage.setItem(RETURN_FLAG, '1') } catch {} }
export function consumeClientsReturn() {
  try { const v = sessionStorage.getItem(RETURN_FLAG); sessionStorage.removeItem(RETURN_FLAG); return v === '1' } catch { return false }
}
