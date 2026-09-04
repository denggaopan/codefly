// @vitest-environment node

import type { ConfigEnv, Plugin, UserConfig } from 'vite'
import { describe, expect, it } from 'vitest'

import config from '../electron.vite.config'

const applyConfigHook = async (plugin: Plugin, target: UserConfig): Promise<void> => {
  const hook = plugin.config
  if (hook === undefined) return
  const handler = typeof hook === 'function' ? hook : hook.handler
  await handler.call({} as never, target, { command: 'build', mode: 'production' } as ConfigEnv)
}

describe('electron-vite main build', () => {
  it('bundles dependencies the staged pty-host cannot resolve while leaving node-pty external', async () => {
    const main = config.main
    expect(main).toBeDefined()

    const plugins = (main?.plugins ?? []).flat().filter((plugin): plugin is Plugin => Boolean(plugin))
    const externalizer = plugins.find((plugin) => plugin.name === 'vite:externalize-deps')
    expect(externalizer).toBeDefined()

    const resolved: UserConfig = {}
    await applyConfigHook(externalizer!, resolved)
    const external = resolved.build?.rollupOptions?.external

    expect(external).toEqual(expect.arrayContaining(['node-pty']))
    expect(external).not.toEqual(expect.arrayContaining(['zod']))
  })
})
