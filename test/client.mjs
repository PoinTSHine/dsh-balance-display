/**
 * Client-half test for dsh-balance-display.
 *
 * The browser half is a `window.__ModuleLoader__.load({ factory })` module, so
 * this harness supplies the three things that wrapper needs — a `window` with a
 * `__ModuleLoader__`, a `document`, and a `react` implementation — then drives
 * the real `apply()` against a stub plugin context.
 *
 * The renderer is a deliberately small React: hooks keep persistent state keyed
 * by component instance, `useRef` hands out a stable box populated with a fake
 * element, and `useEffect`/`useLayoutEffect` honour their dependency arrays. That
 * is enough to drive real interactions — hover the box, fire Escape, read the
 * card's computed coordinates — without a browser, a bundler, or a dependency.
 *
 * Run with `node test/client.mjs`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

// ---------------------------------------------------------------------------
// Hook runtime
// ---------------------------------------------------------------------------

/** Per-render-pass cursor state; the store itself survives re-renders. */
let hookStore = new Map()
let rerenderRequested = false
/** Unique, render-order-stable id for the component instance being expanded. */
let instanceId = 0
let currentInstance = null
let hookCursor = 0
/**
 * Effects are QUEUED during expansion and flushed once the whole tree is
 * built. React runs them after commit, when refs are attached; running them
 * inline would hand a layout effect a null ref, which is exactly the fidelity
 * this harness needs.
 */
let pendingEffects = []

/** Allocate (or read back) one hook slot for the instance being rendered. */
function slot(kind, create) {
  const key = `${currentInstance}#${hookCursor++}:${kind}`
  if (!hookStore.has(key)) hookStore.set(key, create())
  return hookStore.get(key)
}

/** Shallow dependency comparison, exactly as React's effect bailout uses. */
function sameDeps(a, b) {
  if (a === null || b === null || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
  return true
}

/**
 * One dependency-tracked effect, deferred to the post-expansion flush.
 *
 * Cleanups are honoured, because teardown is exactly what a timer-owning
 * component has to get right: React runs the previous cleanup before the next
 * effect with changed deps, and a harness that dropped it could not tell a
 * released timer from a leaked one.
 */
function effectHook(kind, deps, run) {
  const previous = slot(kind, () => ({ deps: null, cleanup: undefined }))
  if (previous.deps !== null && deps !== undefined && sameDeps(previous.deps, deps)) return
  if (typeof previous.cleanup === 'function') previous.cleanup()
  previous.cleanup = undefined
  previous.deps = deps ?? null
  pendingEffects.push(() => { previous.cleanup = run() })
}

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat().filter(child => child !== null && child !== undefined && child !== false),
    }
  },
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useEffect: (fn, deps) => { effectHook('effect', deps, fn) },
  useLayoutEffect: (fn, deps) => { effectHook('layout', deps, fn) },
  useRef: value => slot('ref', () => ({ current: value })),
  useState: (initial) => {
    const box = slot('state', () => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [box.value, (next) => {
      const resolved = typeof next === 'function' ? next(box.value) : next
      // React bails out of an identical update; without this a layout effect
      // that re-sets the same value would loop forever.
      if (Object.is(resolved, box.value)) return
      box.value = resolved
      rerenderRequested = true
    }]
  },
  useSyncExternalStore: (_subscribe, getSnapshot) => { slot('ext', () => ({})); return getSnapshot() },
}

// ---------------------------------------------------------------------------
// DOM / window stubs
// ---------------------------------------------------------------------------

const appendedStyles = []

globalThis.document = {
  hidden: false,
  head: { appendChild: element => appendedStyles.push(element) },
  getElementById: () => null,
  createElement: () => ({ dataset: {}, textContent: '', id: '' }),
  addEventListener() {},
  removeEventListener() {},
}

const intervals = new Map()
let nextTimerId = 1
/**
 * The display settings store persists through `localStorage`. A real stub is
 * supplied (rather than letting every call throw) so the read/write path is
 * exercised; `fakeContext` clears it so one test cannot leak settings into the
 * next.
 */
const storage = new Map()

globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  setInterval: (fn, ms) => { const id = nextTimerId++; intervals.set(id, { fn, ms }); return id },
  clearInterval: (id) => { intervals.delete(id) },
  setTimeout: () => 0,
  clearTimeout() {},
  addEventListener() {},
  removeEventListener() {},
  localStorage: {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: (key) => { storage.delete(key) },
  },
}

/** The captured `__ModuleLoader__.load({ id, factory })` call. */
let loaded
globalThis.window.__ModuleLoader__ = { load: (entry) => { loaded = entry } }

/** `require` shim: `react` is the only module the client half asks for. */
const requireShim = (specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
}

// Evaluating the module registers it on the loader; nothing else runs yet.
await import('../client.js')

// ---------------------------------------------------------------------------
// Mini renderer
// ---------------------------------------------------------------------------

/** Geometry the fake refs hand back, set per mount. */
let geometry = { anchorRect: null, cardSize: { width: 238, height: 120 } }

/** A fake DOM element whose measurements come from {@link geometry}. */
function fakeElement(node) {
  const className = typeof node.props.className === 'string' ? node.props.className : ''
  if (className.includes('dsh-bd-box')) {
    const rect = geometry.anchorRect ?? { top: 700, bottom: 742, left: 8, right: 240, width: 232, height: 42 }
    return { getBoundingClientRect: () => rect }
  }
  if (className.includes('dsh-bd-float')) {
    return { offsetWidth: geometry.cardSize.width, offsetHeight: geometry.cardSize.height, getBoundingClientRect: () => ({}) }
  }
  return { getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) }
}

/**
 * Expand a node tree into a FLAT pre-order list of host and text nodes,
 * invoking function components (and fragments) on the way. Hook slots are keyed
 * by the instance id, which is assigned in render order and is therefore stable
 * across the re-renders of one mount. The tree structure itself is discarded —
 * `text`/`find`/`findAll` all read this one list.
 */
function expand(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const child of node) expand(child, out); return out }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ type: '#text', props: {}, children: [], text: String(node) })
    return out
  }
  if (node.type === React.Fragment) { for (const child of node.children) expand(child, out); return out }
  if (typeof node.type === 'function') {
    const previousInstance = currentInstance
    const previousCursor = hookCursor
    currentInstance = `i${instanceId++}`
    hookCursor = 0
    let output
    try {
      output = node.type({ ...node.props, children: node.children.length === 1 ? node.children[0] : node.children })
    } finally {
      currentInstance = previousInstance
      hookCursor = previousCursor
    }
    expand(output, out)
    return out
  }
  const host = { type: node.type, props: node.props, children: [] }
  // Populate a ref object with a fake element, as the real renderer would.
  const ref = node.props.ref
  if (ref !== null && ref !== undefined && typeof ref === 'object') ref.current = fakeElement(node)
  out.push(host)
  for (const child of node.children) expand(child, out)
  return out
}

/**
 * Mount one component and return readers plus an event driver.
 * @param component - the function component to render.
 * @param props - its props.
 * @param options - `anchorRect` and `cardSize` for the fake element geometry.
 */
function mount(component, props, options = {}) {
  geometry = { anchorRect: options.anchorRect ?? null, cardSize: options.cardSize ?? { width: 238, height: 120 } }
  hookStore = new Map()
  rerenderRequested = false

  const render = () => {
    let nodes = []
    let guard = 0
    do {
      rerenderRequested = false
      pendingEffects = []
      instanceId = 0
      hookCursor = 0
      currentInstance = null
      nodes = expand(component(props))
      // Post-commit flush: refs are attached by now, so layout effects can
      // measure. A flush that updates state schedules another pass.
      for (const run of pendingEffects) run()
    } while (rerenderRequested && (guard += 1) < 50)
    assert.ok(guard < 50, 'render did not settle — a state update is looping')
    return nodes
  }

  let nodes = render()
  return {
    get nodes() { return nodes },
    /** Every text node, concatenated. */
    text: () => nodes.filter(node => node.type === '#text').map(node => node.text).join(''),
    /** All host nodes matching a predicate. */
    findAll: predicate => nodes.filter(node => node.type !== '#text' && predicate(node)),
    /** The first host node matching a predicate. */
    find: predicate => nodes.find(node => node.type !== '#text' && predicate(node)),
    /**
     * Re-render, as React would after a state update from outside an event.
     * Used to drive a component's own timers.
     */
    rerender() {
      nodes = render()
    },
    /**
     * Fire one handler on the first matching node, then re-render.
     * @param predicate - selects the node.
     * @param handler - the prop name, e.g. `onMouseEnter`.
     * @param event - the event object handed to the handler.
     */
    fire(predicate, handler, event = {}) {
      const node = nodes.find(candidate => candidate.type !== '#text' && predicate(candidate))
      assert.ok(node, `no node matched for ${handler}`)
      assert.equal(typeof node.props[handler], 'function', `${handler} is not wired`)
      node.props[handler](event)
      nodes = render()
      return node
    },
  }
}

/** The sidebar box, by its class. */
const boxNode = node => typeof node.props.className === 'string' && node.props.className.includes('dsh-bd-box')
/** The preview card, by its class. */
const cardNode = node => typeof node.props.className === 'string' && node.props.className.includes('dsh-bd-float')

// ---------------------------------------------------------------------------
// Plugin-context stub
// ---------------------------------------------------------------------------

/**
 * A stub of the client plugin context, recording registrations.
 * @param options - the resolved settings section and the raw user layer.
 */
function fakeContext(options = {}) {
  // The display settings store persists to localStorage, so each context starts
  // from a clean one — except when a test deliberately checks that a write
  // survives into a new plugin lifetime.
  if (options.keepStorage !== true) storage.clear()
  // Timers too: a test that opens the hover card and never closes it would
  // otherwise leak its tick into every later test.
  intervals.clear()
  const registrations = []
  const injectedSlots = []
  const boundSpecs = []
  // `let`, because `commit` below moves the committed document the way a real
  // Settings write does.
  let scopeSnapshot = {
    status: 'ready',
    value: { enabled: true, refreshSeconds: 60, currency: '', baseUrl: '', apiKeyEnv: '', timeoutMs: 10_000, ...options.section },
    user: options.user ?? {},
    base: undefined,
    revision: 1,
    writable: true,
  }
  const listeners = new Set()
  const scope = {
    getSnapshot: () => scopeSnapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: async () => {},
    unset: async () => {},
    mutate: async () => {},
    /**
     * Test hook: move the committed document and notify, exactly as the real
     * scope does when the Settings page writes. Without this the runtime's
     * settings subscription can never be exercised.
     */
    commit(patch) {
      scopeSnapshot = { ...scopeSnapshot, value: { ...scopeSnapshot.value, ...patch } }
      for (const listener of [...listeners]) listener()
    },
  }
  const dictionaries = {}
  const ctx = {
    effect(fn) { fn(); return fn },
    locale: {
      register: (ns, dicts) => { dictionaries[ns] = dicts; return () => {} },
      // Mirrors the real locale service exactly: dictionary values are STRINGS,
      // and `{name}` placeholders interpolate from the second argument. A
      // function value therefore fails here just as it would in DSH.
      bind: ns => (key, params) => {
        const template = dictionaries[ns]?.zh?.[key]
        if (typeof template !== 'string') {
          throw new TypeError(`locale key "${key}" is not a string in namespace "${ns}"`)
        }
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
      },
      subscribe: () => () => {},
    },
    settingsScope: { bind(spec) { boundSpecs.push(spec); return scope } },
    slots: {
      inject(name, callback) { injectedSlots.push(name); callback(); return () => {} },
      register(opts, component) { registrations.push({ opts, component }); return () => {} },
    },
  }
  return { ctx, registrations, injectedSlots, boundSpecs, scope, dictionaries }
}

/** Boot the plugin against a stub context and return what it registered. */
function boot(options) {
  const harness = fakeContext(options)
  const mod = loaded.factory(requireShim)
  mod.apply(harness.ctx)
  return { ...harness, mod }
}

/** The component registered for one slot, plus its injected props. */
function slotEntry(harness, name) {
  const entry = harness.registrations.find(row => row.opts.name === name)
  assert.ok(entry, `the plugin must claim ${name}`)
  return entry
}

/** Build a runtime snapshot with the given phase/result. */
function snapshotOf(overrides = {}) {
  return {
    settings: {
      enabled: true, refreshSeconds: 60, currency: '', baseUrl: '', apiKeyEnv: '', timeoutMs: 10_000,
      costEnabled: true, costUnit: 'yuan', costPeakAware: true,
      costPriceCacheHit: 0, costPriceCacheMiss: 0, costPriceOutput: 0,
      ...overrides.settings,
    },
    phase: overrides.phase ?? 'ready',
    result: overrides.result,
    refreshing: overrides.refreshing ?? false,
  }
}

/** One completed-turn node, as the Chat node store carries it. */
function turnNode(time, totalTokens = 1_000_000) {
  return {
    kind: 'turn-tail',
    data: {
      turn: 1,
      seq: 1,
      time,
      closing: null,
      branchUnavailable: false,
      // Only `totalTokens` matters to the cost: it is the peak/off-peak weight.
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, totalTokens },
    },
  }
}

/**
 * A `tokenUsage` projection — the session's authoritative token totals, and the
 * same figure DSH's token pill prints.
 */
function usage(overrides = {}) {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  }
}

/** Instants verified against the tariff: peak, off-peak, and a weekend. */
const PEAK_WED = Date.parse('2026-09-16T02:00:00Z')
const OFFPEAK_WED = Date.parse('2026-09-16T12:00:00Z')
const WEEKEND_SAT = Date.parse('2026-09-19T02:00:00Z')

/** A successful answer carrying one or more currency entries. */
function balanceResult(infos, isAvailable = true) {
  return { ok: true, balance: { isAvailable, fetchedAt: Date.now(), infos } }
}

/**
 * Mount the sidebar box against a fixed snapshot.
 * @param harness - a booted harness.
 * @param options - `wide`, `snapshot`, plus the geometry overrides.
 */
function mountBox(harness, options = {}) {
  const entry = slotEntry(harness, 'sidebar.footer.action')
  const injected = entry.opts.inject()
  injected.runtime.getSnapshot = () => options.snapshot ?? snapshotOf({ result: balanceResult([{ currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00' }]) })
  injected.runtime.load = options.load ?? (async () => {})
  return mount(entry.component, { wide: options.wide ?? true, ...injected }, options)
}

/** Mount the settings page against a fixed snapshot. */
function mountSettings(harness, snapshot) {
  const entry = slotEntry(harness, 'settings.section')
  const injected = entry.opts.inject()
  injected.runtime.getSnapshot = () => snapshot
  return mount(entry.component, { ...injected })
}

/**
 * Mount the composer-dock cost pill.
 * @param harness - a booted harness.
 * @param projection - the `tokenUsage` projection (the token TOTALS); `undefined`
 *   models a session whose harness reports no billing yet.
 * @param turns - turn-tail nodes, used only for the peak/off-peak weighting.
 * @param options - `settings` overrides, plus `legacyOnly` to feed the turns
 *   through the legacy slice instead of the node store.
 */
function mountCost(harness, projection, turns = [], options = {}) {
  const entry = slotEntry(harness, 'conversation.composer.dock')
  const injected = entry.opts.inject()
  injected.runtime.getSnapshot = () => snapshotOf({ settings: options.settings })
  // `useChat` hands the component a snapshot shaped like the real one. The turns
  // live in the NODE STORE, because ui-chat's `legacy` slice omits turn-tail rows
  // by design; `legacy` is populated with a decoy so a regression back to it
  // fails loudly rather than silently.
  const snapshot = options.legacyOnly === true
    ? { nodes: { values: () => [] }, legacy: { nodes: turns } }
    : { nodes: { values: () => turns }, legacy: { nodes: [] } }
  const useProjection = key => (key === 'tokenUsage' ? projection : undefined)
  return mount(entry.component, {
    ...injected,
    useChat: selector => selector(snapshot),
    useProjection,
  })
}

/** The money text the suffix renders, or null when it renders nothing. */
function costText(view) {
  const node = view.find(candidate => typeof candidate.props.className === 'string'
    && candidate.props.className.includes('dsh-bd-cost'))
  return node === undefined ? null : view.text()
}

// ---------------------------------------------------------------------------
// Module surface
// ---------------------------------------------------------------------------

test('module registers on the loader under its own id', () => {
  assert.ok(loaded, 'the module must call window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-balance-display')
  assert.equal(typeof loaded.factory, 'function')
})

test('module exposes the cordis face: inject list and apply', () => {
  const mod = loaded.factory(requireShim)
  assert.deepEqual(mod.inject, ['slots', 'locale'])
  assert.equal(typeof mod.apply, 'function')
})

test('apply claims its slots, and only under the documented declarations', () => {
  const harness = boot()
  assert.deepEqual(harness.registrations.map(row => row.opts.name).sort(),
    ['conversation.composer.dock', 'settings.section', 'sidebar.footer.action'])
  // The slot declarations must be awaited, not assumed by apply order.
  assert.deepEqual(harness.injectedSlots.slice().sort(),
    ['conversation.composer.dock', 'settings.section', 'sidebar.footer.action'])
  // DSH 0.1.7 removed the `settingsScope` service: binding it would throw, and
  // requiring it would leave the plugin waiting forever.
  assert.deepEqual(harness.boundSpecs, [])
})

test('the cost suffix registers after ui-chat\'s stats pills, which own order 0', () => {
  const harness = boot()
  const entry = slotEntry(harness, 'conversation.composer.dock')
  assert.equal(entry.opts.id, 'balance-display-cost')
  // A list slot sorts ascending by order, so anything above ui-chat's 0 renders
  // to the right of the token pill.
  assert.ok(entry.opts.order > 0, 'the cost must follow the shipped stats entry')
})

test('apply injects the stylesheet once and schedules polling', () => {
  const before = appendedStyles.length
  boot()
  assert.equal(appendedStyles.length, before + 1)
  assert.match(appendedStyles.at(-1).textContent, /\.dsh-bd-box/u)
  assert.ok(intervals.size > 0, 'polling must be scheduled at boot')
})

test('both shipped locales declare exactly the same keys, all as strings', () => {
  const harness = boot()
  const dicts = harness.dictionaries['balance-display']
  assert.ok(dicts, 'the plugin must register its dictionaries under its own namespace')
  // DSH enforces a bilingual balance at registration; an asymmetric pair would
  // leave one locale falling back to raw keys.
  assert.deepEqual(Object.keys(dicts.en).sort(), Object.keys(dicts.zh).sort())
  for (const [locale, dict] of Object.entries(dicts)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a plain string`)
    }
  }
})

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

test('the box matches the Settings trigger geometry it is imitating', () => {
  boot()
  const css = appendedStyles.at(-1).textContent
  // ui-settings-general renders its trigger at 42px / radius 12 / padding
  // `0 10px 0 8px` inside a row that bleeds `calc(100% + 4px)` with `-2px`
  // margins; the box copies all of it so the two rows align.
  assert.match(css, /height:42px/u)
  assert.match(css, /border-radius:12px/u)
  assert.match(css, /padding:0 10px 0 8px/u)
  assert.match(css, /width:calc\(100% \+ 4px\)/u)
  assert.match(css, /margin:4px -2px/u)
  assert.match(css, /background:var\(--dsw-alias-interactive-bg-hover\)/u)
  assert.match(css, /\.dsh-bd-box\[data-rail="true"\]\{[^}]*width:36px;height:36px/u)
})

test('the preview card uses the theme floating-layer treatment, not a raw tooltip', () => {
  boot()
  const css = appendedStyles.at(-1).textContent
  const card = /\.dsh-bd-float\{([^}]*)\}/u.exec(css)
  assert.ok(card, 'the card class must be declared')
  const rule = card[1]
  // Fixed positioning is what lets it escape the sidebar's overflow clipping.
  assert.match(rule, /position:fixed/u)
  assert.match(rule, /z-index:100/u)
  // The theme's documented floating-layer stroke+shadow set.
  assert.match(rule, /box-shadow:var\(--dsw-elevation-prominent\)/u)
  // The card sits away from the anchor, so nothing must be hit-testable.
  assert.match(rule, /pointer-events:none/u)
  // Motion is opt-outable, matching the rest of DSH's floating layers.
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.dsh-bd-float\{animation:none\}\}/u)
})

test('the card wears the sidebar surface, not an elevated layer token', () => {
  boot()
  const rule = /\.dsh-bd-float\{([^}]*)\}/u.exec(appendedStyles.at(-1).textContent)[1]
  // --dsw-specific-sidebar-fill is what ui-sidebar's root and the AppFrame
  // column paint themselves with, so the card reads as part of the sidebar.
  assert.match(rule, /background:var\(--dsw-specific-sidebar-fill,var\(--dsw-alias-bg-base\)\)/u)
  assert.doesNotMatch(rule, /--dsw-alias-bg-layer-2/u)
})

test('the card follows the video-wallpaper plugin\'s sidebar opacity', () => {
  boot()
  const css = appendedStyles.at(-1).textContent
  // The wallpaper drives the sidebar column at this exact expression; the card
  // must reuse both the fill and the custom property so one slider moves both.
  const follow = /html\[data-dsh-vw="on"\] \.dsh-bd-float\{([^}]*)\}/u.exec(css)
  assert.ok(follow, 'the card must follow the wallpaper sidebar state')
  assert.match(follow[1], /background:color-mix\(in srgb,var\(--dsw-specific-sidebar-fill,var\(--dsw-alias-bg-base\)\) var\(--dsh-vw-sidebar,100%\),transparent\)/u)
  // The gate is load-bearing: the wallpaper only clears its variables on
  // dispose, so an unconditional read would keep the card translucent after the
  // wallpaper was switched off.
  assert.match(css, /html\[data-dsh-vw="on"\]/u)
})

// ---------------------------------------------------------------------------
// The sidebar box
// ---------------------------------------------------------------------------

test('the box shows the fetched balance in the wide sidebar', () => {
  const harness = boot()
  const view = mountBox(harness)
  assert.match(view.text(), /¥110\.00/u)
})

test('the box marks up its own state for styling and accessibility', () => {
  const harness = boot()
  const view = mountBox(harness, { snapshot: snapshotOf({ result: balanceResult([{ currency: 'USD', total: '5.50', granted: '', toppedUp: '' }]) }) })
  const button = view.find(boxNode)
  assert.equal(button.props['data-state'], 'ready')
  assert.equal(button.props.type, 'button')
  assert.match(button.props['aria-label'], /5\.50/u)
  // A funded account must not carry the low-balance marker.
  assert.equal(button.props['data-low'], undefined)
  // The card glyph is drawn inline, so no icon package is required.
  assert.ok(view.find(node => node.type === 'svg'), 'the box must draw its own glyph')
})

test('the box no longer relies on the browser native title bubble', () => {
  const harness = boot()
  const view = mountBox(harness)
  assert.equal(view.find(boxNode).props.title, undefined, 'a native title would double up with the card')
})

test('the box flags an exhausted account', () => {
  const harness = boot()
  const view = mountBox(harness, { snapshot: snapshotOf({ result: balanceResult([{ currency: 'CNY', total: '0.00' }], false) }) })
  assert.equal(view.find(boxNode).props['data-low'], 'true')
})

test('the box prefers a funded currency over an empty one', () => {
  const harness = boot()
  // The provider's currency order is not stable, so an empty CNY ahead of a
  // funded USD must not win.
  const view = mountBox(harness, { snapshot: snapshotOf({ result: balanceResult([{ currency: 'CNY', total: '0.00' }, { currency: 'USD', total: '12.34' }]) }) })
  assert.match(view.text(), /\$12\.34/u)
})

test('the box honours a configured currency', () => {
  const harness = boot()
  const view = mountBox(harness, {
    snapshot: snapshotOf({
      settings: { currency: 'USD' },
      result: balanceResult([{ currency: 'CNY', total: '99.00' }, { currency: 'USD', total: '1.00' }]),
    }),
  })
  assert.match(view.text(), /\$1\.00/u)
})

test('the box reports a missing credential in words', () => {
  const harness = boot()
  const view = mountBox(harness, { snapshot: snapshotOf({ phase: 'error', result: { ok: false, error: { code: 'no-credential', message: '没有找到 API Key' } } }) })
  assert.match(view.text(), /未配置/u)
  assert.match(view.find(boxNode).props['aria-label'], /没有找到 API Key/u)
})

test('the box shows a loading and an error placeholder', () => {
  const harness = boot()
  const loading = mountBox(harness, { snapshot: snapshotOf({ phase: 'loading' }) })
  assert.match(loading.text(), /—/u)

  const failed = mountBox(harness, { snapshot: snapshotOf({ phase: 'error', result: { ok: false, error: { code: 'network', message: 'offline' } } }) })
  assert.equal(failed.find(boxNode).props['data-state'], 'error')
  assert.match(failed.find(boxNode).props['aria-label'], /offline/u)
})

test('the box renders nothing while the feature is switched off', () => {
  const harness = boot()
  const view = mountBox(harness, { snapshot: snapshotOf({ settings: { enabled: false }, result: balanceResult([{ currency: 'CNY', total: '1.00' }]) }) })
  assert.equal(view.find(boxNode), undefined)
  assert.equal(view.text(), '')
})

test('the collapsed rail drops the text label and marks itself', () => {
  const harness = boot()
  const view = mountBox(harness, { wide: false })
  const button = view.find(boxNode)
  assert.equal(button.props['data-rail'], 'true')
  // The rail is 36px wide, so the amount lives in the card instead.
  assert.equal(view.text(), '')
  assert.match(button.props['aria-label'], /110\.00/u)
})

test('clicking the box performs a forced refresh', () => {
  const harness = boot()
  const forced = []
  const view = mountBox(harness, { load: async (force) => { forced.push(force) } })
  view.fire(boxNode, 'onClick')
  assert.deepEqual(forced, [true], 'a click must bypass the cache')
})

// ---------------------------------------------------------------------------
// The hover / focus preview card
// ---------------------------------------------------------------------------

test('the card stays closed until the pointer or focus opens it', () => {
  const harness = boot()
  const view = mountBox(harness)
  assert.equal(view.find(cardNode), undefined, 'no card before hover')
})

test('hovering the box opens a card with the balance, breakdown and footer', () => {
  const harness = boot()
  const view = mountBox(harness)
  view.fire(boxNode, 'onMouseEnter')
  const card = view.find(cardNode)
  assert.ok(card, 'hover must open the card')
  assert.equal(card.props.role, 'tooltip')
  const text = view.text()
  assert.match(text, /账户余额/u)
  assert.match(text, /¥110\.00/u)
  assert.match(text, /CNY/u)
  // The breakdown renders both amounts with the entry's own currency glyph.
  assert.match(text, /赠送余额/u)
  assert.match(text, /¥10\.00/u)
  assert.match(text, /充值余额/u)
  assert.match(text, /¥100\.00/u)
  // The footer reports freshness and the refresh affordance.
  assert.match(text, /最近更新: \d+ 秒前/u)
  assert.match(text, /点击刷新余额/u)
})

test('leaving the box closes the card again', () => {
  const harness = boot()
  const view = mountBox(harness)
  view.fire(boxNode, 'onMouseEnter')
  assert.ok(view.find(cardNode))
  view.fire(boxNode, 'onMouseLeave')
  assert.equal(view.find(cardNode), undefined)
})

test('moving the pointer off a focused box keeps the card open', () => {
  const harness = boot()
  const view = mountBox(harness)
  // Keyboard focus (focus-visible) pins the card independently of hover.
  view.fire(boxNode, 'onFocus', { currentTarget: { matches: () => true } })
  view.fire(boxNode, 'onMouseEnter')
  view.fire(boxNode, 'onMouseLeave')
  assert.ok(view.find(cardNode), 'focus must hold the card after the pointer leaves')
  view.fire(boxNode, 'onBlur')
  assert.equal(view.find(cardNode), undefined, 'blur releases it')
})

test('a mouse click does not pin the card open', () => {
  const harness = boot()
  const view = mountBox(harness)
  // A click focuses the button but is not focus-visible.
  view.fire(boxNode, 'onFocus', { currentTarget: { matches: () => false } })
  view.fire(boxNode, 'onMouseEnter')
  assert.ok(view.find(cardNode))
  view.fire(boxNode, 'onMouseLeave')
  assert.equal(view.find(cardNode), undefined, 'the card must not linger after a refresh click')
})

test('Escape dismisses the card', () => {
  const harness = boot()
  const view = mountBox(harness)
  view.fire(boxNode, 'onFocus', { currentTarget: { matches: () => true } })
  assert.ok(view.find(cardNode))
  view.fire(boxNode, 'onKeyDown', { key: 'Escape' })
  assert.equal(view.find(cardNode), undefined)
})

test('the card is placed beside the box, clear of the viewport edges', () => {
  const harness = boot()
  // A box low in a narrow viewport: the card must be pushed back inside.
  const view = mountBox(harness, {
    anchorRect: { top: 780, bottom: 822, left: 8, right: 240, width: 232, height: 42 },
    cardSize: { width: 238, height: 300 },
  })
  view.fire(boxNode, 'onMouseEnter')
  const style = view.find(cardNode).props.style
  const left = Number.parseFloat(style.left)
  const top = Number.parseFloat(style.top)
  // Right of the anchor plus the 10px gap.
  assert.equal(left, 250)
  // Vertically centred would be 780 + 21 - 150 = 651; the bottom clamp wins.
  assert.equal(top, 800 - 300 - 8)
  assert.ok(top >= 8 && top + 300 <= 800, 'the card must stay inside the viewport')
})

test('the card clamps horizontally when there is no room to the right', () => {
  const harness = boot()
  const previousWidth = globalThis.window.innerWidth
  globalThis.window.innerWidth = 300
  try {
    const view = mountBox(harness, {
      anchorRect: { top: 100, bottom: 142, left: 8, right: 240, width: 232, height: 42 },
      cardSize: { width: 238, height: 120 },
    })
    view.fire(boxNode, 'onMouseEnter')
    const left = Number.parseFloat(view.find(cardNode).props.style.left)
    assert.equal(left, 300 - 238 - 8)
    assert.ok(left >= 8 && left + 238 <= 300, 'the card must stay inside the viewport')
  } finally {
    globalThis.window.innerWidth = previousWidth
  }
})

test('the card explains a failure instead of showing amounts', () => {
  const harness = boot()
  const view = mountBox(harness, { snapshot: snapshotOf({ phase: 'error', result: { ok: false, error: { code: 'unauthorized', message: 'API Key 无效或已失效' } } }) })
  view.fire(boxNode, 'onMouseEnter')
  const text = view.text()
  assert.match(text, /API Key 无效或已失效/u)
  assert.match(text, /余额获取失败/u)
  // No breakdown is offered when there is no balance to break down.
  assert.doesNotMatch(text, /赠送余额/u)
})

test('the card omits breakdown rows the provider did not send', () => {
  const harness = boot()
  const view = mountBox(harness, { snapshot: snapshotOf({ result: balanceResult([{ currency: 'CNY', total: '7.00', granted: '', toppedUp: '' }]) }) })
  view.fire(boxNode, 'onMouseEnter')
  const text = view.text()
  assert.match(text, /¥7\.00/u)
  assert.doesNotMatch(text, /赠送余额/u)
  assert.doesNotMatch(text, /充值余额/u)
})

test('the card warns when the account cannot pay for calls', () => {
  const harness = boot()
  const view = mountBox(harness, { snapshot: snapshotOf({ result: balanceResult([{ currency: 'CNY', total: '0.00' }], false) }) })
  view.fire(boxNode, 'onMouseEnter')
  const foot = view.find(node => typeof node.props.className === 'string' && node.props.className.includes('dsh-bd-floatFoot'))
  assert.equal(foot.props['data-tone'], 'warn')
  assert.match(view.text(), /余额不足/u)
})

test('the card reports an in-flight refresh', () => {
  const harness = boot()
  const view = mountBox(harness, { snapshot: snapshotOf({ refreshing: true, result: balanceResult([{ currency: 'CNY', total: '5.00' }]) }) })
  view.fire(boxNode, 'onMouseEnter')
  assert.match(view.text(), /正在刷新…/u)
})

test('the open card owns the timer that advances its freshness reading', () => {
  const realNow = Date.now
  try {
    let now = 1_700_000_000_000
    Date.now = () => now
    const harness = boot()
    // `balanceResult` stamps `fetchedAt` from the (stubbed) clock, so the card
    // opens reading "0 秒前".
    const view = mountBox(harness, { snapshot: snapshotOf({ result: balanceResult([{ currency: 'CNY', total: '5.00' }]) }) })
    assert.equal(view.find(cardNode), undefined, 'no card before hover')
    view.fire(boxNode, 'onMouseEnter')
    assert.match(view.text(), /最近更新: 0 秒前/u)

    // A relative reading is only true at the instant it is rendered, and nothing
    // else re-renders this card between polls. So the CARD must own a timer.
    // Picking it by its 1s period is the whole point: the runtime's poll is 60s, so
    // reaching for "the newest timer" instead would silently accept the poll timer
    // and let this test pass with no card timer at all.
    const ticks = [...intervals.entries()].filter(([, entry]) => entry.ms === 1_000)
    assert.equal(ticks.length, 1, 'the open card must own exactly one 1s tick')

    now += 65_000
    ticks[0][1].fn()
    view.rerender()
    assert.match(view.text(), /最近更新: 1 分钟前/u, 'the reading must advance on its own')
  } finally {
    Date.now = realNow
  }
})

test('the card stops ticking once it closes', () => {
  const harness = boot()
  const view = mountBox(harness, { snapshot: snapshotOf({ result: balanceResult([{ currency: 'CNY', total: '5.00' }]) }) })
  const before = intervals.size
  view.fire(boxNode, 'onMouseEnter')
  assert.equal(intervals.size, before + 1, 'opening the card starts exactly one timer')
  // Closing releases it: a card nobody is looking at must not keep a timer alive.
  view.fire(boxNode, 'onMouseLeave')
  assert.equal(intervals.size, before, 'closing must release the timer')
})

// ---------------------------------------------------------------------------
// Session cost (the composer-dock suffix)
// ---------------------------------------------------------------------------

test('the cost pill renders nothing until the harness reports billing', () => {
  const harness = boot()
  assert.equal(costText(mountCost(harness, undefined)), null, 'an empty session is not a cost of zero')
  // A projection of all-zero buckets is equally nothing to price.
  assert.equal(costText(mountCost(harness, usage())), null)
})

test('the cost pill prices the projection at the off-peak tariff', () => {
  const harness = boot()
  // 1M uncached input at ¥1 per 1M is ¥1.00. No turns means no peak weighting.
  assert.equal(costText(mountCost(harness, usage({ uncachedInputTokens: 1_000_000 }))), '1.00 yuan')
})

test('the cost pill bills cache reads and cache WRITES at the cache-hit rate', () => {
  const harness = boot()
  // DeepSeek quotes no separate write price; both bill at the hit rate (¥0.02).
  assert.equal(costText(mountCost(harness, usage({ cacheReadTokens: 1_000_000 }))), '0.02 yuan')
  assert.equal(costText(mountCost(harness, usage({ cacheWriteTokens: 1_000_000 }))), '0.02 yuan')
})

test('the cost pill prices output at the output rate', () => {
  const harness = boot()
  assert.equal(costText(mountCost(harness, usage({ outputTokens: 1_000_000 }))), '4.00 yuan')
})

test('peak hours cost exactly double, and the window is Beijing 09-12 / 14-18', () => {
  const harness = boot()
  const projection = usage({ uncachedInputTokens: 1_000_000 })
  // 02:00 UTC on a Wednesday is inside Beijing 09:00-12:00.
  assert.equal(costText(mountCost(harness, projection, [turnNode(PEAK_WED)])), '2.00 yuan')
  // 12:00 UTC is outside both windows.
  assert.equal(costText(mountCost(harness, projection, [turnNode(OFFPEAK_WED)])), '1.00 yuan')
})

test('weekends are off-peak all day, overriding the peak windows', () => {
  const harness = boot()
  // Saturday 02:00 UTC is inside a peak window by the clock alone.
  const projection = usage({ uncachedInputTokens: 1_000_000 })
  assert.equal(costText(mountCost(harness, projection, [turnNode(WEEKEND_SAT)])), '1.00 yuan')
})

test('a session split across the boundary is weighted, not charged at one rate', () => {
  const harness = boot()
  const projection = usage({ uncachedInputTokens: 1_000_000 })
  // Two equal-weight turns, one peak and one off-peak: the peak share is 1/2, so
  // the multiplier lands at 1.5 rather than at either extreme.
  assert.equal(costText(mountCost(harness, projection, [turnNode(PEAK_WED), turnNode(OFFPEAK_WED)])), '1.50 yuan')
  // Weighted by TOKENS, not by turn count: a negligible peak turn beside a large
  // off-peak one barely moves the figure.
  assert.equal(costText(mountCost(harness, projection, [turnNode(PEAK_WED, 1), turnNode(OFFPEAK_WED, 999_999)])), '1.00 yuan')
})

test('disabling peak awareness charges the off-peak rate everywhere', () => {
  const harness = boot()
  const view = mountCost(harness, usage({ uncachedInputTokens: 1_000_000 }), [turnNode(PEAK_WED)], {
    settings: { costPeakAware: false },
  })
  assert.equal(costText(view), '1.00 yuan')
})

test('a session with no usable turn timing is priced wholly off-peak', () => {
  const harness = boot()
  // Off-peak even at a peak instant: the figure must not move with the clock when
  // there is no usage to justify the move.
  const view = mountCost(harness, usage({ uncachedInputTokens: 1_000_000 }), [{ kind: 'turn-tail', data: { time: PEAK_WED } }])
  assert.equal(costText(view), '1.00 yuan')
})

test('a cache-heavy session is priced on its cached tokens, not just the uncached few', () => {
  const harness = boot()
  // The shape that exposed the earlier per-turn sum: 96.4M tokens at a 99.7% cache
  // hit rate must price the 95.7M cached tokens, not only the 0.3% uncached — that
  // omission is what turned this session into a nonsensical ¥0.24.
  const projection = usage({
    uncachedInputTokens: 288_000,
    cacheReadTokens: 95_712_000,
    outputTokens: 400_000,
  })
  // 0.288×1 + 95.712×0.02 + 0.4×4 = ¥3.80224, at the off-peak rate.
  assert.equal(costText(mountCost(harness, projection, [turnNode(OFFPEAK_WED)])), '3.80 yuan')
})

test('all four disjoint buckets are summed without double counting', () => {
  const harness = boot()
  // 1 × miss(1) + 1 × read(0.02) + 1 × write(0.02) + 1 × output(4) = ¥5.04.
  const projection = usage({
    uncachedInputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
    outputTokens: 1_000_000,
  })
  assert.equal(costText(mountCost(harness, projection)), '5.04 yuan')
})

test('a sub-cent session keeps four decimals instead of collapsing to 0.00', () => {
  const harness = boot()
  assert.equal(costText(mountCost(harness, usage({ cacheReadTokens: 100_000 }))), '0.0020 yuan')
})

test('an off-peak price override applies, and the peak tier still doubles it', () => {
  const harness = boot()
  const settings = { costPriceCacheMiss: 10 }
  const projection = usage({ uncachedInputTokens: 1_000_000 })
  assert.equal(costText(mountCost(harness, projection, [], { settings })), '10.00 yuan')
  assert.equal(costText(mountCost(harness, projection, [turnNode(PEAK_WED)], { settings })), '20.00 yuan')
})

test('the cost pill honours the configured unit and can be switched off', () => {
  const harness = boot()
  const projection = usage({ uncachedInputTokens: 1_000_000 })
  assert.equal(costText(mountCost(harness, projection, [], { settings: { costUnit: '元' } })), '1.00 元')
  assert.equal(costText(mountCost(harness, projection, [], { settings: { costEnabled: false } })), null)
})

/** Mount the cost pill against the LIVE runtime, so settings writes propagate. */
function mountLiveCost(harness, projection) {
  const entry = slotEntry(harness, 'conversation.composer.dock')
  const injected = entry.opts.inject()
  // No `getSnapshot` override: the runtime's own settings subscription is what
  // has to carry a settings change through.
  return mount(entry.component, {
    ...injected,
    useChat: selector => selector({ nodes: { values: () => [] }, legacy: { nodes: [] } }),
    useProjection: key => (key === 'tokenUsage' ? projection : undefined),
  })
}

/** The display settings store the runtime reads, for a test to write through. */
function storeOf(harness) {
  return slotEntry(harness, 'conversation.composer.dock').opts.inject().runtime.getScope()
}

test('switching the cost reading off in the settings store hides the pill', () => {
  const harness = boot()
  const projection = usage({ uncachedInputTokens: 1_000_000 })
  assert.equal(costText(mountLiveCost(harness, projection)), '1.00 yuan')
  // The Settings page writes through this store; the runtime's subscription must
  // carry it. Hand-enumerating the watched fields is exactly how `costEnabled`
  // came to be missed, leaving the pill on screen after it was switched off.
  void storeOf(harness).set('costEnabled', false)
  assert.equal(costText(mountLiveCost(harness, projection)), null)
  void storeOf(harness).set('costEnabled', true)
  assert.equal(costText(mountLiveCost(harness, projection)), '1.00 yuan')
})

test('every cost setting reaches the runtime, not just the ones a timer reads', () => {
  const harness = boot()
  const projection = usage({ uncachedInputTokens: 1_000_000 })
  assert.equal(costText(mountLiveCost(harness, projection)), '1.00 yuan')
  void storeOf(harness).set('costUnit', '元')
  assert.equal(costText(mountLiveCost(harness, projection)), '1.00 元')
  // A unit-price override must land live too, without a reload.
  void storeOf(harness).set('costPriceCacheMiss', 1_000)
  assert.equal(costText(mountLiveCost(harness, projection)), '1000.00 元')
  void storeOf(harness).set('costPeakAware', false)
  assert.equal(costText(mountLiveCost(harness, projection)), '1000.00 元')
})

test('the cost pill carries its own glyph and reading', () => {
  const harness = boot()
  const view = mountCost(harness, usage({ uncachedInputTokens: 1_220_000 }))
  const node = view.find(candidate => String(candidate.props.className).includes('dsh-bd-cost'))
  // A span, not a button: there is nothing for it to open.
  assert.equal(node.type, 'span')
  assert.equal(node.props.onClick, undefined)
  assert.match(node.props['aria-label'], /1\.22 yuan/u)
  assert.equal(costText(view), '1.22 yuan')
  // The coin glyph takes the sibling pills' 14px icon seat.
  const icon = view.find(candidate => candidate.type === 'svg')
  assert.ok(icon, 'the pill must draw its own glyph')
  assert.equal(icon.props.width, 14)
  assert.equal(icon.props.height, 14)
})

test('the cost pill survives malformed nodes and a malformed projection', () => {
  const harness = boot()
  const projection = usage({ uncachedInputTokens: 2_000_000 })
  // Only well-formed turn-tail nodes contribute WEIGHT; everything else is
  // skipped rather than thrown on, so the reading stays at the off-peak rate.
  const view = mountCost(harness, projection, [
    null,
    'nope',
    { kind: 'assistant', data: {} },
    { kind: 'turn-tail', data: { time: PEAK_WED } },
    { kind: 'turn-tail', data: { time: PEAK_WED, tokenUsage: { totalTokens: Number.NaN } } },
  ])
  assert.equal(costText(view), '2.00 yuan')
  // A projection that is not an object yields no reading at all.
  for (const bogus of [null, 'nope', 7]) {
    assert.equal(costText(mountCost(harness, bogus)), null)
  }
})

test('the cost pill reads turn times from the node store, never the legacy slice', () => {
  const harness = boot()
  const projection = usage({ uncachedInputTokens: 1_000_000 })
  // ui-chat's `legacyContribution` returns an empty contribution for turn-tail
  // rows by design, so a component reading `legacy.nodes` finds no turn times at
  // all and can never see a peak hour. The store is the only source that has them.
  assert.equal(costText(mountCost(harness, projection, [turnNode(PEAK_WED)])), '2.00 yuan')
  // The inverse pins it: the same turn reachable ONLY through `legacy` is unseen,
  // leaving the off-peak rate.
  assert.equal(costText(mountCost(harness, projection, [turnNode(PEAK_WED)], { legacyOnly: true })), '1.00 yuan')
})

test('the cost pill copies the composer row\'s own pill geometry', () => {
  boot()
  const css = appendedStyles.at(-1).textContent
  const rule = /\.dsh-bd-cost\{([^}]*)\}/u.exec(css)
  assert.ok(rule, 'the cost class must be declared')
  // ui-chat's `.pill`: 1px/8px padding, 24px radius, transparent at rest,
  // 6px gap to a 14px glyph.
  assert.match(rule[1], /padding:1px 8px/u)
  assert.match(rule[1], /border-radius:24px/u)
  assert.match(rule[1], /background:transparent/u)
  assert.match(rule[1], /gap:6px/u)
  // Same type tier and figures, so it reads as an equal in the row.
  assert.match(rule[1], /font-size:var\(--dsh-content-font-size-secondary,13px\)/u)
  assert.match(rule[1], /font-variant-numeric:tabular-nums/u)
  assert.match(css, /\.dsh-bd-cost svg\{width:14px;height:14px;flex:none\}/u)
  // It is not interactive, so it must NOT fake the buttons' hover fill.
  assert.doesNotMatch(css, /\.dsh-bd-cost:hover/u)
})



// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

test('the settings page renders its controls and live status', () => {
  const harness = boot()
  const view = mountSettings(harness, snapshotOf({
    result: {
      ...balanceResult([{ currency: 'CNY', total: '110.00' }]),
      source: { baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', endpointSource: 'provider', credentialSource: 'file' },
    },
  }))
  const entry = slotEntry(harness, 'settings.section')
  assert.equal(entry.opts.id, 'balance-display')
  const text = view.text()
  assert.match(text, /余额显示/u)
  assert.match(text, /自动刷新间隔/u)
  assert.match(text, /接口地址/u)
  assert.match(text, /API Key 变量名/u)
  assert.match(text, /110\.00/u)
  assert.match(text, /https:\/\/api\.deepseek\.com/u)
  assert.match(text, /DEEPSEEK_API_KEY/u)
  // The endpoint's origin is surfaced, so a blank field is explainable.
  assert.match(text, /跟随模型设置/u)
})

test('the settings page owns a timer that advances its freshness reading', () => {
  const realNow = Date.now
  try {
    let now = 1_700_000_000_000
    Date.now = () => now
    const harness = boot()
    const view = mountSettings(harness, snapshotOf({ result: balanceResult([{ currency: 'CNY', total: '110.00' }]) }))
    // The status card renders its label and value as separate cells, so the
    // reading follows the label with no separator (unlike the hover card's).
    assert.match(view.text(), /最近更新0 秒前/u)
    // Same defect the hover card had: the reading is relative, and the page only
    // re-renders on a poll or a settings change — so it must own a clock. The
    // runtime's poll timer is 60s, so a 1s timer can only be the page's.
    const ticks = [...intervals.entries()].filter(([, entry]) => entry.ms === 1_000)
    assert.equal(ticks.length, 1, 'the settings page must own exactly one 1s tick')
    now += 65_000
    ticks[0][1].fn()
    view.rerender()
    assert.match(view.text(), /最近更新1 分钟前/u, 'the reading must advance on its own')
  } finally {
    Date.now = realNow
  }
})

test('the settings page exposes the session-cost controls', () => {
  const harness = boot()
  const view = mountSettings(harness, snapshotOf({ result: balanceResult([{ currency: 'CNY', total: '110.00' }]) }))
  const text = view.text()
  assert.match(text, /会话费用/u)
  assert.match(text, /显示会话费用/u)
  assert.match(text, /区分峰谷价/u)
  assert.match(text, /谷价 · 缓存命中/u)
  assert.match(text, /谷价 · 缓存未命中/u)
  assert.match(text, /谷价 · 输出/u)
  // The built-in tariff is the placeholder, so a blank field still explains
  // what will actually be charged.
  const placeholders = view.findAll(node => node.type === 'input').map(node => node.props.placeholder)
  for (const tariff of ['0.02', '1', '4']) {
    assert.ok(placeholders.includes(tariff), `the ${tariff} tariff must be the placeholder`)
  }
})

test('each switch is worded for its own label, not for showing and hiding', () => {
  const harness = boot()
  const view = mountSettings(harness, snapshotOf({ result: balanceResult([{ currency: 'CNY', total: '110.00' }]) }))
  // A switch row renders its label immediately before its two buttons, so the
  // reading order in the concatenated text is the check.
  const text = view.text()
  // The two VISIBILITY switches legitimately say show/hide.
  assert.match(text, /显示余额框显示隐藏/u)
  assert.match(text, /显示会话费用显示隐藏/u)
  // The pricing switch answers a behavioural question, so "隐藏" would say
  // nothing: it reads on/off.
  assert.match(text, /区分峰谷价开关/u)
  assert.doesNotMatch(text, /区分峰谷价隐藏/u)
})

test('the settings page surfaces a failure verbatim', () => {
  const harness = boot()
  const view = mountSettings(harness, snapshotOf({ phase: 'error', result: { ok: false, error: { code: 'no-credential', message: '没有找到名为 DEEPSEEK_API_KEY 的 API Key' } } }))
  assert.match(view.text(), /没有找到名为 DEEPSEEK_API_KEY 的 API Key/u)
})

test('the display settings store persists to browser storage and reads back', () => {
  const harness = boot()
  const store = storeOf(harness)
  assert.equal(store.getSnapshot().value.costEnabled, true)
  void store.set('costUnit', '元')
  void store.set('costPriceCacheMiss', 3)
  // A second plugin lifetime over the same storage must see the same settings:
  // that is what makes the Settings page survive a reload. `keepStorage` stops
  // this boot from wiping what the first one wrote.
  const reopened = boot({ keepStorage: true })
  const value = storeOf(reopened).getSnapshot().value
  assert.equal(value.costUnit, '元')
  assert.equal(value.costPriceCacheMiss, 3)
  // Defaults still fill everything the store did not hold.
  assert.equal(value.costPeakAware, true)
})

test('the display settings store returns a STABLE snapshot reference', () => {
  const harness = boot()
  const store = storeOf(harness)
  // `useSyncExternalStore` re-renders forever when `getSnapshot` hands back a new
  // object per call, so identity must hold until something actually changes.
  assert.equal(store.getSnapshot(), store.getSnapshot())
  const before = store.getSnapshot()
  void store.set('costUnit', '元')
  assert.notEqual(store.getSnapshot(), before)
  assert.equal(store.getSnapshot(), store.getSnapshot())
})

test('the display settings store degrades when browser storage is unavailable', () => {
  const harness = boot()
  // A private-mode or quota failure must leave the plugin on defaults and keep
  // accepting writes in memory, never throw inside a slot.
  const original = globalThis.window.localStorage
  globalThis.window.localStorage = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
  }
  try {
    const store = storeOf(harness)
    assert.equal(store.getSnapshot().status, 'ready')
    assert.equal(store.getSnapshot().value.costEnabled, true)
    void store.set('costUnit', '元')
    assert.equal(store.getSnapshot().value.costUnit, '元')
  } finally {
    globalThis.window.localStorage = original
  }
})

test('the settings page renders its controls when the display store is empty', () => {
  const harness = boot()
  const entry = slotEntry(harness, 'settings.section')
  const injected = entry.opts.inject()
  injected.runtime.getSnapshot = () => snapshotOf({ phase: 'loading' })
  const view = mount(entry.component, injected)
  const text = view.text()
  // A brand-new install has no stored preferences at all.
  assert.match(text, /余额显示/u)
  assert.match(text, /自动刷新间隔/u)
  assert.match(text, /尚未获取/u)
})
