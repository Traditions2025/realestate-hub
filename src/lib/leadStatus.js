// The Sierra lead statuses, their colours and their display labels — one source so
// the Clients tabs and the Inbox thread header can never drift apart.

export const LEAD_STATUS_COLORS = {
  prime: '#f59e0b', active: '#3b82f6', new: '#a78bfa', qualify: '#a78bfa',
  watch: '#06b6d4', pending: '#8b5cf6', closed: '#10b981', archived: '#6b7280',
  junk: '#6b7280', donotcontact: '#ef4444', blocked: '#ef4444',
  potential: '#a78bfa', under_contract: '#8b5cf6', on_hold: '#6b7280',
}

export const PRIMARY_STATUSES = ['prime', 'active', 'new', 'qualify', 'pending', 'watch', 'closed']
export const OTHER_STATUSES = ['archived', 'donotcontact', 'junk', 'blocked']
export const ALL_STATUSES = [...PRIMARY_STATUSES, ...OTHER_STATUSES]

export const statusColor = (s) => LEAD_STATUS_COLORS[s] || '#6b7280'

export const formatStatus = (s) => {
  if (!s) return ''
  if (s === 'donotcontact') return 'DNC'
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
