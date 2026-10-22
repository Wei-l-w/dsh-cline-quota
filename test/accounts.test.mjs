/**
 * Offline harness for the cline-quota host half.
 *
 * Mounts the real host module against a fake cordis ctx and a fake Cline API,
 * then drives the registered routes to prove account selection, the pasted-key
 * flow (validate -> credentials.set -> roster file), removal, and the money
 * unit fixes. No network, no DSH process, no credentials needed.
 *
 *   node test/accounts.test.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const HOME = join(tmpdir(), 'dsh-cline-quota-test-' + Date.now())
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME
const statePath = join(HOME, 'cline-quota.accounts.json')

// The credential store the plugin writes through: reference -> secret.
const store = {
  CLINE_API_KEY: 'key-main',
  CLINE_API_KEY_2: 'key-second',
}
const EMAILS = {
  'key-main': 'main@example.com',
  'key-second': 'second@example.com',
  'key-third': 'third@example.com',
  'key-fourth': 'fourth@example.com',
}

// The fake Cline API echoes the bearer key, so which key was used is provable.
globalThis.fetch = async (url, init) => {
  const u = String(url)
  const auth = String((init && init.headers && init.headers.authorization) || '')
  const key = auth.replace(/^Bearer\s+/i, '')
  const body = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })
  if (u.includes('/users/me') && !EMAILS[key]) {
    return { ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized' }
  }
  if (u.includes('/users/me/plan/usage-limits')) {
    return body({
      limits: [
        { type: 'five_hour', percentUsed: key === 'key-second' ? 42 : 5, resetsAt: '2026-10-19T05:58:07Z' },
        { type: 'weekly', percentUsed: 6, resetsAt: '2026-10-25T12:56:39Z' },
        { type: 'monthly', percentUsed: 3, resetsAt: '2026-11-17T12:56:39Z' },
      ],
    })
  }
  if (u.includes('/users/me/plan')) {
    return body({
      plan: {
        displayName: 'Cline Pass',
        interval: 'Monthly',
        entitlements: {
          cline_pass: {
            inferenceCapThreshold: {
              last5HoursUsageCostUSDPerUser: 1e9,
              last7daysUsageCostUSDPerUser: 2.5e9,
              last30daysUsageCostUSDPerUser: 5e9,
            },
          },
        },
      },
      currentPeriodEnd: '2026-11-18T10:10:39Z',
      cancelAt: null,
      canceledAt: null,
    })
  }
  if (u.includes('/balance')) return body({ balance: 398178 })
  if (u.includes('/usages/daily')) {
    return body({
      items: [
        {
          date: '2026-10-18',
          aiModelName: 'cline-pass/deepseek-v4.1-flash',
          aiModelTypeName: 'cline-pass',
          promptTokens: 1000,
          completionTokens: 10,
          costUsd: 500000,
        },
        // Cline relabelled subscription traffic to `cline` while keeping the
        // `cline-pass/` model prefix: this row must still be counted.
        {
          date: '2026-10-19',
          aiModelName: 'cline-pass/deepseek-v4.1-flash-1017',
          aiModelTypeName: 'cline',
          promptTokens: 2000,
          completionTokens: 20,
          costUsd: 700000,
        },
        // A directly billed provider: excluded, whatever its tokens are.
        {
          date: '2026-10-19',
          aiModelName: 'deepseek-v4.1-flash',
          aiModelTypeName: 'deepseek',
          promptTokens: 9999,
          completionTokens: 999,
          costUsd: 800000,
        },
      ],
    })
  }
  if (u.includes('/usages')) {
    return body({
      items: [
        {
          aiModelTypeName: 'cline-pass',
          aiModelName: 'cline-pass/deepseek-v4.1-flash',
          createdAt: new Date().toISOString(),
          promptTokens: 100,
          completionTokens: 5,
          cachedTokens: 80,
          costUsd: 12345,
        },
        {
          aiModelTypeName: 'cline',
          aiModelName: 'cline-pass/deepseek-v4.1-flash-1017',
          createdAt: new Date().toISOString(),
          promptTokens: 1000,
          completionTokens: 10,
          cachedTokens: 900,
          costUsd: 23456,
        },
        {
          aiModelTypeName: 'deepseek',
          aiModelName: 'deepseek-v4.1-flash',
          createdAt: new Date().toISOString(),
          promptTokens: 9999,
          completionTokens: 999,
          costUsd: 34567,
        },
      ],
      nextToken: null,
    })
  }
  if (u.includes('/users/me')) {
    // The id must not be derived from the key, or the "never echoes the key"
    // check below would measure this fake instead of the plugin.
    return body({
      id: 'usr-' + EMAILS[key].split('@')[0],
      email: EMAILS[key],
      displayName: EMAILS[key].split('@')[0],
    })
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' }
}

let routes = new Map()
const ctx = {
  credentials: {
    resolve: async (ref) => (store[ref] ? { value: store[ref], source: 'file' } : undefined),
    describe: async (ref) => ({ configured: Boolean(store[ref]) }),
    // The plugin must not write through these any more: a panel key lives in its
    // own roster file, so a provider change in DSH cannot take it away.
    set: async () => {
      throw new Error('the plugin must not write to the credential store')
    },
    unset: async () => {
      throw new Error('the plugin must not write to the credential store')
    },
  },
  logger: { warn: () => {}, info: () => {} },
  effect: (fn) => fn(),
}

/** Mount the plugin with one config, replacing the routes registered before. */
function mount(config) {
  routes = new Map()
  apply(
    {
      ...ctx,
      webServer: {
        exact: new Map(),
        prefixes: new Map(),
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    config,
  )
}

mount({
  accounts: [
    { label: '主号', keyRef: 'CLINE_API_KEY' },
    { label: '备号', keyRef: 'CLINE_API_KEY_2' },
  ],
})

function respond(path, method, payload) {
  const req = {
    url: path,
    method,
    headers: {},
    on(event, handler) {
      if (method === 'POST') {
        if (event === 'data') handler(Buffer.from(JSON.stringify(payload ?? {})))
        else if (event === 'end') handler()
      }
      return req
    },
    destroy() {},
  }
  return new Promise((resolve) => {
    const res = {
      writeHead() {},
      end(body) {
        resolve(JSON.parse(body))
      },
    }
    routes.get(path.split('?')[0]).handler(req, res)
  })
}
const call = (path) => respond(path, 'GET')
const post = (path, body) => respond(path, 'POST', body)

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '   [' + detail + ']'))
}

// --- account selection ------------------------------------------------------
const a = await call('/api/cline-quota')
check('default picks the first account', a.account.label === '主号' && a.account.keyRef === 'CLINE_API_KEY', a.account.label)
check('cline identity is preserved alongside the label', a.account.email === 'main@example.com', a.account.email)
check('roster lists both configured accounts', a.accounts.length === 2, JSON.stringify(a.accounts))
check('configured flags come from credentials.describe', a.accounts[0].configured === true && a.accounts[1].configured === true)
check('caps decoded with the 1e-8 unit', a.plan.caps.fiveHourUsd === 10 && a.plan.caps.monthlyUsd === 50, JSON.stringify(a.plan.caps))
check('credits stay micro-USD', a.creditsUsd === 0.398178, String(a.creditsUsd))
check('range cost is USD (1e-8 field)', a.tokens.rangeTotals.costUsd === 0.012, String(a.tokens.rangeTotals.costUsd))
check('range total counts both pass rows', a.tokens.rangeTotals.total === 3030, String(a.tokens.rangeTotals.total))
check(
  'a relabelled cline row is still subscription usage',
  a.tokens.models.some((entry) => entry.model === 'cline-pass/deepseek-v4.1-flash-1017' && entry.total === 2020),
  JSON.stringify(a.tokens.models.map((entry) => entry.model + '=' + entry.total)),
)
check(
  'a directly billed provider row is excluded',
  !a.tokens.models.some((entry) => String(entry.model).includes('deepseek-v4.1-flash-1017') === false && entry.total === 10998),
  JSON.stringify(a.tokens.models.map((entry) => entry.model + '=' + entry.total)),
)
check('five-hour total counts the relabelled row', a.tokens.fiveHours.total === 1115, String(a.tokens.fiveHours.total))
check('five-hour requests exclude the other provider', a.tokens.fiveHours.requests === 2, String(a.tokens.fiveHours.requests))

const b = await call('/api/cline-quota?account=' + encodeURIComponent('备号'))
check('explicit account switches the resolved key', b.account.label === '备号' && b.account.email === 'second@example.com', b.account.email)
check('the switched account has its own numbers', b.limits[0].percentUsed === 42, String(b.limits[0].percentUsed))
const byRef = await call('/api/cline-quota?account=CLINE_API_KEY_2')
check('a keyRef also selects the account', byRef.account.label === '备号', byRef.account.label)
const missing = await call('/api/cline-quota?account=' + encodeURIComponent('不存在的'))
check('unknown label falls back to the first account', missing.account.label === '主号', missing.account.label)

// --- pasting a key in the panel --------------------------------------------
const saved = await post('/api/cline-quota/key', { key: 'key-third' })
check('the pasted key is accepted', saved.ok === true, String(saved.error))
check('a panel account carries no credential reference', saved.account.keyRef === undefined, String(saved.account.keyRef))
check('the label defaults to the account e-mail', saved.account.label === 'third@example.com', saved.account.label)
check('the response never echoes the key', !JSON.stringify(saved).includes('key-third'))
check('the credential store stayed untouched', store.CLINE_API_KEY_3 === undefined, Object.keys(store).join(','))
check('the roster file exists', existsSync(statePath), statePath)
const stateText = readFileSync(statePath, 'utf8')
check(
  'the roster file holds the key for the panel account',
  stateText.includes('key-third') && stateText.includes('third@example.com'),
  stateText.replace(/\s+/g, ' ').slice(0, 140),
)

const afterAdd = await call('/api/cline-quota?account=' + encodeURIComponent('third@example.com') + '&refresh=1')
check('the stored account is selectable', afterAdd.ok === true && afterAdd.account.email === 'third@example.com', afterAdd.account.email)
check('the roster grew to three accounts', afterAdd.accounts.length === 3, JSON.stringify(afterAdd.accounts.map((x) => x.label)))

const bad = await post('/api/cline-quota/key', { key: 'bad-key' })
check('an unusable key is rejected', bad.ok === false, String(bad.error))
check('a rejected key is never stored', !readFileSync(statePath, 'utf8').includes('bad-key'), Object.keys(store).join(','))

const dupe = await post('/api/cline-quota/key', { key: 'key-second' })
check('the same key twice is refused', dupe.ok === false && /已经添加过/.test(String(dupe.error)), String(dupe.error))
const labelClash = await post('/api/cline-quota/key', { key: 'key-fourth', label: '主号' })
check('a duplicate label is refused', labelClash.ok === false && /已经有一个叫/.test(String(labelClash.error)), String(labelClash.error))

const removed = await post('/api/cline-quota/key/remove', { label: 'third@example.com' })
check(
  'removing forgets the stored key',
  removed.ok === true && !readFileSync(statePath, 'utf8').includes('key-third'),
  JSON.stringify(removed.accounts.map((x) => x.label)),
)
check('the roster file drops the removed account', !readFileSync(statePath, 'utf8').includes('third@example.com'))
const configRemove = await post('/api/cline-quota/key/remove', { label: '主号' })
check('a configured account cannot be removed', configRemove.ok === false, String(configRemove.error))

// --- missing credential -----------------------------------------------------
delete store.CLINE_API_KEY_2
const d = await call('/api/cline-quota?account=' + encodeURIComponent('备号') + '&refresh=1')
check('a missing key names its reference', d.ok === false && /CLINE_API_KEY_2/.test(String(d.error)), String(d.error))
check('failure still carries the roster', d.accounts.length === 2 && d.accounts[1].configured === false, JSON.stringify(d.accounts))

// --- an install with no configuration at all --------------------------------
// The plugin must not fall back to the provider's credential reference: with no
// config and no panel account the roster stays empty and the panel asks for a key.
mount({})
const empty = await call('/api/cline-quota')
check('no config means no accounts', Array.isArray(empty.accounts) && empty.accounts.length === 0, JSON.stringify(empty.accounts))
check('the empty state is flagged for the panel', empty.empty === true && empty.ok === false, String(empty.error))
check('it asks for a key instead of naming a credential', /＋/.test(String(empty.error)), String(empty.error))
check('the store still holds its own reference', store.CLINE_API_KEY === 'key-main', Object.keys(store).join(','))

const failed = checks.filter((entry) => !entry.ok).length
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' checks passed')
rmSync(HOME, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
