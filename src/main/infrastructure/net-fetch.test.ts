import { describe, expect, it } from 'vitest'

import { createNetFetch, type NetFetch } from './net-fetch'

const URL = 'https://api.github.com/repos/denggaopan/codefly/releases/latest'

const streamOf = (chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) yield chunk
  }
})

type Call = { url: string; init: RequestInit }

/**
 * Stands in for Electron's `net.fetch`. Records what it was asked and answers with a
 * Response-shaped object: `Response` itself is a Chromium-side type here, and the adapter
 * only ever reads the fields this fake provides.
 */
const fakeNetFetch = (answer: Partial<Response>, calls: Call[]): NetFetch => {
  return async (url, init) => {
    calls.push({ url, init })
    return answer as Response
  }
}

describe('createNetFetch', () => {
  it('forwards the URL, headers and abort signal to net.fetch without session cookies', async () => {
    const calls: Call[] = []
    const fetch = createNetFetch(fakeNetFetch({ ok: true, status: 200 }, calls))
    const controller = new AbortController()

    await fetch(URL, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'CodeFly' }, signal: controller.signal })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(URL)
    expect(calls[0]!.init.headers).toEqual({ Accept: 'application/octet-stream', 'User-Agent': 'CodeFly' })
    expect(calls[0]!.init.signal).toBe(controller.signal)
    // The requests only ever go to GitHub's public API and CDN; nothing the default session
    // may hold should ride along.
    expect(calls[0]!.init.credentials).toBe('omit')
  })

  it('exposes status, headers, JSON and the streamed body of the response', async () => {
    const body = streamOf([new Uint8Array(3), new Uint8Array(5)])
    const headers = new Headers({ 'content-length': '8' })
    const fetch = createNetFetch(
      fakeNetFetch(
        {
          ok: true,
          status: 200,
          headers,
          json: async () => ({ tag_name: 'v1.2.3' }),
          body: body as unknown as ReadableStream<Uint8Array>
        },
        []
      )
    )

    const response = await fetch(URL, { headers: {} })

    expect(response.ok).toBe(true)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('8')
    await expect(response.json()).resolves.toEqual({ tag_name: 'v1.2.3' })

    const received: number[] = []
    for await (const chunk of response.body!) received.push(chunk.byteLength)
    expect(received).toEqual([3, 5])
  })

  it('reports a failed response as-is and a missing body as null', async () => {
    const fetch = createNetFetch(fakeNetFetch({ ok: false, status: 404, headers: new Headers(), body: null }, []))

    const response = await fetch(URL, { headers: {} })

    expect(response.ok).toBe(false)
    expect(response.status).toBe(404)
    expect(response.body).toBeNull()
  })

  it('lets a rejection from net.fetch propagate so callers can classify it', async () => {
    const failure = new Error('net::ERR_CONNECTION_RESET')
    const fetch = createNetFetch(async () => {
      throw failure
    })

    await expect(fetch(URL, { headers: {} })).rejects.toBe(failure)
  })
})
