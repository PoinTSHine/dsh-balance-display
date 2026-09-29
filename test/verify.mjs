/**
 * Self-contained verification harness for dsh-balance-display.
 *
 * Run with `node --test test/` (or `npm test`) from the plugin directory. It
 * exercises every pure decision the plugin makes — schema resolution, response
 * normalization, endpoint safety, target inheritance, the provider request, the
 * cache, and the HTTP route — with no DSH installation, no network, and no
 * credentials. `node:test` is a Node builtin, so this adds no dependency.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CACHE_TTL_MS,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  createBalanceSource,
  createSettingsSchema,
  defaultSettings,
  isAllowedEndpoint,
  normalizeBalance,
  queryBalance,
  readProviderSection,
  resolveCredential,
  resolveTarget,
  serveState,
  SETTINGS_FIELDS,
  SettingsSchema,
} from '../index.js'

/** A provider payload shaped exactly like the official `GET /user/balance`. */
const OFFICIAL_PAYLOAD = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
  ],
}

/** A settings scope stand-in reading a fixed resolved value. */
/**
 * A settings READER. DSH 0.1.7 removed the registered settings scope, so the
 * balance source now takes a plain "current settings" function; this factory
 * keeps every call site reading naturally.
 */
const scopeOf = value => () => SettingsSchema(value)

/** A plugin-context stand-in exposing only the services a case needs. */
const ctxOf = ({ credentials, settings } = {}) => ({
  get(name) {
    if (name === 'credentials') return credentials
    if (name === 'settings') return settings
    return undefined
  },
})

/** A fetch stand-in returning a canned response and recording its calls. */
function fakeFetch(outcome) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    if (outcome.throws !== undefined) throw outcome.throws
    const body = typeof outcome.body === 'string' ? outcome.body : JSON.stringify(outcome.body)
    return {
      ok: outcome.status === undefined || (outcome.status >= 200 && outcome.status < 300),
      status: outcome.status ?? 200,
      async json() {
        if (outcome.jsonThrows === true) throw new SyntaxError('not json')
        return JSON.parse(body)
      },
      async text() { return body },
    }
  }
  impl.calls = calls
  return impl
}

test('settings schema: resolves defaults from nothing', () => {
  assert.deepEqual(defaultSettings(), {
    enabled: true,
    refreshSeconds: 60,
    currency: '',
    baseUrl: '',
    apiKeyEnv: '',
    timeoutMs: 10_000,
    costEnabled: true,
    costUnit: 'yuan',
    costPeakAware: true,
    costPriceCacheHit: 0,
    costPriceCacheMiss: 0,
    costPriceOutput: 0,
  })
})

test('settings schema: clamps out-of-range numbers instead of throwing', () => {
  const resolved = SettingsSchema({ refreshSeconds: 1, timeoutMs: 10 ** 9 })
  assert.equal(resolved.refreshSeconds, 10)
  assert.equal(resolved.timeoutMs, 60_000)
})

test('settings schema: non-numeric and non-boolean values fall back to defaults', () => {
  const resolved = SettingsSchema({ enabled: 'yes', refreshSeconds: 'soon', currency: 7 })
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.refreshSeconds, 60)
  // A number where a string belongs re-inherits the default rather than being coerced.
  assert.equal(resolved.currency, '')
})

test('settings schema: a blank string re-inherits the default (the "inherit" meaning)', () => {
  const resolved = SettingsSchema({ baseUrl: '   ', apiKeyEnv: '' })
  assert.equal(resolved.baseUrl, '')
  assert.equal(resolved.apiKeyEnv, '')
})

test('settings schema: strings are trimmed and kept when set', () => {
  const resolved = SettingsSchema({ baseUrl: '  https://example.test/v1  ', apiKeyEnv: ' MY_KEY ' })
  assert.equal(resolved.baseUrl, 'https://example.test/v1')
  assert.equal(resolved.apiKeyEnv, 'MY_KEY')
})

test('settings schema: an array or null input yields full defaults, never a throw', () => {
  for (const input of [null, undefined, [], 'nope', 42]) {
    assert.deepEqual(SettingsSchema(input), defaultSettings())
  }
})

test('settings schema: carries the descriptor shape the settings seam reads', () => {
  assert.equal(SettingsSchema.type, 'object')
  assert.deepEqual(Object.keys(SettingsSchema.dict), SETTINGS_FIELDS.map(field => field.name))
  assert.equal(SettingsSchema.dict.refreshSeconds.type, 'number')
  assert.equal(SettingsSchema.dict.currency.type, 'string')
  assert.equal(SettingsSchema.dict.enabled.type, 'boolean')
  const descriptor = SettingsSchema.toJSON()
  assert.equal(descriptor.type, 'object')
  // The descriptor must be detached from the live node tree.
  descriptor.dict.enabled.meta.default = 'mutated'
  assert.equal(SettingsSchema.dict.enabled.meta.default, true)
})

test('createSettingsSchema is exported for reuse and honours its own field table', () => {
  const schema = createSettingsSchema([{ name: 'n', type: 'number', default: 5, min: 0, max: 10 }])
  assert.deepEqual(schema({ n: 99 }), { n: 10 })
  assert.deepEqual(schema({}), { n: 5 })
})

test('normalizeBalance: reads the official payload', () => {
  assert.deepEqual(normalizeBalance(OFFICIAL_PAYLOAD), {
    isAvailable: true,
    infos: [{ currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00' }],
  })
})

test('normalizeBalance: tolerates multiple currencies and missing amounts', () => {
  const normalized = normalizeBalance({
    is_available: false,
    balance_infos: [
      { currency: 'CNY', total_balance: '0.00' },
      { currency: 'USD', total_balance: '5.00', granted_balance: '1.00', topped_up_balance: '4.00' },
    ],
  })
  assert.equal(normalized.isAvailable, false)
  assert.equal(normalized.infos.length, 2)
  // An absent amount is an empty string, never a fabricated zero.
  assert.equal(normalized.infos[0].granted, '')
  assert.equal(normalized.infos[1].total, '5.00')
})

test('normalizeBalance: refuses payloads with no recognizable balance array', () => {
  assert.equal(normalizeBalance(null), undefined)
  assert.equal(normalizeBalance('nope'), undefined)
  assert.equal(normalizeBalance({}), undefined)
  assert.equal(normalizeBalance({ balance_infos: 'nope' }), undefined)
  // An empty array IS recognizable: the account simply holds nothing.
  assert.deepEqual(normalizeBalance({ is_available: true, balance_infos: [] }), { isAvailable: true, infos: [] })
})

test('normalizeBalance: drops malformed entries rather than coercing them', () => {
  const normalized = normalizeBalance({ balance_infos: [null, 'x', 3, { currency: 'CNY', total_balance: 12.5 }] })
  assert.equal(normalized.infos.length, 1)
  assert.equal(normalized.infos[0].total, '12.5')
})

test('normalizeBalance: is_available must be literally true', () => {
  assert.equal(normalizeBalance({ is_available: 'true', balance_infos: [] }).isAvailable, false)
  assert.equal(normalizeBalance({ balance_infos: [] }).isAvailable, false)
})

test('isAllowedEndpoint: https is always allowed, including remote hosts', () => {
  assert.equal(isAllowedEndpoint('https://api.deepseek.com'), true)
  assert.equal(isAllowedEndpoint('https://proxy.example.test/v1'), true)
})

test('isAllowedEndpoint: http is allowed only on loopback', () => {
  assert.equal(isAllowedEndpoint('http://localhost:8080'), true)
  assert.equal(isAllowedEndpoint('http://127.0.0.1:4000/v1'), true)
  assert.equal(isAllowedEndpoint('http://[::1]:4000'), true)
  // The credential must never cross a plaintext remote link.
  assert.equal(isAllowedEndpoint('http://api.deepseek.com'), false)
  assert.equal(isAllowedEndpoint('http://10.0.0.5:8080'), false)
  assert.equal(isAllowedEndpoint('http://evil.test#localhost'), false)
})

test('isAllowedEndpoint: non-HTTP schemes and malformed URLs are refused', () => {
  assert.equal(isAllowedEndpoint('file:///etc/passwd'), false)
  assert.equal(isAllowedEndpoint('ftp://api.deepseek.com'), false)
  assert.equal(isAllowedEndpoint('not a url'), false)
  assert.equal(isAllowedEndpoint(''), false)
})

test('resolveTarget: with no provider and no overrides, uses the public default', () => {
  const target = resolveTarget(ctxOf(), defaultSettings())
  assert.equal(target.baseUrl, DEFAULT_BASE_URL)
  assert.equal(target.apiKeyEnv, DEFAULT_API_KEY_ENV)
  assert.equal(target.endpointSource, 'default')
  assert.equal(target.credentialSource, 'default')
})

/**
 * A settings service stub in the DSH 0.1.7 shape. Provider configuration is read
 * through `describe()` — one descriptor per active loader entry — because
 * `settings.get(ns)` no longer exists.
 */
const settingsOf = (...rows) => ({ describe: () => rows })
/** One provider row, as `describe()` reports it. */
const providerRow = value => ({ autoGenerate: true, ns: 'llm-deepseek', schema: {}, value, revision: 0, applies: 'live' })

test('resolveTarget: inherits the live llm-deepseek configuration', () => {
  const ctx = ctxOf({ settings: settingsOf(providerRow({ baseURL: 'https://proxy.test/v1', apiKeyEnv: 'MY_KEY' })) })
  const target = resolveTarget(ctx, defaultSettings())
  // A trailing /v1 is stripped so `/user/balance` lands on the root.
  assert.equal(target.baseUrl, 'https://proxy.test')
  assert.equal(target.apiKeyEnv, 'MY_KEY')
  assert.equal(target.endpointSource, 'provider')
  assert.equal(target.credentialSource, 'provider')
})

test('resolveTarget: a plugin override beats the provider configuration', () => {
  const ctx = ctxOf({ settings: settingsOf(providerRow({ baseURL: 'https://proxy.test', apiKeyEnv: 'PROVIDER_KEY' })) })
  const target = resolveTarget(ctx, SettingsSchema({ baseUrl: 'https://mine.test', apiKeyEnv: 'MINE' }))
  assert.equal(target.baseUrl, 'https://mine.test')
  assert.equal(target.apiKeyEnv, 'MINE')
  assert.equal(target.endpointSource, 'plugin')
  assert.equal(target.credentialSource, 'plugin')
})

test('resolveTarget: strips an /anthropic protocol suffix from the provider root', () => {
  const ctx = ctxOf({ settings: settingsOf(providerRow({ baseURL: 'https://api.deepseek.com/anthropic' })) })
  assert.equal(resolveTarget(ctx, defaultSettings()).baseUrl, 'https://api.deepseek.com')
})

test('readProviderSection: survives an absent or hostile settings service', () => {
  assert.equal(readProviderSection(ctxOf()), undefined)
  assert.equal(readProviderSection(ctxOf({ settings: {} })), undefined)
  // A describe that is not a list, one that throws, and rows with no usable value
  // must all read as "no provider configuration" rather than breaking the poll.
  assert.equal(readProviderSection(ctxOf({ settings: { describe: () => 'nope' } })), undefined)
  assert.equal(readProviderSection(ctxOf({ settings: { describe: () => { throw new Error('boom') } } })), undefined)
  assert.equal(readProviderSection(ctxOf({ settings: settingsOf(providerRow(undefined)) })), undefined)
  assert.equal(readProviderSection(ctxOf({ settings: settingsOf(providerRow('nope')) })), undefined)
  assert.equal(readProviderSection(ctxOf({ settings: settingsOf(null, 'nope') })), undefined)
  // Only the provider's own row counts; another plugin's row must be ignored.
  assert.equal(readProviderSection(ctxOf({
    settings: settingsOf({ ...providerRow({ baseURL: 'https://other.test' }), ns: 'llm-pi-ai' }),
  })), undefined)
  assert.equal(readProviderSection({}), undefined)
})

test('resolveCredential: prefers the credentials service', async () => {
  const ctx = ctxOf({ credentials: { resolve: async () => ({ value: 'sk-from-service', source: 'file' }) } })
  assert.deepEqual(await resolveCredential(ctx, 'DEEPSEEK_API_KEY'), { value: 'sk-from-service', source: 'file' })
})

test('resolveCredential: falls back to the environment when the service misses', async () => {
  process.env.DSH_BD_TEST_KEY = 'sk-from-env'
  try {
    const ctx = ctxOf({ credentials: { resolve: async () => undefined } })
    assert.deepEqual(await resolveCredential(ctx, 'DSH_BD_TEST_KEY'), { value: 'sk-from-env', source: 'environment' })
  } finally {
    delete process.env.DSH_BD_TEST_KEY
  }
})

test('resolveCredential: a throwing credentials backend still lets the environment answer', async () => {
  process.env.DSH_BD_TEST_KEY = 'sk-from-env'
  try {
    const ctx = ctxOf({ credentials: { resolve: async () => { throw new Error('backend down') } } })
    assert.deepEqual(await resolveCredential(ctx, 'DSH_BD_TEST_KEY'), { value: 'sk-from-env', source: 'environment' })
  } finally {
    delete process.env.DSH_BD_TEST_KEY
  }
})

test('resolveCredential: an empty stored value is treated as unset', async () => {
  const ctx = ctxOf({ credentials: { resolve: async () => ({ value: '', source: 'file' }) } })
  assert.equal(await resolveCredential(ctx, 'DSH_BD_ABSENT_KEY'), undefined)
})

test('queryBalance: sends a Bearer GET to {root}/user/balance', async () => {
  const fetchImpl = fakeFetch({ body: OFFICIAL_PAYLOAD })
  const result = await queryBalance({ baseUrl: 'https://api.deepseek.com/', apiKey: 'sk-x', timeoutMs: 5_000, fetchImpl })
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(fetchImpl.calls[0].init.method, 'GET')
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer sk-x')
  assert.equal(result.ok, true)
  assert.equal(result.balance.infos[0].total, '110.00')
  assert.equal(typeof result.balance.fetchedAt, 'number')
})

test('queryBalance: reports a rejected key as unauthorized and keeps the provider detail', async () => {
  const fetchImpl = fakeFetch({ status: 401, body: '{"error":{"message":"Authentication Fails"}}' })
  const result = await queryBalance({ baseUrl: DEFAULT_BASE_URL, apiKey: 'bad', timeoutMs: 5_000, fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unauthorized')
  assert.match(result.error.message, /Authentication Fails/u)
})

test('queryBalance: maps other HTTP failures and truncates hostile bodies', async () => {
  const long = 'x'.repeat(5_000)
  const fetchImpl = fakeFetch({ status: 502, body: long })
  const result = await queryBalance({ baseUrl: DEFAULT_BASE_URL, apiKey: 'k', timeoutMs: 5_000, fetchImpl })
  assert.equal(result.error.code, 'http')
  assert.ok(result.error.message.length < 400, 'provider text must be truncated')
})

test('queryBalance: a transport failure becomes a network error, never a rejection', async () => {
  const fetchImpl = fakeFetch({ throws: Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' }) })
  const result = await queryBalance({ baseUrl: DEFAULT_BASE_URL, apiKey: 'k', timeoutMs: 5_000, fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'network')
})

test('queryBalance: a timeout is reported as such', async () => {
  const fetchImpl = fakeFetch({ throws: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) })
  const result = await queryBalance({ baseUrl: DEFAULT_BASE_URL, apiKey: 'k', timeoutMs: 1_000, fetchImpl })
  assert.equal(result.error.code, 'timeout')
})

test('queryBalance: a non-JSON body and an unrecognized shape are distinct errors', async () => {
  const notJson = await queryBalance({
    baseUrl: DEFAULT_BASE_URL, apiKey: 'k', timeoutMs: 1_000, fetchImpl: fakeFetch({ body: '<html>', jsonThrows: true }),
  })
  assert.equal(notJson.error.code, 'shape')
  const wrongShape = await queryBalance({
    baseUrl: 'https://proxy.test', apiKey: 'k', timeoutMs: 1_000, fetchImpl: fakeFetch({ body: { hello: 'world' } }),
  })
  assert.equal(wrongShape.error.code, 'shape')
})

test('createBalanceSource: a missing credential is reported without any request', async () => {
  const fetchImpl = fakeFetch({ body: OFFICIAL_PAYLOAD })
  const source = createBalanceSource(ctxOf(), scopeOf({ apiKeyEnv: 'DSH_BD_DEFINITELY_ABSENT' }), fetchImpl)
  const result = await source.read(false)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'no-credential')
  assert.equal(fetchImpl.calls.length, 0, 'no request may be attempted without a key')
  assert.equal(result.source.apiKeyEnv, 'DSH_BD_DEFINITELY_ABSENT')
})

test('createBalanceSource: an insecure endpoint is refused before the key is used', async () => {
  process.env.DSH_BD_TEST_KEY = 'sk-secret'
  try {
    const fetchImpl = fakeFetch({ body: OFFICIAL_PAYLOAD })
    const source = createBalanceSource(ctxOf(), scopeOf({ apiKeyEnv: 'DSH_BD_TEST_KEY', baseUrl: 'http://remote.test' }), fetchImpl)
    const result = await source.read(false)
    assert.equal(result.error.code, 'insecure-endpoint')
    assert.equal(fetchImpl.calls.length, 0, 'the key must not be sent to a plaintext remote host')
  } finally {
    delete process.env.DSH_BD_TEST_KEY
  }
})

test('createBalanceSource: caches within the TTL and bypasses it when forced', async () => {
  process.env.DSH_BD_TEST_KEY = 'sk-secret'
  try {
    const fetchImpl = fakeFetch({ body: OFFICIAL_PAYLOAD })
    const source = createBalanceSource(ctxOf(), scopeOf({ apiKeyEnv: 'DSH_BD_TEST_KEY' }), fetchImpl)
    assert.equal((await source.read(false)).ok, true)
    assert.equal((await source.read(false)).ok, true)
    assert.equal(fetchImpl.calls.length, 1, 'the second read inside the TTL must be served from cache')
    assert.equal((await source.read(true)).ok, true)
    assert.equal(fetchImpl.calls.length, 2, 'a forced read must reach the provider')
    assert.ok(CACHE_TTL_MS > 0)
  } finally {
    delete process.env.DSH_BD_TEST_KEY
  }
})

test('createBalanceSource: concurrent reads coalesce into one request', async () => {
  process.env.DSH_BD_TEST_KEY = 'sk-secret'
  try {
    const fetchImpl = fakeFetch({ body: OFFICIAL_PAYLOAD })
    const source = createBalanceSource(ctxOf(), scopeOf({ apiKeyEnv: 'DSH_BD_TEST_KEY' }), fetchImpl)
    const results = await Promise.all([source.read(false), source.read(false), source.read(false)])
    assert.equal(fetchImpl.calls.length, 1, 'three simultaneous polls must share one provider call')
    assert.ok(results.every(result => result.ok === true))
  } finally {
    delete process.env.DSH_BD_TEST_KEY
  }
})

test('createBalanceSource: invalidate drops the cached answer', async () => {
  process.env.DSH_BD_TEST_KEY = 'sk-secret'
  try {
    const fetchImpl = fakeFetch({ body: OFFICIAL_PAYLOAD })
    const source = createBalanceSource(ctxOf(), scopeOf({ apiKeyEnv: 'DSH_BD_TEST_KEY' }), fetchImpl)
    await source.read(false)
    source.invalidate()
    await source.read(false)
    assert.equal(fetchImpl.calls.length, 2)
  } finally {
    delete process.env.DSH_BD_TEST_KEY
  }
})

test('createBalanceSource: reads the CURRENT settings on every fetch', async () => {
  process.env.DSH_BD_TEST_KEY = 'sk-secret'
  try {
    const fetchImpl = fakeFetch({ body: OFFICIAL_PAYLOAD })
    let baseUrl = 'https://one.test'
    const scope = () => SettingsSchema({ apiKeyEnv: 'DSH_BD_TEST_KEY', baseUrl })
    const source = createBalanceSource(ctxOf(), scope, fetchImpl)
    await source.read(true)
    baseUrl = 'https://two.test'
    await source.read(true)
    assert.match(fetchImpl.calls[0].url, /^https:\/\/one\.test/u)
    assert.match(fetchImpl.calls[1].url, /^https:\/\/two\.test/u)
  } finally {
    delete process.env.DSH_BD_TEST_KEY
  }
})

/** A minimal `http.ServerResponse` stand-in capturing what the route wrote. */
function fakeResponse() {
  const record = { status: undefined, headers: undefined, body: '' }
  return {
    record,
    setHeader() {},
    writeHead(status, headers) { record.status = status; record.headers = headers },
    end(chunk) { if (typeof chunk === 'string') record.body = chunk },
  }
}

test('serveState: answers a GET with JSON and no-store caching', async () => {
  process.env.DSH_BD_TEST_KEY = 'sk-secret'
  try {
    const source = createBalanceSource(ctxOf(), scopeOf({ apiKeyEnv: 'DSH_BD_TEST_KEY' }), fakeFetch({ body: OFFICIAL_PAYLOAD }))
    const res = fakeResponse()
    await serveState(source, { method: 'GET', url: '/_dsh/balance-display/state' }, res)
    assert.equal(res.record.status, 200)
    assert.equal(res.record.headers['Cache-Control'], 'no-store')
    const parsed = JSON.parse(res.record.body)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.balance.infos[0].currency, 'CNY')
    assert.equal(parsed.source.apiKeyEnv, 'DSH_BD_TEST_KEY')
    // The secret itself must never appear in the payload.
    assert.equal(res.record.body.includes('sk-secret'), false, 'the API key must never cross to the browser')
  } finally {
    delete process.env.DSH_BD_TEST_KEY
  }
})

test('serveState: ?refresh=1 forces a provider read', async () => {
  process.env.DSH_BD_TEST_KEY = 'sk-secret'
  try {
    const fetchImpl = fakeFetch({ body: OFFICIAL_PAYLOAD })
    const source = createBalanceSource(ctxOf(), scopeOf({ apiKeyEnv: 'DSH_BD_TEST_KEY' }), fetchImpl)
    await serveState(source, { method: 'GET', url: '/x' }, fakeResponse())
    await serveState(source, { method: 'GET', url: '/x' }, fakeResponse())
    assert.equal(fetchImpl.calls.length, 1)
    await serveState(source, { method: 'GET', url: '/x?refresh=1' }, fakeResponse())
    assert.equal(fetchImpl.calls.length, 2)
  } finally {
    delete process.env.DSH_BD_TEST_KEY
  }
})

test('serveState: HEAD is answered without a body, and other methods get 405', async () => {
  const source = createBalanceSource(ctxOf(), scopeOf({}), fakeFetch({ body: OFFICIAL_PAYLOAD }))
  const head = fakeResponse()
  await serveState(source, { method: 'HEAD', url: '/x' }, head)
  assert.equal(head.record.status, 200)
  assert.equal(head.record.body, '')

  let allowed
  const post = fakeResponse()
  post.setHeader = (name, value) => { if (name === 'Allow') allowed = value }
  await serveState(source, { method: 'POST', url: '/x' }, post)
  assert.equal(post.record.status, 405)
  assert.equal(allowed, 'GET, HEAD')
})

test('serveState: a failing source still yields a well-formed error body', async () => {
  const source = { read: async () => { throw new Error('unexpected') } }
  const res = fakeResponse()
  await serveState(source, { method: 'GET', url: '/x' }, res)
  assert.equal(res.record.status, 200)
  const parsed = JSON.parse(res.record.body)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'internal')
})
