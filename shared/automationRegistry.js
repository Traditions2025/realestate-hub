// ============================================================================
// AUTOMATION REGISTRY  (isomorphic — imported by BOTH server and client)
// ----------------------------------------------------------------------------
// Single source of truth for every trigger, control and action. UI reads this
// to render the sidebar / config drawers / node summaries; the server reads it
// to validate graphs. Runtime handlers live server-side (routes/automations.js)
// keyed by `type`, so this file stays browser-safe (no DOM, no node imports).
//
// `live: true`  -> fully executes end-to-end today.
// `live: false` -> shown in the library ("Coming soon" badge) but a workflow
//                  that depends on it cannot be activated.
// ============================================================================

// ---- category -> color (matched to the Hub's palette) ----------------------
export const CATEGORY_COLOR = {
  trigger: '#06b6d4',   // teal
  control: '#f59e0b',   // orange
  comm: '#8b5cf6',      // purple  (communication actions)
  crm: '#3b82f6',       // blue    (crm / task / deal / property / workflow actions)
}
export function colorForNode(node) {
  if (!node) return CATEGORY_COLOR.crm
  if (node.kind === 'trigger') return CATEGORY_COLOR.trigger
  if (node.kind === 'control') return CATEGORY_COLOR.control
  const def = getDef(node)
  return def && def.group === 'comm' ? CATEGORY_COLOR.comm : CATEGORY_COLOR.crm
}

// ---- field-schema factory --------------------------------------------------
// type: text | textarea | number | select | multiselect | tags | toggle |
//       richtext | template | date | time | agent | status | priority | percent
const f = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra })

// shared option lists (kept in sync with the Clients module)
export const STATUSES = ['new', 'active', 'prime', 'pending', 'watch', 'qualify', 'closed', 'archived']
export const TEAM = ['Matt', 'John', 'Hunter', 'Cherryl']
export const PROPERTY_TYPES = ['Single Family', 'Condo', 'Townhouse', 'Multi-Family', 'Land', 'Other']
export const LEAD_SOURCES = ['Zillow', 'Realtor.com', 'Website', 'Referral', 'Open House', 'Sierra', 'Other']

// personalization variables offered in the Send Email / Send Text editors
export const MERGE_VARS = [
  { token: '{{first_name}}', label: 'Contact first name' },
  { token: '{{last_name}}', label: 'Contact last name' },
  { token: '{{full_name}}', label: 'Contact full name' },
  { token: '{{city}}', label: 'Contact city' },
  { token: '{{address}}', label: 'Property / contact address' },
  { token: '{{agent_name}}', label: 'Agent name' },
  { token: '{{agent_phone}}', label: 'Agent phone' },
  { token: '{{agent_email}}', label: 'Agent email' },
  { token: '{{company}}', label: 'Company name' },
  { token: '{{properties}}', label: 'Homes they viewed (property cards)' },
]

// ============================================================================
// TRIGGERS
// ============================================================================
// Full property-view configuration (the spec's worked example) is reused so the
// runtime and UI agree on the exact fields.
const PROPERTY_VIEWED_CONFIG = [
  f('match', 'Property', 'select', { options: [{ value: 'any', label: 'Any property' }, { value: 'specific', label: 'A specific listing' }], default: 'any' }),
  f('listing_id', 'Listing / MLS #', 'text', { showIf: { match: 'specific' }, placeholder: 'e.g. 2405123' }),
  f('city', 'City', 'text', { placeholder: 'Cedar Rapids' }),
  f('zip', 'ZIP code', 'text', { placeholder: '52402' }),
  f('price_min', 'Min price', 'number', { placeholder: '150000' }),
  f('price_max', 'Max price', 'number', { placeholder: '400000' }),
  f('property_type', 'Property type', 'select', { options: PROPERTY_TYPES }),
  f('min_views', 'Minimum # of views', 'number', { placeholder: '1', default: 1, help: 'Enroll only after this many views of a qualifying listing.' }),
  f('time_window_days', 'Within (days)', 'number', { placeholder: '30', help: 'Only count views inside this window.' }),
  f('contact_type', 'Contact type', 'select', { options: ['Buyer', 'Seller', 'Both'] }),
  f('lead_source', 'Lead source', 'select', { options: LEAD_SOURCES }),
  f('assigned_agent', 'Assigned agent', 'agent'),
  f('include_tags', 'Include tags', 'tags', { help: 'Only contacts with any of these tags.' }),
  f('exclude_tags', 'Exclude tags', 'tags', { help: 'Skip contacts with any of these tags.' }),
]

const T = (type, label, desc, icon, category, live, config = []) => ({ type, label, desc, icon, category, live, config, kind: 'trigger' })

export const TRIGGERS = [
  // --- Contact & CRM ---
  T('contact_created', 'Contact Created', 'A new lead comes in', '➕', 'Contact & CRM', true, [
    f('lead_source', 'Only when lead source is', 'select', { options: ['', ...LEAD_SOURCES] }),
    f('assigned_agent', 'Only when assigned to', 'agent'),
  ]),
  T('contact_updated', 'Contact Updated', 'A contact record changes', '✏️', 'Contact & CRM', true, [
    f('field', 'Watch field (optional)', 'text', { placeholder: 'e.g. phone, email' }),
  ]),
  T('contact_assigned', 'Contact Assigned', 'A contact is assigned to an agent', '👤', 'Contact & CRM', false),
  T('stage_changed', 'Stage Changed', 'A lead moves to a new stage/status', '🔄', 'Contact & CRM', true, [
    f('to_status', 'When status becomes', 'status'),
  ]),
  T('tag_added', 'Tag Added', 'A tag is added to a contact', '🏷️', 'Contact & CRM', true, [
    f('tag', 'When this tag is added', 'text', { required: true, placeholder: 'e.g. Hot Buyer' }),
  ]),
  T('tag_removed', 'Tag Removed', 'A tag is removed from a contact', '🏷️', 'Contact & CRM', true, [
    f('tag', 'When this tag is removed', 'text', { required: true }),
  ]),
  T('lead_source_changed', 'Lead Source Changed', 'A contact’s lead source changes', '🧭', 'Contact & CRM', false),
  T('contact_status_changed', 'Contact Status Changed', 'A contact’s status changes', '🚦', 'Contact & CRM', true, [
    f('to_status', 'When status becomes', 'status'),
  ]),
  T('collaborator_added', 'Collaborator Added', 'A collaborator is added', '👥', 'Contact & CRM', false),
  T('collaborator_removed', 'Collaborator Removed', 'A collaborator is removed', '👥', 'Contact & CRM', false),

  // --- Inquiry ---
  T('new_inquiry', 'New Inquiry', 'Any new inquiry arrives', '📨', 'Inquiry', false),
  T('website_form_submitted', 'Website Form Submitted', 'A site form is submitted', '🖥️', 'Inquiry', false),
  T('property_inquiry', 'Property Inquiry', 'Inquiry about a specific listing', '🏠', 'Inquiry', false),
  T('general_inquiry', 'General Inquiry', 'A non-property inquiry', '❓', 'Inquiry', false),
  T('new_message_received', 'Incoming Text', 'A contact texts the Hub number', '💬', 'Inquiry', true),
  T('missed_call', 'Missed Call', 'A call from a contact is missed', '📵', 'Inquiry', true),
  T('appointment_requested', 'Appointment Requested', 'A contact requests an appointment', '📅', 'Inquiry', false),

  // --- Property Activity ---
  T('property_viewed', 'Property Viewed', 'A contact views a listing', '👁️', 'Property Activity', true, PROPERTY_VIEWED_CONFIG),
  T('property_saved', 'Property Saved', 'A contact saves/favorites a listing', '⭐', 'Property Activity', false),
  T('property_unsaved', 'Property Unsaved', 'A contact un-saves a listing', '☆', 'Property Activity', false),
  T('property_shared', 'Property Shared', 'A contact shares a listing', '🔗', 'Property Activity', false),
  T('property_inquiry_submitted', 'Property Inquiry Submitted', 'A contact asks about a listing', '📝', 'Property Activity', false),
  T('property_viewed_multiple', 'Property Viewed Multiple Times', 'Repeated views of a listing', '🔥', 'Property Activity', true, [
    f('min_views', 'Minimum views', 'number', { required: true, default: 3, placeholder: '3' }),
    f('time_window_days', 'Within (days)', 'number', { placeholder: '14' }),
  ]),
  T('search_created', 'Search Created', 'A contact saves a search', '🔎', 'Property Activity', false),
  T('search_updated', 'Search Updated', 'A saved search is edited', '🔍', 'Property Activity', false),
  T('listing_matched_search', 'Listing Matched Search', 'A new listing matches a saved search', '🎯', 'Property Activity', false),
  T('price_reduced', 'Price Reduced', 'A watched listing drops in price', '📉', 'Property Activity', false),
  T('listing_status_changed', 'Listing Status Changed', 'A listing’s status changes', '📊', 'Property Activity', false),
  T('open_house_registered', 'Open House Registered', 'A contact registers for an open house', '🚪', 'Property Activity', false),

  // --- Deal ---
  T('deal_created', 'Deal Created', 'A new deal is created', '🤝', 'Deal', false),
  T('deal_stage_changed', 'Deal Stage Changed', 'A deal moves stages', '📈', 'Deal', false),
  T('offer_submitted', 'Offer Submitted', 'An offer is submitted', '📄', 'Deal', false),
  T('offer_accepted', 'Offer Accepted', 'An offer is accepted', '✅', 'Deal', false),
  T('offer_rejected', 'Offer Rejected', 'An offer is rejected', '❌', 'Deal', false),
  T('inspection_scheduled', 'Inspection Scheduled', 'A home inspection is scheduled', '🔧', 'Deal', false),
  T('appraisal_scheduled', 'Appraisal Scheduled', 'An appraisal is scheduled', '🏦', 'Deal', false),
  T('closing_date_added', 'Closing Date Added', 'A closing date is set', '🗓️', 'Deal', false),
  T('closing_date_changed', 'Closing Date Changed', 'A closing date changes', '🗓️', 'Deal', false),
  T('deal_closed', 'Deal Closed', 'A deal closes', '🎉', 'Deal', false),
  T('deal_lost', 'Deal Lost', 'A deal is lost', '💔', 'Deal', false),

  // --- Calendar ---
  T('appointment_created', 'Appointment Created', 'An appointment is booked', '📅', 'Calendar', false),
  T('appointment_updated', 'Appointment Updated', 'An appointment changes', '📅', 'Calendar', false),
  T('appointment_canceled', 'Appointment Canceled', 'An appointment is canceled', '🚫', 'Calendar', false),
  T('calendar_date_reached', 'Calendar Date Reached', 'A calendar date arrives', '⏰', 'Calendar', false),
  T('before_appointment', 'Before Appointment', 'A set time before an appointment', '⏳', 'Calendar', false),
  T('after_appointment', 'After Appointment', 'A set time after an appointment', '⌛', 'Calendar', false),
  T('before_closing_date', 'Before Closing Date', 'A set time before closing', '⏳', 'Calendar', false),
  T('after_closing_date', 'After Closing Date', 'A set time after closing', '⌛', 'Calendar', false),

  // --- Communication ---
  T('email_opened', 'Email Opened', 'A contact opens an email', '📬', 'Communication', false),
  T('email_link_clicked', 'Email Link Clicked', 'A contact clicks an email link', '🖱️', 'Communication', false),
  T('email_replied', 'Email Replied To', 'A contact replies to an email', '↩️', 'Communication', false),
  T('text_replied', 'Text Message Replied To', 'A contact replies to a text we sent', '💬', 'Communication', true),
  T('voicemail_received', 'Voicemail Received', 'A contact leaves a voicemail', '🎙️', 'Communication', true),
  T('call_disposition', 'Call Outcome Set', 'A call is logged with an outcome', '📞', 'Communication', true, [
    f('disposition', 'Only when the outcome is', 'select', { options: ['', 'Connected', 'Left voicemail', 'No answer', 'Busy', 'Wrong number', 'Appointment set', 'Interested', 'Not interested', 'Call back later', 'Do not call'] }),
  ]),
  T('no_response_received', 'No Response Received', 'No reply within a window', '🔕', 'Communication', true, [
    f('days', 'No reply for (days)', 'number', { required: true, default: 3, placeholder: '3' }),
  ]),

  // --- Manual & System ---
  T('manual_enrollment', 'Manual Enrollment', 'You add contacts by hand', '✋', 'Manual & System', true),
  T('recurring_schedule', 'Recurring Schedule', 'Runs daily at a set time', '🔁', 'Manual & System', true, [
    f('run_time', 'Run at', 'time', { default: '09:00' }),
  ]),
  T('specific_date', 'Specific Date', 'Runs once on a chosen date', '📆', 'Manual & System', true, [
    f('run_date', 'Run on', 'date', { required: true }),
    f('run_time', 'At', 'time', { default: '09:00' }),
  ]),
  T('webhook_received', 'Webhook Received', 'An inbound webhook fires', '🪝', 'Manual & System', false),
  T('api_event', 'API Event', 'An API event is received', '⚙️', 'Manual & System', false),
  T('imported_contact', 'Imported Contact', 'A contact is imported', '📥', 'Manual & System', false),
  T('user_added_to_list', 'User Added to List', 'A contact is added to a list', '📋', 'Manual & System', false),
]

// ============================================================================
// CONTROLS
// ============================================================================
export const CONDITION_FIELDS = [
  { value: 'first_name', label: 'Contact name', type: 'text' },
  { value: 'email', label: 'Contact email', type: 'text' },
  { value: 'phone', label: 'Contact phone', type: 'text' },
  { value: 'status', label: 'Contact status', type: 'status' },
  { value: 'stage', label: 'Contact stage', type: 'status' },
  { value: 'lead_source', label: 'Lead source', type: 'select', options: LEAD_SOURCES },
  { value: 'agent_assigned', label: 'Assigned agent', type: 'agent' },
  { value: 'tags', label: 'Tags', type: 'tags' },
  { value: 'property_city', label: 'Property city', type: 'text' },
  { value: 'property_zip', label: 'Property ZIP code', type: 'text' },
  { value: 'property_price', label: 'Property price', type: 'number' },
  { value: 'property_type', label: 'Property type', type: 'select', options: PROPERTY_TYPES },
  { value: 'num_property_views', label: 'Number of property views', type: 'number' },
  { value: 'last_activity_days', label: 'Last activity (days ago)', type: 'number' },
  { value: 'last_email_open_days', label: 'Last email opened (days ago)', type: 'number' },
  { value: 'appointment_date', label: 'Appointment date', type: 'date' },
  { value: 'closing_date', label: 'Closing date', type: 'date' },
  { value: 'created_date', label: 'Created date', type: 'date' },
  { value: 'has_email', label: 'Has an email', type: 'bool' },
  { value: 'has_listing_views', label: 'Has viewed listings', type: 'bool' },
]

export const OPERATORS = [
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'is_empty', label: 'is empty', noValue: true },
  { value: 'is_not_empty', label: 'is not empty', noValue: true },
  { value: 'gt', label: 'greater than' },
  { value: 'lt', label: 'less than' },
  { value: 'gte', label: '>=' },
  { value: 'lte', label: '<=' },
  { value: 'before', label: 'before' },
  { value: 'after', label: 'after' },
  { value: 'in_last', label: 'in the last (days)' },
  { value: 'not_in_last', label: 'not in the last (days)' },
  { value: 'has_any', label: 'has any of' },
  { value: 'has_all', label: 'has all of' },
  { value: 'has_none', label: 'has none of' },
]
// which operators make sense per field type
export function operatorsForType(type) {
  switch (type) {
    case 'number': return ['is', 'is_not', 'gt', 'lt', 'gte', 'lte', 'is_empty', 'is_not_empty']
    case 'date': return ['before', 'after', 'in_last', 'not_in_last', 'is_empty', 'is_not_empty']
    case 'tags': return ['has_any', 'has_all', 'has_none']
    case 'bool': return ['is']
    case 'status': case 'agent': case 'select': return ['is', 'is_not', 'is_empty', 'is_not_empty']
    default: return ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty']
  }
}

const C = (type, label, desc, icon, live, config = [], branches = null) => ({ type, label, desc, icon, live, config, branches, kind: 'control', group: 'control' })

export const CONTROLS = [
  C('condition', 'Condition', 'Split into Yes / No paths', '🔀', true,
    [f('logic', 'Match', 'select', { options: [{ value: 'and', label: 'ALL conditions (AND)' }, { value: 'or', label: 'ANY condition (OR)' }], default: 'and' })],
    ['yes', 'no']),
  C('delay', 'Time Delay', 'Wait before the next step', '⏱️', true, [
    f('amount', 'Wait', 'number', { required: true, default: 1, placeholder: '1' }),
    f('unit', 'Unit', 'select', { options: ['minutes', 'hours', 'days', 'weeks', 'months'], default: 'days' }),
    f('skip_weekends', 'Skip weekends', 'toggle'),
    f('business_hours', 'Only during business hours (8a–6p)', 'toggle'),
    f('use_contact_tz', 'Use contact timezone (else account)', 'toggle'),
  ]),
  C('wait_until', 'Wait Until Condition', 'Pause until something happens', '⏸️', true, [
    f('event', 'Continue when', 'select', {
      required: true, options: [
        { value: 'tag_added', label: 'A tag is added' }, { value: 'status_changed', label: 'Status changes' },
        { value: 'replied', label: 'Contact replies' }, { value: 'email_opened', label: 'Email is opened' },
        { value: 'property_saved', label: 'A property is saved' }, { value: 'appointment', label: 'Appointment scheduled' },
      ]
    }),
    f('tag', 'Tag (if waiting on tag)', 'text', { showIf: { event: 'tag_added' } }),
    f('max_days', 'Give up after (days)', 'number', { default: 7, placeholder: '7' }),
  ], ['continue', 'timeout']),
  C('branch', 'Branch', 'Route by a field’s value', '🌿', true, [
    f('field', 'Branch on', 'select', { required: true, options: [{ value: 'lead_source', label: 'Lead source' }, { value: 'status', label: 'Status' }, { value: 'agent_assigned', label: 'Assigned agent' }] }),
    f('values', 'Paths (one per value)', 'tags', { required: true, help: 'e.g. Zillow, Realtor.com, Website, Referral. An "Other" path catches the rest.' }),
  ], 'dynamic'),
  C('goal', 'Goal', 'Skip ahead when a goal is met', '🏁', true, [
    f('goal', 'Goal reached when', 'select', {
      required: true, options: [
        { value: 'replied', label: 'Contact replied' }, { value: 'appointment', label: 'Appointment booked' },
        { value: 'tag_added', label: 'A tag is added' }, { value: 'status_changed', label: 'Status changed' },
        { value: 'deal_closed', label: 'Deal closed' },
      ]
    }),
    f('tag', 'Tag (if goal is a tag)', 'text', { showIf: { goal: 'tag_added' } }),
  ], ['met', 'continue']),
  C('random_split', 'Random Split', 'A/B split by percentage', '🎲', true, [
    f('percent_a', 'Path A %', 'percent', { required: true, default: 50 }),
  ], ['a', 'b']),
  C('goto', 'Go To Step', 'Jump to another step', '↪️', true, [
    f('target_node', 'Go to', 'node_ref', { required: true }),
  ]),
  C('stop', 'Stop Automation', 'End the automation for this contact', '🛑', true, []),
]

// ============================================================================
// ACTIONS
// ============================================================================
const A = (type, label, desc, icon, group, live, config = []) => ({ type, label, desc, icon, group, live, config, kind: 'action' })

export const ACTIONS = [
  // --- Communication (purple) ---
  A('send_email', 'Send Email', 'Send a personalized email', '✉️', 'comm', true, [
    f('template_id', 'Email template', 'template'),
    f('subject', 'Subject', 'text', { placeholder: 'Supports {{first_name}}' }),
    f('preview_text', 'Preview text', 'text'),
    f('body', 'Email body', 'richtext'),
    f('reply_to', 'Reply-to', 'text', { placeholder: 'matt@mattsmithteam.com' }),
    f('include_properties', 'Append homes they viewed', 'toggle', { help: 'Injects live property cards where {{properties}} appears.' }),
    f('track', 'Track opens & clicks', 'toggle', { default: true }),
  ], { group: 'Communication' }),
  A('send_text', 'Send Text Message', 'Send an SMS (needs Twilio)', '💬', 'comm', false, [
    f('body', 'Message', 'textarea', { required: true }),
  ]),
  A('send_internal_notification', 'Send Internal Notification', 'Notify the team in Slack', '🔔', 'comm', true, [
    f('message', 'Message', 'textarea', { required: true, placeholder: '{{full_name}} just viewed a listing' }),
  ]),
  A('send_drip', 'Start Drip Campaign', 'Enroll the contact in a multi-email drip', '💧', 'comm', true, [
    f('drip_id', 'Drip campaign', 'drip_ref', { required: true, help: 'Build drips on the Templates page. The contact receives each email on its own schedule.' }),
  ]),
  A('send_push', 'Send Push Notification', 'Send a push notification', '📲', 'comm', false),
  A('create_email_draft', 'Create Email Draft', 'Draft an email for review', '📝', 'comm', false),
  A('send_voicemail', 'Send Voicemail Drop', 'Drop a ringless voicemail', '🎙️', 'comm', false),
  A('send_webhook', 'Send Webhook', 'POST to an external URL', '🪝', 'comm', false, [
    f('url', 'Webhook URL', 'text', { required: true }),
  ]),

  // --- CRM (blue) ---
  A('update_contact', 'Update Contact', 'Update a contact field', '🧾', 'crm', false),
  A('change_stage', 'Change Contact Stage', 'Move to a new stage', '🔄', 'crm', true, [f('status', 'New stage', 'status', { required: true })]),
  A('change_status', 'Change Contact Status', 'Set a new status', '🚦', 'crm', true, [f('status', 'New status', 'status', { required: true })]),
  A('assign_agent', 'Assign Agent', 'Assign to an agent', '👤', 'crm', true, [f('agent', 'Assign to', 'agent', { required: true })]),
  A('reassign_agent', 'Reassign Agent', 'Reassign to another agent', '🔁', 'crm', true, [f('agent', 'Reassign to', 'agent', { required: true })]),
  A('assign_lender', 'Assign Lender', 'Assign a lender', '🏦', 'crm', false),
  A('reassign_lender', 'Reassign Lender', 'Reassign a lender', '🏦', 'crm', false),
  A('add_collaborator', 'Add Collaborator', 'Add a collaborator', '👥', 'crm', false),
  A('remove_collaborator', 'Remove Collaborator', 'Remove a collaborator', '👥', 'crm', false),
  A('add_tag', 'Add Tag', 'Add a tag', '🏷️', 'crm', true, [f('tag', 'Tag', 'text', { required: true })]),
  A('remove_tag', 'Remove Tag', 'Remove a tag', '🏷️', 'crm', true, [f('tag', 'Tag', 'text', { required: true })]),
  A('add_to_list', 'Add to List', 'Add to a list', '📋', 'crm', false),
  A('remove_from_list', 'Remove from List', 'Remove from a list', '📋', 'crm', false),
  A('set_custom_field', 'Set Custom Field', 'Set a custom field value', '🔧', 'crm', false),
  A('add_note', 'Add Note', 'Add a note to the contact', '📝', 'crm', true, [f('text', 'Note', 'textarea', { required: true, placeholder: 'Supports {{first_name}}' })]),

  // --- Task & Calendar (blue) ---
  A('create_task', 'Create Task', 'Create a follow-up task', '☑️', 'crm', true, [
    f('title', 'Task title', 'text', { required: true, placeholder: 'Follow up with {{first_name}}' }),
    f('priority', 'Priority', 'select', { options: ['high', 'medium', 'low'], default: 'medium' }),
    f('days_offset', 'Due in (days)', 'number', { placeholder: '2' }),
    f('assignee', 'Assign to', 'agent'),
  ]),
  A('assign_task', 'Assign Task', 'Assign a task to a teammate', '📌', 'crm', false),
  A('create_appointment', 'Create Appointment', 'Book a calendar appointment', '📅', 'crm', false),
  A('update_appointment', 'Update Appointment', 'Update an appointment', '📅', 'crm', false),
  A('cancel_appointment', 'Cancel Appointment', 'Cancel an appointment', '🚫', 'crm', false),
  A('add_calendar_reminder', 'Add Calendar Reminder', 'Add a reminder', '⏰', 'crm', false),

  // --- Deal (blue) ---
  A('create_deal', 'Create Deal', 'Create a deal', '🤝', 'crm', false),
  A('update_deal', 'Update Deal', 'Update a deal', '📈', 'crm', false),
  A('change_deal_stage', 'Change Deal Stage', 'Move a deal stage', '📊', 'crm', false),
  A('set_closing_date', 'Set Closing Date', 'Set the closing date', '🗓️', 'crm', false),
  A('add_deal_note', 'Add Deal Note', 'Note on a deal', '📝', 'crm', false),
  A('assign_deal_owner', 'Assign Deal Owner', 'Set the deal owner', '👤', 'crm', false),

  // --- Property (blue) ---
  A('create_property_alert', 'Create Property Alert', 'Create a listing alert', '🔔', 'crm', false),
  A('update_property_alert', 'Update Property Alert', 'Update a listing alert', '🔔', 'crm', false),
  A('send_property_recommendation', 'Send Property Recommendation', 'Recommend homes they viewed', '🏘️', 'crm', true, [
    f('max', 'How many homes', 'number', { default: 4, placeholder: '4' }),
  ]),
  A('add_property_to_contact', 'Add Property to Contact', 'Attach a property', '🏠', 'crm', false),
  A('remove_property_from_contact', 'Remove Property from Contact', 'Detach a property', '🏠', 'crm', false),
  A('notify_agent_property_activity', 'Notify Agent About Property Activity', 'Alert the agent', '📣', 'crm', true, [
    f('message', 'Note (optional)', 'text' ),
  ]),

  // --- Workflow (blue) ---
  A('enroll_in_automation', 'Enroll in Another Automation', 'Start another automation', '➡️', 'crm', true, [
    f('automation_id', 'Automation', 'automation_ref', { required: true }),
  ]),
  A('remove_from_automation', 'Remove from Another Automation', 'Stop another automation', '⬅️', 'crm', true, [
    f('automation_id', 'Automation', 'automation_ref', { required: true }),
  ]),
  A('end_automation', 'End Current Automation', 'Finish this automation', '🏁', 'crm', true, []),
]

// ============================================================================
// LOOKUP + VALIDATION
// ============================================================================
const BY_TYPE = {}
for (const t of TRIGGERS) BY_TYPE[t.type] = t
for (const c of CONTROLS) BY_TYPE[c.type] = c
for (const a of ACTIONS) BY_TYPE[a.type] = a

// Back-compat aliases (older flows used these type strings)
const ALIASES = { lead_created: 'contact_created', status_changed: 'stage_changed', schedule_daily: 'recurring_schedule', reassign_agent_legacy: 'reassign_agent', assign: 'assign_agent', update_status: 'change_status' }

export function getDef(nodeOrType) {
  const type = typeof nodeOrType === 'string' ? nodeOrType : (nodeOrType && (nodeOrType.type || nodeOrType.actionType))
  return BY_TYPE[type] || BY_TYPE[ALIASES[type]] || null
}

export function iconFor(node) { const d = getDef(node); return d ? d.icon : '⚙️' }
export function labelFor(node) { const d = getDef(node); return d ? d.label : (node && (node.type || node.actionType)) || 'Step' }

// branch keys a node exposes (for canvas edges)
export function branchKeysFor(node) {
  const d = getDef(node)
  if (!d || !d.branches) return null
  if (d.branches === 'dynamic') {
    const vals = (node.config && node.config.values) || []
    return [...vals.map(String), 'other']
  }
  return d.branches
}

// human-readable summary shown on the node card
export function nodeSummary(node) {
  const c = (node && node.config) || {}
  switch (node.type) {
    case 'condition': return `${(c.rules || []).length || 0} rule${(c.rules || []).length === 1 ? '' : 's'} · ${(c.logic || 'and').toUpperCase()}`
    case 'delay': return `Wait ${c.amount || 1} ${c.unit || 'day'}${(c.amount || 1) > 1 ? '' : ''}`
    case 'wait_until': return c.event ? `Until ${c.event.replace('_', ' ')}` : 'Configure wait'
    case 'branch': return c.field ? `By ${c.field.replace('_', ' ')}` : 'Configure branch'
    case 'random_split': return `${c.percent_a || 50}% / ${100 - (c.percent_a || 50)}%`
    case 'send_email': return c.subject || (c.template_id ? 'From template' : 'Configure email')
    case 'add_tag': case 'remove_tag': return c.tag || 'Configure tag'
    case 'change_status': case 'change_stage': return c.status || 'Configure status'
    case 'assign_agent': case 'reassign_agent': return c.agent || 'Configure agent'
    case 'create_task': return c.title || 'Configure task'
    case 'add_note': return c.text ? String(c.text).slice(0, 40) : 'Configure note'
    case 'send_internal_notification': return c.message ? String(c.message).slice(0, 40) : 'Configure message'
    default: { const d = getDef(node); return d ? d.desc : '' }
  }
}

// ---- per-node validation ---------------------------------------------------
// returns [] when valid, otherwise a list of human messages.
export function validateNode(node) {
  const def = getDef(node)
  const errs = []
  if (!def) { errs.push('Unknown step type'); return errs }
  if (!def.live) errs.push(`${def.label} is not available yet (coming soon)`)
  const c = (node.config) || {}

  if (node.type === 'condition') {
    const rules = c.rules || []
    if (!rules.length) errs.push('Add at least one condition rule')
    rules.forEach((r, i) => {
      if (!r.field) errs.push(`Rule ${i + 1}: pick a field`)
      if (!r.op) errs.push(`Rule ${i + 1}: pick an operator`)
      const opDef = OPERATORS.find(o => o.value === r.op)
      if (opDef && !opDef.noValue && (r.value == null || r.value === '')) errs.push(`Rule ${i + 1}: enter a value`)
    })
    return errs
  }
  if (node.type === 'send_email') {
    const hasTemplate = !!c.template_id
    if (!hasTemplate && !c.subject) errs.push('Email needs a subject (or a template)')
    if (!hasTemplate && !c.body) errs.push('Email needs a body (or a template)')
    return errs
  }
  // generic: required fields from the schema (respecting showIf)
  for (const field of (def.config || [])) {
    if (!field.required) continue
    if (field.showIf && !Object.entries(field.showIf).every(([k, v]) => c[k] === v)) continue
    const val = c[field.key]
    const empty = val == null || val === '' || (Array.isArray(val) && !val.length)
    if (empty) errs.push(`${def.label}: "${field.label}" is required`)
  }
  return errs
}

// ---- whole-graph validation ------------------------------------------------
// graph = { nodes: [{id, kind, type, config, x, y}], edges: [{from, to, branch}] }
// returns { ok, errors: [{nodeId?, message}] }
export function validateGraph(graph, meta = {}) {
  const errors = []
  const nodes = (graph && graph.nodes) || []
  const edges = (graph && graph.edges) || []
  if (!meta.name || !meta.name.trim()) errors.push({ message: 'Give the automation a name' })

  const triggers = nodes.filter(n => n.kind === 'trigger')
  if (!triggers.length) { errors.push({ message: 'Add at least one trigger to start the automation' }) }

  // per-node config validation
  for (const n of nodes) {
    for (const m of validateNode(n)) errors.push({ nodeId: n.id, message: m })
  }

  // connectivity: every non-trigger node must be reachable from a trigger
  const incoming = new Set(edges.map(e => e.to))
  const outgoing = {}
  for (const e of edges) (outgoing[e.from] = outgoing[e.from] || []).push(e)
  for (const n of nodes) {
    if (n.kind === 'trigger') continue
    if (n.type === 'stop' || n.type === 'end_automation') continue
    if (!incoming.has(n.id)) errors.push({ nodeId: n.id, message: `"${labelFor(n)}" is not connected to the flow` })
  }
  // A branch node with NO outgoing edges at all is dead weight — flag it.
  // (An individual empty path is a valid "exit the automation" ending.)
  for (const n of nodes) {
    const keys = branchKeysFor(n)
    if (!keys) continue
    if (!(outgoing[n.id] || []).length) errors.push({ nodeId: n.id, message: `"${labelFor(n)}" has no paths leading anywhere` })
  }
  // goto targets must exist
  for (const n of nodes) {
    if (n.type === 'goto' && n.config && n.config.target_node && !nodes.find(x => x.id === n.config.target_node)) {
      errors.push({ nodeId: n.id, message: 'Go To Step points at a step that no longer exists' })
    }
  }
  return { ok: errors.length === 0, errors }
}

// convenience for the sidebar: group triggers by category preserving order
export function triggersByCategory() {
  const out = []
  const seen = {}
  for (const t of TRIGGERS) {
    if (!seen[t.category]) { seen[t.category] = { category: t.category, items: [] }; out.push(seen[t.category]) }
    seen[t.category].items.push(t)
  }
  return out
}
export function actionsByGroup() {
  const groups = {
    Communication: [], 'CRM': [], 'Task & Calendar': [], Deal: [], Property: [], Workflow: [],
  }
  const map = {
    send_email: 'Communication', send_text: 'Communication', send_internal_notification: 'Communication', send_push: 'Communication', create_email_draft: 'Communication', send_voicemail: 'Communication', send_webhook: 'Communication',
    create_task: 'Task & Calendar', assign_task: 'Task & Calendar', create_appointment: 'Task & Calendar', update_appointment: 'Task & Calendar', cancel_appointment: 'Task & Calendar', add_calendar_reminder: 'Task & Calendar',
    create_deal: 'Deal', update_deal: 'Deal', change_deal_stage: 'Deal', set_closing_date: 'Deal', add_deal_note: 'Deal', assign_deal_owner: 'Deal',
    create_property_alert: 'Property', update_property_alert: 'Property', send_property_recommendation: 'Property', add_property_to_contact: 'Property', remove_property_from_contact: 'Property', notify_agent_property_activity: 'Property',
    enroll_in_automation: 'Workflow', remove_from_automation: 'Workflow', end_automation: 'Workflow',
  }
  for (const a of ACTIONS) (groups[map[a.type] || 'CRM']).push(a)
  return Object.entries(groups).filter(([, v]) => v.length).map(([category, items]) => ({ category, items }))
}
