import { net } from 'electron'

/** The request both update services hand to their fetch: a URL, plain headers, an optional abort. */
export type NetFetchInit = { headers: Record<string, string>; signal?: AbortSignal }

/**
 * The slice of a fetch Response the update services read. The update check only looks at
 * `ok`, `status` and `json()`; the installer download also needs `headers` (Content-Length)
 * and the streamed `body`, which is written to disk chunk by chunk and never held in memory.
 */
export type NetFetchResponse = {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  body: AsyncIterable<Uint8Array> | null
}

export type NetFetchLike = (url: string, init: NetFetchInit) => Promise<NetFetchResponse>

/** Electron's `net.fetch`, narrowed to what the adapter passes — injectable so tests never touch Chromium. */
export type NetFetch = (url: string, init: RequestInit) => Promise<Response>

export const createNetFetch =
  (netFetch: NetFetch): NetFetchLike =>
  async (url, init) => {
    // These requests only ever reach GitHub's public API and release CDN; nothing the default
    // session may be holding (cookies, cached credentials) has any business riding along.
    const response = await netFetch(url, { headers: init.headers, signal: init.signal, credentials: 'omit' })
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      json: () => response.json(),
      // Electron answers with a web ReadableStream, which is async-iterable in Node.
      body: response.body as AsyncIterable<Uint8Array> | null
    }
  }

/**
 * GitHub requests through Chromium's network stack instead of Node's global `fetch`.
 *
 * The difference is the proxy. Node's fetch (undici) connects directly and ignores both the
 * Windows proxy settings and HTTP(S)_PROXY, so on a machine that reaches GitHub through a
 * proxy — the norm wherever GitHub is throttled — the in-app installer download crawled at
 * ~10 KB/s while the same file arrived in seconds in the browser. `net.fetch` resolves the
 * proxy the way Chromium does, so the download runs at the speed the user sees everywhere
 * else. Explicit request headers (including `Accept-Encoding: identity`) are sent as given.
 *
 * Only usable after the app `ready` event — which is where the services that use it are built.
 */
export const electronFetch: NetFetchLike = (url, init) =>
  createNetFetch((target, options) => net.fetch(target, options))(url, init)
