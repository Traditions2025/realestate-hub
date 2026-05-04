import React, { useState, useEffect, useMemo } from 'react'
import { authFetch } from '../api'
import Modal from '../components/Modal'

const STAGES = [
  { key: 'all', label: 'All' },
  { key: 'pre_listing', label: 'Pre-Listing' },
  { key: 'coming_soon', label: 'Coming Soon' },
  { key: 'active', label: 'Active' },
  { key: 'under_contract', label: 'Under Contract' },
  { key: 'closed', label: 'Closed' },
]

const ASSETS = [
  { key: 'description', label: 'MLS Description', column: 'marketing_listing_description' },
  { key: 'blog_post', label: 'Blog Post', column: 'marketing_blog_post' },
  { key: 'social_instagram', label: 'Instagram', column: 'marketing_social_instagram' },
  { key: 'social_facebook', label: 'Facebook', column: 'marketing_social_facebook' },
  { key: 'coming_soon', label: 'Coming Soon Post', column: 'marketing_coming_soon' },
  { key: 'just_listed', label: 'Just Listed Post', column: 'marketing_just_listed' },
  { key: 'email_blast', label: 'Email Blast', column: 'marketing_email_blast' },
  { key: 'price_reduction', label: 'Price Reduction', column: 'marketing_price_reduction' },
]

// Canonical marketing task checklist, grouped by stage
const MARKETING_TASK_GROUPS = [
  {
    stage: 'Pre-Listing Prep',
    tasks: [
      { key: 'photos_scheduled', label: 'Schedule professional photoshoot' },
      { key: 'photos_taken', label: 'Photos taken' },
      { key: 'drone_photos', label: 'Drone / aerial photos' },
      { key: 'walkthrough_video', label: 'Walkthrough video filmed' },
      { key: 'description_written', label: 'Listing description written' },
      { key: 'mls_ready', label: 'MLS submission ready' },
    ],
  },
  {
    stage: 'Coming Soon (24-48h before active)',
    tasks: [
      { key: 'cs_facebook', label: 'Coming Soon post — Facebook' },
      { key: 'cs_instagram', label: 'Coming Soon post — Instagram feed' },
      { key: 'cs_instagram_story', label: 'Coming Soon — Instagram Story' },
      { key: 'cs_linkedin', label: 'Coming Soon post — LinkedIn' },
      { key: 'cs_email', label: 'Coming Soon email to database' },
      { key: 'cs_notify_hot_buyers', label: 'Notify hot buyer leads (1-on-1)' },
    ],
  },
  {
    stage: 'Just Listed / Going Active',
    tasks: [
      { key: 'mls_active', label: 'MLS submitted / Active' },
      { key: 'sign_installed', label: 'For Sale sign installed' },
      { key: 'lockbox_installed', label: 'Lockbox installed' },
      { key: 'jl_facebook', label: 'Just Listed — Facebook' },
      { key: 'jl_instagram', label: 'Just Listed — Instagram feed' },
      { key: 'jl_instagram_story', label: 'Just Listed — Instagram Story' },
      { key: 'jl_instagram_reel', label: 'Just Listed — Instagram Reel/video' },
      { key: 'jl_tiktok', label: 'Just Listed — TikTok' },
      { key: 'jl_linkedin', label: 'Just Listed — LinkedIn' },
      { key: 'jl_youtube', label: 'Walkthrough video on YouTube' },
      { key: 'jl_fb_marketplace', label: 'Posted to Facebook Marketplace' },
      { key: 'jl_team_website', label: 'Live on team website (mattsmithteam.com)' },
      { key: 'jl_blog_post', label: 'Blog post published on website' },
      { key: 'jl_email_blast', label: 'Email blast sent to database' },
      { key: 'jl_property_flyer', label: 'Property flyer printed' },
      { key: 'jl_brochure', label: 'Listing brochure printed' },
      { key: 'jl_agent_email', label: 'Submitted to local agent network' },
      { key: 'jl_broker_tour', label: 'Submitted to broker tour' },
    ],
  },
  {
    stage: 'While Active',
    tasks: [
      { key: 'weekly_seller_update', label: 'Weekly seller update sent' },
      { key: 'showing_feedback', label: 'Showing feedback collected' },
      { key: 're_share_post', label: 'Re-share post (week 2+)' },
      { key: 'price_adjustment_reviewed', label: 'Price adjustment reviewed' },
      { key: 'price_reduction_post', label: 'Price reduction post (if applicable)' },
    ],
  },
  {
    stage: 'Under Contract',
    tasks: [
      { key: 'uc_facebook', label: 'Sale Pending post — Facebook' },
      { key: 'uc_instagram', label: 'Sale Pending post — Instagram' },
      { key: 'uc_linkedin', label: 'Sale Pending post — LinkedIn' },
      { key: 'uc_sign_rider', label: 'Sale Pending sign rider installed' },
    ],
  },
  {
    stage: 'Just Sold / Closed',
    tasks: [
      { key: 'js_facebook', label: 'Just Sold post — Facebook' },
      { key: 'js_instagram', label: 'Just Sold post — Instagram' },
      { key: 'js_tiktok', label: 'Just Sold post — TikTok' },
      { key: 'js_linkedin', label: 'Just Sold post — LinkedIn' },
      { key: 'js_youtube', label: 'Just Sold video — YouTube' },
      { key: 'js_blog_post', label: 'Just Sold blog post' },
      { key: 'js_closing_photo', label: 'Closing day photo with clients' },
      { key: 'js_closing_gift', label: 'Closing gift delivered' },
      { key: 'js_testimonial', label: 'Testimonial requested' },
      { key: 'js_google_review', label: 'Google review request sent' },
      { key: 'sign_removed', label: 'Sign removed from property' },
      { key: 'lockbox_returned', label: 'Lockbox returned' },
      { key: 'js_soi_email', label: 'Sphere of influence "I just sold..." email' },
      { key: 'js_website_update', label: 'Website updated (Recently Sold)' },
    ],
  },
]

const TOTAL_TASKS = MARKETING_TASK_GROUPS.reduce((sum, g) => sum + g.tasks.length, 0)

function countDoneTasks(tasksObj) {
  if (!tasksObj || typeof tasksObj !== 'object') return 0
  let n = 0
  for (const k of Object.keys(tasksObj)) {
    if (tasksObj[k]?.done) n++
  }
  return n
}

const FIELD_GROUPS = [
  {
    label: 'Address',
    fields: [
      ['property_address', 'Street Address', 'text'],
      ['city', 'City', 'text'],
      ['state', 'State', 'text'],
      ['zip', 'Zip', 'text'],
    ],
  },
  {
    label: 'Listing Info',
    fields: [
      ['mls_number', 'MLS #', 'text'],
      ['stage', 'Stage', 'select', ['pre_listing','coming_soon','active','under_contract','closed']],
      ['status', 'Status', 'text'],
      ['list_price', 'List Price', 'number'],
      ['original_list_price', 'Original Price', 'number'],
      ['list_date', 'List Date', 'date'],
    ],
  },
  {
    label: 'Property Details',
    fields: [
      ['property_type', 'Type', 'text'],
      ['bedrooms', 'Beds', 'number'],
      ['bathrooms_full', 'Full Baths', 'number'],
      ['bathrooms_half', 'Half Baths', 'number'],
      ['square_feet', 'Sq Ft', 'number'],
      ['lot_size', 'Lot Size', 'text'],
      ['year_built', 'Year Built', 'number'],
      ['stories', 'Stories', 'number'],
      ['garage_spaces', 'Garage Spaces', 'number'],
    ],
  },
  {
    label: 'Systems & Finishes',
    fields: [
      ['basement', 'Basement', 'text'],
      ['heating', 'Heating', 'text'],
      ['cooling', 'Cooling', 'text'],
      ['flooring', 'Flooring', 'text'],
    ],
  },
  {
    label: 'Schools & Cost',
    fields: [
      ['schools', 'Schools', 'text'],
      ['hoa_fee', 'HOA Fee', 'number'],
      ['hoa_frequency', 'HOA Frequency', 'text'],
      ['taxes', 'Annual Taxes', 'number'],
    ],
  },
  {
    label: 'Media',
    fields: [
      ['hero_photo', 'Hero Photo URL', 'text'],
      ['mls_link', 'MLS Link', 'text'],
    ],
  },
  {
    label: 'Seller Contact',
    fields: [
      ['seller_name', 'Seller Name', 'text'],
      ['seller_phone', 'Seller Phone', 'text'],
      ['seller_email', 'Seller Email', 'text'],
    ],
  },
]

const emptyForm = {
  property_address: '', city: '', state: 'IA', zip: '',
  mls_number: '', stage: 'pre_listing', status: 'New',
  list_price: '', original_list_price: '',
  bedrooms: '', bathrooms_full: '', bathrooms_half: '',
  square_feet: '', lot_size: '', year_built: '', property_type: '',
  garage_spaces: '', stories: '', basement: '', heating: '', cooling: '',
  flooring: '', schools: '', hoa_fee: '', hoa_frequency: '', taxes: '',
  features: [], photos: [], hero_photo: '', virtual_tour_url: '', mls_link: '',
  description: '', seller_name: '', seller_phone: '', seller_email: '',
  list_date: '', open_house_date: '', open_house_time: '', notes: '',
  marketing_tasks: {},
}

const fmtPrice = (n) => n ? '$' + Number(n).toLocaleString() : ''
const fmtBaths = (l) => {
  const f = Number(l.bathrooms_full) || 0
  const h = Number(l.bathrooms_half) || 0
  if (!f && !h) return ''
  return h ? `${f}.${h * 5}` : `${f}`
}

export default function Listings() {
  const [items, setItems] = useState([])
  const [stage, setStage] = useState('all')
  const [search, setSearch] = useState('')
  const [openModal, setOpenModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [activeTab, setActiveTab] = useState('details')
  const [aiStatus, setAiStatus] = useState({ configured: false })
  const [generating, setGenerating] = useState(null)
  const [extracting, setExtracting] = useState(null)
  const [urlInput, setUrlInput] = useState('')
  const [featuresInput, setFeaturesInput] = useState('')
  const [addrQuery, setAddrQuery] = useState('')
  const [addrSuggestions, setAddrSuggestions] = useState([])
  const [addrOpen, setAddrOpen] = useState(false)
  const [autoFilling, setAutoFilling] = useState(false)
  const [autoFillResult, setAutoFillResult] = useState(null)
  // Matched leads modal state
  const [matchModalOpen, setMatchModalOpen] = useState(false)
  const [matchLoading, setMatchLoading] = useState(false)
  const [matches, setMatches] = useState([])
  const [matchStrict, setMatchStrict] = useState(true)
  const [matchSelected, setMatchSelected] = useState(new Set())
  const [matchSubject, setMatchSubject] = useState('')
  const [matchBody, setMatchBody] = useState('')
  const [matchPreviewOpen, setMatchPreviewOpen] = useState(false)
  const [matchSending, setMatchSending] = useState(false)

  const load = () => {
    const params = {}
    if (stage !== 'all') params.stage = stage
    if (search) params.search = search
    authFetch('/api/listings?' + new URLSearchParams(params))
      .then(r => r.json()).then(setItems)
  }

  useEffect(() => {
    authFetch('/api/listings/_meta/ai-status').then(r => r.json()).then(setAiStatus).catch(() => {})
  }, [])
  useEffect(() => { load() }, [stage, search])

  // Debounced address autocomplete (Iowa only via Nominatim)
  useEffect(() => {
    if (addrQuery.trim().length < 3) { setAddrSuggestions([]); return }
    const handle = setTimeout(() => {
      authFetch('/api/listings/search-address?q=' + encodeURIComponent(addrQuery))
        .then(r => r.json())
        .then(rows => setAddrSuggestions(Array.isArray(rows) ? rows : []))
        .catch(() => setAddrSuggestions([]))
    }, 350)
    return () => clearTimeout(handle)
  }, [addrQuery])

  const counts = useMemo(() => {
    const c = { all: items.length }
    for (const s of STAGES) if (s.key !== 'all') c[s.key] = 0
    for (const i of items) if (c[i.stage] !== undefined) c[i.stage]++
    return c
  }, [items])

  const openNew = () => {
    setEditingId(null)
    setForm(emptyForm)
    setFeaturesInput('')
    setActiveTab('details')
    setUrlInput('')
    setOpenModal(true)
  }

  const openEdit = async (id) => {
    const r = await authFetch(`/api/listings/${id}`).then(r => r.json())
    const f = { ...emptyForm }
    Object.keys(r).forEach(k => { if (r[k] !== undefined && r[k] !== null) f[k] = r[k] })
    f.features = Array.isArray(r.features) ? r.features : []
    f.photos = Array.isArray(r.photos) ? r.photos : []
    f.marketing_tasks = (r.marketing_tasks && typeof r.marketing_tasks === 'object') ? r.marketing_tasks : {}
    setForm(f)
    setFeaturesInput((f.features || []).join(', '))
    setEditingId(id)
    setActiveTab('details')
    setUrlInput('')
    setOpenModal(true)
  }

  const f2 = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  const pickAddress = (addr) => {
    setForm(prev => ({
      ...prev,
      property_address: addr.property_address || prev.property_address,
      city: addr.city || prev.city,
      state: addr.state || prev.state || 'IA',
      zip: addr.zip || prev.zip,
    }))
    setAddrQuery(`${addr.property_address}, ${addr.city}, ${addr.state} ${addr.zip || ''}`.trim())
    setAddrOpen(false)
    setAutoFillResult(null)
  }

  const autoFillFromWeb = async () => {
    if (!aiStatus.configured) { alert('AI is not configured. Set ANTHROPIC_API_KEY env var on Render.'); return }
    if (!form.property_address || !form.city) { alert('Pick or enter an address first (street + city).'); return }
    setAutoFilling(true)
    setAutoFillResult(null)
    try {
      // Save first if new
      let lid = editingId
      if (!lid) {
        const r = await authFetch('/api/listings', {
          method: 'POST',
          body: JSON.stringify(buildPayload()),
        })
        const d = await r.json()
        lid = d.id
        setEditingId(lid)
      } else {
        await save()
      }
      const r = await authFetch(`/api/listings/${lid}/auto-populate`, {
        method: 'POST',
        body: JSON.stringify({
          property_address: form.property_address,
          city: form.city,
          state: form.state || 'IA',
          zip: form.zip,
        }),
      })
      const d = await r.json()
      if (!d.success) {
        setAutoFillResult({ ok: false, message: d.error || 'No data found', tried: d.tried })
        return
      }
      // Refresh form with newly populated data
      await openEdit(lid)
      setAutoFillResult({ ok: true, source: d.source, fields: Object.keys(d.extracted || {}).length })
    } catch (e) {
      setAutoFillResult({ ok: false, message: e.message })
    } finally {
      setAutoFilling(false)
    }
  }

  const toggleTask = async (taskKey) => {
    const current = form.marketing_tasks || {}
    const isDone = !!current[taskKey]?.done
    const updated = {
      ...current,
      [taskKey]: isDone
        ? { done: false }
        : { done: true, completed_at: new Date().toISOString() },
    }
    setForm(prev => ({ ...prev, marketing_tasks: updated }))
    try {
      const lid = await ensureListing()
      await authFetch(`/api/listings/${lid}`, {
        method: 'PUT',
        body: JSON.stringify({ marketing_tasks: updated }),
      })
      authFetch('/api/listings?' + new URLSearchParams(stage !== 'all' ? { stage } : {}))
        .then(r => r.json()).then(setItems).catch(() => {})
    } catch (e) {
      console.error(e)
    }
  }

  const bulkToggleGroup = async (group, mark) => {
    const current = { ...(form.marketing_tasks || {}) }
    const stamp = new Date().toISOString()
    for (const t of group.tasks) {
      current[t.key] = mark ? { done: true, completed_at: stamp } : { done: false }
    }
    setForm(prev => ({ ...prev, marketing_tasks: current }))
    try {
      const lid = await ensureListing()
      await authFetch(`/api/listings/${lid}`, {
        method: 'PUT',
        body: JSON.stringify({ marketing_tasks: current }),
      })
      authFetch('/api/listings?' + new URLSearchParams(stage !== 'all' ? { stage } : {}))
        .then(r => r.json()).then(setItems).catch(() => {})
    } catch (e) {
      console.error(e)
    }
  }

  const buildPayload = () => {
    const payload = { ...form }
    payload.features = featuresInput.split(',').map(s => s.trim()).filter(Boolean)
    // strip empty strings
    for (const k of Object.keys(payload)) {
      if (payload[k] === '') payload[k] = null
    }
    return payload
  }

  const save = async (e) => {
    if (e) e.preventDefault()
    const payload = buildPayload()
    const url = editingId ? `/api/listings/${editingId}` : '/api/listings'
    try {
      const r = await authFetch(url, {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      })
      const d = await r.json()
      if (!r.ok || d.error) {
        throw new Error(d.error || `HTTP ${r.status}`)
      }
      if (!editingId && d.id) setEditingId(d.id)
      // If the stage was changed, make sure the user can still see the card
      // by switching to the matching stage tab (or 'all' if they were on a tab that no longer matches)
      if (payload.stage && stage !== 'all' && stage !== payload.stage) {
        setStage(payload.stage)
      }
      setOpenModal(false)
      load()
    } catch (err) {
      alert('Save failed: ' + err.message)
    }
  }

  const remove = async (id) => {
    if (!confirm('Delete this listing? This will not affect the original transaction or pre-listing.')) return
    await authFetch(`/api/listings/${id}`, { method: 'DELETE' })
    setOpenModal(false)
    load()
  }

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const data = r.result.toString().split(',')[1]
      resolve(data)
    }
    r.onerror = reject
    r.readAsDataURL(file)
  })

  // Auto-create a placeholder listing if user hasn't saved one yet —
  // this lets PDF/URL import work as the very first action when creating a listing.
  const ensureListing = async () => {
    if (editingId) return editingId
    const placeholder = {
      property_address: form.property_address || `Pending Import — ${new Date().toLocaleString()}`,
      city: form.city || '',
      state: form.state || 'IA',
      zip: form.zip || '',
      stage: form.stage || 'pre_listing',
      status: form.status || 'New',
    }
    const r = await authFetch('/api/listings', {
      method: 'POST',
      body: JSON.stringify(placeholder),
    })
    const d = await r.json()
    if (!d.id) throw new Error('Failed to create listing')
    setEditingId(d.id)
    return d.id
  }

  const extractFromPdf = async (file) => {
    if (!aiStatus.configured) { alert('AI is not configured yet. Add ANTHROPIC_API_KEY on Render and redeploy.'); return }
    setExtracting('pdf')
    try {
      const lid = await ensureListing()
      const pdf_base64 = await fileToBase64(file)
      const r = await authFetch(`/api/listings/${lid}/extract-pdf`, {
        method: 'POST',
        body: JSON.stringify({ pdf_base64, filename: file.name }),
      })
      const d = await r.json()
      if (d.error) { alert('Extraction failed: ' + d.error); return }
      // Reload form with extracted data
      await openEdit(lid)
      alert(`✓ PDF extracted. Review the property details and click Save.`)
    } catch (e) {
      alert('Extraction failed: ' + e.message)
    } finally {
      setExtracting(null)
    }
  }

  const extractFromUrl = async () => {
    if (!urlInput) { alert('Paste a listing URL first.'); return }
    if (!aiStatus.configured) { alert('AI is not configured yet. Add ANTHROPIC_API_KEY on Render and redeploy.'); return }
    setExtracting('url')
    try {
      const lid = await ensureListing()
      const r = await authFetch(`/api/listings/${lid}/extract-url`, {
        method: 'POST',
        body: JSON.stringify({ url: urlInput }),
      })
      const d = await r.json()
      if (d.error) { alert('Extraction failed: ' + d.error); return }
      await openEdit(lid)
      alert(`✓ URL extracted. Review the property details and click Save.`)
    } catch (e) {
      alert('Extraction failed: ' + e.message)
    } finally {
      setExtracting(null)
    }
  }

  const generateAsset = async (assetKey) => {
    if (!editingId) { alert('Save the listing first.'); return }
    if (!aiStatus.configured) { alert('AI is not configured. Set ANTHROPIC_API_KEY env var.'); return }
    setGenerating(assetKey)
    try {
      // Save current form first so AI has latest data
      await save()
      const r = await authFetch(`/api/listings/${editingId}/generate/${assetKey}`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      const d = await r.json()
      if (d.error) { alert('Generation failed: ' + d.error); return }
      const asset = ASSETS.find(a => a.key === assetKey)
      if (asset) f2(asset.column, d.content)
    } catch (e) {
      alert('Generation failed: ' + e.message)
    } finally {
      setGenerating(null)
    }
  }

  const buildMatchedEmail = (l) => {
    const beds = l.bedrooms ? `${l.bedrooms}BR` : ''
    const baths = fmtBaths(l) ? `${fmtBaths(l)}BA` : ''
    const sqft = l.square_feet ? `${Number(l.square_feet).toLocaleString()} sqft` : ''
    const stats = [beds, baths, sqft].filter(Boolean).join(' / ')
    const subject = `New ${beds || 'home'} matching your search — ${l.property_address}${l.city ? ', ' + l.city : ''}`
    const priceLine = l.list_price ? `Listed at $${Number(l.list_price).toLocaleString()}` : ''
    const features = Array.isArray(l.features) && l.features.length ? `<p><strong>Highlights:</strong> ${l.features.slice(0, 5).join(', ')}.</p>` : ''
    const body = `<p>Hi {{first_name}},</p>
<p>A new home just hit the market that lines up with what you've been looking for, and I wanted you to see it before everyone else does.</p>
<h3>${l.property_address}${l.city ? ', ' + l.city : ''}${l.state ? ', ' + l.state : ''} ${l.zip || ''}</h3>
<p><strong>${stats}</strong>${priceLine ? ' &middot; ' + priceLine : ''}</p>
${features}
${l.description ? `<p>${String(l.description).slice(0, 400)}${l.description.length > 400 ? '...' : ''}</p>` : ''}
${l.mls_link ? `<p><a href="${l.mls_link}">View full listing &raquo;</a></p>` : ''}
<p>Want to see it in person? Just reply to this email or call/text me at (319) 431-5859 and we'll find a time.</p>
<p>— Matt Smith<br/>Matt Smith Team — RE/MAX Concepts<br/>(319) 431-5859 | matt@mattsmithteam.com<br/>5235 Buffalo Rdg Dr NE, Cedar Rapids, IA 52411</p>`
    return { subject, body }
  }

  const openMatchedLeads = async () => {
    if (!editingId) { alert('Save the listing first.'); return }
    setMatchModalOpen(true)
    setMatchLoading(true)
    try {
      const r = await authFetch(`/api/listings/${editingId}/matched-leads?strict=${matchStrict ? '1' : '0'}`)
      const d = await r.json()
      setMatches(d.matches || [])
      setMatchSelected(new Set((d.matches || []).map(m => m.id)))
      const tpl = buildMatchedEmail(form)
      setMatchSubject(tpl.subject)
      setMatchBody(tpl.body)
    } catch (e) {
      alert('Failed to load matches: ' + e.message)
    } finally {
      setMatchLoading(false)
    }
  }

  const refreshMatches = async (strict) => {
    setMatchStrict(strict)
    setMatchLoading(true)
    try {
      const r = await authFetch(`/api/listings/${editingId}/matched-leads?strict=${strict ? '1' : '0'}`)
      const d = await r.json()
      setMatches(d.matches || [])
      setMatchSelected(new Set((d.matches || []).map(m => m.id)))
    } finally {
      setMatchLoading(false)
    }
  }

  const toggleMatch = (id) => {
    setMatchSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const sendToMatched = async () => {
    if (matchSelected.size === 0) { alert('Select at least one recipient.'); return }
    if (!matchSubject || !matchBody) { alert('Subject and body are required.'); return }
    if (matchSelected.size > 200) {
      if (!confirm(`You're about to send to ${matchSelected.size} recipients. Continue?`)) return
    }
    setMatchSending(true)
    try {
      const r = await authFetch('/api/email/bulk', {
        method: 'POST',
        body: JSON.stringify({
          client_ids: [...matchSelected],
          subject: matchSubject,
          body: matchBody,
          template: '',
        }),
      })
      const d = await r.json()
      if (d.error) { alert('Send failed: ' + d.error); return }
      alert(`✓ Sent to ${d.sent || matchSelected.size} recipients` + (d.failed ? ` (${d.failed} failed)` : ''))
      setMatchModalOpen(false)
      setMatchPreviewOpen(false)
    } catch (e) {
      alert('Send failed: ' + e.message)
    } finally {
      setMatchSending(false)
    }
  }

  const copy = async (text) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const t = document.createElement('textarea')
      t.value = text
      document.body.appendChild(t)
      t.select()
      document.execCommand('copy')
      document.body.removeChild(t)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Listings</h1>
          <p className="page-subtitle">Pre-listings + active listings — property data, PDF/URL import, and AI-powered marketing</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={openNew}>+ New Listing</button>
        </div>
      </div>

      {!aiStatus.configured && (
        <div className="warning-banner" style={{margin: '8px 0 16px', padding: '10px 14px', background: '#3a2a14', border: '1px solid #c89b4a', borderRadius: 6, color: '#f4d8a3'}}>
          AI features (PDF/URL extraction + marketing generation) require an ANTHROPIC_API_KEY environment variable on the server.
        </div>
      )}

      <div className="status-tabs">
        {STAGES.map(s => (
          <button key={s.key} className={`tab ${stage === s.key ? 'active' : ''}`} onClick={() => setStage(s.key)}>
            {s.label} <span className="tab-count">{counts[s.key] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="toolbar">
        <input
          type="text"
          placeholder="Search address, city, MLS#..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="search-input"
        />
      </div>

      <div className="listings-grid">
        {items.length === 0 ? (
          <div className="empty-state-full">No listings yet. Click "+ New Listing" to add one.</div>
        ) : items.map(item => (
          <div key={item.id} className="listing-card" onClick={() => openEdit(item.id)}>
            {item.hero_photo ? (
              <div className="listing-photo" style={{backgroundImage: `url(${item.hero_photo})`}} />
            ) : (
              <div className="listing-photo listing-photo-empty">No Photo</div>
            )}
            <div className="listing-card-body">
              <div className={`listing-stage-badge stage-${item.stage || 'pre_listing'}`}>{(item.stage || '').replace(/_/g, ' ')}</div>
              <div className="listing-address">{item.property_address}</div>
              <div className="listing-city">{[item.city, item.state, item.zip].filter(Boolean).join(', ')}</div>
              <div className="listing-price">{fmtPrice(item.list_price)}</div>
              <div className="listing-stats">
                {item.bedrooms ? <span>{item.bedrooms} bd</span> : null}
                {fmtBaths(item) ? <span>{fmtBaths(item)} ba</span> : null}
                {item.square_feet ? <span>{Number(item.square_feet).toLocaleString()} sqft</span> : null}
              </div>
              {item.mls_number && <div className="listing-mls">MLS #{item.mls_number}</div>}
              {(() => {
                const done = countDoneTasks(item.marketing_tasks)
                const pct = Math.round((done / TOTAL_TASKS) * 100)
                return (
                  <div className="listing-card-progress">
                    <div className="listing-card-progress-label">
                      Marketing: {done}/{TOTAL_TASKS} ({pct}%)
                    </div>
                    <div className="listing-card-progress-bar">
                      <div className="listing-card-progress-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
        ))}
      </div>

      <Modal open={openModal} onClose={() => setOpenModal(false)} wide title={editingId ? `Edit Listing` : 'New Listing'}>
        <div className="listing-tabs">
          <button className={`listing-tab ${activeTab === 'details' ? 'active' : ''}`} onClick={() => setActiveTab('details')}>Property Details</button>
          <button className={`listing-tab ${activeTab === 'tasks' ? 'active' : ''}`} onClick={() => setActiveTab('tasks')}>
            Marketing Tasks
            {editingId && <span className="tab-badge">{countDoneTasks(form.marketing_tasks)}/{TOTAL_TASKS}</span>}
          </button>
          <button className={`listing-tab ${activeTab === 'import' ? 'active' : ''}`} onClick={() => setActiveTab('import')}>Import (PDF / URL)</button>
          <button className={`listing-tab ${activeTab === 'marketing' ? 'active' : ''}`} onClick={() => setActiveTab('marketing')}>AI Content</button>
          <button className={`listing-tab ${activeTab === 'matched' ? 'active' : ''}`} onClick={() => setActiveTab('matched')}>📨 Send to Matched Leads</button>
        </div>

        {activeTab === 'details' && (
          <form onSubmit={save}>
            <div className="addr-search-box">
              <h4>Quick Add — Search an Iowa Address</h4>
              <div className="addr-search-wrapper">
                <input
                  type="text"
                  className="addr-search-input"
                  placeholder="Start typing... e.g. 2416 C St SW Cedar Rapids"
                  value={addrQuery}
                  onChange={e => { setAddrQuery(e.target.value); setAddrOpen(true) }}
                  onFocus={() => setAddrOpen(true)}
                  onBlur={() => setTimeout(() => setAddrOpen(false), 200)}
                />
                {addrOpen && addrSuggestions.length > 0 && (
                  <div className="addr-suggestions">
                    {addrSuggestions.map((s, i) => (
                      <div
                        key={i}
                        className="addr-suggestion"
                        onMouseDown={() => pickAddress(s)}
                      >
                        <div className="addr-suggestion-line1">
                          {s.property_address}
                        </div>
                        <div className="addr-suggestion-line2">
                          {[s.city, s.state, s.zip].filter(Boolean).join(', ')}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="addr-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!form.property_address || !form.city || autoFilling}
                  onClick={autoFillFromWeb}
                  title={!aiStatus.configured ? 'Requires ANTHROPIC_API_KEY on Render' : ''}
                >
                  {autoFilling ? 'Searching web...' : '✨ Auto-fill from Web (Zillow / Realtor.com)'}
                </button>
                {!aiStatus.configured && <span className="muted" style={{marginLeft: 12}}>(needs API key)</span>}
              </div>
              {autoFillResult && (
                <div className={`addr-result ${autoFillResult.ok ? 'ok' : 'fail'}`}>
                  {autoFillResult.ok ? (
                    <>
                      ✓ Auto-filled {autoFillResult.fields} fields from{' '}
                      <a href={autoFillResult.source} target="_blank" rel="noopener noreferrer" style={{color: 'inherit', textDecoration: 'underline'}}>
                        {(autoFillResult.source || '').includes('zillow') ? 'Zillow'
                          : (autoFillResult.source || '').includes('realtor') ? 'Realtor.com'
                          : (autoFillResult.source || '').includes('redfin') ? 'Redfin'
                          : (autoFillResult.source || '').includes('trulia') ? 'Trulia'
                          : (autoFillResult.source || '').includes('homes.com') ? 'Homes.com'
                          : 'the web'}
                      </a>. Review the fields below and save.
                    </>
                  ) : (
                    <>
                      <div>✗ {autoFillResult.message}</div>
                      {autoFillResult.tried && autoFillResult.tried.length > 0 && (
                        <div style={{marginTop: 8, fontSize: 12, opacity: 0.85}}>
                          <div style={{fontWeight: 600, marginBottom: 4}}>Sources tried:</div>
                          {autoFillResult.tried.map((t, i) => (
                            <div key={i} style={{marginBottom: 2}}>
                              {t.ok ? '✓' : '✗'} <strong>{t.source}</strong>
                              {t.error && <span> — {t.error}</span>}
                              {t.url && <span style={{opacity: 0.6}}> · <a href={t.url} target="_blank" rel="noopener noreferrer" style={{color: 'inherit'}}>open</a></span>}
                            </div>
                          ))}
                        </div>
                      )}
                      <div style={{marginTop: 8, fontSize: 12, opacity: 0.85}}>
                        💡 Tip: open one of the links above to see if the property exists on that site. If it does, paste the URL into the Import tab. If not, the property may not be currently listed for sale — upload the MLS PDF instead.
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {FIELD_GROUPS.map(group => (
              <div key={group.label} className="field-group">
                <h4>{group.label}</h4>
                <div className="form-row-multi">
                  {group.fields.map(([k, label, type, opts]) => (
                    <label key={k} className={type === 'select' || k === 'property_address' ? 'wide-label' : ''}>
                      {label}
                      {type === 'select' ? (
                        <select value={form[k] || ''} onChange={e => f2(k, e.target.value)}>
                          {opts.map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
                        </select>
                      ) : (
                        <input
                          type={type}
                          value={form[k] ?? ''}
                          onChange={e => f2(k, e.target.value)}
                          required={k === 'property_address'}
                        />
                      )}
                    </label>
                  ))}
                </div>
              </div>
            ))}

            <div className="field-group">
              <h4>Features (comma-separated)</h4>
              <textarea
                rows={2}
                placeholder="e.g. Hardwood floors, Quartz counters, Finished basement, Fenced yard"
                value={featuresInput}
                onChange={e => setFeaturesInput(e.target.value)}
              />
            </div>

            <div className="field-group">
              <h4>Description / Public Remarks</h4>
              <textarea
                rows={4}
                placeholder="Property notes, talking points, key facts..."
                value={form.description || ''}
                onChange={e => f2('description', e.target.value)}
              />
            </div>

            <div className="field-group">
              <h4>Internal Notes</h4>
              <textarea
                rows={3}
                value={form.notes || ''}
                onChange={e => f2('notes', e.target.value)}
              />
            </div>

            <div className="form-actions">
              {editingId && (
                <button type="button" className="btn btn-danger" onClick={() => remove(editingId)}>Delete</button>
              )}
              <button type="button" className="btn btn-secondary" onClick={() => setOpenModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">{editingId ? 'Save' : 'Create'}</button>
            </div>
          </form>
        )}

        {activeTab === 'tasks' && (
          <div>
            {!editingId && (
              <div className="warning-banner" style={{padding: '10px 14px', background: '#3a2a14', border: '1px solid #c89b4a', borderRadius: 6, color: '#f4d8a3', marginBottom: 16}}>
                Save the listing (Property Details tab) first, then check off marketing tasks here.
              </div>
            )}

            {(() => {
              const done = countDoneTasks(form.marketing_tasks)
              const pct = Math.round((done / TOTAL_TASKS) * 100)
              return (
                <div className="tasks-overall">
                  <div className="tasks-overall-label">
                    Overall progress: <strong>{done} / {TOTAL_TASKS}</strong> ({pct}%)
                  </div>
                  <div className="tasks-progress-bar">
                    <div className="tasks-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })()}

            {MARKETING_TASK_GROUPS.map(group => {
              const groupDone = group.tasks.filter(t => form.marketing_tasks?.[t.key]?.done).length
              const groupPct = Math.round((groupDone / group.tasks.length) * 100)
              return (
                <div key={group.stage} className="task-group">
                  <div className="task-group-header">
                    <h4>{group.stage}</h4>
                    <div className="task-group-meta">
                      <span className="task-group-count">{groupDone}/{group.tasks.length}</span>
                      <button type="button" className="btn-sm btn-secondary" disabled={!editingId} onClick={() => bulkToggleGroup(group, true)}>Mark all</button>
                      <button type="button" className="btn-sm btn-secondary" disabled={!editingId} onClick={() => bulkToggleGroup(group, false)}>Clear</button>
                    </div>
                  </div>
                  <div className="task-group-bar">
                    <div className="task-group-bar-fill" style={{ width: `${groupPct}%` }} />
                  </div>
                  <div className="task-list">
                    {group.tasks.map(task => {
                      const state = form.marketing_tasks?.[task.key]
                      const done = !!state?.done
                      const stamp = state?.completed_at
                        ? new Date(state.completed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                        : null
                      return (
                        <label key={task.key} className={`task-item ${done ? 'done' : ''}`}>
                          <input
                            type="checkbox"
                            checked={done}
                            disabled={!editingId}
                            onChange={() => toggleTask(task.key)}
                          />
                          <span className="task-label">{task.label}</span>
                          {stamp && <span className="task-stamp">{stamp}</span>}
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {activeTab === 'import' && (
          <div>
            {!aiStatus.configured ? (
              <div className="warning-banner" style={{padding: '10px 14px', background: '#3a2a14', border: '1px solid #c89b4a', borderRadius: 6, color: '#f4d8a3', marginBottom: 16}}>
                AI extraction requires an ANTHROPIC_API_KEY env var on Render. Add it, redeploy, then come back here.
              </div>
            ) : (
              <div className="addr-result ok" style={{marginBottom: 16}}>
                ✓ AI is configured. Upload a PDF or paste a listing URL — the listing will be created automatically and the property fields filled in.
              </div>
            )}

            <div className="field-group">
              <h4>Upload PDF (MLS sheet, listing agreement, brochure)</h4>
              <p className="muted">Claude reads the PDF and fills in the property details automatically. Best results with MLS data sheets.</p>
              <input
                type="file"
                accept="application/pdf"
                disabled={extracting === 'pdf' || !aiStatus.configured}
                onChange={e => { const f = e.target.files?.[0]; if (f) extractFromPdf(f); e.target.value = '' }}
              />
              {extracting === 'pdf' && <div className="muted" style={{marginTop: 8}}>Reading PDF — this can take 20-40 seconds...</div>}
            </div>

            <div className="field-group">
              <h4>Or paste a listing URL</h4>
              <p className="muted">Realtor.com, Zillow, MLS public link, brokerage page — Claude will scrape and parse it.</p>
              <div className="form-row" style={{gap: 8}}>
                <input
                  type="url"
                  placeholder="https://..."
                  value={urlInput}
                  onChange={e => setUrlInput(e.target.value)}
                  disabled={extracting === 'url'}
                />
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!urlInput || extracting === 'url' || !aiStatus.configured}
                  onClick={extractFromUrl}
                >
                  {extracting === 'url' ? 'Extracting...' : 'Extract'}
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'matched' && (
          <div>
            {!editingId && (
              <div className="warning-banner" style={{padding: '10px 14px', background: '#3a2a14', border: '1px solid #c89b4a', borderRadius: 6, color: '#f4d8a3', marginBottom: 16}}>
                Save the listing first (Property Details) to find matched leads.
              </div>
            )}
            <p className="muted" style={{marginTop: 0}}>
              Find buyer leads whose saved Sierra search criteria match this listing's price, beds/baths, sqft, and property type.
              Click "Find Matches" to scan all 45K+ leads — runs locally, no AI cost.
            </p>
            <div className="form-row" style={{gap: 8, alignItems: 'center', marginBottom: 12}}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!editingId || matchLoading}
                onClick={openMatchedLeads}
              >
                {matchLoading ? 'Searching...' : '🎯 Find Matched Leads'}
              </button>
              <label className="filter-check" style={{marginLeft: 12}}>
                <input
                  type="checkbox"
                  checked={matchStrict}
                  onChange={e => { setMatchStrict(e.target.checked); if (matches.length) refreshMatches(e.target.checked) }}
                />
                Strict match (must satisfy price + beds/baths)
              </label>
            </div>
            {matches.length > 0 && (
              <p className="muted" style={{margin: '8px 0'}}>
                {matches.length} match{matches.length === 1 ? '' : 'es'} found ({matchSelected.size} selected). Open the modal to review and send.
              </p>
            )}
          </div>
        )}

        {activeTab === 'marketing' && (
          <div>
            {!editingId && (
              <div className="warning-banner" style={{padding: '10px 14px', background: '#3a2a14', border: '1px solid #c89b4a', borderRadius: 6, color: '#f4d8a3', marginBottom: 16}}>
                Save the listing first to enable marketing generation.
              </div>
            )}
            <p className="muted" style={{marginTop: 0}}>
              Click any button to generate. Each generation uses Claude with the team voice + property details.
              You can edit the generated content directly in each box. Changes save when you click "Save" at the bottom.
            </p>

            {ASSETS.map(asset => (
              <div key={asset.key} className="asset-card">
                <div className="asset-header">
                  <h4>{asset.label}</h4>
                  <div className="asset-actions">
                    <button
                      type="button"
                      className="btn-sm btn-secondary"
                      disabled={!form[asset.column]}
                      onClick={() => copy(form[asset.column])}
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      className="btn-sm btn-primary"
                      disabled={!editingId || generating === asset.key}
                      onClick={() => generateAsset(asset.key)}
                    >
                      {generating === asset.key ? 'Generating...' : (form[asset.column] ? 'Regenerate' : 'Generate')}
                    </button>
                  </div>
                </div>
                <textarea
                  rows={6}
                  value={form[asset.column] || ''}
                  onChange={e => f2(asset.column, e.target.value)}
                  placeholder={`(empty — click "Generate" to create a ${asset.label.toLowerCase()})`}
                />
              </div>
            ))}

            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setOpenModal(false)}>Close</button>
              <button type="button" className="btn btn-primary" onClick={save}>Save All</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Matched Leads modal */}
      <Modal
        open={matchModalOpen}
        onClose={() => setMatchModalOpen(false)}
        wide
        title={`Matched Leads — ${form.property_address || 'Listing'}`}
      >
        <div>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap'}}>
            <div>
              <strong>{matches.length}</strong> match{matches.length === 1 ? '' : 'es'} &middot; <strong>{matchSelected.size}</strong> selected
            </div>
            <div style={{display: 'flex', gap: 8}}>
              <label className="filter-check">
                <input type="checkbox" checked={matchStrict} onChange={e => refreshMatches(e.target.checked)} />
                Strict (require price + beds/baths)
              </label>
              <button
                type="button"
                className="btn-sm btn-secondary"
                onClick={() => setMatchSelected(new Set(matches.map(m => m.id)))}
              >Select all</button>
              <button
                type="button"
                className="btn-sm btn-secondary"
                onClick={() => setMatchSelected(new Set())}
              >Clear</button>
            </div>
          </div>

          <div className="match-list">
            {matchLoading ? (
              <div className="muted" style={{padding: 20, textAlign: 'center'}}>Searching matches...</div>
            ) : matches.length === 0 ? (
              <div className="muted" style={{padding: 20, textAlign: 'center'}}>
                No matches found. Try unchecking "Strict" — or this listing may need more property details (price, beds, type).
              </div>
            ) : matches.map(m => (
              <label key={m.id} className={`match-row ${matchSelected.has(m.id) ? 'selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={matchSelected.has(m.id)}
                  onChange={() => toggleMatch(m.id)}
                />
                <div className="match-info">
                  <div className="match-name">
                    {m.first_name} {m.last_name}
                    {m.lead_score && <span className="match-score-badge">Score {m.lead_score}</span>}
                    {!m.hard_match && <span className="match-soft-badge">soft</span>}
                  </div>
                  <div className="match-contact">
                    {m.email}{m.city ? ` · ${m.city}${m.zip ? ' ' + m.zip : ''}` : ''}
                  </div>
                  {m.reasons?.length > 0 && (
                    <div className="match-reasons">
                      {m.reasons.map((r, i) => <span key={i} className="match-reason">{r}</span>)}
                      <span className="match-rank">match score: {m.score}</span>
                    </div>
                  )}
                </div>
              </label>
            ))}
          </div>

          {matches.length > 0 && (
            <>
              <div className="field-group" style={{marginTop: 18}}>
                <h4>Email Subject</h4>
                <input
                  type="text"
                  value={matchSubject}
                  onChange={e => setMatchSubject(e.target.value)}
                  style={{width: '100%'}}
                />
              </div>
              <div className="field-group">
                <h4>Email Body (HTML)</h4>
                <p className="muted">Use <code>{'{{first_name}}'}</code> for personalization. Each recipient gets their own copy.</p>
                <textarea rows={14} value={matchBody} onChange={e => setMatchBody(e.target.value)} style={{width: '100%', fontFamily: 'monospace', fontSize: 12.5}} />
              </div>

              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setMatchModalOpen(false)}>Cancel</button>
                <button type="button" className="btn btn-secondary" onClick={() => setMatchPreviewOpen(true)} disabled={!matchSelected.size}>
                  👁 Preview Email
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={sendToMatched}
                  disabled={matchSending || matchSelected.size === 0}
                >
                  {matchSending ? 'Sending...' : `Send to ${matchSelected.size} recipient${matchSelected.size === 1 ? '' : 's'}`}
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* Email preview modal */}
      <Modal open={matchPreviewOpen} onClose={() => setMatchPreviewOpen(false)} title="Email Preview" wide>
        {(() => {
          const sample = matches.find(m => matchSelected.has(m.id)) || matches[0]
          if (!sample) return null
          const renderedSubject = matchSubject.replace(/{{first_name}}/g, sample.first_name || 'there')
          const renderedBody = matchBody.replace(/{{first_name}}/g, sample.first_name || 'there')
          return (
            <div>
              <p className="muted">Sample using <strong>{sample.first_name} {sample.last_name}</strong> ({sample.email})</p>
              <div className="email-preview">
                <div className="email-preview-line"><strong>To:</strong> {sample.email}</div>
                <div className="email-preview-line"><strong>From:</strong> matt@mattsmithteam.com</div>
                <div className="email-preview-line"><strong>Subject:</strong> {renderedSubject}</div>
                <hr style={{margin: '12px 0', borderColor: 'var(--border)'}} />
                <div className="email-preview-body" dangerouslySetInnerHTML={{__html: renderedBody}} />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setMatchPreviewOpen(false)}>Close Preview</button>
                <button type="button" className="btn btn-primary" onClick={sendToMatched} disabled={matchSending}>
                  {matchSending ? 'Sending...' : `Send to ${matchSelected.size}`}
                </button>
              </div>
            </div>
          )
        })()}
      </Modal>
    </div>
  )
}
