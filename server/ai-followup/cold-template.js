// Render a cold-buyer drip stage as a TEMPLATE (no Claude): approved bank message + merge
// fields. Text 1 gets greeting + intro + website; later stages are clean continuations with
// the website appended. Used by the scheduled drip (Claude is reserved for inbound replies).
export async function renderColdStageTemplate(stageIndex, approvedBody, client) {
  const { fillTemplate } = await import('../routes/email.js')
  const { centralGreeting } = await import('./context.js')
  // [area] -> the lead's search city, CLEANED (strip a ",IA" / trailing comma), with a safe
  // "your area" fallback so it's never a blank, a stray comma, or a literal bracket.
  let area = ''
  try { area = fillTemplate('{{city_of_interest}}', client).split(',')[0].trim() } catch {}
  if (!area || /^\d/.test(area)) area = 'your area'
  else area = area.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())   // "MARION" -> "Marion"
  let body = String(approvedBody || '').replace(/\[area\]/gi, area).replace(/\[price\]/gi, 'the right price')
  let msg
  if (stageIndex === 0) {
    const b = body.charAt(0).toUpperCase() + body.slice(1)
    // Avoid "Good afternoon John, it's John with Matt Smith Team" when the lead is also a John:
    // drop the first name from the greeting if it matches the sender.
    const fn = String(client.first_name || '').trim()
    const namePart = (fn && fn.toLowerCase() !== 'john') ? ' {{first_name}}' : ''
    msg = `${centralGreeting()}${namePart}, it's John with Matt Smith Team at RE/MAX. ${b} You can always browse the latest at MattSmithTeam.com`
  } else {
    msg = `${body} You can always browse the latest at MattSmithTeam.com`
  }
  return fillTemplate(msg, client)
    .replace(/\{\{[^}]+\}\}/g, '')          // drop any unresolved merge field
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim()
}
