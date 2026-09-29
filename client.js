/**
 * dsh-balance-display — browser half.
 *
 * Three pieces, all driven by the `balance-display` settings namespace:
 *
 * 1. A balance box in the sidebar foot, registered into `sidebar.footer.action`.
 *    That slot is declared by ui-sidebar and rendered directly ABOVE the
 *    `sidebar.settings` seat, inside the same `.footerActions` flex column — so
 *    the box sits above the Settings button by construction, not by styling. Its
 *    geometry is copied from the Settings trigger (42px tall, 12px radius,
 *    `0 10px 0 8px` padding, `--dsw-alias-interactive-bg-hover` on hover) so the
 *    two rows read as one pair.
 * 2. A polling runtime: one balance fetch at mount, then one per configured
 *    interval (60s by default), plus an explicit fetch on click. Polling pauses
 *    while the document is hidden.
 * 3. A `settings.section` page for the switch, the interval, and the endpoint /
 *    credential names.
 *
 * The provider query itself lives in the server half: it needs the API key, and
 * the key must never reach the browser.
 *
 * @module dsh-balance-display/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-balance-display',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement
    const { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /** Settings namespace owned by this plugin. */
    const NS = 'balance-display'
    /** Same-origin route mounted by the server half. */
    const STATE_ROUTE = '/_dsh/balance-display/state'
    /**
     * Browser-half revision, rendered in the settings page. A hard refresh is
     * the only way a `client.js` change reaches the browser, and there is no
     * other way to tell whether that happened — bump this whenever client.js
     * changes, and the page itself answers "is the browser up to date?".
     */
    const VERSION = '1.5.0'

    /**
     * Fallbacks mirroring the host schema, used before the document arrives.
     * `baseUrl`/`apiKeyEnv` are EMPTY on purpose: empty means "inherit from the
     * live `llm-deepseek` configuration", which the server half resolves.
     */
    const DEFAULTS = {
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
    }
    /** What the server falls back to when nothing overrides the target. */
    const FALLBACK_BASE_URL = 'https://api.deepseek.com'
    const FALLBACK_API_KEY_ENV = 'DEEPSEEK_API_KEY'
    /** Numeric domains, mirrored from the host schema so the UI cannot offer a value it clamps. */
    const REFRESH_DOMAIN = { min: 10, max: 3_600 }
    const TIMEOUT_DOMAIN = { min: 1_000, max: 60_000 }
    /** Unit-price domain, in the configured currency per 1M tokens. 0 = use the built-in tariff. */
    const PRICE_DOMAIN = { min: 0, max: 100_000 }

    const STYLE_ID = 'dsh-balance-display-style'
    /** Currency glyphs; an unknown code falls back to the code itself. */
    const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: 'JP¥', HKD: 'HK$', TWD: 'NT$', SGD: 'S$' }

    const zh = {
      nav: '余额显示',
      title: '余额显示',
      intro: '在左侧边栏「设置」按钮上方显示账户余额，默认每分钟自动刷新，点击即可立即刷新。余额由本地服务端查询，API Key 不会发送到浏览器。',
      enabled: '显示余额框',
      on: '显示',
      off: '隐藏',
      /* A behavioural switch answers its own label, so it must not borrow the
         show/hide wording: "区分峰谷价 · 隐藏" says nothing. */
      switchOn: '开',
      switchOff: '关',
      interval: '自动刷新间隔',
      intervalHint: '单位：秒。默认 60 秒（每分钟一次）；点击余额框可随时手动刷新。',
      currency: '显示币种',
      currencyHint: '留空表示显示接口返回的第一种币种，例如 CNY 或 USD。',
      endpoint: '接口地址',
      endpointHint: '留空即自动沿用「设置 → 模型」中 DeepSeek 的接口地址。余额查询使用「地址 + /user/balance」。',
      credential: 'API Key 变量名',
      credentialHint: '留空即自动沿用「设置 → 模型」中 DeepSeek 的凭据名称（通常为 DEEPSEEK_API_KEY）。插件只读取这个名称，不会保存或显示密钥内容。',
      timeout: '请求超时',
      timeoutHint: '单位：毫秒。',
      serverHint: '接口地址与 API Key 名称由本插件的加载配置决定（profile 补丁中该行的 config 段），此处只读显示。显示相关的偏好保存在浏览器本地。',
      reset: '恢复默认',
      loading: '正在读取设置…',
      unavailable: '设置暂不可用：宿主没有注册 balance-display 设置命名空间。',
      groupDisplay: '显示',
      groupSource: '数据来源',
      status: '当前状态',
      statusEndpoint: '实际接口',
      statusKey: '实际凭据名',
      statusUpdated: '最近更新',
      statusNever: '尚未获取',
      inherited: '自动',
      endpointPlugin: '插件设置',
      endpointProvider: '跟随模型设置',
      endpointEnvironment: '环境变量',
      endpointDefault: '默认地址',
      credentialPlugin: '插件设置',
      credentialProvider: '跟随模型设置',
      credentialDefault: '默认名称',
      refreshing: '正在刷新…',
      clickToRefresh: '点击刷新余额',
      balanceLabel: '账户余额',
      granted: '赠送余额',
      toppedUp: '充值余额',
      unavailableBalance: '余额不足',
      errorTitle: '余额获取失败',
      noKey: '未配置',
      /* Interpolated by the locale service: `t(key, { seconds })`. */
      ago: '{seconds} 秒前',
      minutesAgo: '{minutes} 分钟前',

      /* Session cost (the composer-dock figure). */
      groupCost: '会话费用',
      costLabel: '本会话费用',
      costEnabled: '显示会话费用',
      costUnit: '费用单位',
      costUnitHint: '显示在金额后面的文字，例如 yuan 或 元（会自动补一个空格）。留空则为 yuan。',
      costPeakAware: '区分峰谷价',
      costPeakAwareHint: '按每一轮调用实际发生的时间分别套用峰价或谷价（峰价 = 谷价的 2 倍）。关闭后全部按谷价计算。',
      priceCacheHit: '谷价 · 缓存命中',
      priceCacheMiss: '谷价 · 缓存未命中',
      priceOutput: '谷价 · 输出',
      priceHint: '单位：元 / 百万 tokens。留空即使用内置的 DeepSeek 官方价（命中 0.02、未命中 1、输出 4，峰价翻倍；缓存写入按命中价计）。',
      priceSuffix: '元 / 百万',
      costNote: '费用由本会话每一轮调用的 token 用量乘以对应时段单价累加得出，单价内置为 DeepSeek 官方 2026 年 9 月价格。若官方调价，可在此覆盖。',
    }

    const en = {
      nav: 'Balance display',
      title: 'Balance display',
      intro: 'Shows the account balance in the left sidebar, directly above the Settings button. It refreshes once a minute by default, and a click refreshes it immediately. The balance is queried by the local server half, so the API key never reaches the browser.',
      enabled: 'Show the balance box',
      on: 'Shown',
      off: 'Hidden',
      /* See the zh note: a behavioural switch reads as on/off, not shown/hidden. */
      switchOn: 'On',
      switchOff: 'Off',
      interval: 'Auto-refresh interval',
      intervalHint: 'Seconds. Defaults to 60 (once a minute); clicking the box refreshes at any time.',
      currency: 'Currency',
      currencyHint: 'Leave empty to show the first currency the endpoint reports, e.g. CNY or USD.',
      endpoint: 'Endpoint',
      endpointHint: 'Leave empty to follow the DeepSeek endpoint already configured under Settings → Models. Balance reads use “endpoint + /user/balance”.',
      credential: 'API key variable name',
      credentialHint: 'Leave empty to follow the credential name configured for DeepSeek under Settings → Models (usually DEEPSEEK_API_KEY). The plugin only reads this name — it never stores or displays the secret.',
      timeout: 'Request timeout',
      timeoutHint: 'Milliseconds.',
      serverHint: 'The endpoint and credential name come from this plugin’s loader config (the config block of its profile-patch row) and are shown read-only here. Display preferences are stored in this browser.',
      reset: 'Reset to defaults',
      loading: 'Reading settings…',
      unavailable: 'Settings unavailable: the host registered no balance-display settings namespace.',
      groupDisplay: 'Display',
      groupSource: 'Data source',
      status: 'Status',
      statusEndpoint: 'Endpoint in use',
      statusKey: 'Credential name in use',
      statusUpdated: 'Last updated',
      statusNever: 'Not fetched yet',
      inherited: 'auto',
      endpointPlugin: 'plugin setting',
      endpointProvider: 'from model settings',
      endpointEnvironment: 'environment',
      endpointDefault: 'default',
      credentialPlugin: 'plugin setting',
      credentialProvider: 'from model settings',
      credentialDefault: 'default',
      refreshing: 'Refreshing…',
      clickToRefresh: 'Click to refresh the balance',
      balanceLabel: 'Balance',
      granted: 'Granted',
      toppedUp: 'Topped up',
      unavailableBalance: 'Insufficient balance',
      errorTitle: 'Balance request failed',
      noKey: 'Not set',
      /* Interpolated by the locale service: `t(key, { seconds })`. */
      ago: '{seconds}s ago',
      minutesAgo: '{minutes}m ago',

      /* Session cost (the composer-dock figure). */
      groupCost: 'Session cost',
      costLabel: 'Session cost',
      costEnabled: 'Show the session cost',
      costUnit: 'Cost unit',
      costUnitHint: 'Text printed after the amount, e.g. yuan (one space is inserted automatically). Blank means yuan.',
      costPeakAware: 'Peak / off-peak pricing',
      costPeakAwareHint: 'Prices each turn at the peak or off-peak rate in force when it ran (peak = 2× off-peak). Off charges everything at the off-peak rate.',
      priceCacheHit: 'Off-peak · cache hit',
      priceCacheMiss: 'Off-peak · cache miss',
      priceOutput: 'Off-peak · output',
      priceHint: 'Per 1M tokens, in the unit above. Blank uses the built-in DeepSeek official tariff (hit 0.02, miss 1, output 4, peak doubled; cache writes bill at the hit rate).',
      priceSuffix: 'per 1M',
      costNote: 'The figure sums each turn’s token usage at the rate in force when that turn ran. The built-in unit prices are DeepSeek’s official September 2026 tariff; override them here if they change.',
    }

    /**
     * The whole stylesheet. The sidebar box rules mirror the Settings trigger in
     * ui-settings-general's `SettingsRoot.module.css` — including the outer
     * `calc(100% + 4px)` / `-2px` bleed that `.triggerRow` applies — so the two
     * rows have identical width, height, rounding and hover chrome.
     */
    const STYLESHEET = `
.dsh-bd-box{flex:none;display:flex;align-items:center;gap:8px;width:calc(100% + 4px);height:42px;
  margin:4px -2px;padding:0 10px 0 8px;box-sizing:border-box;border:none;border-radius:12px;
  background:transparent;cursor:pointer;overflow:hidden;color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:14px;line-height:22px;text-align:left;
  transition:background .15s ease,color .15s ease}
.dsh-bd-box:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-bd-box[data-rail="true"]{flex:none;width:36px;height:36px;margin:8px 0 10px;justify-content:center;gap:0;padding:0}
.dsh-bd-icon{flex:none;display:block}
.dsh-bd-label{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.dsh-bd-box[data-state="loading"] .dsh-bd-label,
.dsh-bd-box[data-refreshing="true"] .dsh-bd-label{opacity:.5}
.dsh-bd-box[data-state="error"]{color:var(--dsw-alias-label-tertiary)}
.dsh-bd-box[data-low="true"]{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-primary))}

/* The session-cost pill: a FOURTH reading in the composer dock, beside ui-chat's
   two stats pills and the ContextMeter. Its geometry is copied from that row's
   own pill (1px/8px padding, 24px radius, transparent at rest, 13px tertiary
   text, 14px glyph, tabular figures) so it sits in the row as an equal rather
   than as a sticker on its neighbour.
   It stays a SPAN, not a button: there is nothing for it to open, so it declares
   no hover fill. At rest it is visually identical to its button siblings, which
   is the point — only the pointer feedback differs, and that feedback would be a
   lie here. */
.dsh-bd-cost{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;
  max-width:100%;padding:1px 8px;border-radius:24px;background:transparent;
  color:var(--dsw-alias-label-tertiary);
  font-size:var(--dsh-content-font-size-secondary,13px);
  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum";
  white-space:nowrap}
.dsh-bd-cost svg{width:14px;height:14px;flex:none}

/* Hover/focus preview card. Two things matter here.
   SURFACE: the card wears the SIDEBAR's own fill (--dsw-specific-sidebar-fill,
   which is what ui-sidebar's root and the AppFrame column paint themselves
   with), not an elevated layer token, so it reads as a piece of the sidebar
   rather than a panel floating over it.
   PLACEMENT: fixed positioning, which is what lets it escape the sidebar's
   overflow clipping — DSH's own Tooltip documents relying on the same property.
   --dsw-elevation-prominent supplies the hairline stroke + shadow that keep the
   card separated from the conversation area behind it, and it already draws the
   0.5px stroke inside box-shadow, so no separate border is declared.
   pointer-events:none because the card sits away from the anchor: a pointer
   travelling toward it has already left the button, so there is nothing to keep
   hit-testable. */
.dsh-bd-float{position:fixed;z-index:100;box-sizing:border-box;width:238px;padding:12px 14px;
  border-radius:12px;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base));
  box-shadow:var(--dsw-elevation-prominent);
  color:var(--dsw-alias-label-primary);pointer-events:none;
  animation:dsh-bd-float-in 140ms var(--ds-ease-in-out)}
/* With the video-wallpaper plugin driving the sidebar, the card follows the SAME
   fill at the SAME opacity, so that plugin's "left sidebar opacity" slider moves
   both surfaces together. It reuses the plugin's own custom property and mirrors
   its color-mix expression exactly.
   The data-dsh-vw gate is load-bearing: that plugin only clears its custom
   properties when it is DISPOSED, so switching the wallpaper off leaves a stale
   --dsh-vw-sidebar behind — reading it unconditionally would keep the card
   translucent with no wallpaper at all. */
html[data-dsh-vw="on"] .dsh-bd-float{
  background:color-mix(in srgb,var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base)) var(--dsh-vw-sidebar,100%),transparent)}
@keyframes dsh-bd-float-in{from{opacity:0}}
@media (prefers-reduced-motion:reduce){.dsh-bd-float{animation:none}}
.dsh-bd-floatHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dsh-bd-floatLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-bd-floatAmount{display:flex;align-items:baseline;gap:6px;margin-top:2px}
.dsh-bd-floatValue{font-size:20px;line-height:26px;font-weight:600;letter-spacing:-.01em;
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.dsh-bd-floatCode{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-bd-floatRows{display:grid;gap:4px;margin-top:10px;padding-top:10px;
  border-top:0.5px solid var(--dsw-alias-border-l1)}
.dsh-bd-floatRow{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
  font-size:12px;line-height:18px}
.dsh-bd-floatRow span:first-child{color:var(--dsw-alias-label-tertiary)}
.dsh-bd-floatRow span:last-child{color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.dsh-bd-floatFoot{margin-top:10px;padding-top:10px;
  border-top:0.5px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-tertiary)}
.dsh-bd-floatFoot[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-tertiary))}
.dsh-bd-floatError{margin:8px 0 0;font-size:11.5px;line-height:17px;word-break:break-word;
  color:var(--dsw-alias-state-error-primary)}

.dsh-bd-page{display:grid;gap:18px;max-width:640px;padding:6px 2px 36px}
.dsh-bd-title{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}
.dsh-bd-intro{margin:0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.dsh-bd-section{display:grid;gap:12px}
.dsh-bd-sectionHead{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;letter-spacing:.02em;
  text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.dsh-bd-card{display:grid;gap:14px;padding:14px 16px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l1)}
.dsh-bd-row{display:grid;gap:6px}
.dsh-bd-rowHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.dsh-bd-label{font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-bd-value{font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dsh-bd-hint{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
.dsh-bd-range{width:100%;height:20px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsh-bd-range:disabled{cursor:default;opacity:.5}
.dsh-bd-text{width:100%;height:30px;padding:0 10px;box-sizing:border-box;border-radius:8px;
  border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px}
.dsh-bd-text:disabled{opacity:.5;cursor:default}
.dsh-bd-switchRow{display:flex;align-items:center;gap:10px}
.dsh-bd-seg{display:inline-flex;padding:2px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-2);
  border:0.5px solid var(--dsw-alias-border-l1);margin-left:auto}
.dsh-bd-seg button{height:24px;padding:0 12px;border:0;border-radius:999px;corner-shape:round;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dsh-bd-seg button[data-active]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-bd-seg button:disabled{cursor:default;opacity:.5}
.dsh-bd-foot{display:flex;align-items:center;gap:10px}
.dsh-bd-btn{display:inline-flex;align-items:center;height:28px;padding:0 12px;border-radius:999px;corner-shape:round;
  border:0.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;cursor:pointer;transition:background .15s ease,color .15s ease}
.dsh-bd-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-bd-btn:disabled{opacity:.5;cursor:default}
.dsh-bd-stamp{margin-left:auto;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.dsh-bd-note{margin:0;padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.55;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.dsh-bd-note[data-tone="error"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);
  color:var(--dsw-alias-state-error-primary)}
.dsh-bd-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0;font-size:12px}
.dsh-bd-kv dt{color:var(--dsw-alias-label-tertiary)}
.dsh-bd-kv dd{margin:0;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;word-break:break-all}
`

    /** Clamp a number into an inclusive domain, falling back to `fallback`. */
    function clamp(value, domain, fallback) {
      const number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(domain.max, Math.max(domain.min, number))
    }

    /** True for a plain object (not null, not an array) — the shape a stored section must have. */
    function isPlainRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /**
     * Resolve a stored section into the full settings shape. The settings
     * document can be hand-edited, so every path is clamped rather than trusted.
     * @param value - a plain section candidate, or anything else.
     */
    function resolveSettings(value) {
      const source = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
      const text = (candidate, fallback) => (
        typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : fallback
      )
      const flag = (candidate, fallback) => (typeof candidate === 'boolean' ? candidate : fallback)
      /** A price is 0 or a positive amount; anything else re-inherits the sentinel. */
      const price = candidate => (Number.isFinite(Number(candidate)) && Number(candidate) > 0
        ? Math.min(PRICE_DOMAIN.max, Number(candidate))
        : 0)
      return {
        enabled: flag(source.enabled, DEFAULTS.enabled),
        refreshSeconds: clamp(source.refreshSeconds, REFRESH_DOMAIN, DEFAULTS.refreshSeconds),
        currency: typeof source.currency === 'string' ? source.currency.trim() : DEFAULTS.currency,
        baseUrl: text(source.baseUrl, DEFAULTS.baseUrl),
        apiKeyEnv: text(source.apiKeyEnv, DEFAULTS.apiKeyEnv),
        timeoutMs: clamp(source.timeoutMs, TIMEOUT_DOMAIN, DEFAULTS.timeoutMs),
        costEnabled: flag(source.costEnabled, DEFAULTS.costEnabled),
        costUnit: typeof source.costUnit === 'string' && source.costUnit.trim().length > 0
          ? source.costUnit.trim()
          : DEFAULTS.costUnit,
        costPeakAware: flag(source.costPeakAware, DEFAULTS.costPeakAware),
        costPriceCacheHit: price(source.costPriceCacheHit),
        costPriceCacheMiss: price(source.costPriceCacheMiss),
        costPriceOutput: price(source.costPriceOutput),
      }
    }

    /**
     * Resolve one scope snapshot into the settings shape.
     *
     * `snapshot.value` is the host's RESOLVED section, and the raw user layer is
     * merged on top: a field this build knows but the HOST's schema does not yet
     * — a plugin update whose `index.js` has not been reloaded — is absent from
     * `value`, and reading only `value` would snap that control back to this
     * file's default while the stored override sat unused in the document.
     * @param snapshot - a settings-scope snapshot, or anything else.
     */
    function fromSnapshot(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object' || snapshot.status !== 'ready') return resolveSettings(undefined)
      const user = snapshot.user
      const overrides = typeof user === 'object' && user !== null && !Array.isArray(user) ? user : {}
      return resolveSettings({ ...snapshot.value, ...overrides })
    }

    /**
     * Pick the balance entry to display.
     *
     * The provider returns `balance_infos` for every currency the account holds,
     * and the ORDER IS NOT STABLE between calls (a documented upstream
     * complaint), so "just take the first" makes the box flip between currencies
     * at random. Preference order: the currency the user configured, then a
     * currency that actually holds money, then CNY, then the first entry.
     */
    function pickInfo(balance, preferred) {
      const infos = Array.isArray(balance?.infos) ? balance.infos : []
      const list = infos.filter(info => info !== null && typeof info === 'object')
      if (list.length === 0) return undefined
      const code = info => (typeof info.currency === 'string' ? info.currency.toUpperCase() : '')
      const want = typeof preferred === 'string' ? preferred.trim().toUpperCase() : ''
      if (want.length > 0) {
        const match = list.find(info => code(info) === want)
        if (match !== undefined) return match
      }
      const funded = list.filter(info => Number(info.total) > 0)
      const cnyFirst = entries => entries.find(info => code(info) === 'CNY')
      return cnyFirst(funded) ?? funded[0] ?? cnyFirst(list) ?? list[0]
    }

    /**
     * Render one amount with its currency glyph; `''` when there is nothing to
     * show. Used for the total and for the granted / topped-up breakdown, which
     * the provider sends as bare strings with no symbol of their own.
     */
    function amountText(info, amount) {
      const text = typeof amount === 'string' ? amount.trim() : ''
      if (text.length === 0) return ''
      const code = typeof info?.currency === 'string' ? info.currency.toUpperCase() : ''
      const symbol = CURRENCY_SYMBOLS[code]
      if (symbol !== undefined) return `${symbol}${text}`
      return code.length > 0 ? `${text} ${code}` : text
    }

    /** The headline amount of one balance entry. */
    function moneyText(info) {
      return info === undefined ? '' : amountText(info, info.total)
    }

    /* ── Session cost ────────────────────────────────────────────────────── */

    /**
     * DeepSeek's official OFF-PEAK CNY list price, per 1,000,000 tokens, as of
     * the September 2026 tariff. The peak tier is exactly double this.
     *
     * `cacheHit` prices cache READS and cache WRITES alike: DeepSeek quotes no
     * separate write price and bills those tokens at the hit rate. There is no
     * reasoning rate either — reasoning tokens are already inside
     * `outputTokens`, so adding them again would double-charge.
     *
     * Every current official model (`deepseek-flash`, `deepseek-v4-pro`) shares
     * this tariff, so one table serves them all. The Settings page overrides it
     * individually if DeepSeek changes prices.
     */
    const DEEPSEEK_OFFPEAK_CNY = { cacheHit: 0.02, cacheMiss: 1, output: 4 }

    /**
     * Peak windows as UTC hours, half-open `[start, end)`: 01:00-04:00 and
     * 06:00-10:00 UTC, which is 09:00-12:00 and 14:00-18:00 in Beijing.
     */
    const PEAK_WINDOWS_UTC = [[1, 4], [6, 10]]

    /**
     * Beijing wall-clock weekday without a timezone database: Beijing is UTC+8
     * with no daylight saving, so shifting the instant and reading the UTC
     * fields yields the Beijing calendar.
     */
    function beijingWeekday(atMs) {
      return new Date(atMs + 8 * 3_600_000).getUTCDay()
    }

    /**
     * Whether one instant is billed at the peak tier.
     *
     * Weekends are entirely off-peak, and that rule OUTRANKS the windows: since
     * Beijing 2026-08-23 DeepSeek no longer distinguishes tiers on Saturdays and
     * Sundays.
     */
    function isPeakMoment(atMs) {
      const weekday = beijingWeekday(atMs)
      if (weekday === 0 || weekday === 6) return false
      const hour = new Date(atMs).getUTCHours()
      return PEAK_WINDOWS_UTC.some(([start, end]) => hour >= start && hour < end)
    }

    /** Both price tiers in force, with any off-peak override applied. */
    function resolvePrices(settings) {
      const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)
      const offPeak = {
        cacheHit: positive(settings.costPriceCacheHit, DEEPSEEK_OFFPEAK_CNY.cacheHit),
        cacheMiss: positive(settings.costPriceCacheMiss, DEEPSEEK_OFFPEAK_CNY.cacheMiss),
        output: positive(settings.costPriceOutput, DEEPSEEK_OFFPEAK_CNY.output),
      }
      // DeepSeek publishes the peak tier as exactly double, so overriding the
      // base rate keeps that relationship rather than letting the two drift.
      const peak = {
        cacheHit: offPeak.cacheHit * 2,
        cacheMiss: offPeak.cacheMiss * 2,
        output: offPeak.output * 2,
      }
      return { offPeak, peak }
    }

    /** One token bucket, tolerating an absent or malformed figure. */
    function tokensOf(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
    }

    /**
     * The whole session's cost.
     *
     * Token TOTALS come from the `tokenUsage` projection — the same durable,
     * complete figure DSH's own token pill and dialog print — so the money can
     * never disagree with the token count shown right beside it. The per-turn
     * nodes supply only the peak/off-peak WEIGHTING: each completed turn adds its
     * token count to the peak share when it ran inside a peak window.
     *
     * Summing per-turn `tokenUsage` as the total is NOT safe, which is how a
     * 96M-token session first read as ¥0.24. A turn's `tokenUsage` is "absent when
     * the loaded evidence is incomplete", and inside it the cache buckets are
     * optional ("present only when every attempt reported the bucket") — so a
     * per-turn sum silently drops whole turns, and for the ones it keeps it can
     * drop the entire cached prompt, which is 99.7% of a cache-heavy session.
     *
     * Because the peak tier is exactly 2× the off-peak tier, weighting by time
     * collapses to a single multiplier: `1 + peakShare`.
     *
     * @param nodes - Chat nodes, used only for the timing weights.
     * @param usage - the session's `tokenUsage` projection.
     * @param settings - resolved plugin settings.
     * @returns the amount, or `undefined` when nothing has been billed yet.
     */
    function sessionCost(nodes, usage, settings) {
      if (usage === null || typeof usage !== 'object') return undefined
      const uncached = tokensOf(usage.uncachedInputTokens)
      const output = tokensOf(usage.outputTokens)
      // Reads and writes bill alike, so the two cache buckets share one rate.
      const cached = tokensOf(usage.cacheReadTokens) + tokensOf(usage.cacheWriteTokens)
      if (uncached + cached + output <= 0) return undefined

      let peakWeight = 0
      let totalWeight = 0
      if (settings.costPeakAware && Array.isArray(nodes)) {
        for (const node of nodes) {
          if (node === null || typeof node !== 'object' || node.kind !== 'turn-tail') continue
          const turn = node.data?.tokenUsage
          if (turn === undefined || turn === null) continue
          const weight = tokensOf(turn.totalTokens)
          if (weight <= 0) continue
          totalWeight += weight
          const at = typeof node.data.time === 'number' ? node.data.time : Date.now()
          if (isPeakMoment(at)) peakWeight += weight
        }
      }
      // A session whose turns carry no usable timing is priced wholly off-peak
      // rather than at whatever tier the clock happens to sit in: the figure must
      // not move on its own, without any usage to justify it.
      const peakShare = totalWeight > 0 ? peakWeight / totalWeight : 0

      const prices = resolvePrices(settings)
      return (1 + peakShare) * (
        uncached * prices.offPeak.cacheMiss
        + cached * prices.offPeak.cacheHit
        + output * prices.offPeak.output
      ) / 1_000_000
    }

    /**
     * The money text: two decimals, which is what a normal session reads as. A
     * sub-cent session keeps four so it does not collapse into a flat `0.00`.
     */
    function formatCost(value) {
      if (!Number.isFinite(value) || value <= 0) return '0.00'
      return value < 0.01 ? value.toFixed(4) : value.toFixed(2)
    }

    /** The box's own glyph: a bank card, sized to the 16px icon seat. */
    function BalanceIcon({ size }) {
      return h('svg', {
        className: 'dsh-bd-icon',
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('rect', {
          x: 1.9, y: 3.8, width: 12.2, height: 8.4, rx: 2.2,
          stroke: 'currentColor', strokeWidth: 1.3,
        }),
        h('path', { d: 'M1.9 6.6h12.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M10.3 9.7h2.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      )
    }

    /**
     * The display settings store.
     *
     * DSH 0.1.7 removed the `settingsScope` client service: settings now derive
     * from each plugin entry's own `Config` schema, which this package cannot
     * declare (see the server half's `apply`). Everything this side configures is
     * a DISPLAY preference — which readings show, the refresh interval, the money
     * unit, the tariff — so it is stored where a browser preference belongs, in
     * `localStorage`, and the page keeps working with no DSH settings service at
     * all. The server-side knobs (endpoint, credential name, timeout) are not
     * here: they belong to the loader row and are reported read-only by the page.
     *
     * The shape deliberately mirrors the removed settings scope — `getSnapshot`,
     * `subscribe`, `set`, `unset`, `mutate` — so the runtime and the page read it
     * exactly as they read the service it replaces.
     */
    function createLocalSettings() {
      const KEY = 'dsh-balance-display'
      const listeners = new Set()
      let revision = 0
      let value = resolveSettings(readStored())
      /**
       * `useSyncExternalStore` requires a STABLE snapshot reference until
       * something actually changes — returning a fresh object per call makes
       * React re-render forever. So the snapshot is built only here and in
       * {@link publish}.
       */
      let snapshot = build()

      function build() {
        return {
          status: 'ready',
          value,
          base: undefined,
          user: value,
          revision,
          writable: true,
          mode: 'memory',
        }
      }

      function readStored() {
        try {
          const raw = window.localStorage.getItem(KEY)
          if (raw === null) return undefined
          const parsed = JSON.parse(raw)
          return isPlainRecord(parsed) ? parsed : undefined
        } catch {
          // A corrupted or unavailable store must degrade to defaults, never
          // take the plugin down.
          return undefined
        }
      }

      function persist() {
        try {
          window.localStorage.setItem(KEY, JSON.stringify(value))
        } catch {
          // Private-mode or quota failures leave the in-memory value standing.
        }
      }

      function publish() {
        revision += 1
        snapshot = build()
        for (const listener of [...listeners]) listener()
      }

      function apply(ops) {
        const next = { ...value }
        for (const op of ops) {
          const field = Array.isArray(op.path) ? op.path[0] : undefined
          if (typeof field !== 'string') continue
          if (op.op === 'set') next[field] = op.value
          else delete next[field]
        }
        value = resolveSettings(next)
        persist()
        publish()
      }

      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (field, next) => { apply([{ op: 'set', path: [field], value: next }]); return Promise.resolve(true) },
        unset: (field) => { apply([{ op: 'unset', path: [field] }]); return Promise.resolve(true) },
        mutate: (ops) => { apply(ops); return Promise.resolve(true) },
      }
    }

    /**
     * The polling runtime: the settings store, the last balance answer, and the
     * one timer both the box and the Settings page read. Created once per plugin
     * lifetime.
     * @param scope - the display settings store.
     */
    function createRuntime(scope) {
      let snapshot = {
        settings: resolveSettings(undefined),
        /** 'loading' before the first answer, then 'ready' or 'error'. */
        phase: 'loading',
        result: undefined,
        refreshing: false,
      }
      const listeners = new Set()
      let timer = null
      let disposed = false
      /** Monotonic guard: only the newest in-flight fetch may publish. */
      let generation = 0

      const emit = (patch) => {
        snapshot = { ...snapshot, ...patch }
        for (const listener of [...listeners]) listener()
      }

      function stopTimer() {
        if (timer === null) return
        window.clearInterval(timer)
        timer = null
      }

      function schedule() {
        stopTimer()
        if (disposed || !snapshot.settings.enabled || document.hidden) return
        timer = window.setInterval(() => { void load(false) }, snapshot.settings.refreshSeconds * 1_000)
      }

      async function load(force) {
        if (disposed) return
        const current = ++generation
        emit({ refreshing: true })
        let result
        try {
          const response = await fetch(force ? `${STATE_ROUTE}?refresh=1` : STATE_ROUTE, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          result = await response.json()
        } catch (error) {
          result = {
            ok: false,
            error: { code: 'transport', message: `无法请求本地服务端：${error instanceof Error ? error.message : String(error)}` },
          }
        }
        if (disposed || current !== generation) return
        emit({ phase: result !== undefined && result.ok === true ? 'ready' : 'error', result, refreshing: false })
      }

      /**
       * Re-read the settings document and republish it when it moved.
       *
       * EVERY field is compared, deliberately. Hand-enumerating them is how
       * `costEnabled` came to be missed: switching the cost pill off wrote the
       * document but never reached the runtime, so the pill stayed on screen. A
       * new field is now picked up by merely existing.
       */
      function syncSettings() {
        const next = fromSnapshot(scope.getSnapshot())
        const previous = snapshot.settings
        // Every resolved value is a primitive, so identity comparison is exact.
        const moved = Object.keys(next).filter(key => next[key] !== previous[key])
        if (moved.length === 0) return
        emit({ settings: next })
        // Only these two are read by the timer, so only they rebuild it.
        if (moved.includes('enabled') || moved.includes('refreshSeconds')) schedule()
        // Re-enabling after a spell off: the cached answer is long gone, so fetch
        // now instead of leaving the box stale for a whole interval.
        if (next.enabled && !previous.enabled) void load(false)
      }

      /** A hidden tab must not keep polling the provider. */
      function onVisibility() {
        if (document.hidden) {
          stopTimer()
          return
        }
        void load(false)
        schedule()
      }

      return {
        /** Bound reader for `useSyncExternalStore` (never pass the scope's own methods). */
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot: () => snapshot,
        /** Bound readers for the Settings page's own `useSyncExternalStore`. */
        subscribeScope: listener => scope.subscribe(listener),
        getScopeSnapshot: () => scope.getSnapshot(),
        load,
        start() {
          const offSettings = scope.subscribe(syncSettings)
          syncSettings()
          document.addEventListener('visibilitychange', onVisibility)
          void load(false)
          schedule()
          return () => {
            disposed = true
            stopTimer()
            document.removeEventListener('visibilitychange', onVisibility)
            offSettings()
          }
        },
      }
    }

    /** Seconds since a timestamp, rendered compactly for the tooltip. */
    function agoText(timestamp, t) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return t('statusNever')
      const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000))
      if (seconds < 60) return t('ago', { seconds })
      return t('minutesAgo', { minutes: Math.round(seconds / 60) })
    }

    /**
     * Re-render once a second while `active`, so a RELATIVE timestamp stays true.
     *
     * {@link agoText} is only correct at the instant it is rendered, and neither
     * surface that shows it re-renders on its own between polls — the value would
     * otherwise freeze at whatever it said when the surface appeared. This is a
     * hook rather than two inline timers because it was forgotten once already, and
     * a second copy is how it gets forgotten again.
     *
     * @param active - whether to tick; the caller passes its own visibility.
     */
    function useSecondTick(active) {
      const [, setTick] = useState(0)
      useEffect(() => {
        if (active === false) return undefined
        const id = window.setInterval(() => { setTick(tick => tick + 1) }, 1_000)
        return () => { window.clearInterval(id) }
      }, [active])
    }

    /** The label the box shows, and whether it represents a failure. */
    function displayFor(snapshot, t) {
      if (snapshot.phase === 'loading') return { text: '—', state: 'loading' }
      const result = snapshot.result
      if (result === undefined || result.ok !== true) {
        const code = result?.error?.code
        // A missing credential is actionable and stable, so it gets words; every
        // other failure is transient and stays a dash, with the reason on hover.
        if (code === 'no-credential') return { text: t('noKey'), state: 'error' }
        return { text: '—', state: 'error' }
      }
      const info = pickInfo(result.balance, snapshot.settings.currency)
      const text = moneyText(info)
      if (text.length === 0) return { text: '—', state: 'error' }
      return { text, state: 'ready', info, low: result.balance?.isAvailable === false }
    }

    /**
     * The hover/focus preview card.
     *
     * Replaces the browser's native `title` bubble, which cannot be styled, is
     * slow to appear, and renders the whole detail as one undifferentiated line.
     * This card is a real DSH surface: a fixed-position box (fixed positioning is
     * what lets it escape the sidebar's overflow clipping, exactly as DSH's own
     * Tooltip does) carrying the l2 ground and the theme's prominent elevation.
     *
     * It opens to the RIGHT of the box — outward from the sidebar — vertically
     * centred on it, then clamps inside the viewport. Position is measured in a
     * layout effect, so it is placed before the browser paints and never flashes
     * at the viewport origin.
     *
     * @param props.anchorRef - the sidebar box the card is anchored to.
     * @param props.open - whether the card is showing.
     * @param props.snapshot - the runtime snapshot.
     * @param props.t - translator.
     */
    function BalanceCard({ anchorRef, open, snapshot, t }) {
      const cardRef = useRef(null)
      const [pos, setPos] = useState(null)
      // The footer's freshness reading is relative, so it needs a clock of its own
      // while the card is open.
      useSecondTick(open)

      useLayoutEffect(() => {
        if (!open) {
          setPos(null)
          return
        }
        const place = () => {
          const anchor = anchorRef.current
          const card = cardRef.current
          if (anchor === null || card === null) return
          const rect = anchor.getBoundingClientRect()
          const width = card.offsetWidth
          const height = card.offsetHeight
          const margin = 8
          const gap = 10
          const left = Math.max(margin, Math.min(rect.right + gap, window.innerWidth - width - margin))
          const top = Math.max(margin, Math.min(rect.top + rect.height / 2 - height / 2, window.innerHeight - height - margin))
          setPos({ left, top })
        }
        place()
        window.addEventListener('resize', place)
        // Capture phase: this also catches scrolling inside the session list's
        // own pane, which does not bubble to window.
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open, anchorRef])

      if (!open) return null

      const result = snapshot.result
      const failed = snapshot.phase !== 'loading' && (result === undefined || result.ok !== true)
      const info = result?.ok === true ? pickInfo(result.balance, snapshot.settings.currency) : undefined
      const code = typeof info?.currency === 'string' ? info.currency.toUpperCase() : ''
      const amount = moneyText(info)
      const low = result?.ok === true && result.balance?.isAvailable === false

      const children = [
        h('div', { className: 'dsh-bd-floatHead', key: 'head' },
          h('span', { className: 'dsh-bd-floatLabel' }, t('balanceLabel')),
          code.length > 0 ? h('span', { className: 'dsh-bd-floatCode' }, code) : null,
        ),
        h('div', { className: 'dsh-bd-floatAmount', key: 'amount' },
          h('span', { className: 'dsh-bd-floatValue' }, failed ? '—' : amount.length > 0 ? amount : '—'),
        ),
      ]

      if (failed) {
        const message = result?.error?.message
        if (typeof message === 'string' && message.length > 0) {
          children.push(h('p', { className: 'dsh-bd-floatError', key: 'error' }, message))
        }
      }

      // The breakdown only earns its divider when it actually has a row.
      const rows = []
      if (!failed && info !== undefined) {
        if (typeof info.granted === 'string' && info.granted.length > 0) {
          rows.push(h('div', { className: 'dsh-bd-floatRow', key: 'granted' },
            h('span', null, t('granted')),
            h('span', null, amountText(info, info.granted)),
          ))
        }
        if (typeof info.toppedUp === 'string' && info.toppedUp.length > 0) {
          rows.push(h('div', { className: 'dsh-bd-floatRow', key: 'toppedUp' },
            h('span', null, t('toppedUp')),
            h('span', null, amountText(info, info.toppedUp)),
          ))
        }
      }
      if (rows.length > 0) children.push(h('div', { className: 'dsh-bd-floatRows', key: 'rows' }, ...rows))

      const foot = []
      if (failed) foot.push(t('errorTitle'))
      else if (result?.ok === true) {
        foot.push(`${t('statusUpdated')}: ${agoText(result.balance?.fetchedAt, t)}`)
        // The warn tone needs a reason next to it, or it just looks arbitrary.
        if (low) foot.push(t('unavailableBalance'))
      } else foot.push(t('statusNever'))
      foot.push(snapshot.refreshing ? t('refreshing') : t('clickToRefresh'))
      // One wrapping line rather than adjacent spans: the warning makes this
      // three items, and a fixed flex row would either clip or crowd them.
      children.push(h('div', {
        className: 'dsh-bd-floatFoot',
        key: 'foot',
        'data-tone': low ? 'warn' : undefined,
      }, foot.join(' · ')))

      return h('div', {
        ref: cardRef,
        className: 'dsh-bd-float',
        role: 'tooltip',
        // Placed by the layout effect; hidden until then so the first paint
        // cannot show it at the viewport origin.
        style: pos === null ? { visibility: 'hidden' } : { left: `${pos.left}px`, top: `${pos.top}px` },
      }, ...children)
    }

    /**
     * The sidebar box. Rendered from the shared runtime, so a click and the
     * timer go through exactly the same path. Hover and keyboard focus both open
     * the preview card; the card is pinned while a KEYBOARD focus holds it, but
     * not after a mouse click, which would otherwise leave it stuck open until
     * the user clicked elsewhere.
     */
    function BalanceBox({ wide, runtime, t }) {
      const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
      const [open, setOpen] = useState(false)
      const anchorRef = useRef(null)
      // Hover and focus are independent triggers, so moving the pointer off a
      // still-focused box must not close the card.
      const triggers = useRef({ hover: false, focus: false })
      const sync = () => { setOpen(triggers.current.hover || triggers.current.focus) }

      const { text, state, low } = displayFor(snapshot, t)
      if (!snapshot.settings.enabled) return null

      const failed = state === 'error' && snapshot.phase !== 'loading'
      const ariaLabel = failed
        ? `${t('balanceLabel')}: ${t('errorTitle')} ${snapshot.result?.error?.message ?? ''}`
        : `${t('balanceLabel')}: ${text}`

      return h(React.Fragment, null,
        h('button', {
          ref: anchorRef,
          type: 'button',
          className: 'dsh-bd-box',
          'data-rail': wide ? undefined : 'true',
          'data-state': state,
          'data-low': low === true ? 'true' : undefined,
          'data-refreshing': snapshot.refreshing ? 'true' : undefined,
          'aria-label': ariaLabel,
          'aria-describedby': undefined,
          onMouseEnter: () => { triggers.current.hover = true; sync() },
          onMouseLeave: () => { triggers.current.hover = false; sync() },
          onFocus: (event) => {
            // A click focuses the button too. Only a keyboard focus pins the
            // card open; otherwise it would linger after a refresh click.
            const element = event.currentTarget
            triggers.current.focus = typeof element.matches === 'function' && element.matches(':focus-visible')
            sync()
          },
          onBlur: () => { triggers.current.focus = false; sync() },
          onKeyDown: (event) => {
            if (event.key !== 'Escape') return
            triggers.current = { hover: false, focus: false }
            sync()
          },
          onClick: () => { void runtime.load(true) },
        },
          h(BalanceIcon, { size: wide ? 16 : 18 }),
          wide ? h('span', { className: 'dsh-bd-label' }, text) : null,
        ),
        h(BalanceCard, { anchorRef, open, snapshot, t }),
      )
    }

    /**
     * The cost pill's glyph: a coin struck with a ¥, sized to the 14px seat the
     * sibling pills give their own icons.
     */
    function CostIcon() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('circle', { cx: 8, cy: 8, r: 6.2, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', {
          d: 'M5.8 5.5 8 8.6l2.2-3.1',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8 8.6v2.7', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M6.2 9.8h3.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      )
    }

    /**
     * The session-cost pill — the FOURTH reading in the composer dock.
     *
     * It registers on `conversation.composer.dock`, the same list slot ui-chat's
     * stats pills and the ContextMeter occupy, so it joins that row as an equal.
     * The stylesheet copies the row's own pill geometry (see `.dsh-bd-cost`).
     *
     * Cost combines two sources, each used for what it is actually complete for:
     * the `tokenUsage` projection supplies the token TOTALS (so the money always
     * reconciles with the token count printed beside it), and the per-turn Chat
     * nodes supply the peak/off-peak WEIGHTING (the projection carries no
     * timestamps). See {@link sessionCost}.
     *
     * `useChat` and `useProjection` arrive as standard slot props — they are what
     * ui-chat's own pills read; `runtime` and `t` ride the inject face.
     */
    function CostSuffix({ useChat, useProjection, runtime, t }) {
      /**
       * `legacy.nodes` is the WRONG source here: ui-chat's `legacyContribution`
       * returns an empty contribution for `turn-tail` rows on purpose ("known
       * Chat rows intentionally make no legacy timeline contribution"), so the
       * compatibility slice never carries them and reading it yields no billable
       * turn at all. The node store carries every materialized Chat row,
       * turn-tails included, and caches its array — so the `useMemo` below still
       * sees a stable identity between real changes.
       */
      const nodes = useChat(state => state?.nodes?.values())
      /**
       * The token totals come from the projection DSH itself prints beside this
       * pill, so the two can never disagree.
       */
      const usage = useProjection('tokenUsage')
      // `settings` is a stable object per settings snapshot, and the memo lists
      // every field the pricing reads, so an unrelated change cannot stale it.
      const settings = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot).settings
      const cost = useMemo(() => sessionCost(nodes, usage, settings), [
        nodes,
        usage,
        settings.costPeakAware,
        settings.costPriceCacheHit,
        settings.costPriceCacheMiss,
        settings.costPriceOutput,
      ])
      /**
       * A pill that stays silent because a source shape moved is impossible to
       * diagnose from the UI — that is exactly how the `legacy.nodes` mistake went
       * unnoticed. Say it once in the console when the harness reports billing but
       * the cost still cannot be computed.
       */
      const reported = useRef(false)
      useEffect(() => {
        if (reported.current || !settings.costEnabled || cost !== undefined) return
        if (usage === undefined || usage === null) return
        reported.current = true
        console.warn('[dsh-balance-display] tokenUsage carried no billable buckets; the session cost cannot be computed')
      }, [cost, usage, settings.costEnabled])
      // Nothing to price until a turn settles with recorded usage.
      if (!settings.costEnabled || cost === undefined) return null
      // One space between the amount and the unit, joined here rather than baked
      // into the default unit: a stored `yuan` predating this must pick the space
      // up too, and any unit reads the same way.
      const money = `${formatCost(cost)} ${settings.costUnit}`
      return h('span', {
        className: 'dsh-bd-cost',
        'aria-label': `${t('costLabel')}: ${money}`,
      },
        h(CostIcon, null),
        h('span', null, money),
      )
    }

    /** One labelled slider row. */
    function Slider({ label, hint, value, domain, unit, disabled, onChange, format }) {
      return h('div', { className: 'dsh-bd-row' },
        h('div', { className: 'dsh-bd-rowHead' },
          h('span', { className: 'dsh-bd-label' }, label),
          h('span', { className: 'dsh-bd-value' }, format(value)),
        ),
        h('input', {
          className: 'dsh-bd-range',
          type: 'range',
          min: domain.min,
          max: domain.max,
          step: unit,
          value: Math.round(value),
          disabled: disabled === true,
          'aria-label': label,
          onChange: (event) => { onChange(Number(event.currentTarget.value)) },
        }),
        hint === undefined ? null : h('p', { className: 'dsh-bd-hint' }, hint),
      )
    }

    /**
     * A free-text row that commits on blur or Enter. Committing per keystroke
     * would write a half-typed URL — or a half-typed credential name — into the
     * settings document on every key press.
     */
    function TextRow({ label, hint, value, disabled, placeholder, note, onCommit }) {
      const [draft, setDraft] = useState(value)
      // Re-sync when the document itself moves (a reset, or another window),
      // but never while this input is being edited.
      const focused = useRef(false)
      useEffect(() => { if (!focused.current) setDraft(value) }, [value])
      const commit = () => {
        if (draft === value) return
        onCommit(draft)
      }
      return h('div', { className: 'dsh-bd-row' },
        h('div', { className: 'dsh-bd-rowHead' },
          h('span', { className: 'dsh-bd-label' }, label),
          note === undefined || note.length === 0 ? null : h('span', { className: 'dsh-bd-value' }, note),
        ),
        h('input', {
          className: 'dsh-bd-text',
          type: 'text',
          value: draft,
          disabled: disabled === true,
          placeholder,
          'aria-label': label,
          spellCheck: false,
          onFocus: () => { focused.current = true },
          onChange: (event) => { setDraft(event.currentTarget.value) },
          onBlur: () => { focused.current = false; commit() },
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.currentTarget.blur()
          },
        }),
        hint === undefined ? null : h('p', { className: 'dsh-bd-hint' }, hint),
      )
    }

    /**
     * The Settings page. A change stages locally first so the control never lags
     * the drag, then writes the whole field through the settings scope.
     */
    function BalanceSettings({ runtime, t }) {
      // The status card shows a relative freshness reading, so the page needs its
      // own clock too. The section only mounts while the panel is open, so no
      // visibility guard is needed.
      useSecondTick(true)
      const scopeSnapshot = useSyncExternalStore(runtime.subscribeScope, runtime.getScopeSnapshot, runtime.getScopeSnapshot)
      const live = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
      const value = fromSnapshot(scopeSnapshot)
      const locked = scopeSnapshot.status !== 'ready' || scopeSnapshot.writable === false
      /** Values staged by an in-flight edit, which outrank the document until it agrees. */
      const [staged, setStaged] = useState({})

      /** A staged value when one is in flight, else the value the document holds. */
      const shown = (field) => (staged[field] === undefined ? value[field] : staged[field])
      const write = (field, next) => {
        setStaged(previous => ({ ...previous, [field]: next }))
        const scope = runtime.getScope()
        void Promise.resolve(scope.set(field, next)).catch(() => {})
      }
      /**
       * One unit-price row. The document stores a NUMBER where 0 means "use the
       * built-in tariff", so the field shows blank in that case and an empty or
       * unparseable entry writes the sentinel back rather than a NaN.
       */
      const priceRow = (field, label, fallback) => h(TextRow, {
        key: field,
        label,
        note: t('priceSuffix'),
        value: shown(field) > 0 ? String(shown(field)) : '',
        disabled: locked,
        placeholder: String(fallback),
        onCommit: (next) => {
          const parsed = Number(next.trim())
          write(field, Number.isFinite(parsed) && parsed > 0 ? Math.min(PRICE_DOMAIN.max, parsed) : 0)
        },
      })
      // A staged value drops as soon as the committed document agrees with it.
      useEffect(() => {
        setStaged((previous) => {
          const next = { ...previous }
          let changed = false
          for (const field of Object.keys(next)) {
            if (value[field] === next[field]) { delete next[field]; changed = true }
          }
          return changed ? next : previous
        })
      }, [value.enabled, value.refreshSeconds, value.currency, value.baseUrl, value.apiKeyEnv, value.timeoutMs,
        value.costEnabled, value.costUnit, value.costPeakAware,
        value.costPriceCacheHit, value.costPriceCacheMiss, value.costPriceOutput])

      const result = live.result
      // What the server actually used, which is the authoritative answer for a
      // blank (inherited) field. Falls back to this side's own resolution before
      // the first answer lands.
      const source = result?.source
      const effectiveBaseUrl = source?.baseUrl ?? (value.baseUrl.length > 0 ? value.baseUrl : FALLBACK_BASE_URL)
      const effectiveKeyEnv = source?.apiKeyEnv ?? (value.apiKeyEnv.length > 0 ? value.apiKeyEnv : FALLBACK_API_KEY_ENV)
      /** Locale suffix per origin marker; an unrecognized one (a credential backend name like `file`) shows verbatim. */
      const SOURCE_SUFFIX = { plugin: 'Plugin', provider: 'Provider', environment: 'Environment', default: 'Default' }
      const annotate = (prefix, kind) => {
        const suffix = SOURCE_SUFFIX[kind]
        if (suffix === undefined) return typeof kind === 'string' && kind.length > 0 ? kind : ''
        return t(`${prefix}${suffix}`)
      }
      const endpointNote = annotate('endpoint', source?.endpointSource)
      const credentialNote = annotate('credential', source?.credentialSource)

      const statusText = live.refreshing
        ? t('refreshing')
        : result?.ok === true
          ? moneyText(pickInfo(result.balance, live.settings.currency))
          : result?.error?.code === 'no-credential' ? t('noKey') : '—'

      let notice
      if (scopeSnapshot.status === 'unavailable') notice = t('unavailable')
      else if (scopeSnapshot.status === 'loading') notice = t('loading')

      return h('div', { className: 'dsh-bd-page' },
        h('h2', { className: 'dsh-bd-title' }, t('title')),
        h('p', { className: 'dsh-bd-intro' }, t('intro')),
        notice === undefined ? null : h('p', { className: 'dsh-bd-note' }, notice),

        h('section', { className: 'dsh-bd-section' },
          h('div', { className: 'dsh-bd-sectionHead' }, t('groupDisplay')),
          h('div', { className: 'dsh-bd-card' },
            h('div', { className: 'dsh-bd-switchRow' },
              h('span', { className: 'dsh-bd-label' }, t('enabled')),
              h('div', { className: 'dsh-bd-seg' },
                h('button', {
                  type: 'button',
                  'data-active': shown('enabled') === true ? '' : undefined,
                  disabled: locked,
                  onClick: () => { write('enabled', true) },
                }, t('on')),
                h('button', {
                  type: 'button',
                  'data-active': shown('enabled') === true ? undefined : '',
                  disabled: locked,
                  onClick: () => { write('enabled', false) },
                }, t('off')),
              ),
            ),
            h(Slider, {
              label: t('interval'),
              hint: t('intervalHint'),
              value: shown('refreshSeconds'),
              domain: REFRESH_DOMAIN,
              unit: 5,
              disabled: locked,
              format: seconds => `${Math.round(seconds)} s`,
              onChange: next => { write('refreshSeconds', next) },
            }),
            h(TextRow, {
              label: t('currency'),
              hint: t('currencyHint'),
              value: shown('currency'),
              disabled: locked,
              placeholder: 'CNY',
              onCommit: next => { write('currency', next.trim()) },
            }),
          ),
        ),

        h('section', { className: 'dsh-bd-section' },
          h('div', { className: 'dsh-bd-sectionHead' }, t('groupSource')),
          h('div', { className: 'dsh-bd-card' },
            // Read-only by design. These three are SERVER knobs, resolved from the
            // plugin's loader-row config (the profile patch) and reported back by
            // the route; a control here could not persist them and would be a lie.
            h('dl', { className: 'dsh-bd-kv' },
              h('dt', null, t('endpoint')),
              h('dd', null, effectiveBaseUrl),
              h('dt', null, t('credential')),
              h('dd', null, effectiveKeyEnv),
            ),
            h('p', { className: 'dsh-bd-hint' }, t('serverHint')),
          ),
        ),

        h('section', { className: 'dsh-bd-section' },
          h('div', { className: 'dsh-bd-sectionHead' }, t('groupCost')),
          h('div', { className: 'dsh-bd-card' },
            h('p', { className: 'dsh-bd-hint' }, t('costNote')),
            h('div', { className: 'dsh-bd-switchRow' },
              h('span', { className: 'dsh-bd-label' }, t('costEnabled')),
              h('div', { className: 'dsh-bd-seg' },
                h('button', {
                  type: 'button',
                  'data-active': shown('costEnabled') === true ? '' : undefined,
                  disabled: locked,
                  onClick: () => { write('costEnabled', true) },
                }, t('on')),
                h('button', {
                  type: 'button',
                  'data-active': shown('costEnabled') === true ? undefined : '',
                  disabled: locked,
                  onClick: () => { write('costEnabled', false) },
                }, t('off')),
              ),
            ),
            h(TextRow, {
              label: t('costUnit'),
              hint: t('costUnitHint'),
              value: shown('costUnit'),
              disabled: locked,
              placeholder: DEFAULTS.costUnit,
              onCommit: next => { write('costUnit', next.trim()) },
            }),
            h('div', { className: 'dsh-bd-switchRow' },
              h('span', { className: 'dsh-bd-label' }, t('costPeakAware')),
              h('div', { className: 'dsh-bd-seg' },
                h('button', {
                  type: 'button',
                  'data-active': shown('costPeakAware') === true ? '' : undefined,
                  disabled: locked,
                  onClick: () => { write('costPeakAware', true) },
                }, t('switchOn')),
                h('button', {
                  type: 'button',
                  'data-active': shown('costPeakAware') === true ? undefined : '',
                  disabled: locked,
                  onClick: () => { write('costPeakAware', false) },
                }, t('switchOff')),
              ),
            ),
            h('p', { className: 'dsh-bd-hint' }, t('costPeakAwareHint')),
            priceRow('costPriceCacheHit', t('priceCacheHit'), DEEPSEEK_OFFPEAK_CNY.cacheHit),
            priceRow('costPriceCacheMiss', t('priceCacheMiss'), DEEPSEEK_OFFPEAK_CNY.cacheMiss),
            priceRow('costPriceOutput', t('priceOutput'), DEEPSEEK_OFFPEAK_CNY.output),
            h('p', { className: 'dsh-bd-hint' }, t('priceHint')),
          ),
        ),

        h('section', { className: 'dsh-bd-section' },
          h('div', { className: 'dsh-bd-sectionHead' }, t('status')),
          h('div', { className: 'dsh-bd-card' },
            h('dl', { className: 'dsh-bd-kv' },
              h('dt', null, t('status')),
              h('dd', null, statusText),
              h('dt', null, t('statusEndpoint')),
              h('dd', null, `${effectiveBaseUrl}${endpointNote.length > 0 ? ` (${endpointNote})` : ''}`),
              h('dt', null, t('statusKey')),
              h('dd', null, `${effectiveKeyEnv}${credentialNote.length > 0 ? ` (${credentialNote})` : ''}`),
              h('dt', null, t('statusUpdated')),
              h('dd', null, result?.ok === true ? agoText(result.balance?.fetchedAt, t) : t('statusNever')),
            ),
            result !== undefined && result.ok !== true
              ? h('p', { className: 'dsh-bd-note', 'data-tone': 'error' }, `${t('errorTitle')}：${result.error?.message ?? ''}`)
              : null,
            h('div', { className: 'dsh-bd-foot' },
              h('button', {
                type: 'button',
                className: 'dsh-bd-btn',
                onClick: () => { void runtime.load(true) },
              }, t('clickToRefresh')),
              h('button', {
                type: 'button',
                className: 'dsh-bd-btn',
                disabled: locked,
                onClick: () => {
                  setStaged({})
                  const scope = runtime.getScope()
                  void Promise.resolve(scope.mutate(
                    Object.keys(DEFAULTS).map(field => ({ op: 'unset', path: [field] })),
                  )).catch(() => {})
                },
              }, t('reset')),
              h('span', { className: 'dsh-bd-stamp' }, `v${VERSION}`),
            ),
          ),
        ),
      )
    }

    /** Inject the stylesheet once, and only if it is not already mounted. */
    function injectStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.dataset.plugin = 'dsh-balance-display'
      element.dataset.pluginCss = STYLE_ID
      element.textContent = STYLESHEET
      document.head.appendChild(element)
    }

    return {
      // `settingsScope` is deliberately absent: DSH 0.1.7 removed that service,
      // and requiring it would leave the whole client half waiting forever.
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-balance-display: locale')
        const t = ctx.locale.bind(NS)

        injectStyle()

        const scope = createLocalSettings()
        const runtime = createRuntime(scope)
        // Exposed for the Settings page's writes; the store's methods are plain
        // closures, so only this accessor is handed out.
        runtime.getScope = () => scope
        ctx.effect(() => runtime.start(), 'dsh-balance-display: balance polling')

        // `sidebar.footer.action` is declared by ui-sidebar and rendered above
        // the Settings seat; `slots.inject` waits for that declaration rather
        // than assuming apply order. `t` rides the inject face rather than a
        // `locale:` declaration, so the component receives exactly one translator.
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: NS,
          order: 50,
          inject: () => ({ runtime, t }),
        }, BalanceBox))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: NS,
          order: 65,
          label: () => t('nav'),
          inject: () => ({ runtime, t }),
        }, BalanceSettings))

        // The composer dock. ui-chat's stats pills own order 0 there, so this
        // registers after them and reads as a continuation of the token pill.
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: `${NS}-cost`,
          order: 60,
          inject: () => ({ runtime, t }),
        }, CostSuffix))
      },
    }
  },
})
