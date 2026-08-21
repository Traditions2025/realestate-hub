// Role-based access control. Centralized so authorization is never scattered as
// ad-hoc `role === 'x'` checks across routes. Permissions are strings; each role
// maps to a set. `can(role, perm)` is the single source of truth. Designed so
// per-permission role customization can be layered on later without changing callers.

export const ROLES = ['owner', 'admin', 'agent', 'transaction_coordinator', 'isa', 'marketing', 'read_only']

// The full permission vocabulary (extend as routes adopt enforcement).
export const PERMISSIONS = [
  'clients.view', 'clients.edit', 'clients.delete',
  'communications.view', 'communications.send', 'communications.bulk',
  'transactions.view', 'transactions.edit', 'transactions.delete',
  'tasks.view', 'tasks.edit',
  'ai.view', 'ai.manage', 'ai.autopilot',
  'automations.view', 'automations.edit',
  'reporting.view',
  'settings.view', 'settings.edit',
  'users.manage',
  'audit.view',
  'data.export',
]

const READ_ONLY = new Set(PERMISSIONS.filter(p => p.endsWith('.view')))

// Role → permission set. `owner` short-circuits to everything in can().
const ROLE_PERMS = {
  owner: new Set(PERMISSIONS),
  admin: new Set(PERMISSIONS),   // near-full; specific owner-only gates enforced in-route as needed
  agent: new Set([
    'clients.view', 'clients.edit',
    'communications.view', 'communications.send',
    'transactions.view', 'tasks.view', 'tasks.edit',
    'ai.view', 'reporting.view',
  ]),
  transaction_coordinator: new Set([
    'clients.view',
    'communications.view', 'communications.send',
    'transactions.view', 'transactions.edit',
    'tasks.view', 'tasks.edit', 'reporting.view',
  ]),
  isa: new Set([
    'clients.view', 'clients.edit',
    'communications.view', 'communications.send',
    'ai.view', 'ai.manage', 'tasks.view', 'tasks.edit',
  ]),
  marketing: new Set([
    'clients.view',
    'communications.view',
    'automations.view', 'automations.edit',
    'reporting.view',
  ]),
  read_only: READ_ONLY,
}

export function can(role, permission) {
  const r = String(role || '').toLowerCase()
  if (r === 'owner') return true
  const set = ROLE_PERMS[r]
  return set ? set.has(permission) : false
}

export function isValidRole(role) { return ROLES.includes(String(role || '').toLowerCase()) }
