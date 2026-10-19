// Sanity-check the range-preset arithmetic the client now uses: which preset a
// requested range maps to, and when the payload counts as stale.
const DAY = 86400000
const iso = (d) => new Date(d).toISOString().slice(0, 10)
const today = '2026-10-19'
const resolvedMax = today

function preset(days) {
  const last = resolvedMax
  const first = iso(Date.parse(last + 'T00:00:00Z') - (days - 1) * DAY)
  return { from: first, to: last }
}

function requestedDaysOf(range) {
  return range && range.from && range.to
    ? Math.round((Date.parse(range.to + 'T00:00:00Z') - Date.parse(range.from + 'T00:00:00Z')) / DAY) + 1
    : null
}

function activeDaysOf(range, resolvedRange, rolling) {
  if (rolling) return null
  const requested = requestedDaysOf(range)
  return requested !== null ? requested : (resolvedRange && resolvedRange.days) || null
}

function staleOf(range, resolvedRange, payloadMode) {
  if (!payloadMode) return false
  const rolling = Boolean((range && range.window) || payloadMode === 'rolling24h')
  const shownFrom = rolling ? resolvedRange.dayFrom : (range && range.from) || resolvedRange.from
  const shownTo = rolling ? resolvedRange.dayTo : (range && range.to) || resolvedRange.to
  return (
    rolling !== (payloadMode === 'rolling24h') ||
    (!rolling && (resolvedRange.from !== shownFrom || resolvedRange.to !== shownTo))
  )
}

const checks = []
const check = (name, ok, detail) => {
  checks.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '   [' + detail + ']'))
}

const resolved14 = { from: '2026-10-06', to: today, max: today, days: 14 }
check('default range highlights 14 天', activeDaysOf(null, resolved14, false) === 14, String(activeDaysOf(null, resolved14, false)))

for (const days of [7, 14, 30]) {
  const range = preset(days)
  // The payload that is on screen when the click happens: always a different
  // range, otherwise the click changes nothing and nothing is pending.
  const previous = preset(days === 7 ? 30 : 7)
  check(
    `clicking ${days} 天 maps to the ${days} 天 preset`,
    activeDaysOf(range, previous, false) === days,
    JSON.stringify(range) + ' -> ' + String(activeDaysOf(range, previous, false)),
  )
  check(`clicking ${days} 天 marks the payload stale`, staleOf(range, previous, 'range') === true)
}

const resolved7 = preset(7)
check(
  'once the payload matches, it is no longer stale',
  staleOf(resolved7, { from: resolved7.from, to: resolved7.to, max: today, days: 7 }, 'range') === false,
)

const window24 = { window: '24h' }
check('24h wins over the day presets', activeDaysOf(window24, resolved7, true) === null)
check('24h marks the payload stale until it arrives', staleOf(window24, resolved7, 'range') === true)
check(
  '24h stops being stale once the payload is rolling',
  staleOf(window24, { dayFrom: today, dayTo: today, max: today, days: 1 }, 'rolling24h') === false,
)

const custom = { from: '2026-10-10', to: today }
check('a custom 10-day range highlights no preset', activeDaysOf(custom, resolved14, false) === 10)

const failed = checks.filter((ok) => !ok).length
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' checks passed')
process.exit(failed ? 1 : 0)
