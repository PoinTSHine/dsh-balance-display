/**
 * dsh-balance-display — server half.
 *
 * Two jobs:
 *
 * 1. Normalize this plugin's own settings. DSH 0.1.7 derives settings from each
 *    loader entry's `Config` schema, which this package cannot declare (see
 *    {@link apply} for the exact reason), so the table below serves as a plain
 *    normalizer over the row's `config:` block instead of a registered namespace.
 * 2. Serve the account balance over a same-origin route. The query to the
 *    provider needs the API key, and the key must never reach the browser, so
 *    this half is the only thing that talks to the provider.
 *
 * This module imports NOTHING but `node:` builtins, and that is deliberate. Node
 * resolves a bare specifier by walking up from the importing file's real path, and
 * this package lives at `E:\deepseek-harness-plugins\balance-display` — outside
 * the DSH installation tree, with no `node_modules` above it — so a bare
 * `@deepseek-ai/...` import would fail the entry and leave the plugin inactive.
 *
 * @module dsh-balance-display
 */

/** Loader plugin name (also the `window.__ModuleLoader__` entry id). */
export const name = 'dsh-balance-display'

/**
 * Required services: none.
 *
 * The settings service and the credentials service are both read through
 * `ctx.get`, so a deployment that composes neither still activates this plugin
 * and simply reports the missing piece through the route. Declaring `settings`
 * here would instead leave the whole plugin waiting whenever that service is
 * itself inactive.
 */
export const inject = []

/** Loader row id this plugin is mounted under (the profile patch entry's `id`). */
export const SETTINGS_NAMESPACE = 'balance-display'

/** Same-origin route the browser half polls. */
export const STATE_ROUTE = '/_dsh/balance-display/state'

/** Official DeepSeek API root; also the provider that owns the balance endpoint. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** Credential name resolved through the credentials service, then the environment. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Endpoint override carried by the environment, honored only when nothing else names one. */
export const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'

/** The settings namespace owned by the DeepSeek provider plugin. */
export const PROVIDER_NAMESPACE = 'llm-deepseek'

/** Default poll interval, in seconds. The user asked for "every minute". */
export const DEFAULT_REFRESH_SECONDS = 60
/** Lower bound of the poll interval: below this the provider is needlessly hammered. */
export const MIN_REFRESH_SECONDS = 10
/** Upper bound of the poll interval. */
export const MAX_REFRESH_SECONDS = 3_600

/** How long one provider answer is reused before a fresh poll reaches the provider. */
export const DEFAULT_TIMEOUT_MS = 10_000
/** Lower bound of the provider request timeout. */
export const MIN_TIMEOUT_MS = 1_000
/** Upper bound of the provider request timeout. */
export const MAX_TIMEOUT_MS = 60_000

/** How long a computed answer is served to everyone. Two browser tabs polling on
 * the same minute must not both reach the provider, so requests landing inside
 * this window share one result. An explicit refresh (`?refresh=1`, which is what
 * a click on the box sends) always bypasses it. */
export const CACHE_TTL_MS = 5_000

/**
 * Lower bound of a price override. 0 is the sentinel for "use the built-in
 * DeepSeek tariff"; anything positive replaces it.
 */
export const MIN_PRICE = 0
/** Upper bound of a price override, per 1M tokens. Generous but finite. */
export const MAX_PRICE = 100_000

/**
 * Structural view of one field. Retained from the era when this table was handed
 * to DSH as a schema stand-in; kept because it documents each field's domain in
 * one place, but nothing consumes it as a schema any more.
 */
function nodeFor(field) {
  if (field.type === 'number') {
    return { type: 'number', meta: { default: field.default, min: field.min, max: field.max } }
  }
  if (field.type === 'string') return { type: 'string', meta: { default: field.default } }
  return { type: 'boolean', meta: { default: field.default } }
}

/**
 * Namespace fields, in document order. Every field defaults here, so a
 * hand-edited settings document and the Settings page agree and both halves
 * always receive a fully defaulted object.
 *
 * `baseUrl` and `apiKeyEnv` default to the EMPTY string, which means "inherit":
 * the plugin then follows whatever the `llm-deepseek` section already resolved
 * for the live model traffic (its `baseURL`, its `apiKeyEnv`, then
 * `$DEEPSEEK_BASE_URL`, then the public API). A blank field therefore tracks the
 * provider the user actually uses instead of duplicating — and drifting from —
 * that configuration. Setting either overrides it.
 *
 * `apiKeyEnv` is a credential NAME, never a secret value: the plugin never
 * stores a key, it only names the one DSH already holds.
 */
export const SETTINGS_FIELDS = [
  { name: 'enabled', type: 'boolean', default: true },
  { name: 'refreshSeconds', type: 'number', default: DEFAULT_REFRESH_SECONDS, min: MIN_REFRESH_SECONDS, max: MAX_REFRESH_SECONDS },
  /** Empty means "show the first currency the provider reports". */
  { name: 'currency', type: 'string', default: '' },
  /** Empty means "inherit the llm-deepseek endpoint". */
  { name: 'baseUrl', type: 'string', default: '' },
  /** Empty means "inherit the llm-deepseek credential name". */
  { name: 'apiKeyEnv', type: 'string', default: '' },
  { name: 'timeoutMs', type: 'number', default: DEFAULT_TIMEOUT_MS, min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS },

  /* ── Session cost (the figure beside the composer's token pill) ─────────── */
  { name: 'costEnabled', type: 'boolean', default: true },
  /** Text printed after the amount, e.g. `yuan`. A blank value re-inherits it. */
  { name: 'costUnit', type: 'string', default: 'yuan' },
  /** Price each turn at the peak or off-peak rate in force when it ran. */
  { name: 'costPeakAware', type: 'boolean', default: true },
  /**
   * Off-peak unit prices per 1M tokens. 0 is the sentinel for "use the built-in
   * DeepSeek tariff"; the peak tier is always derived as double these.
   */
  { name: 'costPriceCacheHit', type: 'number', default: 0, min: MIN_PRICE, max: MAX_PRICE },
  { name: 'costPriceCacheMiss', type: 'number', default: 0, min: MIN_PRICE, max: MAX_PRICE },
  { name: 'costPriceOutput', type: 'number', default: 0, min: MIN_PRICE, max: MAX_PRICE },
]

/** True for a plain (non-array, non-null) object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build the normalizer for one field table.
 *
 * The result is a callable that turns a raw candidate (the loader row's
 * `config:` block, which may be absent, partial, or hand-edited) into a complete,
 * clamped settings object. It deliberately never throws: a mistyped value falls
 * back to its default rather than taking the plugin's activation down.
 *
 * It carries `type`/`dict`/`toJSON()` for the historical reason that it used to
 * be handed to DSH's settings seam as a schema stand-in. It is NOT one any more —
 * see {@link apply} — and it must not be passed off as one: DSH rehydrates with
 * the real schemastery constructor, which would not convert these plain child
 * descriptions into schemas.
 *
 * @param fields - ordered field specs.
 * @returns a callable normalizer.
 */
export function createSettingsSchema(fields) {
  const schema = (input) => {
    const source = isPlainObject(input) ? input : {}
    const resolved = {}
    for (const field of fields) {
      const candidate = source[field.name]
      if (field.type === 'boolean') {
        resolved[field.name] = typeof candidate === 'boolean' ? candidate : field.default
        continue
      }
      if (field.type === 'number') {
        const number = typeof candidate === 'number' ? candidate : Number(candidate)
        resolved[field.name] = Number.isFinite(number)
          ? Math.min(field.max, Math.max(field.min, number))
          : field.default
        continue
      }
      // Strings are trimmed, and an empty one re-inherits the default: for
      // every string field here the default IS the "unset" meaning, so a
      // cleared input can never produce a value the plugin cannot use.
      const text = typeof candidate === 'string' ? candidate.trim() : ''
      resolved[field.name] = text.length === 0 ? field.default : text
    }
    return resolved
  }
  schema.type = 'object'
  schema.meta = {}
  schema.dict = Object.fromEntries(fields.map(field => [field.name, nodeFor(field)]))
  // A detached copy: the descriptor crosses the wire, so handing out the live
  // table would let a consumer mutate this schema's own node tree.
  schema.toJSON = () => ({ type: 'object', meta: {}, dict: structuredClone(schema.dict) })
  return schema
}

/**
 * Normalizer for {@link SETTINGS_FIELDS}, applied to the loader row's config.
 *
 * NOT exported as `Config`, and it must stay that way. Cordis reads a plugin
 * module's `Config` export as the plugin's own loader-config schema and validates
 * against it — and DSH 0.1.7 additionally derives the settings UI from it. This
 * callable is not a schemastery schema (see {@link createSettingsSchema}), so
 * exporting it under that name would fail the entry at load.
 */
export const SettingsSchema = createSettingsSchema(SETTINGS_FIELDS)

/** Fully defaulted settings value. */
export function defaultSettings() {
  return SettingsSchema(undefined)
}

/**
 * Whether a credential may be sent to this endpoint at all.
 *
 * The key travels in an `Authorization` header, so a plaintext endpoint would
 * put it on the wire in the clear. HTTPS is always fine; HTTP is allowed only
 * for a loopback host, which is how a local proxy is addressed. Anything else
 * (an `ftp:`/`file:` scheme, a malformed URL, a remote `http:` host) is refused
 * before the request is built.
 *
 * @param baseUrl - candidate endpoint root.
 * @returns true when the request may carry the credential.
 */
export function isAllowedEndpoint(baseUrl) {
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * Read the DeepSeek provider's own resolved configuration.
 *
 * The reference implementation reads `baseURL`/`apiKeyEnv` from here rather than
 * hardcoding them, and so does this one: a deployment that renamed the
 * credential variable or points at a proxy must not also have to re-teach the
 * balance box where its key lives.
 *
 * DSH 0.1.7 reshaped this seam: a namespace is no longer looked up by name with
 * `settings.get(ns)`. Configuration now derives from each plugin entry's own
 * `Config` schema and is read through `settings.describe()`, which returns one
 * descriptor per active entry. Every step stays defensive — the provider plugin
 * may be absent, or the settings service may itself be inactive.
 *
 * @param ctx - plugin context carrying the settings service.
 * @returns the section, or `undefined` when it is absent.
 */
export function readProviderSection(ctx) {
  const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
  if (settings === undefined || settings === null || typeof settings.describe !== 'function') return undefined
  let described
  try {
    described = settings.describe()
  } catch {
    return undefined
  }
  if (!Array.isArray(described)) return undefined
  const row = described.find(candidate => isPlainObject(candidate) && candidate.ns === PROVIDER_NAMESPACE)
  return row !== undefined && isPlainObject(row.value) ? row.value : undefined
}

/** Trim trailing slashes and a protocol suffix so `/user/balance` can be appended. */
function rootOf(value) {
  return value.trim().replace(/\/+$/u, '').replace(/\/(?:v\d+|anthropic)$/iu, '')
}

/**
 * Resolve the endpoint and credential name one query will use, following the
 * namespace override first and the live provider configuration second.
 *
 * @param ctx - plugin context.
 * @param settings - the resolved `balance-display` settings.
 * @returns the effective endpoint, credential name, and where each came from.
 */
export function resolveTarget(ctx, settings) {
  const provider = readProviderSection(ctx)
  const configuredBase = typeof settings.baseUrl === 'string' ? settings.baseUrl.trim() : ''
  const providerBase = typeof provider?.baseURL === 'string' ? provider.baseURL.trim() : ''
  const envBase = typeof process.env[BASE_URL_ENV] === 'string' ? process.env[BASE_URL_ENV].trim() : ''
  const baseUrl = rootOf(configuredBase.length > 0 ? configuredBase
    : providerBase.length > 0 ? providerBase
      : envBase.length > 0 ? envBase
        : DEFAULT_BASE_URL)

  const configuredEnv = typeof settings.apiKeyEnv === 'string' ? settings.apiKeyEnv.trim() : ''
  const providerEnv = typeof provider?.apiKeyEnv === 'string' ? provider.apiKeyEnv.trim() : ''
  const apiKeyEnv = configuredEnv.length > 0 ? configuredEnv
    : providerEnv.length > 0 ? providerEnv
      : DEFAULT_API_KEY_ENV

  return {
    baseUrl,
    apiKeyEnv,
    endpointSource: configuredBase.length > 0 ? 'plugin' : providerBase.length > 0 ? 'provider' : envBase.length > 0 ? 'environment' : 'default',
    credentialSource: configuredEnv.length > 0 ? 'plugin' : providerEnv.length > 0 ? 'provider' : 'default',
  }
}

/** Coerce one provider amount into a trimmed string, or `''` when unusable. */
function amountOf(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * Normalize one `GET /user/balance` payload into the shape both halves share.
 *
 * The provider answers `{ is_available, balance_infos: [{ currency,
 * total_balance, granted_balance, topped_up_balance }] }` with every amount as
 * a STRING. Anything unexpected is dropped rather than coerced, so a provider
 * change surfaces as a short list (or an error) instead of a wrong number.
 *
 * @param payload - parsed provider response body.
 * @returns `undefined` when the payload has no recognizable balance array.
 */
export function normalizeBalance(payload) {
  if (!isPlainObject(payload)) return undefined
  if (!Array.isArray(payload.balance_infos)) return undefined
  const infos = []
  for (const info of payload.balance_infos) {
    if (!isPlainObject(info)) continue
    infos.push({
      currency: typeof info.currency === 'string' ? info.currency.trim() : '',
      total: amountOf(info.total_balance),
      granted: amountOf(info.granted_balance),
      toppedUp: amountOf(info.topped_up_balance),
    })
  }
  return { isAvailable: payload.is_available === true, infos }
}

/** JSON response helper: never cached by the browser, always UTF-8. */
function respondJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/**
 * Resolve the provider API key without ever copying it into a response.
 *
 * The credentials service is the sanctioned source (it owns the environment
 * layers, the user `.env`, and `~/.dsh/.credentials.yaml`). It is reached
 * through the context rather than imported, and it is optional: when it is
 * absent, or holds nothing under this name, the process environment is the
 * fallback.
 *
 * @param ctx - plugin context carrying the (optional) `credentials` service.
 * @param ref - credential name, e.g. `DEEPSEEK_API_KEY`.
 * @returns the secret and where it came from, or `undefined` when unset.
 */
export async function resolveCredential(ctx, ref) {
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && resolved !== null
        && typeof resolved.value === 'string' && resolved.value.length > 0) {
        return { value: resolved.value, source: typeof resolved.source === 'string' ? resolved.source : 'credentials' }
      }
    } catch {
      // A credentials backend failure must not hide an environment key, so the
      // fallback below still runs.
    }
  }
  const fromEnv = process.env[ref]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return { value: fromEnv.trim(), source: 'environment' }
  }
  return undefined
}

/**
 * Query the provider's balance endpoint once.
 *
 * @param options - resolved endpoint, secret, timeout, and a fetch implementation.
 * @returns a normalized result or a typed error — never a rejection.
 */
export async function queryBalance(options) {
  const { baseUrl, apiKey, timeoutMs, fetchImpl } = options
  const url = `${baseUrl.replace(/\/+$/u, '')}/user/balance`
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const aborted = error !== null && typeof error === 'object' && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return {
      ok: false,
      error: {
        code: aborted ? 'timeout' : 'network',
        message: aborted
          ? `请求超时（${timeoutMs} 毫秒）`
          : `无法连接 ${baseUrl}：${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
  if (!response.ok) {
    // The provider's own message is genuinely useful here (an invalid key says
    // so), but it is untrusted text, so it is read defensively and truncated.
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 300)
    } catch {
      detail = ''
    }
    const code = response.status === 401 || response.status === 403 ? 'unauthorized' : 'http'
    const hint = code === 'unauthorized' ? 'API Key 无效或已失效' : `服务端返回 ${response.status}`
    return { ok: false, error: { code, message: detail.length > 0 ? `${hint}：${detail}` : hint } }
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    return { ok: false, error: { code: 'shape', message: '余额接口返回的不是合法 JSON' } }
  }
  const balance = normalizeBalance(payload)
  if (balance === undefined) {
    return { ok: false, error: { code: 'shape', message: '余额接口返回的数据结构无法识别（可能该地址不是 DeepSeek 官方接口）' } }
  }
  return { ok: true, balance: { ...balance, fetchedAt: Date.now() } }
}

/**
 * The cache and in-flight coalescing in front of {@link queryBalance}.
 *
 * Every invocation re-reads the settings, so an edit that changes the endpoint or
 * the credential name takes effect on the very next poll without a restart.
 *
 * @param ctx - plugin context used for credential resolution.
 * @param readSettings - returns the current normalized settings.
 * @param fetchImpl - fetch implementation (injectable for tests).
 */
export function createBalanceSource(ctx, readSettings, fetchImpl = fetch) {
  let cache
  let inflight

  async function compute() {
    const settings = readSettings()
    const target = resolveTarget(ctx, settings)
    // Reported on every outcome, including failures, so the Settings page can
    // show which endpoint and credential name were actually used.
    const source = {
      baseUrl: target.baseUrl,
      apiKeyEnv: target.apiKeyEnv,
      endpointSource: target.endpointSource,
      credentialSource: target.credentialSource,
    }
    if (!isAllowedEndpoint(target.baseUrl)) {
      return {
        ok: false,
        source,
        error: {
          code: 'insecure-endpoint',
          message: `出于安全考虑，不会把 API Key 发送到 ${target.baseUrl}：只允许 https 地址，或本机 http 代理。`,
        },
      }
    }
    const credential = await resolveCredential(ctx, target.apiKeyEnv)
    if (credential === undefined) {
      return {
        ok: false,
        source,
        error: {
          code: 'no-credential',
          message: `没有找到名为 ${target.apiKeyEnv} 的 API Key，可在「设置 → 模型」中填写，或写入环境变量。`,
        },
      }
    }
    const result = await queryBalance({
      baseUrl: target.baseUrl,
      apiKey: credential.value,
      timeoutMs: settings.timeoutMs,
      fetchImpl,
    })
    return { ...result, source: { ...source, credentialSource: credential.source } }
  }

  return {
    /**
     * Read the balance, reusing a recent answer unless `force`.
     * @param force - bypass the cache and hit the provider now.
     */
    async read(force) {
      const now = Date.now()
      if (!force && cache !== undefined && now - cache.at < CACHE_TTL_MS) return cache.value
      // Coalesce: a second caller while one query is outstanding joins it
      // rather than opening a second request.
      if (inflight !== undefined) return inflight
      const started = compute().then((value) => {
        cache = { at: Date.now(), value }
        return value
      })
      inflight = started
      try {
        return await started
      } finally {
        if (inflight === started) inflight = undefined
      }
    },
    /** Drop the cached answer, so the next read reaches the provider. */
    invalidate() {
      cache = undefined
    },
  }
}

/**
 * Serve one balance poll.
 * @param source - cache-backed balance source.
 * @param req - the incoming request (handler owns the full response lifecycle).
 * @param res - the response to write.
 * @param config - current display settings to ride along, so the browser half
 *   renders from one response instead of needing its own settings channel.
 */
export async function serveState(source, req, res, config) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    respondJson(res, 405, { error: 'GET this route for the current balance' })
    return
  }
  // An explicit refresh is a user-visible gesture, so it never reads the cache.
  const force = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1'
  let result
  try {
    result = await source.read(force)
  } catch (error) {
    // createBalanceSource is written not to throw, but the route still must not
    // take the process down if that ever changes.
    result = { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  respondJson(res, 200, config === undefined ? result : { ...result, config })
}

/**
 * Resolve the plugin's settings and mount the balance route.
 *
 * DSH 0.1.7 replaced the `settings.register()` seam: a plugin's settings are now
 * derived from its OWN `Config` schema, surfaced through `settings.describe()`,
 * and stored in the profile's patch layer. This package deliberately declares no
 * `Config`.
 *
 * That is not laziness — a valid one cannot be produced here. DSH rehydrates a
 * schema with `new Schema(json)` (see `plainSchema` in dsh-settings), and that
 * constructor only resolves CHILD references through the `{ uid, refs }` envelope
 * a real `toJSON()` emits: a plain `{ type, meta, dict }` description is copied by
 * `Object.assign`, so its `dict` children would stay plain objects rather than
 * becoming schemas. Only the builders (`z.object(...)` and friends) run children
 * through `Schema.from` — and `Schema.from` THROWS on a plain object
 * (`cannot infer schema from [object Object]`). So a stand-in would have to forge
 * a real reference table, and the genuine library is the only practical source.
 *
 * Its knobs therefore arrive as the loader row's own `config:` block, already
 * normalized and defaulted by {@link SettingsSchema} below, and are handed to the
 * browser half through the balance route.
 *
 * @param ctx - plugin context owning both registrations.
 * @param config - the loader row's `config:` block, or undefined.
 */
export function apply(ctx, config) {
  const settings = SettingsSchema(config)
  const readSettings = () => settings
  const source = createBalanceSource(ctx, readSettings)
  // The Web carrier is an optional service: without it (CLI-only runs) only the
  // balance route is absent.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: (req, res) => { void serveState(source, req, res, readSettings()) },
    }), 'dsh-balance-display: balance route')
  })
  ctx.logger.info('[dsh-balance-display] balance route mounted at %s', STATE_ROUTE)
}
