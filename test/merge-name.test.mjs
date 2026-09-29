// {{first_name}} fell back to "there" only when the column was EMPTY, so a column holding
// something that is not a name merged straight into the greeting: "Hi Drewglenn04@hotmail.com,".
// 1,136 records in the file hold an email address there and 65 hold a placeholder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usableFirstName, tidyName } from '../server/routes/email.js'

const greeting = v => 'Hi ' + (usableFirstName(v) || 'there') + ','

test('an email address is not a name', () => {
  for (const v of ['Drewglenn04@hotmail.com', 'Huskykibbles27@yahoo.com', 'Jjb1225@yahoo.com',
    'someone@example.com', 'www.example.com'])
    assert.equal(greeting(v), 'Hi there,', JSON.stringify(v) + ' must not reach a greeting')
})

test('a placeholder is not a name', () => {
  for (const v of ['None', 'none', 'Unknown', 'Test', 'N/A', 'na', 'null', 'Owner', 'Homeowner',
    'Resident', 'Current Resident', 'no name', 'asdf', 'xxx', '.', '-'])
    assert.equal(greeting(v), 'Hi there,', JSON.stringify(v) + ' must not reach a greeting')
})

test('digits, punctuation and import junk are not names', () => {
  for (const v of ['123', '3226', '!!!', '', '   ', null, undefined])
    assert.equal(greeting(v), 'Hi there,')
})

test('a real name survives untouched', () => {
  for (const v of ['Ryan', 'Elizabeth', 'Sara Jane', 'Dave and Liz', 'ShaLynn', 'DeWitt', 'B J', 'E Ray'])
    assert.equal(usableFirstName(v), v, v + ' is a real name and must survive')
})

test('ALL CAPS is calmed down, all lowercase is raised', () => {
  assert.equal(usableFirstName('MARIUS'), 'Marius')
  assert.equal(tidyName('SHELBY'), 'Shelby')
  assert.equal(usableFirstName('marius'), 'Marius')
})

test('a middle initial is dropped, but a name that IS initials is kept whole', () => {
  assert.equal(usableFirstName('Katie T'), 'Katie')
  assert.equal(usableFirstName('Abigail S'), 'Abigail')
  assert.equal(usableFirstName('Jjoseph  J.'), 'Jjoseph')
  assert.equal(usableFirstName('ShaLynn N'), 'ShaLynn')
  // "B J Seaton" goes by B J; dropping the last token would leave "B"
  assert.equal(usableFirstName('B J'), 'B J')
  assert.equal(usableFirstName('R J'), 'R J')
  assert.equal(usableFirstName('W D'), 'W D')
  // a double first name is not an initial
  assert.equal(usableFirstName('Sara Jane'), 'Sara Jane')
  assert.equal(usableFirstName('E Ray'), 'E Ray')
})

test('Mc and O names get their inner capital, whatever the surrounding case', () => {
  assert.equal(tidyName('Mcmahan'), 'McMahan')
  assert.equal(tidyName('mcmahan'), 'McMahan')
  assert.equal(tidyName('MCMAHAN'), 'McMahan')
  assert.equal(tidyName("O'donnell"), "O'Donnell")
  assert.equal(tidyName('Mcclure'), 'McClure')
})

test('Mac names are left alone, because that is how they are spelled', () => {
  for (const v of ['Mackenzie', 'Mackinaw', 'Macbride', 'Macy'])
    assert.equal(tidyName(v), v, v + ' is spelled that way')
})

test('a couple reads "and", never "And"', () => {
  assert.equal(usableFirstName('Cynthia And Ernie'), 'Cynthia and Ernie')
  assert.equal(usableFirstName('Kari And Wes'), 'Kari and Wes')
  assert.equal(usableFirstName('Andy & Debra'), 'Andy & Debra')
  // names that merely start with "And" are untouched
  for (const v of ['Andrea', 'Andy', 'Anderson', 'Alexander'])
    assert.equal(usableFirstName(v), v)
})

test('HTML entities from a bad import are decoded', () => {
  assert.equal(usableFirstName('Jerry &amp; Melissa'), 'Jerry & Melissa')
  assert.equal(usableFirstName('Zozo &amp; Mustafa&#39;s'), "Zozo & Mustafa's")
})

test('mojibake is not a name', () => {
  assert.equal(greeting('\u00e2\u0080\u00a2d\u00c3\u00b8ggy'), 'Hi there,')
})

test('nothing humiliating reaches a greeting', () => {
  assert.equal(greeting('Fuck You Uck U'), 'Hi there,')
})

test('whitespace is normalised', () => {
  assert.equal(usableFirstName('Danielle '), 'Danielle')
  assert.equal(usableFirstName(' Nicole'), 'Nicole')
  assert.equal(tidyName('Tshitenga  Yapanu'), 'Tshitenga Yapanu')
})

// Names drift back after every sync unless the ingest fixes them too. "Zinse FADONOUGBO"
// was still shouting after the bulk repair, which is what sent us looking at the sync.
test('the Sierra ingest applies the same name pass', async () => {
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../server/sierra-helper.js', import.meta.url), 'utf8'))
  assert.match(src, /import \{ tidyName \} from '\.\/routes\/email\.js'/)
  assert.match(src, /const firstName = tidyName\(lead\.firstName \|\| ''\)/)
  assert.match(src, /const lastName = tidyName\(lead\.lastName \|\| ''\)/)
})
