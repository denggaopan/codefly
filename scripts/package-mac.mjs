#!/usr/bin/env node
// Produces the macOS bundles — release/<Product>-<version>-mac-{x64,arm64}.zip — from
// a non-macOS host.
//
// electron-builder refuses `--mac` on Windows outright, so the packaging step runs
// in a Linux container (scripts/mac-builder.Dockerfile) with this repository
// bind-mounted. Everything platform-independent still happens on the host: `npm run
// package:mac` builds out/ here first, and the container only reuses the host's
// node_modules (node-pty ships darwin prebuilds, so nothing needs compiling).
//
// What the container cannot do — and what this script does not pretend to do — is
// sign or notarize the bundle; see README.md § Packaging.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'codefly-mac-builder'
const DOCKERFILE = path.join('scripts', 'mac-builder.Dockerfile')
const CONTAINER_SCRIPT = 'scripts/package-mac.container.sh'
// On Linux, electron-builder keeps its toolsets under ~/.cache/electron-builder and
// @electron/get keeps the Electron zips under ~/.cache/electron; persisting the
// parent on the host turns every run after the first into a no-download build.
const CONTAINER_CACHE = '/root/.cache'
const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']
// Matches the host part of a proxy URL ("//user:pw@127.0.0.1:10808") when it is a
// loopback address, which inside the container would point at the container itself.
const LOOPBACK_HOST = /(\/\/(?:[^@/]*@)?)(127(?:\.\d{1,3}){3}|localhost|\[::1\])(?=[:/]|$)/i

const fail = (message) => {
  console.error(`package:mac: ${message}`)
  process.exit(1)
}

const hostCacheDir = () =>
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'codefly-mac-builder', 'cache')
    : path.join(homedir(), '.cache', 'codefly-mac-builder')

/** Host proxy settings, rewritten so a loopback proxy is reached through Docker's host alias. */
const containerProxyEnvironment = () => {
  const environment = {}
  for (const name of PROXY_VARIABLES) {
    const value = process.env[name]
    if (!value) continue
    environment[name] = name.toLowerCase() === 'no_proxy' ? value : value.replace(LOOPBACK_HOST, '$1host.docker.internal')
  }
  return environment
}

const docker = (args, { capture = false } = {}) => {
  const result = spawnSync('docker', args, {
    cwd: projectDir,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8'
  })
  if (result.error) {
    if (result.error.code === 'ENOENT') fail('docker was not found on PATH. Install and start Docker Desktop, then retry.')
    throw result.error
  }
  return result
}

const ensureBuiltInputs = () => {
  if (!existsSync(path.join(projectDir, 'node_modules', 'electron-builder', 'cli.js'))) {
    fail('node_modules is missing electron-builder. Run `npm install` first.')
  }
  if (!existsSync(path.join(projectDir, 'out', 'main', 'index.js'))) {
    fail('out/ has not been built. Run `npm run build` first (or use `npm run package:mac`).')
  }
}

const ensureDockerDaemon = () => {
  const probe = docker(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], { capture: true })
  if (probe.status !== 0) {
    fail(`the Docker daemon is not reachable (${probe.stderr.trim() || 'no details'}). Start Docker Desktop and retry.`)
  }
  console.log(`package:mac: Docker daemon ${probe.stdout.trim()}`)
}

const main = () => {
  ensureBuiltInputs()
  ensureDockerDaemon()

  const proxyEnvironment = containerProxyEnvironment()
  const proxyArguments = (flag) => Object.entries(proxyEnvironment).flatMap(([name, value]) => [flag, `${name}=${value}`])
  if (Object.keys(proxyEnvironment).length > 0) {
    console.log(`package:mac: forwarding proxy settings ${Object.keys(proxyEnvironment).join(', ')} into the container`)
  }

  console.log(`package:mac: building image ${IMAGE}`)
  const build = docker(['build', '--tag', IMAGE, '--file', DOCKERFILE, ...proxyArguments('--build-arg'), 'scripts'])
  if (build.status !== 0) fail(`docker build exited with ${build.status}`)

  const cacheDir = hostCacheDir()
  mkdirSync(cacheDir, { recursive: true })
  console.log(`package:mac: Electron download cache ${cacheDir}`)

  const run = docker([
    'run',
    '--rm',
    ...(process.stdout.isTTY ? ['--tty'] : []),
    '--mount', `type=bind,src=${projectDir},dst=/project`,
    '--mount', `type=bind,src=${cacheDir},dst=${CONTAINER_CACHE}`,
    '--workdir', '/project',
    ...proxyArguments('--env'),
    IMAGE,
    'sh', CONTAINER_SCRIPT
  ])
  if (run.status !== 0) fail(`the container build exited with ${run.status}`)
  console.log('package:mac: done — bundles are under release/. They are unsigned; see README.md § Packaging.')
}

main()
