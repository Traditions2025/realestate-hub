import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import Modal from '../components/Modal'

const eventTypes = ['Showing', 'Listing Appointment', 'Closing', 'Inspection', 'Appraisal', 'Walkthrough', 'Open House', 'Team Meeting', 'Training', 'Marketing', 'Personal', 'Other']
const colorOptions = ['blue', 'green', 'red', 'purple', 'amber', 'teal', 'pink']
const colorMap = { blue: '#3b82f6', green: '#10b981', red: '#ef4444', purple: '#8b5cf6', amber: '#f59e0b', teal: '#14b8a6', pink: '#ec4899' }

const emptyEvent = {
  title: '', event_type: 'Showing', event_date: '', start_time: '', end_time: '',
  location: '', description: '', attendees: '', reminder_minutes: 30,
  recurring: '', color: 'blue', completed: 0
}

export default function Calendar() {
  const [items, setItems] = useState([])
  const [typeFilter, setTypeFilter] = useState('')
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [selectedDate, setSelectedDate] = useState(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyEvent)

  const load = () => {
    const params = new URLSearchParams({ month: currentMonth })
    if (typeFilter) params.set('event_type', typeFilter)
    authFetch('/api/calendar?' + params).then(r => r.json()).then(setItems)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { load() }, [currentMonth, typeFilter])

  const openNew = (date) => {
    setEditing(null)
    setForm({ ...emptyEvent, event_date: date || new Date().toISOString().split('T')[0] })
    setModalOpen(true)
  }

  const openEdit = (item) => {
    setEditing(item.id)
    const f = { ...emptyEvent }
    Object.keys(f).forEach(k => { if (item[k] !== undefined && item[k] !== null) f[k] = item[k] })
    setForm(f)
    setModalOpen(true)
  }

  const save = async (e) => {
    e.preventDefault()
    const data = { ...form, reminder_minutes: Number(form.reminder_minutes), completed: form.completed ? 1 : 0 }
    const opts = { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
    await authFetch(editing ? `/api/calendar/${editing}` : '/api/calendar', opts)
    setModalOpen(false)
    load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this event?')) return
    await authFetch(`/api/calendar/${id}`, { method: 'DELETE' })
    load()
  }

  const toggleComplete = async (item) => {
    await authFetch(`/api/calendar/${item.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: item.completed ? 0 : 1 })
    })
    load()
  }

  const f2 = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  // Calendar
  const [year, month] = currentMonth.split('-').map(Number)
  const daysInMonth = new Date(year, month, 0).getDate()
  const firstDay = new Date(year, month - 1, 1).getDay()
  const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long', year: 'numeric' })
  const today = new Date().toISOString().split('T')[0]

  const prevMonth = () => {
    const d = new Date(year, month - 2)
    setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  const nextMonth = () => {
    const d = new Date(year, month)
    setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  // Events for selected date
  const selectedEvents = selectedDate ? items.filter(e => e.event_date === selectedDate) : []

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Calendar</h1>
          <p className="page-subtitle">Auto-syncs from Matt's Google Calendar every 5 minutes</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-secondary" onClick={async () => {
            const r = await authFetch('/api/calendar/sync-ical', { method: 'POST' })
            const d = await r.json()
            if (d.error) alert('Sync failed: ' + d.error)
            else { alert(`Calendar synced. Total events: ${d.total_events}`); load() }
          }}>Sync Google Calendar</button>
          <button className="btn btn-primary" onClick={() => openNew()}>+ New Event</button>
        </div>
      </div>

      <div className="toolbar">
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All Event Types</option>
          {eventTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div className="calendar-layout">
        <div className="cal-container">
          <div className="cal-nav">
            <button onClick={prevMonth} className="btn btn-secondary">&lt;</button>
            <h3>{monthName}</h3>
            <button onClick={nextMonth} className="btn btn-secondary">&gt;</button>
          </div>
          <div className="cal-grid">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
              <div key={d} className="cal-header-cell">{d}</div>
            ))}
            {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} className="cal-cell empty"></div>)}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1
              const dateStr = `${currentMonth}-${String(day).padStart(2, '0')}`
              const dayEvents = items.filter(e => e.event_date === dateStr)
              const isToday = dateStr === today
              const isSelected = dateStr === selectedDate
              return (
                <div key={day} className={`cal-cell ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
                  onClick={() => setSelectedDate(dateStr)}>
                  <div className="cal-day">{day}</div>
                  <div className="cal-posts">
                    {dayEvents.slice(0, 3).map(ev => (
                      <div key={ev.id} className="cal-post" style={{ borderLeftColor: colorMap[ev.color] || '#3b82f6' }}
                        onClick={e => { e.stopPropagation(); openEdit(ev) }}>
                        <span className="cal-post-title">{ev.start_time ? ev.start_time.substring(0, 5) + ' ' : ''}{ev.title}</span>
                      </div>
                    ))}
                    {dayEvents.length > 3 && <div className="cal-more">+{dayEvents.length - 3} more</div>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Day Detail Sidebar */}
        <div className="day-detail">
          <div className="day-detail-header">
            <h3>{selectedDate ? new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : 'Select a day'}</h3>
            {selectedDate && <button className="btn btn-primary btn-sm" onClick={() => openNew(selectedDate)}>+ Add</button>}
          </div>
          {selectedDate ? (
            selectedEvents.length === 0 ? (
              <p className="empty-state">No events this day</p>
            ) : (
              <div className="day-events">
                {selectedEvents.map(ev => (
                  <div key={ev.id} className={`day-event ${ev.completed ? 'completed' : ''}`}
                    style={{ borderLeftColor: colorMap[ev.color] || '#3b82f6' }}>
                    <div className="day-event-header">
                      <input type="checkbox" checked={!!ev.completed} onChange={() => toggleComplete(ev)} />
                      <span className="day-event-title" onClick={() => openEdit(ev)}>{ev.title}</span>
                    </div>
                    <div className="day-event-meta">
                      <span>{ev.event_type}</span>
                      {ev.start_time && <span>{ev.start_time}{ev.end_time ? ` - ${ev.end_time}` : ''}</span>}
                    </div>
                    {ev.location && <div className="day-event-location">{ev.location}</div>}
                    {ev.attendees && <div className="day-event-attendees">{ev.attendees}</div>}
                  </div>
                ))}
              </div>
            )
          ) : <p className="empty-state">Click a day to see events</p>}
        </div>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Event' : 'New Event'}>
        <form onSubmit={save}>
          <label>Title<input value={form.title} onChange={e => f2('title', e.target.value)} required /></label>
          <div className="form-row">
            <label>Event Type<select value={form.event_type} onChange={e => f2('event_type', e.target.value)}>
              {eventTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select></label>
            <label>Date<input type="date" value={form.event_date} onChange={e => f2('event_date', e.target.value)} required /></label>
          </div>
          <div className="form-row">
            <label>Start Time<input type="time" value={form.start_time} onChange={e => f2('start_time', e.target.value)} /></label>
            <label>End Time<input type="time" value={form.end_time} onChange={e => f2('end_time', e.target.value)} /></label>
          </div>
          <label>Location<input value={form.location} onChange={e => f2('location', e.target.value)} placeholder="Address or meeting link" /></label>
          <label>Attendees<input value={form.attendees} onChange={e => f2('attendees', e.target.value)} placeholder="Matt, John, client name..." /></label>
          <label>Description<textarea value={form.description} onChange={e => f2('description', e.target.value)} rows={3} /></label>
          <div className="form-row">
            <label>Reminder<select value={form.reminder_minutes} onChange={e => f2('reminder_minutes', e.target.value)}>
              <option value={15}>15 min</option><option value={30}>30 min</option>
              <option value={60}>1 hour</option><option value={120}>2 hours</option><option value={1440}>1 day</option>
            </select></label>
            <label>Color<select value={form.color} onChange={e => f2('color', e.target.value)}>
              {colorOptions.map(c => <option key={c} value={c}>{c}</option>)}
            </select></label>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            {editing && <button type="button" className="btn btn-danger" onClick={() => { remove(editing); setModalOpen(false) }}>Delete</button>}
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'} Event</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
