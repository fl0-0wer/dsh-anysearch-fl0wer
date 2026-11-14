/**
 * dsh-anysearch — host half.
 *
 * Registers an `anysearch` search provider on the DSH web capability seam
 * (`ctx.web`), so the model-facing `web_search` tool runs on
 * https://api.anysearch.com/v1/search instead of whatever was configured before.
 *
 * Wire contract (verified against the live endpoint):
 *   POST https://api.anysearch.com/v1/search
 *   content-type: application/json
 *   authorization: Bearer <key>        (optional — the anonymous tier works keyless)
 *   body: { "query": string, "max_results": number }
 *   200 → { "code": 0, "message": "success", "request_id": "...",
 *           "data": { "results": [ { title, url, snippet, content } ],
 *                     "metadata": { total_results, search_time_ms } } }
 *
 * Design notes:
 * - Zero dependencies. Workspace-linked plugins are loaded from their real path,
 *   outside the profile's hoisted `node_modules`, so a bare `@deepseek-ai/*`
 *   import would not resolve. Everything here uses builtins + global fetch.
 * - No `Config` export on purpose: `resolveConfig()` only validates when a plugin
 *   ships a Schemastery schema, so the raw YAML section is handed to `apply()`
 *   as-is and read defensively below (`readField` tolerates both plain values and
 *   the accessor objects a resolved schema section exposes).
 * - A rejected key is NOT fatal: the request is retried anonymously once and the
 *   result carries a note, so a bad key degrades instead of killing search.
 */

export const name = 'dsh-anysearch'

/** The seam this provider registers into. */
export const inject = ['web']

/** Stable provider id; `web.searchProvider` refers to this string. */
export const ANYSEARCH_PROVIDER_ID = 'anysearch'

/** Default endpoint (full path — this API has no `/v1` + path split). */
export const ANYSEARCH_DEFAULT_URL = 'https://api.anysearch.com/v1/search'

/** Default credential reference read from the credentials service / launch env. */
export const ANYSEARCH_DEFAULT_KEY_ENV = 'ANYSEARCH_API_KEY'

const DEFAULT_TIMEOUT_MS = 20000
const DEFAULT_MAX_RESULTS = 8
const USER_AGENT = 'dsh-anysearch/1.0.0 (+deepseek-harness)'

/** Provider-specific error that still exposes the seam's machine-readable `code`. */
class AnySearchError extends Error {
  constructor(message, code = 'WEB_PROVIDER_ERROR', options) {
    super(message, options)
    this.name = 'AnySearchError'
    this.code = code
  }
}

/**
 * Read one config field from a raw section or a schema-resolved section.
 * @param {unknown} section - the plugin's config object.
 * @param {string} key - field name.
 * @param {unknown} fallback - value when absent/blank.
 * @returns {unknown} the field value.
 */
function readField(section, key, fallback) {
  const holder = section && typeof section === 'object' ? section[key] : undefined
  let value = holder
  if (holder && typeof holder === 'object' && typeof holder.get === 'function') {
    try {
      value = holder.get()
    } catch {
      value = undefined
    }
  }
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && value.trim().length === 0) return fallback
  return value
}

/** Positive integer or the fallback. */
function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

/** Coerce a possible accessor/array into a plain number. */
function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * Compose the caller's cancellation signal with our own timeout.
 * @param {AbortSignal|undefined} signal - upstream cancellation.
 * @param {number} timeoutMs - per-request budget.
 * @returns {{signal: AbortSignal, cleanup: () => void, timedOut: () => boolean}} controller bundle.
 */
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new AnySearchError(`AnySearch search timed out after ${timeoutMs}ms`, 'WEB_PROVIDER_ERROR'))
  }, timeoutMs)
  const onAbort = () => controller.abort(signal.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/** True when an error is our own abort (upstream cancel or our timeout). */
function isAbort(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'WEB_ABORTED'
}

/**
 * One AnySearch provider instance.
 *
 * `resolveOptions` is a thunk, not a value: the profile's YAML section can change
 * between two searches (hot config reload), and rebuilding the provider object
 * would make the seam's selected provider flicker out of the registry.
 */
class AnySearchProvider {
  id = ANYSEARCH_PROVIDER_ID

  /**
   * @param {() => object} resolveOptions - options for the NEXT operation, snapshotted at entry.
   * @param {any} ctx - plugin context, used only for `ctx.get('credentials')`.
   */
  constructor(resolveOptions, ctx) {
    this.resolveOptions = resolveOptions
    this.ctx = ctx
  }

  /** Usable as soon as an endpoint parses — the key is optional by design. */
  available() {
    const options = this.resolveOptions()
    if (options.disabled === true) return false
    try {
      return URL.canParse(options.url) || (URL.canParse(options.baseURL) && options.path.length > 0)
    } catch {
      return false
    }
  }

  /**
   * Run one search.
   * @param {{query: string, maxResults?: number}} request - the seam's search request.
   * @param {AbortSignal|undefined} signal - cancellation from the tool layer.
   * @returns {Promise<{sources: Array<{url: string, title?: string, snippet?: string}>, truncated: boolean, content?: string}>} normalized result.
   */
  async search(request, signal) {
    const query = typeof request?.query === 'string' ? request.query.trim() : ''
    if (query.length === 0) throw new AnySearchError('AnySearch search needs a non-empty query', 'WEB_PROVIDER_ERROR')
    const options = this.resolveOptions()
    const endpoint = this.endpointOf(options)
    const maxResults = positiveInt(request?.maxResults, options.maxResults)
    const credentials = await this.resolveKey(options, signal)
    const payload = JSON.stringify({ query, max_results: maxResults })
    const startedAt = Date.now()
    const trace = (fields) => recordDiagnostics(options, {
      query,
      endpoint,
      keySource: credentials.source,
      keyPresent: credentials.apiKey.length > 0,
      maxResults,
      elapsedMs: Date.now() - startedAt,
      ...fields,
    })

    const attempt = async (key) => {
      const { signal: scoped, cleanup, timedOut } = withTimeout(signal, options.timeoutMs)
      try {
        return await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': USER_AGENT,
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          body: payload,
          signal: scoped,
        })
      } catch (error) {
        if (signal?.aborted === true) throw new AnySearchError('AnySearch search aborted', 'WEB_ABORTED', { cause: error })
        if (timedOut() || isAbort(error)) {
          throw new AnySearchError(`AnySearch search request failed: ${String(error?.message ?? error)} (endpoint ${endpoint})`, 'WEB_PROVIDER_ERROR', { cause: error })
        }
        throw new AnySearchError(`AnySearch search request failed: ${String(error?.message ?? error)} (endpoint ${endpoint})`, 'WEB_PROVIDER_ERROR', { cause: error })
      } finally {
        cleanup()
      }
    }

    let rejectedKey = ''
    let response = await attempt(credentials.apiKey)
    if ((response.status === 401 || response.status === 403) && credentials.apiKey) {
      // A bad/expired key must not remove the capability: fall back to the free tier.
      rejectedKey = credentials.apiKey
      response = await attempt('')
    }

    if (!response.ok) {
      trace({ status: response.status, error: `http ${response.status}` })
      const detail = await safeErrorDetail(response, signal)
      const suffix = detail ? `: ${detail}` : ''
      if (response.status === 401 || response.status === 403) {
        throw new AnySearchError(
          `AnySearch rejected the request (HTTP ${response.status})${suffix}. The anonymous tier refused it too — check the key in ${credentials.source} or the network egress.`,
          'WEB_PROVIDER_ERROR',
        )
      }
      if (response.status === 429) {
        throw new AnySearchError(`AnySearch rate limit hit (HTTP 429)${suffix}; retry later or raise the quota with a key`, 'WEB_PROVIDER_ERROR')
      }
      throw new AnySearchError(`AnySearch API error (HTTP ${response.status})${suffix} (endpoint ${endpoint})`, 'WEB_PROVIDER_ERROR')
    }

    let body
    try {
      body = await response.json()
    } catch (error) {
      if (signal?.aborted === true) throw new AnySearchError('AnySearch search aborted', 'WEB_ABORTED', { cause: error })
      throw new AnySearchError(`AnySearch returned an unprocessable body (endpoint ${endpoint})`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (body?.code !== undefined && body.code !== 0) {
      throw new AnySearchError(`AnySearch API error: ${body?.message ?? body?.code}`, 'WEB_PROVIDER_ERROR')
    }

    const sources = mapSources(body)
    trace({
      status: response.status,
      requestId: typeof body?.request_id === 'string' ? body.request_id : undefined,
      totalResults: body?.data?.metadata?.total_results,
      searchTimeMs: body?.data?.metadata?.search_time_ms,
      sources: sources.length,
      rejectedKey: rejectedKey ? true : undefined,
    })
    if (sources.length === 0 && rejectedKey) {
      return {
        sources,
        truncated: false,
        content: `AnySearch key in ${credentials.source} was rejected (HTTP ${response.statusText || '401'}); this search ran on the free anonymous tier.`,
      }
    }
    return {
      sources,
      truncated: false,
      ...(rejectedKey
        ? { content: `AnySearch key in ${credentials.source} was rejected; fell back to the free anonymous tier.` }
        : {}),
    }
  }

  /** Build the effective endpoint from `url`, or `baseURL` + `path`. */
  endpointOf(options) {
    if (typeof options.url === 'string' && options.url.length > 0) return options.url
    const base = String(options.baseURL).replace(/\/+$/u, '')
    const path = String(options.path ?? '').startsWith('/') ? options.path : `/${options.path ?? ''}`
    return `${base}${path}`
  }

  /**
   * Resolve this operation's key without retaining it: literal config first, then
   * the credentials service (which is also where `~/.dsh/.env` lands), then the
   * process environment.
   * @returns {Promise<{apiKey: string, source: string}>} the key (possibly '') and where it came from.
   */
  async resolveKey(options, signal) {
    if (options.apiKey) return { apiKey: options.apiKey, source: 'config.apiKey' }
    const ref = options.apiKeyEnv
    if (options.allowCredentials !== false) {
      const credentials = this.ctx?.get?.('credentials')
      if (credentials?.resolve) {
        try {
          const record = await credentials.resolve(ref)
          const value = typeof record === 'string' ? record : record?.value
          if (typeof value === 'string' && value.length > 0) return { apiKey: value.trim(), source: `credentials ${ref}` }
        } catch (error) {
          if (signal?.aborted === true) throw new AnySearchError('AnySearch search aborted', 'WEB_ABORTED', { cause: error })
        }
      }
    }
    const ambient = process.env?.[ref]
    if (typeof ambient === 'string' && ambient.trim().length > 0) return { apiKey: ambient.trim(), source: `$${ref}` }
    return { apiKey: '', source: `$missing:${ref}` }
  }
}

/**
 * Append one JSON line to the configured diagnostics journal.
 *
 * Off unless `diagnostics` names a file. It exists so a real in-process search
 * can be proven to have sent the key (`keyPresent` / `keySource`) and to have
 * hit the configured endpoint — otherwise a silently ignored credential looks
 * exactly like a working one. Never throws, never blocks the search.
 * @param {object} options - resolved provider options.
 * @param {object} fields - the trace record.
 */
function recordDiagnostics(options, fields) {
  const target = options.diagnostics
  if (typeof target !== 'string' || target.length === 0) return
  const line = `${JSON.stringify({ ts: new Date().toISOString(), provider: ANYSEARCH_PROVIDER_ID, ...fields })}\n`
  writeJournalLine(target, line)
}

/** Hard cap on the diagnostics journal; one rotation keeps a single `.1` tail. */
const DIAGNOSTICS_MAX_BYTES = 2 * 1024 * 1024

/**
 * Append one line, rotating to `<path>.1` first when the journal grew past the cap.
 * Fire-and-forget: a diagnostics failure must never affect a search.
 * @param {string} target - journal path.
 * @param {string} line - the record.
 */
function writeJournalLine(target, line) {
  void import('node:fs/promises')
    .then(async (fs) => {
      try {
        const stat = await fs.stat(target)
        if (stat.size > DIAGNOSTICS_MAX_BYTES) await fs.rename(target, `${target}.1`)
      } catch {
        // no journal yet (or a racing rotation) — just append
      }
      await fs.appendFile(target, line, 'utf8')
    })
    .catch(() => {})
}

/** Pull a short error message out of a failed response without throwing. */async function safeErrorDetail(response, signal) {
  try {
    const text = await response.text()
    if (!text) return ''
    try {
      const parsed = JSON.parse(text)
      const message = parsed?.message ?? parsed?.error?.message ?? parsed?.error
      if (typeof message === 'string' && message.length > 0) return message.slice(0, 300)
    } catch {
      // not JSON — fall through to the raw text
    }
    return text.slice(0, 300)
  } catch (error) {
    if (signal?.aborted === true) return ''
    return ''
  }
}

/**
 * Normalize `data.results[]` into seam sources, deduping by URL and preferring
 * AnySearch's richer `content` field as the snippet when `snippet` is empty.
 * @param {any} body - parsed response body.
 * @returns {Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>} sources.
 */
function mapSources(body) {
  const results = Array.isArray(body?.data?.results) ? body.data.results : []
  const seen = new Set()
  const sources = []
  for (const item of results) {
    const url = typeof item?.url === 'string' ? item.url.trim() : ''
    if (url.length === 0 || seen.has(url)) continue
    seen.add(url)
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    const snippet = typeof item.snippet === 'string' && item.snippet.trim().length > 0
      ? item.snippet.trim()
      : typeof item.content === 'string'
        ? item.content.trim()
        : ''
    const publishedAt = typeof item.published_at === 'string'
      ? item.published_at
      : typeof item.date === 'string'
        ? item.date
        : undefined
    sources.push({
      url,
      ...(title.length > 0 ? { title } : {}),
      ...(snippet.length > 0 ? { snippet: snippet.slice(0, 600) } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    })
  }
  return sources
}

/**
 * Project the raw YAML section into one search's options. Defaults are applied
 * here (not in the provider) so every value the provider reads is fully formed.
 * @param {unknown} config - raw plugin config.
 * @returns {object} options for one operation.
 */
function resolveOptions(config) {
  const timeout = toNumber(readField(config, 'timeoutMs', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS)
  return {
    url: readField(config, 'url', ''),
    baseURL: readField(config, 'baseURL', 'https://api.anysearch.com'),
    path: readField(config, 'path', '/v1/search'),
    apiKey: String(readField(config, 'apiKey', '')),
    apiKeyEnv: String(readField(config, 'apiKeyEnv', ANYSEARCH_DEFAULT_KEY_ENV)),
    maxResults: positiveInt(readField(config, 'maxResults', DEFAULT_MAX_RESULTS), DEFAULT_MAX_RESULTS),
    timeoutMs: timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    disabled: readField(config, 'disabled', false) === true,
    allowCredentials: readField(config, 'allowCredentials', true) !== false,
    diagnostics: String(readField(config, 'diagnostics', '') ?? ''),
  }
}

/**
 * Register the AnySearch search provider with `ctx.web`.
 * @param {any} ctx - plugin context (must expose `web`).
 * @param {unknown} config - the section from `cordis.patch.yml` / the profile layer.
 */
export function apply(ctx, config) {
  // One provider per plugin instance; `registerSearchProvider` is effect-scoped
  // by the seam itself, so no extra ctx.effect wrapper is needed here.
  ctx.web.registerSearchProvider(new AnySearchProvider(() => resolveOptions(config), ctx))
}

export { AnySearchProvider, mapSources, resolveOptions }
