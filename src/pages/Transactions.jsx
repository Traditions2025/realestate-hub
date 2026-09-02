import React, { useState, useEffect, useRef } from 'react'
import { api, authFetch } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'
import { inlineImagesIntoBody, autoEmbedYoutubeLinks } from '../components/inlineImages'
import EmailToolbar from '../components/EmailToolbar'

const statusOptions = ['Active', 'Under Contract', 'Pending', 'Clear to Close', 'Closed', 'Pre-Listing', 'Withdrawn', 'Expired', 'Cancelled']
const financeTypes = ['Conventional', 'FHA', 'VA', 'USDA', 'Cash', 'Other']

// Pre-listing prep/marketing checklist (columns on the pre_listings table).
// Shown in the pre-listing popup so a pre-listing opens like any other card
// instead of redirecting to the (now removed) Pre-Listing Pipeline page.
const preListingChecklist = [
  ['marketing_materials_sent', 'Marketing Materials Sent'],
  ['seller_discovery_form', 'Send Google Form "Home Seller Discovery Questions"'],
  ['cma', 'CMA'],
  ['seller_netsheet', 'Seller Netsheet'],
  ['loop_created', 'Loop Created'],
  ['listing_contract_signed', 'Listing Contract Signed'],
  ['getting_home_ready', 'Getting Your Home Ready'],
  ['schedule_photoshoot', 'Schedule Professional Photoshoot'],
  ['get_spare_keys', 'Get Spare Keys'],
  ['install_lockbox', 'Install Lockbox'],
  ['install_signs', 'Install For Sale Signs'],
  ['written_description', 'Written Property Description'],
  ['coming_soon_post', 'Coming Soon Post (24 Hrs Before)'],
  ['coming_soon_email', 'Coming Soon Email (24 Hrs Before)'],
  ['listing_submitted_mls', 'Listing Submitted in MLS'],
  ['posted_social_media', 'Posted on Social Media'],
]

// Unified listing marketing/prep checklist — the SAME list shows on a pre-listing
// (in the pre-listing popup) and on an Active-status transaction. Stored as JSON
// on pre_listings.marketing_tasks AND transactions.marketing_tasks:
// { taskKey: { done: bool } }. The server auto-clears a transaction's copy when
// it moves to Under Contract.
const MARKETING_TASK_GROUPS = [
  { stage: '1. Listing Setup & Client Onboarding', tasks: [
    ['create_dotloop_folder', 'Create Dotloop folder'],
    ['dotloop_listing_agreement', 'Signed: Listing Agreement'],
    ['dotloop_appointed_agency', 'Signed: Agency Agreement'],
    ['dotloop_seller_disclosure', 'Signed: Property Disclosure'],
    ['dotloop_lead_paint', 'Signed: Lead-Based Paint (if built before 1978)'],
    ['dotloop_additional_disclosures', 'Add to Dotloop: Any additional required disclosures'],
    ['send_discovery_questionnaire', 'Send Home Seller Discovery Questionnaire (Google Form)'],
    ['send_premarketing', 'Send pre-marketing materials'],
    ['schedule_walkthrough', 'Schedule listing walkthrough'],
    ['prepare_cma', 'Prepare and send CMA'],
  ]},
  { stage: '2. Property Preparation', tasks: [
    ['schedule_photography', 'Schedule professional photography'],
    ['schedule_video', 'Schedule video'],
    ['schedule_drone', 'Schedule drone photography/video (if applicable)'],
    ['schedule_floorplan', 'Schedule floor plan (if applicable)'],
    ['coordinate_staging', 'Coordinate staging (if needed)'],
    ['install_lockbox', 'Install lockbox'],
    ['lockbox_location_leo', 'Provide lockbox location to Leo'],
    ['collect_keys', 'Collect all keys from seller'],
    ['install_yard_sign', 'Install yard sign'],
    ['install_booties', 'Install booties/shoe covers inside the home'],
  ]},
  { stage: '3. MLS Preparation', tasks: [
    ['write_mls_remarks', 'Write MLS remarks'],
    ['mls_data_entry', 'Complete MLS data entry'],
    ['mls_new_listing_sheet', 'Fill out MLS New Listing Sheet'],
    ['mls_save_incomplete', 'Save MLS listing as Incomplete'],
    ['mls_upload_photos', 'Upload photos'],
    ['mls_upload_disclosures', 'Upload disclosures to MLS attachments'],
    ['mls_verify_accuracy', 'Verify all listing information for accuracy'],
  ]},
  { stage: '4. Showing Setup', tasks: [
    ['establish_showing_instructions', 'Establish showing instructions'],
    ['setup_showingtime', 'Set up ShowingTime'],
    ['configure_showing_instructions', 'Configure: Showing instructions'],
    ['configure_access_info', 'Configure: Access information'],
    ['configure_occupancy', 'Configure: Occupancy status'],
    ['configure_showing_remarks', 'Configure: Showing remarks'],
    ['configure_seller_notifications', 'Configure: Seller notifications'],
    ['showingtime_upload_disclosures', 'Upload disclosures to ShowingTime'],
  ]},
  { stage: '5. Marketing Preparation', tasks: [
    ['create_feature_sheet', 'Create feature sheet'],
    ['obtain_utility_history', 'Obtain utility history from seller'],
    ['create_blog_post', 'Create blog post for MattSmithTeam.com'],
    ['prepare_database_email', 'Prepare database email'],
    ['prepare_social_content', 'Prepare social media content'],
    ['prepare_youtube_meta', 'Prepare YouTube description, tags, and thumbnails (if applicable)'],
  ]},
  { stage: '6. Launch Day', tasks: [
    ['mls_go_live', 'Make listing live in MLS'],
    ['email_home_live_seller', 'Email "Your Home Is Now Live" to seller'],
    ['email_listing_database', 'Email listing to database'],
    ['post_remax_first_to_know', 'Post to RE/MAX "First to Know"'],
    ['post_fb_marketplace', 'Post on Facebook Marketplace'],
    ['share_fb_groups', 'Share in Facebook Groups'],
    ['publish_blog', 'Publish blog on MattSmithTeam.com'],
    ['post_facebook', 'Post on Facebook'],
    ['post_instagram', 'Post on Instagram'],
    ['post_tiktok', 'Post on TikTok'],
    ['post_linkedin', 'Post on LinkedIn'],
    ['post_youtube', 'Post on YouTube (video)'],
    ['post_youtube_shorts', 'Post on YouTube Shorts (if applicable)'],
    ['post_instagram_reels', 'Post on Instagram Reels'],
    ['post_facebook_reels', 'Post on Facebook Reels'],
  ]},
  { stage: '7. High-End Listing Marketing (when applicable)', tasks: [
    ['zillow_showcase', 'Enroll in Zillow Showcase'],
    ['premium_lifestyle_video', 'Create premium lifestyle video'],
    ['cinematic_drone', 'Produce cinematic drone footage'],
    ['luxury_brochure', 'Create luxury property brochure'],
    ['relocation_campaign', 'Develop relocation marketing campaign'],
    ['targeted_social_ads', 'Launch targeted social media advertising'],
  ]},
  { stage: '8. Condo Listings (additional items)', tasks: [
    ['condo_hoa_bylaws', 'Obtain/review: HOA Bylaws'],
    ['condo_ccrs', 'Obtain/review: Covenants, Conditions & Restrictions (CC&Rs)'],
    ['condo_hoa_rules', 'Obtain/review: HOA Rules & Regulations'],
    ['condo_hoa_financials', 'Obtain/review: HOA Financial Documents (if available)'],
    ['condo_hoa_contact', 'Obtain/review: HOA Contact Information'],
    ['condo_hoa_transfer_fees', 'Obtain/review: HOA Transfer Fees'],
    ['condo_hoa_dues', 'Obtain/review: HOA Dues'],
    ['condo_hoa_resale_cert', 'Obtain/review: HOA Resale Certificate (if required)'],
    ['condo_pet_restrictions', 'Verify: Pet restrictions'],
    ['condo_rental_restrictions', 'Verify: Rental restrictions'],
    ['condo_short_term_rental', 'Verify: Short-term rental policy'],
    ['condo_parking_rules', 'Verify: Parking rules'],
    ['condo_storage_info', 'Verify: Storage unit information'],
    ['condo_movein_requirements', 'Verify: Move-in/move-out requirements'],
    ['condo_special_assessments', 'Verify: Special assessments'],
    ['condo_amenities', 'Verify: Amenities'],
  ]},
]
const MARKETING_TOTAL = MARKETING_TASK_GROUPS.reduce((s, g) => s + g.tasks.length, 0)
const parseTasks = (v) => {
  if (!v) return {}
  if (typeof v === 'object') return v
  try { return JSON.parse(v) || {} } catch { return {} }
}
const countMarketingDone = (obj) => Object.values(obj || {}).filter(t => t && t.done).length

const emptyTx = {
  property_address: '', mls_number: '', type: 'purchase', source: '', buyer_name: '',
  buyers_agent_name: '', seller_name: '', sellers_agent_name: '', agency_type: '',
  property_status: 'Active', list_price: '', purchase_price: '', contract_date: '',
  closing_date: '', mortgage_contingency_date: '', appraisal_contingency_date: '',
  appraisal_contingency_status: 'Not Started', inspection_contingency_date: '',
  financing_release: '', final_walkthrough: '', inspection_release: '', final_inspection_waiver: '',
  final_walkthrough_time: '', final_walkthrough_location: '', final_walkthrough_confirmed: 0,
  final_walkthrough_invite_signature: '', final_walkthrough_invite_sent_at: '',
  financing_status: 'Not Started',
  type_of_finance: '',
  earnest_money_due_date: '', ipi_due_date: '',
  lender_name: '', lender_company: '', lender_email: '',
  dotloop_status: 'Not Submitted',
  has_insurance_contingency: 1, has_home_warranty: 1, home_warranty_paid_by: 'seller',
  remove_listing_alerts: 0, email_contract_closing: 0,
  ayse_added_to_loop: 0, ayse_contracts_signed: 0, earnest_money_deposit: 'Not Started', earnest_money_amount: '',
  home_inspection: 'Not Started', home_inspector: '', inspection_date: '',
  whole_property_inspection: 0, radon_test: 0, wdi_inspection: 0, septic_inspection: 0,
  well_inspection: 0, sewer_inspection: 0, seller_acknowledgment: 0, abstract: 'Not Started',
  title_commitment: 'Not Started', mortgage_payoff: 'Not Started',
  alta_statement: 'Not Ready', deed_package: 'Not Ready',
  utilities_set: 0, sales_worksheet_added: 0, submit_loop_review: 0, approved_commission: 0,
  closing_complete: 0, testimonial_request: 0, client_id: '', tc_assigned: '', notes: '',
  // Expanded under-contract checklist
  closing_time: '', closing_location: '',
  closing_time_confirmed: 0, closing_location_confirmed: 0, closing_attendees_notified: 0,
  closing_disclosure_reviewed: 0, wire_instructions_sent: 0, seller_signed_deed: 0,
  mls_pending_marked: 0, mls_sold_marked: 0,
  sellers_disclosure_received: 0, hoa_docs_provided: 0,
  keys_remotes_collected: 0, sign_lockbox_removed: 0,
  commission_received: 0, referral_followup_30day: 0,
  buyer_payment_method: '', financing_release_followup: 0,
  marketing_tasks: {},
  seller_prepaids: '', seller_prepaids_amount: '',
}

// Dropdown options for document/status fields
const ABSTRACT_OPTIONS = ['Not Started', 'Ordered', 'Received', 'N/A']
const TITLE_COMMITMENT_OPTIONS = ['Not Started', 'Ordered', 'Received', 'N/A']
const MORTGAGE_PAYOFF_OPTIONS = ['Not Started', 'Requested', 'Received', 'N/A']
const ALTA_OPTIONS = ['Not Ready', 'Ready']
const DEED_PACKAGE_OPTIONS = ['Not Ready', 'Ready', 'Signed']
const PAYMENT_METHOD_OPTIONS = ['', 'Wire (verified by phone)', 'Check', 'Cashier’s Check', 'Cash', 'Other']
const DOTLOOP_OPTIONS = ['Not Submitted', 'Needs Review', 'Listing Approved', 'Approved for Commission']

// Parse a date string as a LOCAL date (no UTC drift). Accepts:
//   YYYY-MM-DD                (HTML date input / ISO)
//   YYYY-MM-DDTHH:MM[:SS]     (ISO datetime)
//   M/D/YYYY or MM/DD/YYYY    (legacy Google Sheet format)
function parseLocalDate(s) {
  if (!s) return null
  const str = String(s).trim()
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]))
  return null
}
function formatLocalDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Mortgage / Appraisal contingency — 30 calendar days after contract date.
// If that date lands on a weekend, roll BACK to the prior Friday.
function calcContingencyDate(contractDate, days = 30) {
  const d = parseLocalDate(contractDate)
  if (!d) return ''
  d.setDate(d.getDate() + days)
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1)
  }
  return formatLocalDate(d)
}

// Earnest money due — 3 business days after contract date (skip weekends)
function calcEarnestDue(contractDate) {
  const d = parseLocalDate(contractDate)
  if (!d) return ''
  let added = 0
  while (added < 3) {
    d.setDate(d.getDate() + 1)
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return formatLocalDate(d)
}

// Final walkthrough — the day before closing.
// If that day is Sat or Sun, walk backwards to the previous Friday.
// Examples: closing Wed 6/10 → walkthrough Tue 6/9.
//           closing Mon 6/8  → walkthrough Fri 6/5.
//           closing Sun       → walkthrough Fri.
//           closing Sat       → walkthrough Fri.
function calcFinalWalkthrough(closingDate) {
  const d = parseLocalDate(closingDate)
  if (!d) return ''
  d.setDate(d.getDate() - 1) // start at "day before closing"
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1)
  }
  return formatLocalDate(d)
}

export default function Transactions() {
  const [items, setItems] = useState([])
  const [preListings, setPreListings] = useState([])
  const [clients, setClients] = useState([])
  const [filter, setFilter] = useState({ type: '', property_status: '' })
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  // Pre-listing popup (replaces the old redirect to the Pre-Listing Pipeline page)
  const [plModalOpen, setPlModalOpen] = useState(false)
  const [plEditing, setPlEditing] = useState(null)
  const [shareCopied, setShareCopied] = useState(false)
  const deepLinkRef = useRef(false)
  const [form, setForm] = useState(emptyTx)
  const [draggingId, setDraggingId] = useState(null)
  const [dragOverStage, setDragOverStage] = useState(null)
  const [extractingPdf, setExtractingPdf] = useState(false)
  const [extractResult, setExtractResult] = useState(null)
  const [aiConfigured, setAiConfigured] = useState(false)
  const [linkedClient, setLinkedClient] = useState(null)
  // People roster (multiple leads/clients on one transaction)
  const [people, setPeople] = useState([])
  const [personSearch, setPersonSearch] = useState('')
  const [personResults, setPersonResults] = useState([])
  const [personOpen, setPersonOpen] = useState(false)
  const [personRole, setPersonRole] = useState('co-buyer')
  // Email composer
  const [emailOpen, setEmailOpen] = useState(false)
  const [emailTemplates, setEmailTemplates] = useState([])
  const [emailForm, setEmailForm] = useState({
    template_id: '', recipient_type: 'client', to_email: '', to_name: '',
    subject: '', body: '', auto_cc: [], extra_cc: [], attachments: [],
  })
  const [emailSending, setEmailSending] = useState(false)
  const [emailPreviewOpen, setEmailPreviewOpen] = useState(false)
  const txEmailBodyRef = useRef(null)

  useEffect(() => {
    authFetch('/api/transactions/_meta/ai-status').then(r => r.json()).then(d => setAiConfigured(!!d.configured)).catch(() => {})
    authFetch('/api/email/transaction-templates').then(r => r.json()).then(setEmailTemplates).catch(() => {})
  }, [])

  const openEmailComposer = async (recipientType) => {
    if (!editing) { alert('Save the transaction first.'); return }
    let toEmail = ''
    let toName = ''
    if (recipientType === 'client') {
      toEmail = linkedClient?.email || ''
      toName = linkedClient ? `${linkedClient.first_name} ${linkedClient.last_name}` : ''
    } else if (recipientType === 'closer') {
      // Pull Cherryl's info from the Partners table dynamically
      try {
        const closer = await authFetch('/api/email/closer-info').then(r => r.json())
        toEmail = closer?.email || ''
        toName = closer?.name || ''
        if (!toEmail) {
          alert('Cherryl\'s email is not set. Add her on the Partners tab with role "Closer" or "Closing Coordinator", or set name "Cherryl" / company "At Your Service Escrow".')
          return
        }
      } catch {
        alert('Could not load closer info from Partners. Please check the Partners tab.')
        return
      }
    } else if (recipientType === 'lender') {
      toName = form.lender_name || ''
    }
    setEmailForm({
      template_id: '',
      recipient_type: recipientType,
      to_email: toEmail,
      to_name: toName,
      subject: '',
      body: '',
      auto_cc: ['johnwithmattsmithteam@gmail.com', 'mattsmithremax@gmail.com'],
    })
    setEmailOpen(true)
  }

  const loadEmailTemplate = async (templateId) => {
    if (!templateId || !editing) return
    try {
      const r = await authFetch(`/api/email/transaction-preview/${templateId}/${editing}`)
      const d = await r.json()
      if (d.error) { alert(d.error); return }
      setEmailForm(prev => ({
        ...prev,
        template_id: templateId,
        subject: d.subject,
        body: d.body,
        recipient_type: d.recipient,
        to_email: d.suggested_to || prev.to_email,
        auto_cc: d.auto_cc || prev.auto_cc,
        extra_cc: d.suggested_cc || [],
      }))
    } catch (e) {
      alert('Failed to load template: ' + e.message)
    }
  }

  const sendTransactionEmail = async () => {
    if (!emailForm.to_email || !emailForm.subject || !emailForm.body) {
      alert('Recipient, subject, and body are required.'); return
    }
    setEmailSending(true)
    try {
      const r = await authFetch('/api/email/send-transaction', {
        method: 'POST',
        body: JSON.stringify({
          transaction_id: editing,
          to_email: emailForm.to_email,
          to_name: emailForm.to_name,
          subject: emailForm.subject,
          body: emailForm.body,
          template_id: emailForm.template_id,
          additional_cc: emailForm.extra_cc || [],
          attachments: emailForm.attachments || [],
        }),
      })
      const d = await r.json()
      if (d.error) { alert('Send failed: ' + d.error); return }
      alert(`✓ Email sent to ${emailForm.to_email}\nCC: ${(d.cc || []).join(', ')}`)
      setEmailOpen(false)
    } catch (e) {
      alert('Send failed: ' + e.message)
    } finally {
      setEmailSending(false)
    }
  }

  // When the modal-bound client_id changes, fetch full client info to display inline
  useEffect(() => {
    const cid = form.client_id
    if (!cid) { setLinkedClient(null); return }
    authFetch(`/api/clients/${cid}`).then(r => r.json()).then(setLinkedClient).catch(() => setLinkedClient(null))
  }, [form.client_id])

  // People roster — load whenever an existing transaction is opened.
  const loadPeople = (id) => {
    if (!id) { setPeople([]); return }
    authFetch(`/api/transactions/${id}/people`).then(r => r.json()).then(rows => setPeople(Array.isArray(rows) ? rows : [])).catch(() => setPeople([]))
  }
  useEffect(() => { loadPeople(editing) }, [editing])
  // Search CRM clients to add as a person (debounced).
  useEffect(() => {
    if (personSearch.trim().length < 2) { setPersonResults([]); return }
    const t = setTimeout(() => {
      const params = new URLSearchParams({ search: personSearch, limit: 20 })
      authFetch(`/api/clients?${params}`).then(r => r.json()).then(rows => setPersonResults(Array.isArray(rows) ? rows : (rows.rows || []))).catch(() => setPersonResults([]))
    }, 250)
    return () => clearTimeout(t)
  }, [personSearch])
  const addPerson = async ({ client_id, name }) => {
    if (!editing) { alert('Save the transaction first, then add people.'); return }
    await authFetch(`/api/transactions/${editing}/people`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: client_id || null, name: name || null, role: personRole })
    })
    setPersonSearch(''); setPersonResults([]); setPersonOpen(false)
    loadPeople(editing)
  }
  const removePerson = async (pid) => {
    await authFetch(`/api/transactions/${editing}/people/${pid}`, { method: 'DELETE' })
    loadPeople(editing)
  }

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result.toString().split(',')[1])
    r.onerror = reject
    r.readAsDataURL(file)
  })

  // Auto-create a placeholder transaction so PDF extraction can work even on a brand new modal
  const ensureTransactionId = async () => {
    if (editing) return editing
    const placeholder = {
      property_address: form.property_address || `Pending Import — ${new Date().toLocaleString()}`,
      type: form.type || 'purchase',
      property_status: form.property_status || 'Active',
    }
    const r = await api.createTransaction(placeholder)
    setEditing(r.id)
    return r.id
  }

  const extractPurchaseAgreement = async (file) => {
    if (!aiConfigured) { alert('AI extraction needs ANTHROPIC_API_KEY on Render.'); return }
    setExtractingPdf(true)
    setExtractResult(null)
    try {
      const id = await ensureTransactionId()
      const pdf_base64 = await fileToBase64(file)
      const r = await authFetch(`/api/transactions/${id}/extract-pdf`, {
        method: 'POST',
        body: JSON.stringify({ pdf_base64, filename: file.name }),
      })
      const d = await r.json()
      if (d.error) {
        setExtractResult({ ok: false, message: d.error })
        return
      }
      // Refresh form with the updated row
      const updated = await api.getTransaction(id)
      const f = { ...emptyTx }
      Object.keys(f).forEach(k => { if (updated[k] !== undefined && updated[k] !== null) f[k] = updated[k] })
      setForm(f)
      setExtractResult({ ok: true, count: d.updated_fields, fields: Object.keys(d.extracted || {}) })
      load()
    } catch (e) {
      setExtractResult({ ok: false, message: e.message })
    } finally {
      setExtractingPdf(false)
    }
  }

  // Drag payload format: "tx:<id>" or "pl:<id>"
  const onDragStart = (e, kind, item) => {
    const payload = `${kind}:${item.id}`
    setDraggingId(payload)
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', payload) } catch {}
  }
  const onDragEnd = () => { setDraggingId(null); setDragOverStage(null) }
  const onDragOver = (e, stage) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverStage !== stage) setDragOverStage(stage)
  }

  const promotePreListingToTransaction = async (pl, newStatus) => {
    const txType = 'listing' // Pre-listings always become listing-type transactions
    // Dedup: if a listing transaction already exists for this address, just update its status instead of creating another
    const existing = items.find(i =>
      i.type === 'listing' &&
      (i.property_address || '').toLowerCase().trim() === (pl.property_address || '').toLowerCase().trim()
    )
    if (existing) {
      const ok = confirm(`A listing transaction for "${pl.property_address}" already exists.\n\nUpdate its status to ${newStatus} and mark this pre-listing as Listed?`)
      if (!ok) return
      try {
        await api.updateTransaction(existing.id, { property_status: newStatus })
        await authFetch(`/api/pre-listings/${pl.id}`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'Listed' }),
        })
        load()
      } catch (err) {
        alert('Failed: ' + err.message)
      }
      return
    }

    const ok = confirm(`Promote "${pl.property_address}" from Pre-Listing to ${newStatus}?\n\nThis will create a new ${txType} transaction. The pre-listing record will be marked as Listed.`)
    if (!ok) return
    try {
      await api.createTransaction({
        property_address: pl.property_address,
        type: txType,
        property_status: newStatus,
        seller_name: pl.owner_name || '',
        client_id: pl.client_id || null,
        notes: pl.notes || '',
      })
      await authFetch(`/api/pre-listings/${pl.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'Listed' }),
      })
      load()
    } catch (err) {
      alert('Failed to promote pre-listing: ' + err.message)
    }
  }

  // Undo a wrong-direction move (Active → Pre-Listing). Does NOT mark Withdrawn.
  // Path 1: transaction was promoted from a pre-listing (has pre_listing_id) →
  //   restore that pre-listing's status to 'New' and delete the transaction.
  //   This is true "undo" — pre-listing card re-appears in the Pre-Listing column,
  //   no orphan Withdrawn transaction left behind.
  // Path 2: transaction has no pre_listing_id (manually created) →
  //   create a fresh pre-listing from the transaction's data and delete the
  //   transaction. Same end state, no Withdrawn flag.
  const demoteTransactionToPreListing = async (tx) => {
    const hasLink = !!tx.pre_listing_id
    const msg = hasLink
      ? `Undo move and put "${tx.property_address}" back in Pre-Listing?\n\nThe transaction record will be deleted and the original pre-listing entry restored. Any checklist progress on the transaction will be lost.`
      : `Move "${tx.property_address}" back to Pre-Listing?\n\nA pre-listing entry will be created and the transaction record removed. No Withdrawn marker.`
    if (!confirm(msg)) return
    try {
      if (hasLink) {
        // Restore the linked pre-listing
        await authFetch(`/api/pre-listings/${tx.pre_listing_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'New' }),
        })
      } else {
        // Create a new pre-listing carrying over the address / owner / notes
        await authFetch('/api/pre-listings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_address: tx.property_address,
            owner_name: tx.seller_name || '',
            status: 'New',
            client_id: tx.client_id || null,
            notes: tx.notes || '',
          }),
        })
      }
      // Delete the wrong-direction transaction (no Withdrawn marker)
      await authFetch(`/api/transactions/${tx.id}`, { method: 'DELETE' })
      load()
    } catch (err) {
      alert('Failed to demote transaction: ' + err.message)
    }
  }

  const onDrop = async (e, newStatus) => {
    e.preventDefault()
    setDragOverStage(null)
    const payload = draggingId || e.dataTransfer.getData('text/plain')
    setDraggingId(null)
    if (!payload) return
    const [kind, idStr] = payload.split(':')
    const id = Number(idStr)
    if (!id) return

    if (kind === 'pl') {
      // Pre-listing → transaction stage
      const pl = preListings.find(p => p.id === id)
      if (!pl) return
      if (newStatus === 'Pre-Listing') return // dropped on same column
      await promotePreListingToTransaction(pl, newStatus)
      return
    }

    // Transaction card
    const item = items.find(i => i.id === id)
    if (!item) return

    if (newStatus === 'Pre-Listing') {
      await demoteTransactionToPreListing(item)
      return
    }

    if (item.property_status === newStatus) return
    // Optimistic update
    setItems(prev => prev.map(i => i.id === id ? { ...i, property_status: newStatus } : i))
    try {
      await api.updateTransaction(id, { property_status: newStatus })
    } catch (err) {
      alert('Failed to update status: ' + err.message)
      load()
    }
  }

  const load = () => {
    const params = {}
    if (filter.type) params.type = filter.type
    if (filter.property_status) params.property_status = filter.property_status
    if (search) params.search = search
    api.getTransactions(params).then(setItems)
    // Pre-listings show in pipeline as the first column
    const plParams = new URLSearchParams()
    if (search) plParams.set('search', search)
    authFetch('/api/pre-listings?' + plParams).then(r => r.json()).then(setPreListings).catch(() => {})
  }

  useEffect(() => { load() }, [])

  // Deep-link: /transactions?prelisting=<id> auto-opens that pre-listing popup
  // so a shared link drops the recipient straight onto the checklist.
  useEffect(() => {
    if (deepLinkRef.current || !preListings.length) return
    const id = new URLSearchParams(window.location.search).get('prelisting')
    if (!id) { deepLinkRef.current = true; return }
    const pl = preListings.find(p => String(p.id) === String(id))
    if (pl) { deepLinkRef.current = true; openPreListing(pl) }
  }, [preListings])

  // Client search-as-you-type (replaces loading all 45K clients into a dropdown)
  const [clientSearch, setClientSearch] = useState('')
  const [clientResults, setClientResults] = useState([])
  const [clientOpen, setClientOpen] = useState(false)
  useEffect(() => {
    if (clientSearch.trim().length < 2) { setClientResults([]); return }
    const handle = setTimeout(() => {
      const params = new URLSearchParams({ search: clientSearch, limit: 20 })
      authFetch('/api/clients?' + params)
        .then(r => r.json())
        .then(rows => setClientResults(rows || []))
        .catch(() => setClientResults([]))
    }, 300)
    return () => clearTimeout(handle)
  }, [clientSearch])
  useEffect(() => { load() }, [filter, search])

  // Pre-listing checklist items for progress calculation
  // Pre-listing progress now uses the same unified marketing checklist (JSON)
  // as Active transactions.
  const getPlProgress = (pl) => {
    const done = countMarketingDone(parseTasks(pl.marketing_tasks))
    return Math.round((done / MARKETING_TOTAL) * 100)
  }

  const openNew = () => { setEditing(null); setForm(emptyTx); setExtractResult(null); setModalOpen(true) }
  const openNewPreListing = () => {
    setEditing(null)
    setForm({ ...emptyTx, type: 'listing', property_status: 'Pre-Listing' })
    setExtractResult(null)
    setModalOpen(true)
  }
  const openEdit = (item) => {
    setExtractResult(null)
    setEditing(item.id)
    const f = { ...emptyTx }
    Object.keys(f).forEach(k => { if (item[k] !== undefined && item[k] !== null) f[k] = item[k] })
    f.marketing_tasks = parseTasks(item.marketing_tasks)  // stored as JSON text
    setForm(f)
    setModalOpen(true)
  }

  // Open the pre-listing popup (was: redirect to /pre-listings).
  const openPreListing = (pl) => {
    setPlEditing({ ...pl, marketing_tasks: parseTasks(pl.marketing_tasks) })
    setPlModalOpen(true)
  }
  // Toggle a marketing-checklist item on a pre-listing (JSON, same list as
  // Active transactions) and persist immediately.
  const togglePlMarketing = async (key) => {
    if (!plEditing) return
    const mt = { ...(plEditing.marketing_tasks || {}) }
    mt[key] = { done: !(mt[key] && mt[key].done) }
    const updated = { ...plEditing, marketing_tasks: mt }
    setPlEditing(updated)
    setPreListings(prev => prev.map(p => p.id === updated.id ? { ...p, marketing_tasks: mt } : p))
    try {
      await authFetch(`/api/pre-listings/${updated.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketing_tasks: JSON.stringify(mt) }),
      })
    } catch {}
  }
  // Toggle a checklist item and persist it immediately.
  const togglePlCheck = async (key) => {
    if (!plEditing) return
    const next = plEditing[key] ? 0 : 1
    const updated = { ...plEditing, [key]: next }
    setPlEditing(updated)
    setPreListings(prev => prev.map(p => p.id === updated.id ? { ...p, [key]: next } : p))
    try {
      await authFetch(`/api/pre-listings/${updated.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: next }),
      })
    } catch { /* optimistic; a reload will reconcile */ }
  }
  // Persist a plain field (address/owner/walkthrough/notes) on blur.
  const savePlField = async (key, value) => {
    if (!plEditing) return
    const updated = { ...plEditing, [key]: value }
    setPlEditing(updated)
    setPreListings(prev => prev.map(p => p.id === updated.id ? { ...p, [key]: value } : p))
    try {
      await authFetch(`/api/pre-listings/${updated.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      })
    } catch {}
  }

  const save = async (e) => {
    e.preventDefault()
    const data = { ...form }
    ;['list_price', 'purchase_price', 'client_id'].forEach(k => {
      if (data[k] === '') data[k] = null
      else if (data[k]) data[k] = Number(data[k])
    })
    // marketing_tasks is a JSON object in the form — persist it as text
    data.marketing_tasks = JSON.stringify(data.marketing_tasks || {})
    if (editing) await api.updateTransaction(editing, data)
    else await api.createTransaction(data)
    setModalOpen(false)
    load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this transaction?')) return
    await api.deleteTransaction(id)
    load()
  }

  // Google Sheet sync REMOVED 2026-05-14. The hub is the master file —
  // never pull from the sheet. syncSheet and clearAndResync handlers
  // deleted along with their buttons.

  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }))
  const check = (k) => setForm(prev => ({ ...prev, [k]: prev[k] ? 0 : 1 }))

  // Finance type change: Cash means no loan -> no mortgage/financing contingency
  // and no appraisal, so clear both. (Matches the PA-extraction rule.)
  const setFinance = (v) => setForm(prev => {
    const next = { ...prev, type_of_finance: v }
    if (v === 'Cash') { next.mortgage_contingency_date = ''; next.appraisal_contingency_date = '' }
    return next
  })
  // (Mortgage & appraisal contingency inputs already lock to the same date below.)
  // Home warranty payer drives the on/off flag the email templates read.
  const setWarrantyPayer = (v) => setForm(prev => ({ ...prev, home_warranty_paid_by: v, has_home_warranty: v === 'none' ? 0 : 1 }))
  const toggleMarketing = (key) => setForm(prev => {
    const mt = { ...(prev.marketing_tasks || {}) }
    mt[key] = { done: !(mt[key] && mt[key].done) }
    return { ...prev, marketing_tasks: mt }
  })

  // Pipeline groups - Pending merged into Under Contract
  const pipelineStatuses = ['Active', 'Under Contract', 'Clear to Close', 'Closed']

  // Compute upcoming action items for Under Contract transactions
  const today = new Date()
  today.setHours(0,0,0,0)
  const parseDate = (s) => {
    if (!s) return null
    const parts = s.split(/[\/\-]/)
    let d
    if (parts[0].length === 4) d = new Date(s)
    else d = new Date(`${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}`)
    return isNaN(d) ? null : d
  }

  // Global sort: Under Contract / Pending first (soonest closing on top, no-date
  // rows at the bottom of that group), then everything else in original order.
  const sortedItems = (() => {
    const isUC = (s) => s === 'Under Contract' || s === 'Pending'
    const uc = items.filter(i => isUC(i.property_status))
    const rest = items.filter(i => !isUC(i.property_status))
    uc.sort((a, b) => {
      const da = parseDate(a.closing_date)
      const db = parseDate(b.closing_date)
      if (!da && !db) return 0
      if (!da) return 1
      if (!db) return -1
      return da.getTime() - db.getTime()
    })
    return [...uc, ...rest]
  })()
  const daysUntil = (date) => {
    const d = parseDate(date)
    if (!d) return null
    return Math.ceil((d - today) / (1000 * 60 * 60 * 24))
  }
  // A contingency whose status is terminal (e.g. financing/appraisal Approved) is considered
  // removed — drop it from Upcoming Actions instead of nagging about a satisfied contingency.
  const ACTION_TERMINAL = {
    'Inspection': ['Completed', 'Waived', 'N/A', 'Not Applicable'],
    'Appraisal Contingency': ['Approved', 'Completed', 'Waived', 'N/A', 'Not Applicable'],
    'Mortgage Contingency': ['Approved'],
  }
  const getUpcomingActions = (item) => {
    const actions = [
      { label: 'Inspection', date: item.inspection_contingency_date, status: item.home_inspection },
      { label: 'Appraisal Contingency', date: item.appraisal_contingency_date, status: item.appraisal_contingency_status },
      { label: 'Mortgage Contingency', date: item.mortgage_contingency_date, status: item.financing_status },
      { label: 'Financing Release', date: item.financing_release },
      { label: 'Final Walkthrough', date: item.final_walkthrough },
      { label: 'Closing', date: item.closing_date },
    ]
    return actions
      .map(a => ({ ...a, days: daysUntil(a.date) }))
      .filter(a => a.days !== null && a.days >= -2)
      .filter(a => !(a.status && (ACTION_TERMINAL[a.label] || []).includes(a.status)))
      .sort((a, b) => a.days - b.days)
      .slice(0, 3)
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Transaction Tracker</h1>
          <p className="page-subtitle">Hub is the source of truth. Edit directly here.</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-secondary" onClick={openNewPreListing} title="Quick-add a new pre-listing (sets type=listing, status=Pre-Listing)">
            + New Pre-Listing
          </button>
          <button className="btn btn-primary" onClick={openNew}>+ New Transaction</button>
        </div>
      </div>

      <div className="toolbar">
        <input type="text" placeholder="Search address, MLS, buyer, seller..." value={search} onChange={e => setSearch(e.target.value)} className="search-input" />
        <select value={filter.type} onChange={e => setFilter(p => ({ ...p, type: e.target.value }))}>
          <option value="">All Types</option>
          <option value="purchase">Purchase</option>
          <option value="listing">Listing</option>
        </select>
        <select value={filter.property_status} onChange={e => setFilter(p => ({ ...p, property_status: e.target.value }))}>
          <option value="">All Statuses</option>
          {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Pipeline View */}
      <div className="pipeline">
        {/* Pre-Listing column - pulls from pre_listings table.
            Hide pre-listings that have already been promoted ('Listed') or removed ('Withdrawn'). */}
        {(() => {
          const activePreListings = preListings.filter(pl =>
            !['Listed', 'Withdrawn', 'Cancelled'].includes(pl.status)
          )
          return (
        <div
          className={`pipeline-column ${dragOverStage === 'Pre-Listing' ? 'drop-target' : ''}`}
          onDragOver={e => onDragOver(e, 'Pre-Listing')}
          onDragLeave={() => setDragOverStage(s => s === 'Pre-Listing' ? null : s)}
          onDrop={e => onDrop(e, 'Pre-Listing')}
        >
          <div className="pipeline-header">
            <span>Pre-Listing</span>
            <span className="pipeline-count">{activePreListings.length}</span>
          </div>
          <div className="pipeline-scroll">
            {activePreListings.map(pl => {
              const progress = getPlProgress(pl)
              return (
                <div
                  key={`pl-${pl.id}`}
                  className={`pipeline-card ${draggingId === `pl:${pl.id}` ? 'dragging' : ''}`}
                  draggable
                  onDragStart={e => onDragStart(e, 'pl', pl)}
                  onDragEnd={onDragEnd}
                  onClick={() => openPreListing(pl)}
                >
                  <div className="pipeline-card-type">
                    <StatusBadge status="pre_listing" />
                    <span className="type-tag type-listing">pre-listing</span>
                  </div>
                  <div className="pipeline-card-address">{pl.property_address}</div>
                  <div className="pipeline-card-meta">
                    <span>{pl.owner_name || '—'}</span>
                    <span style={{fontSize: 11, color: progress === 100 ? '#10b981' : '#3b82f6'}}>{progress}%</span>
                  </div>
                  <div className="progress-bar" style={{marginTop: 6, height: 4}}>
                    <div className="progress-fill" style={{ width: `${progress}%`, backgroundColor: progress === 100 ? '#10b981' : '#3b82f6' }}></div>
                  </div>
                  {pl.walkthrough && pl.walkthrough !== 'Not Scheduled' && (
                    <div className="pipeline-card-date">Walkthrough: {pl.walkthrough}</div>
                  )}
                </div>
              )
            })}
            {activePreListings.length === 0 && (
              <div style={{padding: '20px 14px', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center'}}>
                No pre-listings
              </div>
            )}
          </div>
        </div>
          )
        })()}

        {pipelineStatuses.map(stage => {
          // Merge Pending into Under Contract
          let stageItems = stage === 'Under Contract'
            ? items.filter(i => i.property_status === 'Under Contract' || i.property_status === 'Pending')
            : items.filter(i => i.property_status === stage)
          // Under Contract: sort by closing date, soonest first; rows w/o a date go to the bottom.
          // parseDate handles both ISO (YYYY-MM-DD) and legacy M/D/YYYY from older Sheet syncs.
          if (stage === 'Under Contract') {
            stageItems = [...stageItems].sort((a, b) => {
              const da = parseDate(a.closing_date)
              const db = parseDate(b.closing_date)
              if (!da && !db) return 0
              if (!da) return 1
              if (!db) return -1
              return da.getTime() - db.getTime()
            })
          }
          return (
            <div
              key={stage}
              className={`pipeline-column ${dragOverStage === stage ? 'drop-target' : ''}`}
              onDragOver={e => onDragOver(e, stage)}
              onDragLeave={() => setDragOverStage(s => s === stage ? null : s)}
              onDrop={e => onDrop(e, stage)}
            >
              <div className="pipeline-header">
                <span>{stage}</span>
                <span className="pipeline-count">{stageItems.length}</span>
              </div>
              <div className="pipeline-scroll">
              {stageItems.map(item => {
                const isUnderContract = stage === 'Under Contract'
                const actions = isUnderContract ? getUpcomingActions(item) : []
                return (
                  <div
                    key={item.id}
                    className={`pipeline-card ${draggingId === `tx:${item.id}` ? 'dragging' : ''}`}
                    draggable
                    onDragStart={e => onDragStart(e, 'tx', item)}
                    onDragEnd={onDragEnd}
                    onClick={() => openEdit(item)}
                  >
                    <div className="pipeline-card-type">
                      <StatusBadge status={item.property_status?.toLowerCase().replace(/ /g, '_')} />
                      <span className={`type-tag type-${item.type}`}>{item.type}</span>
                    </div>
                    <div className="pipeline-card-address">{item.property_address}</div>
                    <div className="pipeline-card-meta">
                      <span>{item.buyer_name || item.seller_name || '—'}</span>
                      {item.purchase_price && <span className="price">${Number(item.purchase_price).toLocaleString()}</span>}
                    </div>
                    {/* Upcoming actions for Under Contract */}
                    {actions.length > 0 && (
                      <div className="pipeline-actions">
                        {actions.map((a, i) => {
                          const urgent = a.days <= 3
                          const overdue = a.days < 0
                          return (
                            <div key={i} className={`pipeline-action ${overdue ? 'overdue' : urgent ? 'urgent' : ''}`}>
                              <span className="action-label">{a.label}</span>
                              <span className="action-date">
                                {a.date}
                                {a.days >= 0 ? ` (${a.days}d)` : ` (${Math.abs(a.days)}d ago)`}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {!isUnderContract && item.closing_date && (
                      <div className="pipeline-card-date">Close: {item.closing_date}</div>
                    )}
                  </div>
                )
              })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Full Table - desktop */}
      <div className="table-container desktop-only-table">
        <table className="data-table">
          <thead>
            <tr>
              <th>Property Address</th>
              <th>MLS</th>
              <th>Type</th>
              <th>Status</th>
              <th>Buyer</th>
              <th>Seller</th>
              <th>Price</th>
              <th>Contract</th>
              <th>Closing</th>
              <th>TC</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.length === 0 ? (
              <tr><td colSpan="11" className="empty-state">No transactions found. Click + New Transaction to add one.</td></tr>
            ) : sortedItems.map(item => (
              <tr key={item.id}>
                <td className="cell-primary" onClick={() => openEdit(item)}>{item.property_address}</td>
                <td>{item.mls_number || '—'}</td>
                <td><span className="type-inline">{item.type}</span></td>
                <td><StatusBadge status={item.property_status?.toLowerCase().replace(/ /g, '_')} /></td>
                <td>{item.buyer_name || '—'}</td>
                <td>{item.seller_name || '—'}</td>
                <td>{item.purchase_price ? `$${Number(item.purchase_price).toLocaleString()}` : item.list_price ? `$${Number(item.list_price).toLocaleString()}` : '—'}</td>
                <td>{item.contract_date || '—'}</td>
                <td>{item.closing_date || '—'}</td>
                <td>{item.tc_assigned || '—'}</td>
                <td>
                  <button className="btn-sm" onClick={() => openEdit(item)}>Edit</button>
                  <button className="btn-sm btn-danger" onClick={() => remove(item.id)}>Del</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Card list - mobile */}
      <div className="mobile-only-cards">
        {sortedItems.length === 0 ? (
          <div className="empty-state-full">No transactions found. Click + New Transaction to add one.</div>
        ) : sortedItems.map(item => (
          <div key={item.id} className="data-card" onClick={() => openEdit(item)}>
            <div className="data-card-header">
              <div className="data-card-title">{item.property_address}</div>
              <StatusBadge status={item.property_status?.toLowerCase().replace(/ /g, '_')} />
            </div>
            <div className="data-card-meta">
              <span className={`type-tag type-${item.type}`}>{item.type}</span>
              {item.mls_number && <span>MLS {item.mls_number}</span>}
            </div>
            <div className="data-card-body">
              {item.buyer_name && <div><strong>Buyer:</strong> {item.buyer_name}</div>}
              {item.seller_name && <div><strong>Seller:</strong> {item.seller_name}</div>}
              {(item.purchase_price || item.list_price) && (
                <div><strong>Price:</strong> {item.purchase_price ? `$${Number(item.purchase_price).toLocaleString()}` : `$${Number(item.list_price).toLocaleString()}`}</div>
              )}
              {item.contract_date && <div><strong>Contract:</strong> {item.contract_date}</div>}
              {item.closing_date && <div><strong>Closing:</strong> {item.closing_date}</div>}
              {item.tc_assigned && <div><strong>TC:</strong> {item.tc_assigned}</div>}
            </div>
          </div>
        ))}
      </div>

      {/* Full Transaction Form Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Transaction' : 'New Transaction'} wide>
        {/* Auto-extract from Purchase Agreement PDF */}
        <div className="addr-search-box" style={{marginBottom: 18}}>
          <h4>📄 Quick Fill — Upload Purchase Agreement</h4>
          <p className="muted" style={{margin: '0 0 10px'}}>
            Upload the signed Purchase Agreement (or Listing Agreement) PDF and Claude will auto-fill the property, parties, prices, and contingency dates below.
          </p>
          <div className="form-row" style={{gap: 8, alignItems: 'center'}}>
            <input
              type="file"
              accept="application/pdf"
              disabled={extractingPdf || !aiConfigured}
              onChange={e => { const f = e.target.files?.[0]; if (f) extractPurchaseAgreement(f); e.target.value = '' }}
            />
            {!aiConfigured && <span className="muted">(needs ANTHROPIC_API_KEY)</span>}
            {extractingPdf && <span className="muted">Reading PDF — 20-40 seconds...</span>}
          </div>
          {extractResult && (
            <div className={`addr-result ${extractResult.ok ? 'ok' : 'fail'}`} style={{marginTop: 10}}>
              {extractResult.ok ? (
                <>
                  ✓ Extracted {extractResult.count} field{extractResult.count === 1 ? '' : 's'}: {(extractResult.fields || []).slice(0, 8).join(', ')}{extractResult.fields?.length > 8 ? '...' : ''}. Review below and click Save.
                </>
              ) : (
                <>✗ {extractResult.message}</>
              )}
            </div>
          )}
        </div>

        <form onSubmit={save} className="form-grid">
          {/* Property Info */}
          <div className="form-section">
            <h4>Property Info</h4>
            <label>Property Address<input value={form.property_address} onChange={e => f('property_address', e.target.value)} required /></label>
            <div className="form-row">
              <label>MLS #<input value={form.mls_number} onChange={e => f('mls_number', e.target.value)} /></label>
              <label>Type<select value={form.type} onChange={e => f('type', e.target.value)}>
                <option value="purchase">Purchase (we represent buyer)</option>
                <option value="listing">Listing (we represent seller)</option>
                <option value="both">Both (dual agency / both sides)</option>
              </select></label>
            </div>
            <div className="form-row">
              <label>Source<input value={form.source} onChange={e => f('source', e.target.value)} placeholder="MLS, Zillow, Referral..." /></label>
              <label>Status<select value={form.property_status} onChange={e => f('property_status', e.target.value)}>
                {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select></label>
            </div>
            <div className="form-row">
              <label>Agency Type<select value={form.agency_type} onChange={e => f('agency_type', e.target.value)}>
                <option value="">Select...</option>
                <option value="Buyer's Agent">Buyer's Agent</option>
                <option value="Listing Agent">Listing Agent</option>
                <option value="Dual Agent">Dual Agent</option>
              </select></label>
              <label>Type of Finance<select value={form.type_of_finance} onChange={e => setFinance(e.target.value)}>
                <option value="">Select...</option>
                {financeTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select></label>
            </div>
            {/* Seller prepaids / credit — for under-contract (and later) deals */}
            {['Under Contract', 'Pending', 'Clear to Close', 'Closed'].includes(form.property_status) && (
              <div className="form-row">
                <label>Seller Prepaids / Credit
                  <select value={form.seller_prepaids} onChange={e => f('seller_prepaids', e.target.value)}>
                    <option value="">Select...</option>
                    <option value="Yes">Yes</option>
                    <option value="No">No</option>
                  </select>
                </label>
                <label>Amount
                  <input type="text" inputMode="decimal" placeholder="$"
                    value={form.seller_prepaids_amount}
                    onChange={e => f('seller_prepaids_amount', e.target.value)}
                    disabled={form.seller_prepaids !== 'Yes'} />
                </label>
              </div>
            )}
          </div>

          {/* People */}
          <div className="form-section">
            <h4>People</h4>
            <div className="form-row">
              <label>Buyer Name<input value={form.buyer_name} onChange={e => f('buyer_name', e.target.value)} /></label>
              <label>Buyer's Agent<input value={form.buyers_agent_name} onChange={e => f('buyers_agent_name', e.target.value)} /></label>
            </div>
            <div className="form-row">
              <label>Seller Name<input value={form.seller_name} onChange={e => f('seller_name', e.target.value)} /></label>
              <label>Seller's Agent<input value={form.sellers_agent_name} onChange={e => f('sellers_agent_name', e.target.value)} /></label>
            </div>
            <label>Client (from CRM — represents who we're working for)
              {form.client_id && linkedClient ? (
                <div className="linked-client-card" style={{position: 'relative', marginTop: 4}}>
                  <button
                    type="button"
                    onClick={() => { f('client_id', ''); setClientSearch(''); setClientResults([]) }}
                    title="Change client"
                    style={{position: 'absolute', top: 8, right: 10, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16}}
                  >✕</button>
                  <div className="linked-client-name">
                    📇 {linkedClient.first_name} {linkedClient.last_name}
                    {linkedClient.lead_score && <span className="email-status-tag">Score {linkedClient.lead_score}</span>}
                  </div>
                  <div className="linked-client-row">
                    {linkedClient.email && <span>✉ {linkedClient.email}</span>}
                    {linkedClient.phone && <span>☎ {linkedClient.phone}</span>}
                    {linkedClient.address && <span>📍 {linkedClient.address}{linkedClient.city ? ', ' + linkedClient.city : ''}</span>}
                  </div>
                </div>
              ) : (
                <div style={{position: 'relative'}}>
                  <input
                    type="text"
                    placeholder="Search by name or email (start typing 2+ chars)..."
                    value={clientSearch}
                    onChange={e => { setClientSearch(e.target.value); setClientOpen(true) }}
                    onFocus={() => setClientOpen(true)}
                    onBlur={() => setTimeout(() => setClientOpen(false), 200)}
                  />
                  {clientOpen && clientResults.length > 0 && (
                    <div className="addr-suggestions">
                      {clientResults.map(c => (
                        <div
                          key={c.id}
                          className="addr-suggestion"
                          onMouseDown={() => {
                            f('client_id', c.id)
                            setClientSearch('')
                            setClientResults([])
                            setClientOpen(false)
                          }}
                        >
                          <div className="addr-suggestion-line1">{c.first_name} {c.last_name}</div>
                          <div className="addr-suggestion-line2">
                            {c.email || 'no email'}{c.phone ? ' · ' + c.phone : ''}{c.city ? ' · ' + c.city : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {clientOpen && clientSearch.trim().length >= 2 && clientResults.length === 0 && (
                    <div style={{padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)'}}>No matches — try a different search</div>
                  )}
                </div>
              )}
            </label>

            {/* Additional people on this deal (e.g. two family members buying together) */}
            <div style={{ marginTop: 12 }}>
              <label style={{ display: 'block' }}>Additional people on this transaction</label>
              {!editing ? (
                <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>Save the transaction first, then add co-buyers or co-sellers here.</p>
              ) : (
                <>
                  {people.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0' }}>
                      {people.map(p => (
                        <div key={p.id} className="linked-client-card" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px' }}>
                          <span style={{ fontWeight: 600 }}>{p.name || 'Unnamed'}</span>
                          <span className="email-status-tag">{p.role}</span>
                          {p.email && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>✉ {p.email}</span>}
                          {p.phone && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>☎ {p.phone}</span>}
                          <button type="button" className="btn-sm btn-danger" style={{ marginLeft: 'auto' }} onClick={() => removePerson(p.id)}>Remove</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 6 }}>
                    <select value={personRole} onChange={e => setPersonRole(e.target.value)} style={{ maxWidth: 130 }}>
                      <option value="co-buyer">Co-buyer</option>
                      <option value="buyer">Buyer</option>
                      <option value="co-seller">Co-seller</option>
                      <option value="seller">Seller</option>
                      <option value="other">Other</option>
                    </select>
                    <div style={{ position: 'relative', flex: 1 }}>
                      <input
                        type="text"
                        placeholder="Search CRM by name/email, or type a name…"
                        value={personSearch}
                        onChange={e => { setPersonSearch(e.target.value); setPersonOpen(true) }}
                        onFocus={() => setPersonOpen(true)}
                        onBlur={() => setTimeout(() => setPersonOpen(false), 200)}
                        onKeyDown={e => { if (e.key === 'Enter' && personSearch.trim()) { e.preventDefault(); addPerson({ name: personSearch.trim() }) } }}
                      />
                      {personOpen && personResults.length > 0 && (
                        <div className="addr-suggestions">
                          {personResults.map(c => (
                            <div key={c.id} className="addr-suggestion" onMouseDown={() => addPerson({ client_id: c.id })}>
                              <div className="addr-suggestion-line1">{c.first_name} {c.last_name}</div>
                              <div className="addr-suggestion-line2">{c.email || 'no email'}{c.phone ? ' · ' + c.phone : ''}{c.city ? ' · ' + c.city : ''}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <button type="button" className="btn btn-sm btn-secondary" disabled={!personSearch.trim()} onClick={() => addPerson({ name: personSearch.trim() })}>Add</button>
                  </div>
                  <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>Pick a CRM match to link the lead, or type a name and click Add for someone not in the CRM.</p>
                </>
              )}
            </div>
          </div>

          {/* Lender */}
          <div className="form-section">
            <h4>Lender</h4>
            <div className="form-row">
              <label>Lender Name<input value={form.lender_name} onChange={e => f('lender_name', e.target.value)} placeholder="e.g. Tim Lamb" /></label>
              <label>Lender Company<input value={form.lender_company} onChange={e => f('lender_company', e.target.value)} placeholder="e.g. Corda Credit Union" /></label>
            </div>
            <label>Lender Email<input type="email" value={form.lender_email} onChange={e => f('lender_email', e.target.value)} placeholder="e.g. tim@cordacu.com" /></label>
            <div className="form-row">
              <label>Type of Finance<select value={form.type_of_finance} onChange={e => setFinance(e.target.value)}>
                <option value="">Select...</option>
                {financeTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select></label>
              <label>Financing Status<select value={form.financing_status || 'Not Started'} onChange={e => f('financing_status', e.target.value)}>
                <option>Not Started</option>
                <option>In Progress</option>
                <option>Approved</option>
              </select></label>
            </div>
          </div>

          {/* Pricing */}
          <div className="form-section">
            <h4>Pricing</h4>
            <label>Purchase Price<input type="number" value={form.purchase_price} onChange={e => f('purchase_price', e.target.value)} /></label>
            <div className="form-row">
              <label>Earnest Money Amount
                <input type="text" inputMode="decimal" placeholder="$" value={form.earnest_money_amount || ''} onChange={e => f('earnest_money_amount', e.target.value)} />
              </label>
              <label>Earnest Money Status
                <select value={['Not Started', 'In Progress', 'Completed'].includes(form.earnest_money_deposit) ? form.earnest_money_deposit : 'Not Started'} onChange={e => f('earnest_money_deposit', e.target.value)}>
                  <option>Not Started</option>
                  <option>In Progress</option>
                  <option>Completed</option>
                </select>
              </label>
            </div>
          </div>

          {/* Key Dates */}
          <div className="form-section">
            <h4>Key Dates</h4>
            <div className="form-row">
              <label>Contract Date
                <input
                  type="date"
                  value={form.contract_date}
                  onChange={e => {
                    const v = e.target.value
                    setForm(prev => {
                      const next = { ...prev, contract_date: v }
                      if (v) {
                        if (!prev.earnest_money_due_date) {
                          next.earnest_money_due_date = calcEarnestDue(v)
                        }
                        // Mortgage + Appraisal contingency = 30 calendar days after contract,
                        // rolled back to the prior Friday if it lands on a weekend.
                        const cont30 = calcContingencyDate(v, 30)
                        if (!prev.mortgage_contingency_date) next.mortgage_contingency_date = cont30
                        if (!prev.appraisal_contingency_date) next.appraisal_contingency_date = cont30
                      }
                      return next
                    })
                  }}
                  title="Auto-fills Earnest Money Due (3 biz days), Mortgage + Appraisal Contingency (30 days, no weekends) when blank"
                />
              </label>
              <label>Closing Date
                <input
                  type="date"
                  value={form.closing_date}
                  onChange={e => {
                    const v = e.target.value
                    setForm(prev => {
                      const next = { ...prev, closing_date: v }
                      // Final walkthrough is ALWAYS the last weekday before closing — keep it in sync
                      if (v) {
                        next.final_walkthrough = calcFinalWalkthrough(v)
                      }
                      return next
                    })
                  }}
                  title="Final Walkthrough auto-sets to the weekday before closing"
                />
              </label>
            </div>
            <div className="form-row">
              <label title="Auto-set 3 business days after contract date — editable">
                Earnest Money Due
                <input type="date" value={form.earnest_money_due_date} onChange={e => f('earnest_money_due_date', e.target.value)} />
              </label>
              <label title="Initial Property Inspection response due">
                IPI Due Date
                <input type="date" value={form.ipi_due_date} onChange={e => f('ipi_due_date', e.target.value)} />
              </label>
            </div>
            {form.type_of_finance === 'Cash' && (
              <p className="muted" style={{margin: '0 0 8px', fontSize: 12}}>Cash purchase — no mortgage/financing contingency and no appraisal, so these are cleared.</p>
            )}
            <div className="form-row">
              <label>Mortgage Contingency
                <input
                  type="date"
                  value={form.mortgage_contingency_date}
                  disabled={form.type_of_finance === 'Cash'}
                  onChange={e => {
                    const v = e.target.value
                    setForm(prev => {
                      const next = { ...prev, mortgage_contingency_date: v }
                      // Mortgage & Appraisal contingency are always the same date — keep them locked together
                      if (v) {
                        next.appraisal_contingency_date = v
                      }
                      return next
                    })
                  }}
                  title="Mortgage & Appraisal contingencies are always the same date — auto-synced"
                />
              </label>
              <label>Appraisal Contingency
                <input
                  type="date"
                  value={form.appraisal_contingency_date}
                  disabled={form.type_of_finance === 'Cash'}
                  onChange={e => {
                    const v = e.target.value
                    setForm(prev => {
                      const next = { ...prev, appraisal_contingency_date: v }
                      // Always keep Mortgage contingency locked to the same date
                      if (v) {
                        next.mortgage_contingency_date = v
                      }
                      return next
                    })
                  }}
                  title="Mortgage & Appraisal contingencies are always the same date — auto-synced"
                />
              </label>
            </div>
            <div className="form-row">
              <label>Inspection Contingency<input type="date" value={form.inspection_contingency_date} onChange={e => f('inspection_contingency_date', e.target.value)} /></label>
              <label>Final Walkthrough Date<input type="date" value={form.final_walkthrough} onChange={e => f('final_walkthrough', e.target.value)} /></label>
            </div>
            <div className="form-row">
              <label>Final Walkthrough Time
                <input value={form.final_walkthrough_time} onChange={e => f('final_walkthrough_time', e.target.value)} placeholder="e.g. 3:00 PM CDT" />
              </label>
              <label>Final Walkthrough Location
                <input value={form.final_walkthrough_location} onChange={e => f('final_walkthrough_location', e.target.value)} placeholder={form.property_address || 'e.g. property address'} />
              </label>
            </div>
            {editing && form.final_walkthrough && (
              <div style={{padding: '10px 12px', background: 'rgba(168,85,247,0.07)', border: '1px solid rgba(168,85,247,0.25)', borderRadius: 6, fontSize: 13, marginTop: 8}}>
                <div style={{marginBottom: 6}}>🚶 <strong>Walkthrough on the hub calendar:</strong> auto-synced.</div>
                {form.final_walkthrough_time && form.final_walkthrough_location && (
                  <div style={{fontSize: 12, color: form.final_walkthrough_invite_sent_at ? '#10b981' : '#fbbf24', marginBottom: 8}}>
                    {form.final_walkthrough_invite_sent_at
                      ? `✓ Team walkthrough invite sent — ${new Date(form.final_walkthrough_invite_sent_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                      : '⏳ Team invite will fire on next Save (time + location set).'}
                  </div>
                )}
                <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
                  {['buyer','seller','other'].map(aud => (
                    <button key={aud} type="button" className="btn btn-sm btn-secondary"
                      disabled={!form.final_walkthrough_time || !form.final_walkthrough_location}
                      onClick={async () => {
                        const label = aud[0].toUpperCase() + aud.slice(1)
                        const email = prompt(`Send walkthrough invite to ${label}:\n\nEnter their email:`, '')
                        if (!email || !email.trim()) return
                        const note = prompt('Optional note (blank to skip):', '') || ''
                        try {
                          const r = await authFetch(`/api/transactions/${editing}/send-walkthrough-invite`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ recipients: email.trim(), audience: aud, message: note }),
                          })
                          const d = await r.json()
                          alert(d.success ? `✓ Walkthrough invite sent to ${email.trim()}` : ('Failed: ' + (d.error || 'unknown')))
                        } catch (err) { alert('Failed: ' + err.message) }
                      }}>
                      📧 Send Walkthrough Invite to {aud[0].toUpperCase()+aud.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="form-row">
              <label>Financing Release<input type="date" value={form.financing_release} onChange={e => f('financing_release', e.target.value)} /></label>
              <label>Inspection Release<input type="date" value={form.inspection_release} onChange={e => f('inspection_release', e.target.value)} /></label>
            </div>
            <label>Final Inspection Waiver<input type="date" value={form.final_inspection_waiver} onChange={e => f('final_inspection_waiver', e.target.value)} /></label>
          </div>

          {/* Inspection */}
          <div className="form-section form-full">
            <h4>Inspection</h4>
            <div className="form-row">
              <label>Home Inspection<select value={form.home_inspection} onChange={e => f('home_inspection', e.target.value)}>
                <option value="Not Started">Not Started</option><option value="Scheduled">Scheduled</option>
                <option value="In Progress">In Progress</option><option value="Completed">Completed</option><option value="N/A">N/A</option>
              </select></label>
              <label>Home Inspector<input value={form.home_inspector} onChange={e => f('home_inspector', e.target.value)} placeholder="e.g. 5 Seasons Home Inspections" /></label>
              <label>Inspection Date<input type="date" value={form.inspection_date} onChange={e => f('inspection_date', e.target.value)} /></label>
            </div>
            <label>Appraisal Status<select value={form.appraisal_contingency_status} onChange={e => f('appraisal_contingency_status', e.target.value)}>
              <option value="Not Started">Not Started</option><option value="Ordered">Ordered</option>
              <option value="Approved">Approved</option>
              <option value="Completed">Completed</option><option value="N/A">N/A</option>
            </select></label>
            <div className="checklist-grid" style={{marginTop: 10}}>
              {[
                ['whole_property_inspection', 'Whole Property Inspection'],
                ['radon_test', 'Radon Test'],
                ['wdi_inspection', 'WDI (Wood-Destroying Insect)'],
                ['septic_inspection', 'Septic Inspection'],
                ['well_inspection', 'Well Inspection'],
                ['sewer_inspection', 'Sewer Inspection'],
              ].map(([key, label]) => (
                <label key={key} className="checkbox-label">
                  <input type="checkbox" checked={!!form[key]} onChange={() => check(key)} />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {/* Contract Contingencies — control which sections appear in the buyer email */}
          <div className="form-section">
            <h4>Contract Terms</h4>
            <p className="muted" style={{margin: '0 0 8px', fontSize: 12}}>These control which sections appear in the buyer "Under Contract / Next Steps" email.</p>
            <label className="checkbox-label">
              <input type="checkbox" checked={!!form.has_insurance_contingency} onChange={() => check('has_insurance_contingency')} />
              Insurance contingency in contract (7 business days)
            </label>
            <label>1-year home warranty
              <select value={form.home_warranty_paid_by || 'seller'} onChange={e => setWarrantyPayer(e.target.value)}>
                <option value="seller">Included — paid by seller</option>
                <option value="buyer">Included — paid by buyer</option>
                <option value="none">No home warranty</option>
              </select>
            </label>
          </div>

          {/* Title & Closing Documents (dropdowns) */}
          <div className="form-section form-full">
            <h4>Title & Closing Documents</h4>
            <div className="form-row" style={{gridTemplateColumns: 'repeat(5, 1fr)'}}>
              <label>Abstract<select value={form.abstract || 'Not Started'} onChange={e => f('abstract', e.target.value)}>
                {ABSTRACT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select></label>
              <label>Title Commitment<select value={form.title_commitment || 'Not Started'} onChange={e => f('title_commitment', e.target.value)}>
                {TITLE_COMMITMENT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select></label>
              {form.type !== 'purchase' ? (
                <label>Mortgage Payoff<select value={form.mortgage_payoff || 'Not Started'} onChange={e => f('mortgage_payoff', e.target.value)}>
                  {MORTGAGE_PAYOFF_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select></label>
              ) : (
                <div style={{fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center', fontStyle: 'italic'}}>
                  Mortgage Payoff<br/>(listing-side only)
                </div>
              )}
              <label>ALTA Statement<select value={form.alta_statement || 'Not Ready'} onChange={e => f('alta_statement', e.target.value)}>
                {ALTA_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select></label>
              <label>Deed Package<select value={form.deed_package || 'Not Ready'} onChange={e => f('deed_package', e.target.value)}>
                {DEED_PACKAGE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select></label>
            </div>
          </div>

          {/* Listing & Disclosures — first thing after going under contract */}
          {/* Each item has a side: 'both' = always shown; 'listing' = listing-side only; 'purchase' = buyer-side only.
              When transaction.type is unset, we show everything so nothing's accidentally hidden. */}
          {(() => {
            // 'both' = we represent both sides → must do every task; same when type is unset
            const showItem = (it) => {
              if (!form.type || form.type === 'both') return true
              return it.side === 'both' || it.side === form.type
            }
            const renderChecks = (items) => items.filter(showItem).map(it => (
              <label key={it.key} className="checkbox-label">
                <input type="checkbox" checked={!!form[it.key]} onChange={() => check(it.key)} />
                {it.label}
              </label>
            ))
            const phase1 = [
              { key: 'mls_pending_marked',         label: 'MLS Marked Pending',                       side: 'listing' },
              { key: 'remove_listing_alerts',      label: 'Remove Listing Alerts (Sierra & MLS)',     side: 'listing' },
              { key: 'email_contract_closing',     label: 'Email Contract to Closing & Next Steps',   side: 'both' },
              { key: 'ayse_added_to_loop',         label: 'AYSE Added to Loop',                       side: 'both' },
              { key: 'ayse_contracts_signed',      label: 'AYSE Contracts Signed',                    side: 'both' },
              { key: 'sellers_disclosure_received',label: 'Seller’s Disclosure (RPDS) Received',     side: 'listing' },
            ]
            const phase2Logistics = [
              { key: 'closing_time_confirmed',     label: 'Closing Time Confirmed',                   side: 'both' },
              { key: 'closing_location_confirmed', label: 'Closing Location Confirmed',               side: 'both' },
              { key: 'closing_attendees_notified', label: 'Buyer/Seller Notified of When & Where',    side: 'both' },
              { key: 'closing_disclosure_reviewed',label: 'Closing Disclosure Reviewed (3-day rule)', side: 'both' },
              { key: 'final_walkthrough_confirmed',label: 'Final Walkthrough Time + Location Confirmed', side: 'both' },
              { key: 'utilities_set',              label: 'Utilities Set to New Owner',               side: 'purchase' },
            ]
            const phase3 = [
              { key: 'seller_signed_deed',     label: 'Seller Signed Deed Package',           side: 'listing' },
              { key: 'keys_remotes_collected', label: 'Keys / Garage Remotes Collected',      side: 'both' },
              { key: 'sign_lockbox_removed',   label: 'Sign + Lockbox Removed',               side: 'listing' },
              { key: 'closing_complete',       label: 'Closing Complete',                     side: 'both' },
              { key: 'mls_sold_marked',        label: 'MLS Marked Sold',                      side: 'listing' },
              { key: 'sales_worksheet_added',  label: 'Sales Worksheet Added',                side: 'both' },
              { key: 'submit_loop_review',     label: 'Submit Loop for Review',               side: 'both' },
              { key: 'approved_commission',    label: 'Approved for Commission',              side: 'both' },
              { key: 'commission_received',    label: 'Commission Received',                  side: 'both' },
              { key: 'testimonial_request',    label: 'Testimonial Request Sent',             side: 'both' },
              { key: 'referral_followup_30day',label: '30-Day Post-Close Follow-Up',          side: 'both' },
            ]
            const sideLabel =
              form.type === 'listing'  ? '🏠 LISTING SIDE'
            : form.type === 'purchase' ? '🎯 PURCHASE SIDE'
            : form.type === 'both'     ? '🔄 BOTH SIDES (dual agency)'
            : 'ALL TASKS (set Type to filter)'
            return (
              <>
                <div className="form-section form-full">
                  <h4>Listing & Disclosures <span style={{fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', marginLeft: 8}}>{sideLabel}</span></h4>
                  <label>Dotloop Transaction Status<select value={form.dotloop_status || 'Not Submitted'} onChange={e => f('dotloop_status', e.target.value)}>
                    {DOTLOOP_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select></label>
                  <div className="checklist-grid" style={{marginTop: 10}}>{renderChecks(phase1)}</div>
                </div>

                <div className="form-section form-full">
                  <h4>Closing Logistics</h4>
                  <div className="form-row">
                    <label>Closing Time
                      <input value={form.closing_time} onChange={e => f('closing_time', e.target.value)} placeholder="e.g. 10:00 AM CDT" />
                    </label>
                    <label>Closing Location
                      <input value={form.closing_location} onChange={e => f('closing_location', e.target.value)} placeholder="e.g. Heartland Title – Marion office" />
                    </label>
                  </div>
                  <label>Verify How Buyer Is Paying
                    <select value={form.buyer_payment_method || ''} onChange={e => f('buyer_payment_method', e.target.value)}>
                      <option value="">— Not Verified —</option>
                      {PAYMENT_METHOD_OPTIONS.filter(o => o).map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </label>
                  {editing && form.closing_date && (
                    <div style={{marginTop: 12, padding: '10px 12px', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 6, fontSize: 13}}>
                      <div style={{marginBottom: 8}}>
                        📅 <strong>Closing on the hub calendar:</strong> auto-synced from this transaction. Edits here update the calendar event.
                      </div>
                      {form.closing_time && form.closing_location && (
                        <div style={{fontSize: 12, color: form.closing_invite_sent_at ? '#10b981' : '#fbbf24', marginBottom: 8}}>
                          {form.closing_invite_sent_at
                            ? `✓ Team auto-invite sent to John + Matt — ${new Date(form.closing_invite_sent_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. Re-fires automatically if Closing Time or Location changes.`
                            : '⏳ Team auto-invite will fire to John + Matt the next time this transaction is saved (Closing Time + Location are both set).'
                          }
                        </div>
                      )}
                      <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          disabled={!form.closing_time || !form.closing_location}
                          onClick={async () => {
                            const fallback = form.buyer_name ? `${form.buyer_name}'s email` : 'buyer@example.com'
                            const email = prompt(`Send closing invite to BUYER${form.buyer_name ? ` (${form.buyer_name})` : ''}:\n\nEnter their email address:`, '')
                            if (!email || !email.trim()) return
                            const note = prompt('Optional note to include (leave blank to skip):', '') || ''
                            try {
                              const r = await authFetch(`/api/transactions/${editing}/send-closing-invite`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ recipients: email.trim(), audience: 'buyer', message: note }),
                              })
                              const d = await r.json()
                              alert(d.success ? `✓ Buyer invite sent to ${email.trim()}` : ('Failed: ' + (d.error || 'unknown')))
                            } catch (err) { alert('Failed: ' + err.message) }
                          }}
                          title={!form.closing_time || !form.closing_location ? 'Set Closing Time AND Location first' : 'Send calendar invite to the buyer'}
                        >
                          📧 Send to Buyer
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          disabled={!form.closing_time || !form.closing_location}
                          onClick={async () => {
                            const email = prompt(`Send closing invite to SELLER${form.seller_name ? ` (${form.seller_name})` : ''}:\n\nEnter their email address:`, '')
                            if (!email || !email.trim()) return
                            const note = prompt('Optional note to include (leave blank to skip):', '') || ''
                            try {
                              const r = await authFetch(`/api/transactions/${editing}/send-closing-invite`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ recipients: email.trim(), audience: 'seller', message: note }),
                              })
                              const d = await r.json()
                              alert(d.success ? `✓ Seller invite sent to ${email.trim()}` : ('Failed: ' + (d.error || 'unknown')))
                            } catch (err) { alert('Failed: ' + err.message) }
                          }}
                          title={!form.closing_time || !form.closing_location ? 'Set Closing Time AND Location first' : 'Send calendar invite to the seller'}
                        >
                          📧 Send to Seller
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          disabled={!form.closing_time || !form.closing_location}
                          onClick={async () => {
                            const email = prompt('Send closing invite to another email address:', '')
                            if (!email || !email.trim()) return
                            const note = prompt('Optional note to include (leave blank to skip):', '') || ''
                            try {
                              const r = await authFetch(`/api/transactions/${editing}/send-closing-invite`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ recipients: email.trim(), audience: 'other', message: note }),
                              })
                              const d = await r.json()
                              alert(d.success ? `✓ Invite sent to ${email.trim()}` : ('Failed: ' + (d.error || 'unknown')))
                            } catch (err) { alert('Failed: ' + err.message) }
                          }}
                        >
                          📧 Send to Other
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="checklist-grid" style={{marginTop: 10}}>{renderChecks(phase2Logistics)}</div>
                </div>

                <div className="form-section form-full">
                  <h4>Day-of & Post-Closing</h4>
                  <div className="checklist-grid" style={{marginTop: 4}}>{renderChecks(phase3)}</div>
                </div>
              </>
            )
          })()}

          {/* Custom checklist — any transaction, any status. Each item is a
              row in the tasks table with category='Listing' and a related_id
              pointing to this transaction. They auto-appear on the Tasks tab
              under TODO and stay in sync from either side. */}
          {editing && (
            <div className="form-section form-full">
              <h4>📋 Custom Checklist</h4>
              <p className="muted" style={{margin: '0 0 8px', fontSize: 12}}>
                Any item you add here also appears on the Tasks tab under TODO (category: Listing).
              </p>
              <CustomChecklist transactionId={editing} address={form.property_address} />
            </div>
          )}

          <div className="form-section form-full">
            <label>Notes<textarea value={form.notes} onChange={e => f('notes', e.target.value)} rows={3} /></label>
          </div>

          {editing && (
            <div className="form-section form-full">
              <h4>📧 Send Transaction Email</h4>
              <p className="muted" style={{margin: '0 0 10px'}}>
                All transaction emails auto-CC <strong>johnwithmattsmithteam@gmail.com</strong> and <strong>mattsmithremax@gmail.com</strong>.
              </p>
              <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
                <button type="button" className="lead-action-btn lead-action-email" onClick={() => openEmailComposer('client')} disabled={!linkedClient?.email}>
                  ✉ Email Client {linkedClient?.email ? `(${linkedClient.first_name})` : '(no email)'}
                </button>
                <button type="button" className="lead-action-btn lead-action-email" onClick={() => openEmailComposer('lender')}>
                  🏦 Email Lender {form.lender_name ? `(${form.lender_name})` : ''}
                </button>
                <button type="button" className="lead-action-btn lead-action-email" onClick={() => openEmailComposer('closer')}>
                  📋 Email Cherryl
                </button>
                <button type="button" className="lead-action-btn" onClick={() => openEmailComposer('custom')}>
                  ✉ Custom Recipient
                </button>
              </div>
            </div>
          )}

          {/* Marketing checklist — only while Pre-Listing or Active. The server
              clears it automatically once the deal reaches Under Contract. */}
          {['Pre-Listing', 'Active'].includes(form.property_status) && (
            <div className="marketing-section" style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <h4 style={{ margin: 0 }}>Marketing Checklist</h4>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {countMarketingDone(form.marketing_tasks)}/{MARKETING_TOTAL} done
                </span>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 10px' }}>
                Clears automatically when this moves to Under Contract.
              </p>
              {MARKETING_TASK_GROUPS.map(group => (
                <div key={group.stage} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>{group.stage}</div>
                  <div className="checklist-grid">
                    {group.tasks.map(([key, label]) => (
                      <label key={key} style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: '3px 0', margin: 0, cursor: 'pointer', fontSize: 13, fontWeight: 400, textAlign: 'left' }}>
                        <input type="checkbox" style={{ flexShrink: 0, marginTop: 2, width: 16, height: 16 }} checked={!!(form.marketing_tasks?.[key]?.done)} onChange={() => toggleMarketing(key)} />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="form-actions">
            {editing && (
              <button
                type="button"
                className="btn btn-danger"
                style={{marginRight: 'auto'}}
                onClick={async () => {
                  const confirmMsg = `Delete this transaction?\n\n  ${form.property_address || 'Untitled'}\n\nThis removes it from the Transactions tab. Any linked Listings entry will need to be deleted separately if applicable.\n\nThis cannot be undone.`
                  if (!confirm(confirmMsg)) return
                  try {
                    const r = await authFetch(`/api/transactions/${editing}`, { method: 'DELETE' })
                    if (r.ok) {
                      setModalOpen(false)
                      load()
                    } else {
                      const d = await r.json().catch(() => ({}))
                      alert('Delete failed: ' + (d.error || r.statusText))
                    }
                  } catch (err) {
                    alert('Delete failed: ' + err.message)
                  }
                }}
                title="Permanently delete this transaction (cannot be undone)"
              >
                🗑 Delete Transaction
              </button>
            )}
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'} Transaction</button>
          </div>
        </form>
      </Modal>

      {/* Pre-Listing Popup — opens in place of the removed Pre-Listing Pipeline page */}
      <Modal open={plModalOpen} onClose={() => setPlModalOpen(false)} title="Pre-Listing" wide>
        {plEditing && (
          <div className="prelisting-modal">
            <div className="form-row">
              <label>Property Address
                <input value={plEditing.property_address || ''}
                  onChange={e => setPlEditing({ ...plEditing, property_address: e.target.value })}
                  onBlur={e => savePlField('property_address', e.target.value)} />
              </label>
            </div>
            <div className="form-row">
              <label>Owner
                <input value={plEditing.owner_name || ''}
                  onChange={e => setPlEditing({ ...plEditing, owner_name: e.target.value })}
                  onBlur={e => savePlField('owner_name', e.target.value)} />
              </label>
              <label>Walkthrough
                <select value={plEditing.walkthrough || 'Not Scheduled'}
                  onChange={e => savePlField('walkthrough', e.target.value)}>
                  <option value="Not Scheduled">Not Scheduled</option>
                  <option value="Scheduled">Scheduled</option>
                  <option value="Not Done">Not Done</option>
                  <option value="Completed">Completed</option>
                </select>
              </label>
            </div>

            {(() => {
              const done = countMarketingDone(plEditing.marketing_tasks)
              const pct = Math.round((done / MARKETING_TOTAL) * 100)
              return (
                <div style={{ margin: '12px 0 4px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                    <span>Marketing Checklist</span>
                    <span style={{ color: pct === 100 ? '#10b981' : '#3b82f6' }}>{done}/{MARKETING_TOTAL} · {pct}%</span>
                  </div>
                  <div className="progress-bar" style={{ height: 5 }}>
                    <div className="progress-fill" style={{ width: `${pct}%`, backgroundColor: pct === 100 ? '#10b981' : '#3b82f6' }}></div>
                  </div>
                </div>
              )
            })()}
            {MARKETING_TASK_GROUPS.map(group => (
              <div key={group.stage} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>{group.stage}</div>
                <div className="checklist-grid">
                  {group.tasks.map(([key, label]) => (
                    <label key={key} style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: '3px 0', margin: 0, cursor: 'pointer', fontSize: 13, fontWeight: 400, textAlign: 'left' }}>
                      <input type="checkbox" style={{ flexShrink: 0, marginTop: 2, width: 16, height: 16 }} checked={!!(plEditing.marketing_tasks?.[key]?.done)} onChange={() => togglePlMarketing(key)} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}

            <div className="form-row" style={{ marginTop: 10 }}>
              <label style={{ flex: 1 }}>Notes
                <textarea rows={3} value={plEditing.notes || ''}
                  onChange={e => setPlEditing({ ...plEditing, notes: e.target.value })}
                  onBlur={e => savePlField('notes', e.target.value)} />
              </label>
            </div>

            <div className="modal-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button type="button" className="btn btn-secondary" style={{ marginRight: 'auto' }}
                onClick={async () => {
                  const url = `${window.location.origin}/transactions?prelisting=${plEditing.id}`
                  try { await navigator.clipboard.writeText(url); setShareCopied(true); setTimeout(() => setShareCopied(false), 2500) }
                  catch { window.prompt('Copy this link to share:', url) }
                }}
                title="Copy a link that opens this checklist — share it with Matt to review">
                {shareCopied ? '✓ Link copied' : '🔗 Copy share link'}
              </button>
              <button type="button" className="btn btn-secondary"
                onClick={() => { const pl = plEditing; setPlModalOpen(false); promotePreListingToTransaction(pl, 'Active') }}>
                Promote to Active
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setPlModalOpen(false)}>Done</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Email Composer Modal */}
      <Modal open={emailOpen} onClose={() => setEmailOpen(false)} title="Send Transaction Email" wide>
        <div className="field-group">
          <h4>Template</h4>
          <select value={emailForm.template_id} onChange={e => loadEmailTemplate(e.target.value)} style={{width: '100%'}}>
            <option value="">— Choose a template (or write from scratch) —</option>
            {emailTemplates
              .filter(t => emailForm.recipient_type === 'custom' || t.recipient === emailForm.recipient_type)
              .map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label>To (email — separate multiple with comma)
            <input
              type="text"
              value={emailForm.to_email}
              onChange={e => setEmailForm(p => ({ ...p, to_email: e.target.value }))}
              placeholder="kevin@example.com, sara@example.com"
            />
          </label>
          <label>To (name)<input value={emailForm.to_name} onChange={e => setEmailForm(p => ({ ...p, to_name: e.target.value }))} /></label>
        </div>
        <div className="muted" style={{padding: '6px 10px', background: 'rgba(200, 155, 74, 0.08)', borderRadius: 4, marginBottom: 10}}>
          📋 Auto-CC: {[...(emailForm.auto_cc || []), ...(emailForm.extra_cc || [])].join(', ') || 'none'}
          {(emailForm.extra_cc || []).length > 0 && (
            <span style={{marginLeft: 8, color: '#fbbf24', fontWeight: 600}}>(includes Cherryl)</span>
          )}
        </div>
        <label>Subject<input value={emailForm.subject} onChange={e => setEmailForm(p => ({ ...p, subject: e.target.value }))} style={{width: '100%'}} /></label>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, marginTop: 8}}>
          <span style={{fontSize: 13, fontWeight: 500}}>Body</span>
          <div style={{display: 'flex', gap: 6}}>
            <label className="btn btn-sm btn-secondary" style={{cursor: 'pointer', margin: 0, position: 'relative', overflow: 'hidden'}}>
              📁 Load HTML File
              <input
                type="file"
                accept=".html,.htm,text/html"
                style={{position: 'absolute', opacity: 0, top: 0, left: 0, width: '100%', height: '100%', cursor: 'pointer'}}
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  const text = await file.text()
                  setEmailForm(p => ({ ...p, body: text }))
                  e.target.value = ''
                }}
              />
            </label>
            <button type="button" className="btn btn-sm btn-secondary" disabled={!emailForm.body} onClick={() => setEmailPreviewOpen(true)}>👁 Preview</button>
          </div>
        </div>
        <EmailToolbar
          textareaRef={txEmailBodyRef}
          body={emailForm.body}
          setBody={(b) => setEmailForm(p => ({ ...p, body: b }))}
          showPreview={false}
          compact
        />
        <textarea ref={txEmailBodyRef} rows={20} value={emailForm.body} onChange={e => setEmailForm(p => ({ ...p, body: e.target.value }))} style={{width: '100%', fontFamily: 'monospace', fontSize: 13, resize: 'vertical'}} />
        <p className="muted" style={{fontSize: 11, margin: '2px 0 0'}}>
          📁 Load HTML · 📷 Inline Images (so they render) · plain text also auto-formats with paragraphs and clickable links.
        </p>

        <div className="field-group">
          <h4>📎 Attachments</h4>
          <input
            type="file"
            multiple
            onChange={async (e) => {
              const files = Array.from(e.target.files || [])
              if (!files.length) return
              const newAttachments = await Promise.all(files.map(file => new Promise((resolve, reject) => {
                const reader = new FileReader()
                reader.onload = () => resolve({
                  filename: file.name,
                  type: file.type || 'application/octet-stream',
                  size: file.size,
                  content_base64: reader.result.toString().split(',')[1],
                })
                reader.onerror = reject
                reader.readAsDataURL(file)
              })))
              setEmailForm(p => ({ ...p, attachments: [...(p.attachments || []), ...newAttachments] }))
              e.target.value = ''
            }}
          />
          {(emailForm.attachments || []).length > 0 && (
            <div style={{marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6}}>
              {emailForm.attachments.map((att, i) => (
                <span key={i} className="lead-tag" style={{padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 6}}>
                  📎 {att.filename} ({(att.size / 1024).toFixed(0)} KB)
                  <button
                    type="button"
                    onClick={() => setEmailForm(p => ({ ...p, attachments: p.attachments.filter((_, idx) => idx !== i) }))}
                    style={{background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 14}}
                  >✕</button>
                </span>
              ))}
              <span className="muted" style={{fontSize: 11, alignSelf: 'center'}}>
                Total: {((emailForm.attachments.reduce((s, a) => s + a.size, 0)) / 1024 / 1024).toFixed(2)} MB
              </span>
            </div>
          )}
          <p className="muted" style={{fontSize: 11, margin: '4px 0 0'}}>SendGrid limit: 30 MB total. PDFs, images, and most file types supported.</p>
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setEmailOpen(false)}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={sendTransactionEmail} disabled={emailSending || !emailForm.to_email}>
            {emailSending ? 'Sending...' : 'Send Email'}
          </button>
        </div>
      </Modal>

      {/* Transaction Email Preview Modal */}
      <Modal open={emailPreviewOpen} onClose={() => setEmailPreviewOpen(false)} title="Email Preview" wide>
        <div>
          <p className="muted" style={{margin: '0 0 8px'}}>
            Sample using transaction data + linked client info
          </p>
          <div style={{padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 4, marginBottom: 8, fontSize: 13}}>
            <strong>To:</strong> {emailForm.to_email || '(no recipient)'}<br/>
            <strong>Subject:</strong> {emailForm.subject || '(no subject)'}
          </div>
          <iframe
            title="Email preview"
            srcDoc={autoEmbedYoutubeLinks(emailForm.body || '')}
            style={{width: '100%', height: '60vh', border: '1px solid var(--border)', borderRadius: 4, background: 'white'}}
          />
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setEmailPreviewOpen(false)}>Close</button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

// =====================================================================
// Custom checklist sub-component
// Renders tasks where related_type='transaction' AND related_id=transactionId.
// Adding an item creates a new task via /api/tasks; toggling sets status
// to 'done' or back to 'todo'. The Tasks tab is the source of truth — this
// is just a focused view for one transaction.
// =====================================================================
function CustomChecklist({ transactionId, address }) {
  const [items, setItems] = useState([])
  const [newTitle, setNewTitle] = useState('')
  const [newDueDate, setNewDueDate] = useState('')
  const [loading, setLoading] = useState(false)

  const load = async () => {
    try {
      const r = await authFetch(`/api/tasks?related_type=transaction&related_id=${transactionId}`)
      const data = await r.json()
      setItems(Array.isArray(data) ? data : [])
    } catch {}
  }

  useEffect(() => { if (transactionId) load() }, [transactionId])

  const addItem = async (e) => {
    e.preventDefault()
    const title = newTitle.trim()
    if (!title) return
    setLoading(true)
    try {
      await authFetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          status: 'todo',
          priority: 'medium',
          category: 'Listing',
          related_type: 'transaction',
          related_id: transactionId,
          due_date: newDueDate || undefined,
          description: address ? `Listing: ${address}` : undefined,
        }),
      })
      setNewTitle('')
      setNewDueDate('')
      await load()
    } catch (err) {
      alert('Failed to add: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const updateDate = async (item, newDate) => {
    try {
      await authFetch(`/api/tasks/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ due_date: newDate || null }),
      })
      await load()
    } catch (err) {
      alert('Failed to update date: ' + err.message)
    }
  }

  const toggle = async (item) => {
    const newStatus = item.status === 'done' ? 'todo' : 'done'
    try {
      await authFetch(`/api/tasks/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      await load()
    } catch (err) {
      alert('Failed to update: ' + err.message)
    }
  }

  const remove = async (item) => {
    if (!confirm(`Delete "${item.title}"? (Also removes from Tasks tab.)`)) return
    try {
      await authFetch(`/api/tasks/${item.id}`, { method: 'DELETE' })
      await load()
    } catch (err) {
      alert('Failed to delete: ' + err.message)
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  return (
    <div>
      {items.length > 0 && (
        <div style={{display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10}}>
          {items.map(it => {
            const overdue = it.due_date && it.due_date < today && it.status !== 'done'
            return (
              <div key={it.id} style={{display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--bg-elevated)', borderRadius: 4}}>
                <input type="checkbox" checked={it.status === 'done'} onChange={() => toggle(it)} />
                <span style={{flex: 1, fontSize: 13, textDecoration: it.status === 'done' ? 'line-through' : 'none', color: it.status === 'done' ? 'var(--text-muted)' : 'var(--text-primary)'}}>
                  {it.title}
                </span>
                {it.assigned_to && <span style={{fontSize: 11, color: 'var(--text-muted)'}}>{it.assigned_to}</span>}
                <input
                  type="date"
                  value={it.due_date || ''}
                  onChange={e => updateDate(it, e.target.value)}
                  title={overdue ? 'Overdue' : 'Due date'}
                  style={{
                    fontSize: 11,
                    padding: '2px 6px',
                    border: `1px solid ${overdue ? '#ef4444' : 'var(--border)'}`,
                    borderRadius: 3,
                    background: 'var(--bg-secondary)',
                    color: overdue ? '#ef4444' : 'var(--text-primary)',
                  }}
                />
                <button type="button" className="btn-sm btn-danger" onClick={() => remove(it)} title="Delete this task">×</button>
              </div>
            )
          })}
        </div>
      )}
      <form onSubmit={addItem} style={{display: 'flex', gap: 6}}>
        <input
          type="text"
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          placeholder="Add a custom checklist item..."
          style={{flex: 1, padding: 8, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13}}
          maxLength={200}
          disabled={loading}
        />
        <input
          type="date"
          value={newDueDate}
          onChange={e => setNewDueDate(e.target.value)}
          title="Optional due date"
          style={{padding: 8, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13}}
          disabled={loading}
        />
        <button type="submit" className="btn btn-secondary" disabled={loading || !newTitle.trim()}>
          + Add
        </button>
      </form>
    </div>
  )
}
