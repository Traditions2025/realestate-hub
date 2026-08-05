// Starter automation templates. Each graph uses only LIVE triggers/actions so it
// can be activated straight away. Contents are fully editable after creation.

const linear = (nodes) => {
  const edges = []
  for (let i = 0; i < nodes.length - 1; i++) edges.push({ from: nodes[i].id, to: nodes[i + 1].id, branch: null })
  return { nodes, edges }
}

export const STARTER_TEMPLATES = [
  {
    id: 'property-viewed-followup',
    name: 'Property Viewed Follow-Up',
    icon: '👁️',
    description: 'When a contact views a listing, wait a bit, then email them the homes they’ve been looking at.',
    audience: 'Active buyers browsing listings',
    graph: linear([
      { id: 'trg', kind: 'trigger', type: 'property_viewed', config: { match: 'any', min_views: 1 } },
      { id: 'd1', kind: 'control', type: 'delay', config: { amount: 2, unit: 'hours' } },
      {
        id: 'e1', kind: 'action', type: 'send_email', config: {
          subject: 'Homes in {{city}} you might love, {{first_name}}',
          body: '<p>Hi {{first_name}},</p><p>I noticed you were browsing homes — here are the ones that caught your eye, plus a couple of similar options:</p>{{properties}}<p>Want to tour any of these in person? Just reply and I’ll set it up.</p><p>{{agent_name}}</p>',
          include_properties: true, track: true,
        }
      },
    ]),
  },
  {
    id: 'new-lead-response',
    name: 'New Lead Response',
    icon: '➕',
    description: 'Instantly welcome a new lead by email and drop a high-priority call task on your list.',
    audience: 'Every brand-new contact',
    graph: linear([
      { id: 'trg', kind: 'trigger', type: 'contact_created', config: {} },
      { id: 'e1', kind: 'action', type: 'send_email', config: { subject: 'Thanks for reaching out, {{first_name}}!', body: '<p>Hi {{first_name}},</p><p>Thanks for connecting with the Matt Smith Team. I’d love to learn what you’re looking for so I can send you the right homes. What area and price range are you considering?</p><p>{{agent_name}}<br>{{company}}</p>' } },
      { id: 't1', kind: 'action', type: 'create_task', config: { title: 'Call new lead {{first_name}} {{last_name}}', priority: 'high', days_offset: 0 } },
    ]),
  },
  {
    id: 'no-response-nurture',
    name: 'No-Response Nurture',
    icon: '🔕',
    description: 'Re-engage contacts who’ve gone quiet with a check-in, a pause, then a fresh batch of listings.',
    audience: 'Leads with no reply in 3+ days',
    graph: linear([
      { id: 'trg', kind: 'trigger', type: 'no_response_received', config: { days: 3 } },
      { id: 'e1', kind: 'action', type: 'send_email', config: { subject: 'Still on the hunt, {{first_name}}?', body: '<p>Hi {{first_name}},</p><p>Just checking in — are you still looking? Reply with what you have in mind and I’ll pull together some options.</p><p>{{agent_name}}</p>' } },
      { id: 'd1', kind: 'control', type: 'delay', config: { amount: 4, unit: 'days' } },
      { id: 'e2', kind: 'action', type: 'send_email', config: { subject: 'A few fresh listings worth a look', body: '<p>Hi {{first_name}},</p><p>Some new homes hit the market that line up with what you’ve been viewing:</p>{{properties}}<p>Want details on any? Just reply.</p><p>{{agent_name}}</p>', include_properties: true } },
    ]),
  },
  {
    id: 'hot-lead-alert',
    name: 'Hot Lead Alert',
    icon: '🔥',
    description: 'When a contact is tagged “Hot,” ping the team in Slack and create an urgent follow-up task.',
    audience: 'Contacts tagged Hot',
    graph: linear([
      { id: 'trg', kind: 'trigger', type: 'tag_added', config: { tag: 'Hot' } },
      { id: 'n1', kind: 'action', type: 'send_internal_notification', config: { message: '🔥 {{full_name}} was just tagged HOT — jump on it.' } },
      { id: 't1', kind: 'action', type: 'create_task', config: { title: 'Reach out to {{first_name}} ASAP (hot lead)', priority: 'high', days_offset: 0 } },
    ]),
  },
  {
    id: 'weekly-checkin',
    name: 'Weekly Watch-List Check-In',
    icon: '🔁',
    description: 'Every morning, email watch-status contacts a friendly check-in. Others simply exit.',
    audience: 'Contacts in “watch” status',
    graph: {
      nodes: [
        { id: 'trg', kind: 'trigger', type: 'recurring_schedule', config: { run_time: '09:00' } },
        { id: 'c1', kind: 'control', type: 'condition', config: { logic: 'and', rules: [{ field: 'status', op: 'is', value: 'watch' }] } },
        { id: 'e1', kind: 'action', type: 'send_email', config: { subject: 'Checking in, {{first_name}}', body: '<p>Hi {{first_name}},</p><p>Anything new on your home search this week? Happy to send fresh listings or answer questions any time.</p><p>{{agent_name}}</p>' } },
      ],
      edges: [
        { from: 'trg', to: 'c1', branch: null },
        { from: 'c1', to: 'e1', branch: 'yes' },
      ],
    },
  },
]
