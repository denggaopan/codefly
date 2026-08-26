import { describe, expect, it } from 'vitest'

import { COMMAND_MAX_BUFFER_BYTES, CommandError, commandRunner } from './command-runner'

describe('commandRunner', () => {
  it('preserves UTF-8 stdout and stderr from a successful child', async () => {
    const result = await commandRunner.run(process.execPath, ['-e', "process.stdout.write('out \\u00e9\\n'); process.stderr.write('err \\u6f22\\n')"])

    expect(result).toEqual({ stdout: 'out \u00e9\n', stderr: 'err \u6f22\n', exitCode: 0 })
  })

  it('reports nonzero child output in a CommandError', async () => {
    const file = process.execPath
    const args = ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"]

    await expect(commandRunner.run(file, args)).rejects.toMatchObject({
      file,
      args,
      result: { stdout: 'out', stderr: 'err', exitCode: 7 }
    } satisfies Partial<CommandError>)
  })

  it('passes metacharacters as one literal argument without a shell', async () => {
    const literal = 'hello world & echo injected; $(nope)'
    const result = await commandRunner.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal])

    expect(result.stdout).toBe(literal)
  })

  it('retains spawn diagnostics for a missing executable', async () => {
    const file = `codefly-missing-${process.pid}.exe`

    await expect(commandRunner.run(file, [])).rejects.toMatchObject({
      file,
      code: expect.any(String),
      result: { stdout: '', stderr: '', exitCode: -1 },
      cause: expect.any(Error)
    } satisfies Partial<CommandError>)
  })

  it('limits command output and retains overflow diagnostics', async () => {
    await expect(commandRunner.run(process.execPath, ['-e', `process.stdout.write('x'.repeat(${COMMAND_MAX_BUFFER_BYTES + 1}))`])).rejects.toMatchObject({
      result: { stdout: expect.any(String), stderr: expect.any(String), exitCode: -1 },
      cause: expect.any(Error)
    } satisfies Partial<CommandError>)
  })
})
