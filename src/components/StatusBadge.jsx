import React from 'react'

const statusColors = {
  // Transaction statuses
  pre_listing: '#6b7280',
  active: '#3b82f6',
  pending: '#f59e0b',
  option_period: '#f97316',
  under_contract: '#8b5cf6',
  clear_to_close: '#10b981',
  closed: '#059669',
  withdrawn: '#ef4444',
  expired: '#dc2626',
  cancelled: '#991b1b',
  terminated_sale_contract: '#ef4444',
  terminated: '#ef4444',

  // Client statuses
  prime: '#f59e0b',
  potential: '#a78bfa',
  watch: '#06b6d4',
  on_hold: '#6b7280',

  // Task statuses
  todo: '#6b7280',
  in_progress: '#3b82f6',
  done: '#10b981',

  // Project statuses
  planning: '#a78bfa',
  completed: '#059669',

  // Marketing statuses
  planned: '#6b7280',
  paused: '#f59e0b',

  // Priority
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#6b7280',
}

export default function StatusBadge({ status, type = 'status' }) {
  const color = statusColors[status] || '#6b7280'
  const label = status ? status.replace(/_/g, ' ') : 'unknown'

  return (
    <span
      className="status-badge"
      style={{
        backgroundColor: `${color}18`,
        color: color,
        borderColor: `${color}40`,
      }}
    >
      {label}
    </span>
  )
}
