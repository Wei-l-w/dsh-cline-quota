/**
 * dsh-cline-quota — host half.
 *
 * Registers one exact HTTP route on the DSH webserver that reports the Cline /
 * ClinePass subscription quota for the account behind CLINE_API_KEY. The Cline
 * API key never leaves the host process: the browser only sees the normalized
 * JSON below.
 *
 * Endpoints used (all under https://api.cline.bot/api/v1):
 *   GET /users/me/plan/usage-limits -> the three rolling-window percentages
 *   GET /users/me/plan              -> plan name, period end, cancellation state
 *   GET /users/{id}/balance         -> Cline credits, in micro-USD
 *
 * @module dsh-cline-quota
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Exact route the browser half fetches. */
const ROUTE = '/api/cline-quota'

/**
 * Diagnostics route: the browser half reports that its bundle executed
 * (`applied`) and that the panel mounted (`mounted`). It exists so the
 * plugin's presence in a running GUI can be verified without looking at the
 * screen — `GET` returns the recorded beacons, `POST` appends one.
 */
const DIAG_ROUTE = '/api/cline-quota/diag'

/** Route that stores a key the user pasted in the panel. */
const KEY_ROUTE = '/api/cline-quota/key'

/** Route that forgets an account the panel added. */
const KEY_REMOVE_ROUTE = '/api/cline-quota/key/remove'

/** File holding this plugin's own account roster: labels and references only. */
const STATE_FILENAME = 'cline-quota.accounts.json'

/** Bounded retention for both diagnostics lists. */
const MAX_DIAG = 50

/** Cline public API base. */
const API_BASE = 'https://api.cline.bot/api/v1'

/** Credential reference the profile's cline provider already uses. */
const KEY_REF = 'CLINE_API_KEY'

/** The account offered when the plugin's config names none. */
const DEFAULT_ACCOUNTS = [{ label: '默认', keyRef: KEY_REF }]

/** A credential reference is a POSIX shell identifier; nothing else can name one. */
const KEY_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Read the configured accounts, keeping only entries that can name a credential
 * reference. An unusable or empty list falls back to the single default account,
 * so a profile without this plugin's config keeps working unchanged.
 * @param config - the plugin's resolved config, as the loader composed it.
 * @returns the accounts to offer, in configured order.
 */
function readAccounts(config) {
  const raw = config?.accounts
  if (!Array.isArray(raw)) return DEFAULT_ACCOUNTS
  const accounts = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const keyRef = typeof entry.keyRef === 'string' ? entry.keyRef.trim() : ''
    if (!KEY_REF_PATTERN.test(keyRef)) continue
    const label = typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : keyRef
    if (accounts.some((account) => account.label === label || account.keyRef === keyRef)) continue
    accounts.push({ label, keyRef })
  }
  return accounts.length ? accounts : DEFAULT_ACCOUNTS
}

/**
 * Resolve one requested account against the configured list.
 * @param accounts - the configured accounts.
 * @param requested - the decoded `account` query value, when one was sent.
 * @returns the matching account, or the first configured one.
 */
function pickAccount(accounts, requested) {
  if (typeof requested === 'string' && requested !== '') {
    const match = accounts.find((account) => account.label === requested || account.keyRef === requested)
    if (match !== undefined) return match
  }
  return accounts[0]
}

/**
 * Read the `account` query parameter. The route's request log drops the query
 * string, so this is the only place the selection is decoded.
 * @param url - the request URL.
 * @returns the decoded value, or an empty string.
 */
function parseAccount(url) {
  const query = String(url ?? '').split('?')[1]
  if (query === undefined) return ''
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=')
    const name = separator === -1 ? pair : pair.slice(0, separator)
    if (name !== 'account') continue
    const value = separator === -1 ? '' : pair.slice(separator + 1)
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return ''
}

/**
 * Presence of each configured account's credential, never its value.
 * @param ctx - host root context.
 * @param accounts - the configured accounts.
 * @returns one entry per account, in configured order.
 */
async function describeAccounts(ctx, accounts) {
  return Promise.all(
    accounts.map(async (account) => {
      let configured = false
      try {
        configured = Boolean((await ctx.credentials.describe(account.keyRef))?.configured)
      } catch {
        configured = false
      }
      return { label: account.label, keyRef: account.keyRef, source: account.source ?? 'config', configured }
    }),
  )
}

/** The harness home, as this process sees it. */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** Absolute path of this plugin's roster file. */
function stateFilePath() {
  return join(dshHome(), STATE_FILENAME)
}

/**
 * Accounts the user added from the panel. Only references are recorded here:
 * the keys themselves live in the credential store these references name.
 * @returns the stored accounts, or an empty list when none are recorded.
 */
function readStoredAccounts() {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(), 'utf8'))
    const list = Array.isArray(parsed?.accounts) ? parsed.accounts : []
    return list
      .filter(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          typeof entry.label === 'string' &&
          entry.label !== '' &&
          typeof entry.keyRef === 'string' &&
          KEY_REF_PATTERN.test(entry.keyRef),
      )
      .map((entry) => ({ label: entry.label, keyRef: entry.keyRef, source: 'stored' }))
  } catch {
    return []
  }
}

/**
 * Write the stored roster, creating the harness home when it is missing.
 * @param accounts - the accounts to record, references only.
 */
function writeStoredAccounts(accounts) {
  const file = stateFilePath()
  const temporary = `${file}.tmp`
  mkdirSync(dshHome(), { recursive: true })
  writeFileSync(
    temporary,
    `${JSON.stringify({ accounts: accounts.map(({ label, keyRef }) => ({ label, keyRef })) }, null, 2)}\n`,
    { mode: 0o600 },
  )
  renameSync(temporary, file)
}

/**
 * Configured accounts first, then the ones added from the panel, dropping
 * duplicate labels and references.
 * @param configured - accounts from the plugin's config.
 * @param stored - accounts recorded by the panel.
 * @returns the roster to offer.
 */
function mergeAccounts(configured, stored) {
  const accounts = []
  for (const account of [...configured.map((entry) => ({ ...entry, source: 'config' })), ...stored]) {
    if (accounts.some((entry) => entry.label === account.label || entry.keyRef === account.keyRef)) continue
    accounts.push(account)
  }
  return accounts.length ? accounts : DEFAULT_ACCOUNTS.map((entry) => ({ ...entry, source: 'config' }))
}

/**
 * The first credential reference no account uses yet.
 * @param accounts - every account currently known.
 * @returns a free `CLINE_API_KEY_<n>` reference.
 */
function nextKeyRef(accounts) {
  for (let index = 2; index < 100; index += 1) {
    const candidate = `CLINE_API_KEY_${index}`
    if (!accounts.some((account) => account.keyRef === candidate)) return candidate
  }
  return `CLINE_API_KEY_${Date.now()}`
}

/** Success cache lifetime; a request with `?refresh=1` bypasses it. */
const CACHE_MS = 20_000

/** Failure cache lifetime — short, so a transient error clears quickly. */
const ERROR_CACHE_MS = 5_000

/**
 * Success cache lifetime for an explicitly requested token range. Historical
 * days do not change, so a longer lifetime is safe and keeps a user stepping
 * through ranges off the API.
 */
const RANGE_CACHE_MS = 60_000

/** How many distinct ranges the response cache keeps. */
const CACHE_MAX_RANGES = 12

/** Upstream call timeout. */
const TIMEOUT_MS = 15_000

/** Display labels for the three rolling windows the API reports. */
const LIMIT_LABELS = {
  five_hour: '5 小时',
  weekly: '本周',
  monthly: '本月',
}

/** Micro-USD per USD — the unit of the `balance` field (millionths of a dollar). */
const MICRO_USD = 1_000_000
/**
 * The usage fields (`/usages`, `/usages/daily` `costUsd`) and the plan caps
 * (`last5Hours/last7days/last30daysUsageCostUSDPerUser`) are NOT micro-USD.
 * Verified 2026-10-19 on this account's 5-hour window: the raw field
 * 46,523,719 equals the reference-price cost of that window's token mix
 * (prompt 15,794,163 / cached 13,459,860 / completion 124,521 -> $0.46523763)
 * only when divided by 1e8. Dividing by 1e6 overstates every usage/cap amount
 * by 100x. The balance above keeps MICRO_USD.
 */
const COST_UNITS = 100_000_000

/**
 * Token consumption is reported for the ClinePass subscription only. Usage rows
 * carry an `aiModelTypeName`; rows from other providers (for example the direct
 * DeepSeek model, `aiModelTypeName: "deepseek"`) are billed separately and would
 * otherwise inflate the figures shown beside the ClinePass quota.
 */
const TOKEN_MODEL_TYPE = 'cline-pass'

/**
 * Model-name prefix every subscription row carries, whatever its type label is.
 *
 * Cline relabelled subscription traffic in October 2026: the same
 * `cline-pass/deepseek-v4.1-flash-1017` rows started arriving with
 * `aiModelTypeName: "cline"` (routed through `vercel`, `creditsUsed: 0`) instead
 * of `"cline-pass"`. Keying only on the type label silently dropped every newer
 * day, so the token block looked frozen; the prefix is what actually marks the
 * subscription, and the type label is kept as the primary test for older rows.
 */
const TOKEN_MODEL_PREFIX = 'cline-pass/'

/**
 * Whether a usage row belongs to the ClinePass subscription.
 * @param row - one `/usages` item or `/usages/daily` row.
 * @returns true for subscription usage, false for separately billed providers.
 */
function isPassUsage(row) {
  if (row?.aiModelTypeName === TOKEN_MODEL_TYPE) return true
  return typeof row?.aiModelName === 'string' && row.aiModelName.startsWith(TOKEN_MODEL_PREFIX)
}

/**
 * One authorized GET against the Cline API, unwrapping the `{data, success}` envelope.
 * @param key - resolved Cline API key.
 * @param path - API path beginning with a slash.
 * @returns the envelope's `data` payload.
 * @throws when the transport fails, the status is not ok, or `success` is false.
 */
async function apiGet(key, path) {
  const response = await fetch(API_BASE + path, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!response.ok || body?.success === false) {
    const detail = body?.error ? ` ${body.error}` : text ? ` ${text.slice(0, 200)}` : ''
    throw new Error(`${path} -> HTTP ${response.status}${detail}`)
  }
  return body?.data ?? body
}

/**
 * Days of history the token section reports by default (the default chart
 * width).
 */
const TOKEN_CHART_DAYS = 14

/** Longest span a caller may request; anything wider is clipped to this. */
const MAX_RANGE_DAYS = 186

/**
 * The widest window `/usages/daily` accepts; the API answers
 * `Date range must not exceed 31 days` beyond it, so longer ranges are fetched
 * as consecutive windows and merged.
 */
const DAILY_WINDOW_DAYS = 31

/** Series length above which the chart buckets by week instead of by day. */
const MAX_DAILY_BARS = 31

/**
 * Maximum `/usages` pages walked for the rolling five-hour window. The page
 * size is the API's 200-item maximum, so four pages cover a heavy session's
 * window; `complete: false` marks the rare case where they do not.
 */
const MAX_USAGE_PAGES = 4

/**
 * Page budget for the rolling 24-hour view: a day of heavy use is several
 * times the five-hour volume, so it gets a larger (still bounded) budget.
 */
const MAX_USAGE_PAGES_24H = 12

/** The rolling window the picker offers beside its calendar presets. */
const ROLLING_WINDOW_HOURS = 24

/** The window the quota API calls `five_hour`. */
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

/** One hour in milliseconds. */
const HOUR_MS = 60 * 60 * 1000

/** `YYYY-MM-DD` in UTC, the format `/usages/daily` requires. */
function ymd(date) {
  return date.toISOString().slice(0, 10)
}

/**
 * Walk `/usages` newest-first until the page runs past `since`, collecting the
 * requests inside the window. The API's page cursor is `cursor=<nextToken>`.
 * @param key - Cline API key.
 * @param userId - account id.
 * @param since - epoch milliseconds, inclusive lower bound on `createdAt`.
 * @param maxPages - page budget for this walk.
 * @returns the in-window items and whether the walk reached `since`.
 */
async function fetchRecentUsages(key, userId, since, maxPages = MAX_USAGE_PAGES) {
  const items = []
  let cursor
  let complete = false
  for (let page = 0; page < maxPages; page += 1) {
    const query = `/users/${userId}/usages?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const body = await apiGet(key, query)
    const batch = body?.items ?? []
    for (const item of batch) {
      if (!isPassUsage(item)) continue
      if (Date.parse(item.createdAt) >= since) items.push(item)
    }
    const oldest = batch[batch.length - 1]
    if (batch.length < 200 || oldest === undefined || Date.parse(oldest.createdAt) < since) {
      complete = true
      break
    }
    cursor = body?.nextToken
    if (!cursor) {
      complete = true
      break
    }
  }
  return { items, complete }
}

/** Sum one usage item list into prompt/completion/cached/cost/requests. */
function sumUsages(items) {
  return items.reduce(
    (acc, item) => ({
      prompt: acc.prompt + (item.promptTokens ?? 0),
      completion: acc.completion + (item.completionTokens ?? 0),
      cached: acc.cached + (item.cachedTokens ?? 0),
      costUsd: acc.costUsd + (item.costUsd ?? 0),
      requests: acc.requests + 1,
    }),
    { prompt: 0, completion: 0, cached: 0, costUsd: 0, requests: 0 },
  )
}

/** Local `HH:00` label for an hour boundary. */
function hourLabel(epochMs) {
  return `${String(new Date(epochMs).getHours()).padStart(2, '0')}:00`
}

/**
 * Build the rolling 24-hour view: hourly buckets over the window plus its
 * totals, leading models, and the five-hour subtotal that falls inside it.
 * @param key - Cline API key.
 * @param userId - account id.
 * @returns the `tokens` section in rolling mode.
 */
async function fetchRolling24h(key, userId) {
  const now = Date.now()
  const since = now - ROLLING_WINDOW_HOURS * HOUR_MS
  const { items, complete } = await fetchRecentUsages(key, userId, since, MAX_USAGE_PAGES_24H)

  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS
  const series = []
  for (let offset = ROLLING_WINDOW_HOURS - 1; offset >= 0; offset -= 1) {
    const start = currentHour - offset * HOUR_MS
    series.push({ date: new Date(start).toISOString(), label: hourLabel(start), total: 0, costUsd: 0 })
  }
  const byHour = new Map(series.map((point, index) => [point.date, index]))
  const modelTotals = new Map()
  for (const item of items) {
    const at = Date.parse(item.createdAt)
    const bucket = new Date(Math.floor(at / HOUR_MS) * HOUR_MS).toISOString()
    const index = byHour.get(bucket)
    if (index !== undefined) {
      series[index].total += (item.promptTokens ?? 0) + (item.completionTokens ?? 0)
      series[index].costUsd += item.costUsd ?? 0
    }
    modelTotals.set(item.aiModelName, (modelTotals.get(item.aiModelName) ?? 0) + (item.promptTokens ?? 0) + (item.completionTokens ?? 0))
  }

  const totals = sumUsages(items)
  const five = sumUsages(items.filter((item) => Date.parse(item.createdAt) >= now - FIVE_HOURS_MS))
  const oldest = items.reduce((min, item) => Math.min(min, Date.parse(item.createdAt)), now)

  return {
    scope: TOKEN_MODEL_TYPE,
    mode: 'rolling24h',
    range: {
      hours: ROLLING_WINDOW_HOURS,
      from: new Date(currentHour - (ROLLING_WINDOW_HOURS - 1) * HOUR_MS).toISOString(),
      to: new Date(now).toISOString(),
      // The calendar dates the window spans, so the picker's inputs stay usable
      // as a way back to a date range.
      dayFrom: ymd(new Date(currentHour - (ROLLING_WINDOW_HOURS - 1) * HOUR_MS)),
      dayTo: ymd(new Date(now)),
      max: ymd(new Date()),
      explicit: true,
    },
    seriesUnit: 'hour',
    series,
    seriesMax: series.reduce((max, point) => Math.max(max, point.total), 0),
    seriesTotal: series.reduce((sum, point) => sum + point.total, 0),
    seriesCostUsd: series.reduce((sum, point) => sum + point.costUsd, 0) / COST_UNITS,
    rangeTotals: { ...totals, total: totals.prompt + totals.completion, costUsd: totals.costUsd / COST_UNITS },
    fiveHours: {
      ...five,
      total: five.prompt + five.completion,
      costUsd: five.costUsd / COST_UNITS,
      complete: complete || oldest <= now - FIVE_HOURS_MS,
    },
    complete,
    topModels: [...modelTotals.entries()]
      .map(([model, total]) => ({ model, total }))
      .sort((left, right) => right.total - left.total)
      .slice(0, 3),
  }
}

/**
 * Parse the requested token range from a request URL. Both bounds are optional
 * and must be `YYYY-MM-DD`; the end defaults to today, the start to the default
 * chart width back from it, a reversed pair is swapped, and an over-long span
 * is clipped so one request can never ask for unbounded history.
 * @param url - the raw request URL.
 * @returns the resolved range and whether the caller asked for one explicitly.
 */
export function parseRange(url) {
  const query = new URL(url ?? '/', 'http://dsh.invalid').searchParams
  if (query.get('window') === '24h') {
    return { mode: 'rolling24h', from: undefined, to: undefined, explicit: true }
  }
  const date = (name) => {
    const value = query.get(name)
    return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      ? value
      : undefined
  }
  const today = ymd(new Date())
  const explicitFrom = date('from')
  const explicitTo = date('to')

  let to = explicitTo ?? today
  if (to > today) to = today
  let from = explicitFrom ?? ymd(new Date(Date.parse(`${to}T00:00:00Z`) - (TOKEN_CHART_DAYS - 1) * 86400000))
  if (from > to) {
    const swapped = from
    from = to
    to = swapped
  }
  const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1
  if (spanDays > MAX_RANGE_DAYS) {
    from = ymd(new Date(Date.parse(`${to}T00:00:00Z`) - (MAX_RANGE_DAYS - 1) * 86400000))
  }
  return { mode: 'range', from, to, explicit: explicitFrom !== undefined || explicitTo !== undefined }
}

/** Every `YYYY-MM-DD` from `from` to `to`, inclusive. */
function listDays(from, to) {
  const days = []
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= end; at += 86400000) days.push(ymd(new Date(at)))
  return days
}

/**
 * Build the chart series: one point per day, or per week once the range is
 * longer than a chart can draw legibly.
 * @param from - first day, inclusive.
 * @param to - last day, inclusive.
 * @param dayTotals - per-day totals keyed by `YYYY-MM-DD`.
 * @returns the series unit and its points, oldest first.
 */
function buildSeries(from, to, dayTotals) {
  const days = listDays(from, to)
  const point = (date, label) => {
    const day = dayTotals.get(date)
    return { date, label, total: day?.total ?? 0, costUsd: day?.costUsd ?? 0 }
  }
  if (days.length <= MAX_DAILY_BARS) {
    return { unit: 'day', points: days.map((day) => point(day, day)) }
  }
  const points = []
  for (let index = 0; index < days.length; index += 7) {
    const chunk = days.slice(index, index + 7)
    const bucket = chunk.reduce(
      (acc, day) => {
        const entry = dayTotals.get(day)
        return { total: acc.total + (entry?.total ?? 0), costUsd: acc.costUsd + (entry?.costUsd ?? 0) }
      },
      { total: 0, costUsd: 0 },
    )
    points.push({
      date: chunk[0],
      label: `${chunk[0]} ~ ${chunk[chunk.length - 1]}`,
      total: bucket.total,
      costUsd: bucket.costUsd,
    })
  }
  return { unit: 'week', points }
}

/**
 * Fetch the per-day rows for a range, splitting it into the API's 31-day
 * windows and merging the results.
 * @param key - Cline API key.
 * @param userId - account id.
 * @param from - first day, inclusive.
 * @param to - last day, inclusive.
 * @returns every row the windows returned.
 */
async function fetchDailyRows(key, userId, from, to) {
  const days = listDays(from, to)
  const windows = []
  for (let index = 0; index < days.length; index += DAILY_WINDOW_DAYS) {
    const chunk = days.slice(index, index + DAILY_WINDOW_DAYS)
    windows.push({ start: chunk[0], end: chunk[chunk.length - 1] })
  }
  const pages = await Promise.all(
    windows.map((window) =>
      apiGet(key, `/users/${userId}/usages/daily?startDate=${window.start}&endDate=${window.end}`),
    ),
  )
  return pages.flatMap((page) => page?.items ?? [])
}

/**
 * Read and normalize token consumption: the selected range's series, totals and
 * leading models, plus the rolling five-hour window.
 * @param key - Cline API key.
 * @param userId - account id.
 * @param range - the resolved range from {@link parseRange}.
 * @returns the `tokens` section of the payload.
 */
async function fetchTokens(key, userId, range) {
  if (range.mode === 'rolling24h') return fetchRolling24h(key, userId)

  const [dailyRows, recent] = await Promise.all([
    fetchDailyRows(key, userId, range.from, range.to),
    fetchRecentUsages(key, userId, Date.now() - FIVE_HOURS_MS),
  ])

  const rows = dailyRows.filter((row) => isPassUsage(row))
  const dayTotals = new Map()
  const modelTotals = new Map()
  const perModel = new Map()
  for (const row of rows) {
    const total = (row.promptTokens ?? 0) + (row.completionTokens ?? 0)
    const day = dayTotals.get(row.date) ?? { total: 0, costUsd: 0 }
    day.total += total
    day.costUsd += row.costUsd ?? 0
    dayTotals.set(row.date, day)
    modelTotals.set(row.aiModelName, (modelTotals.get(row.aiModelName) ?? 0) + total)

    // The same rows kept per model, so the browser half can show one model's own
    // token consumption on the same window with the same bucketing.
    const entry = perModel.get(row.aiModelName) ?? {
      prompt: 0,
      completion: 0,
      costUsd: 0,
      dayTotals: new Map(),
    }
    entry.prompt += row.promptTokens ?? 0
    entry.completion += row.completionTokens ?? 0
    entry.costUsd += row.costUsd ?? 0
    const modelDay = entry.dayTotals.get(row.date) ?? { total: 0, costUsd: 0 }
    modelDay.total += total
    modelDay.costUsd += row.costUsd ?? 0
    entry.dayTotals.set(row.date, modelDay)
    perModel.set(row.aiModelName, entry)
  }

  const series = buildSeries(range.from, range.to, dayTotals)
  const withTotal = (entry) => ({ ...entry, total: entry.prompt + entry.completion })

  const fiveHours = recent.items.reduce(
    (acc, item) => ({
      prompt: acc.prompt + (item.promptTokens ?? 0),
      completion: acc.completion + (item.completionTokens ?? 0),
      cached: acc.cached + (item.cachedTokens ?? 0),
      costUsd: acc.costUsd + (item.costUsd ?? 0),
      requests: acc.requests + 1,
    }),
    { prompt: 0, completion: 0, cached: 0, costUsd: 0, requests: 0 },
  )

  return {
    scope: TOKEN_MODEL_TYPE,
    mode: 'range',
    range: {
      from: range.from,
      to: range.to,
      days: listDays(range.from, range.to).length,
      explicit: range.explicit,
      // The API buckets usage by UTC day, so this — not the browser's local
      // date — is the latest day a range can meaningfully end on.
      max: ymd(new Date()),
    },
    seriesUnit: series.unit,
    series: series.points,
    seriesMax: series.points.reduce((max, point) => Math.max(max, point.total), 0),
    seriesTotal: series.points.reduce((sum, point) => sum + point.total, 0),
    seriesCostUsd: series.points.reduce((sum, point) => sum + point.costUsd, 0) / COST_UNITS,
    rangeTotals: withTotal({
      prompt: rows.reduce((sum, row) => sum + (row.promptTokens ?? 0), 0),
      completion: rows.reduce((sum, row) => sum + (row.completionTokens ?? 0), 0),
      costUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) / COST_UNITS,
    }),
    fiveHours: {
      ...withTotal(fiveHours),
      cached: fiveHours.cached,
      requests: fiveHours.requests,
      complete: recent.complete,
      costUsd: fiveHours.costUsd / COST_UNITS,
    },
    topModels: [...modelTotals.entries()]
      .map(([model, total]) => ({ model, total }))
      .sort((left, right) => right.total - left.total)
      .slice(0, 3),
    // Every model in the window with its own totals and series, so the browser
    // half can switch the whole token block to a single model.
    models: [...perModel.entries()]
      .map(([model, entry]) => ({
        model,
        prompt: entry.prompt,
        completion: entry.completion,
        total: entry.prompt + entry.completion,
        costUsd: entry.costUsd / COST_UNITS,
        series: buildSeries(range.from, range.to, entry.dayTotals).points,
      }))
      .sort((left, right) => right.total - left.total),
  }
}

/**
 * Read and normalize the quota for one key. Pure I/O, no cordis surface, so it
 * can be exercised directly by a test harness.
 * @param key - Cline API key.
 * @param range - optional token range; defaults to the last {@link TOKEN_CHART_DAYS} days.
 * @returns the payload served to the browser half.
 */
export async function fetchQuota(key, range = parseRange('/')) {
  if (!key) throw new Error('empty Cline API key')

  const me = await apiGet(key, '/users/me')
  const [limits, plan, balance, tokens] = await Promise.all([
    apiGet(key, '/users/me/plan/usage-limits'),
    apiGet(key, '/users/me/plan').catch(() => null),
    me?.id ? apiGet(key, `/users/${me.id}/balance`).catch(() => null) : Promise.resolve(null),
    me?.id ? fetchTokens(key, me.id, range).catch(() => null) : Promise.resolve(null),
  ])

  const caps = plan?.plan?.entitlements?.cline_pass?.inferenceCapThreshold ?? null

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    account: {
      id: me?.id ?? null,
      email: me?.email ?? null,
      name: me?.displayName ?? null,
    },
    limits: (limits?.limits ?? []).map((entry) => ({
      type: entry.type,
      label: LIMIT_LABELS[entry.type] ?? entry.type,
      percentUsed: typeof entry.percentUsed === 'number' ? entry.percentUsed : null,
      resetsAt: entry.resetsAt ?? null,
    })),
    tokens,
    plan: plan
      ? {
          name: plan.plan?.displayName ?? plan.plan?.name ?? null,
          interval: plan.plan?.interval ?? null,
          currentPeriodEnd: plan.currentPeriodEnd ?? null,
          cancelAt: plan.cancelAt ?? null,
          canceledAt: plan.canceledAt ?? null,
          active: plan.plan?.isActive ?? null,
          caps: caps
            ? {
                fiveHourUsd: caps.last5HoursUsageCostUSDPerUser / COST_UNITS,
                weeklyUsd: caps.last7daysUsageCostUSDPerUser / COST_UNITS,
                monthlyUsd: caps.last30daysUsageCostUSDPerUser / COST_UNITS,
              }
            : null,
        }
      : null,
    creditsUsd: typeof balance?.balance === 'number' ? balance.balance / MICRO_USD : null,
  }
}

/** Services this plugin waits for before its apply runs. */
export const inject = ['webServer', 'credentials']

/**
 * Read and parse a small JSON request body. Diagnostics must never throw into
 * the route handler, so every failure resolves to `undefined`.
 * @param req - the incoming request.
 * @param limit - maximum accepted body size in bytes.
 * @returns the parsed body, or undefined.
 */
function readJsonBody(req, limit = 4096) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

/**
 * Register one route inside the calling fiber's effect scope, reclaiming our
 * own path when a previous generation of this plugin left its registration
 * behind.
 *
 * The reclaim exists because a leaked registration is strictly worse than a
 * replaced one: it belongs to a disposed context, so it can only ever answer
 * with "cannot get required service ... in inactive context", and it makes the
 * next generation's `register` throw on the duplicate path (which would fail
 * the whole plugin). It is guarded — an unreachable table rethrows the original
 * collision.
 * @param ctx - host root context.
 * @param route - the route to register.
 * @param label - effect label.
 * @returns the disposer removing the route.
 */
function registerRoute(ctx, route, label) {
  const register = () => {
    try {
      return ctx.webServer.register(route)
    } catch (error) {
      const table = route.kind === 'exact' ? ctx.webServer.exact : ctx.webServer.prefixes
      if (!(table instanceof Map) || !table.has(route.path)) throw error
      ctx.logger?.warn?.(`cline-quota: reclaiming stale ${route.kind} route ${route.path}`)
      table.delete(route.path)
      return ctx.webServer.register(route)
    }
  }
  return ctx.effect(register, label)
}

/**
 * Register the quota route and its diagnostics companion. The quota response is
 * always JSON: HTTP 200 with `ok: true`, or HTTP 200 with `ok: false` and a
 * readable `error`, so the browser half has exactly one shape to render.
 *
 * Both registrations live in this fiber's effect scope (`ctx.effect`), which is
 * what removes them when the entry is reloaded or disabled.
 * @param ctx - host root context.
 */
export function apply(ctx, config) {
  /**
   * Accounts this profile exposes. Each names its own credential reference, so
   * the browser half can switch accounts without ever seeing a key; the ones the
   * panel adds are recorded in this plugin's own roster file.
   */
  const configured = readAccounts(config)
  const currentAccounts = () => mergeAccounts(configured, readStoredAccounts())
  /**
   * Response cache keyed by `<from>|<to>`: the quota section is identical for
   * every range, but the token section is not, and a user stepping through
   * ranges should not re-hit the API each time.
   * @type {Map<string, { at: number, ok: boolean, payload: unknown }>}
   */
  const cache = new Map()

  /** Beacons posted by the browser half (bundle applied / panel mounted). */
  const events = []
  /** Requests seen by the quota route, newest last. */
  const hits = []
  const record = (list, entry) => {
    list.push(entry)
    if (list.length > MAX_DIAG) list.shift()
  }

  const send = (res, body) => {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  registerRoute(
    ctx,
    {
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        const force = typeof req.url === 'string' && req.url.includes('refresh=1')
        const range = parseRange(req.url)
        const accounts = currentAccounts()
        const account = pickAccount(accounts, parseAccount(req.url))
        record(hits, {
          at: new Date().toISOString(),
          method: req.method ?? null,
          refresh: force,
          account: account.label,
          range: range.mode === 'rolling24h' ? 'window=24h' : range.explicit ? `${range.from}..${range.to}` : null,
          userAgent: req.headers['user-agent'] ?? null,
          // Query string is dropped: the desktop host's authenticated URL carries
          // a token there and this log must not capture it.
          origin: req.headers.origin ?? req.headers.referer ?? null,
        })

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          send(res, { ok: false, error: 'method not allowed' })
          return
        }

        const now = Date.now()
        const windowKey = range.mode === 'rolling24h' ? 'rolling24h' : `${range.from}|${range.to}`
        const cacheKey = `${account.label}|${windowKey}`
        const cached = cache.get(cacheKey)
        const ttl = range.explicit ? RANGE_CACHE_MS : CACHE_MS
        if (!force && cached !== undefined && now - cached.at < (cached.ok ? ttl : ERROR_CACHE_MS)) {
          send(res, cached.payload)
          return
        }

        // The roster rides on every response, failures included, so the browser
        // half can still offer the other accounts.
        const selection = { label: account.label, keyRef: account.keyRef }
        const roster = await describeAccounts(ctx, accounts)

        try {
          const resolved = await ctx.credentials.resolve(account.keyRef)
          if (!resolved?.value) {
            throw new Error(`${account.keyRef} is not configured for this DSH profile`)
          }
          const quota = await fetchQuota(resolved.value, range)
          const payload = {
            ...quota,
            // The Cline identity of the key plus the label this profile knows it by.
            account: { ...(quota.account ?? {}), ...selection },
            accounts: roster,
          }
          cache.set(cacheKey, { at: Date.now(), ok: true, payload })
          while (cache.size > CACHE_MAX_RANGES) cache.delete(cache.keys().next().value)
          send(res, payload)
        } catch (error) {
          const payload = { ok: false, error: String(error?.message ?? error), account: selection, accounts: roster }
          cache.set(cacheKey, { at: Date.now(), ok: false, payload })
          ctx.logger?.warn?.(`cline-quota: ${payload.error}`)
          send(res, payload)
        }
      },
    },
    'cline-quota: quota route',
  )

  registerRoute(
    ctx,
    {
      kind: 'exact',
      path: KEY_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const key = typeof body?.key === 'string' ? body.key.trim() : ''
        const requestedLabel = typeof body?.label === 'string' ? body.label.trim() : ''
        if (key === '') {
          send(res, { ok: false, error: 'key is required' })
          return
        }
        try {
          // Validate before storing anything: an unusable key must never reach
          // the credential store.
          const me = await apiGet(key, '/users/me')
          if (!me?.id) throw new Error('这个 key 没有返回账号信息')
          const accounts = currentAccounts()
          const label =
            requestedLabel !== '' ? requestedLabel : me.email || me.displayName || `账号 ${accounts.length + 1}`
          if (accounts.some((account) => account.label === label)) {
            throw new Error(`已经有一个叫「${label}」的账号了`)
          }
          // The same key twice would show one account as two.
          for (const existing of accounts) {
            let value
            try {
              value = (await ctx.credentials.resolve(existing.keyRef))?.value
            } catch {
              value = undefined
            }
            if (value !== undefined && value === key) {
              throw new Error(`这个 key 已经添加过了（${existing.label}）`)
            }
          }
          const keyRef = nextKeyRef(accounts)
          await ctx.credentials.set(keyRef, key)
          writeStoredAccounts([...readStoredAccounts(), { label, keyRef }])
          cache.clear()
          ctx.logger?.info?.(`cline-quota: stored account ${JSON.stringify(label)} as ${keyRef}`)
          send(res, {
            ok: true,
            account: { label, keyRef, id: me.id ?? null, email: me.email ?? null, name: me.displayName ?? null },
            accounts: await describeAccounts(ctx, currentAccounts()),
          })
        } catch (error) {
          // The key itself is never logged or echoed back.
          send(res, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    'cline-quota: key entry route',
  )

  registerRoute(
    ctx,
    {
      kind: 'exact',
      path: KEY_REMOVE_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const label = typeof body?.label === 'string' ? body.label.trim() : ''
        const stored = readStoredAccounts()
        const target = stored.find((account) => account.label === label)
        if (target === undefined) {
          send(res, { ok: false, error: '只有从面板添加的账号可以删除' })
          return
        }
        try {
          await ctx.credentials.unset(target.keyRef)
        } catch (error) {
          ctx.logger?.warn?.(`cline-quota: could not unset ${target.keyRef}: ${String(error?.message ?? error)}`)
        }
        writeStoredAccounts(stored.filter((account) => account.label !== label))
        cache.clear()
        send(res, { ok: true, accounts: await describeAccounts(ctx, currentAccounts()) })
      },
    },
    'cline-quota: key removal route',
  )

  registerRoute(
    ctx,
    {
      kind: 'exact',
      path: DIAG_ROUTE,
      handler: async (req, res) => {
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          if (body !== undefined && body !== null && typeof body === 'object') {
            record(events, { at: new Date().toISOString(), ...body })
          }
          send(res, { ok: true, recorded: events.length })
          return
        }
        send(res, { ok: true, events, hits })
      },
    },
    'cline-quota: diagnostics route',
  )

  ctx.logger?.info?.(`cline-quota: serving ${ROUTE} (diagnostics at ${DIAG_ROUTE})`)
}
