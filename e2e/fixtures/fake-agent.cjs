#!/usr/bin/env node
'use strict'

/**
 * Deterministic stand-in for the real `claude`/`codex` CLIs, used only when the app is
 * launched with CODEFLY_E2E=1 (see src/main/index.ts). It plays two roles with the exact
 * same script, distinguished only by how it is invoked:
 *
 *  - Interactive PTY: TerminalService spawns it (through a cmd.exe shim, see
 *    fake-agent.cmd) with the fixed bypass argv for the session kind. It stays alive,
 *    echoing every line of stdin back to stdout, until it receives a line that is exactly
 *    "exit", or its stdin is closed.
 *  - Title generation: TitleService spawns it non-interactively with a `--print` /
 *    `exec ...` style argv and pipes the full title prompt into stdin, then closes stdin.
 *    This script echoes whatever it received and exits 0 once stdin ends, which is enough
 *    for TitleService to capture non-empty output and sanitize/truncate it.
 *
 * In both roles, on startup it writes its own `process.argv.slice(2)` as JSON to the file
 * named by the CODEFLY_E2E_ARGV_LOG environment variable (when set) BEFORE printing a ready
 * marker, so a test can assert exactly which argv a given launch received: the composition
 * root points CODEFLY_E2E_ARGV_LOG at a different file per role (see
 * buildE2ETitleAdapters/CODEFLY_E2E_TITLE_ARGV_LOG in src/main/index.ts), so the interactive
 * launch argv and the title-process argv never collide.
 */

const fs = require('node:fs')

const argv = process.argv.slice(2)
const logPath = process.env.CODEFLY_E2E_ARGV_LOG
if (logPath) {
  fs.writeFileSync(logPath, JSON.stringify(argv), 'utf8')
}

process.stdout.write('CODEFLY_E2E_FAKE_AGENT_READY\n')

let buffer = ''

const handleLine = (line) => {
  if (line.trim() === 'exit') {
    process.exit(0)
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  const text = String(chunk)
  process.stdout.write(chunk)
  buffer += text
  const lines = buffer.split(/\r?\n/)
  buffer = lines.pop() ?? ''
  for (const line of lines) handleLine(line)
})

// The non-interactive title flow writes the whole prompt then immediately closes stdin
// (child.stdin.end(prompt)); the interactive PTY flow normally never reaches 'end' during
// ordinary use. Either way, once stdin closes there is nothing left to serve.
process.stdin.on('end', () => {
  process.exit(0)
})
