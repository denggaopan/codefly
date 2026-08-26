import { describe, expect, it } from 'vitest'

import { CommandError, commandRunner } from './command-runner'

describe('commandRunner', () => {
  it('preserves UTF-8 stdout and stderr from a successful child', async () => {
    const result = await commandRunner.run(process.execPath, ['-e', "process.stdout.write('out\\n'); process.stderr.write('err\\n')"])

    expect(result).toEqual({ stdout: 'out\n', stderr: 'err\n', exitCode: 0 })
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
})
