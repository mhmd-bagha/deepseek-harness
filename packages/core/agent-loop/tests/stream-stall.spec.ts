import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { guardStreamStall, StreamStallError } from '../src/agent.ts'

const textChunk = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text })

async function *healthyStream(): AsyncGenerator<StreamChunk> {
  yield textChunk('one ')
  yield textChunk('two')
}

/** Never yields and never ends: a provider that went silent mid-turn. */
async function *stalledStream(): AsyncGenerator<StreamChunk> {
  yield textChunk('partial ')
  await new Promise<never>(() => {})
  // unreachable: keeps the generator open forever
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('guardStreamStall', () => {
  it('passes a healthy stream through untouched', async () => {
    const chunks = await collect(guardStreamStall(healthyStream(), 50, AbortSignal.timeout(5000)))
    expect(chunks.map(chunk => chunk.type === 'text-delta' ? chunk.text : '')).toEqual(['one ', 'two'])
  })

  it('throws StreamStallError when chunks stop arriving', async () => {
    const error = await collect(guardStreamStall(stalledStream(), 30, AbortSignal.timeout(5000)))
      .then(() => null, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(StreamStallError)
    expect((error as StreamStallError).code).toBe('stream-stall')
    expect((error as StreamStallError).stallTimeoutMs).toBe(30)
  })

  it('keeps chunks already delivered before the stall', async () => {
    const seen: StreamChunk[] = []
    const failure = await (async () => {
      try {
        for await (const chunk of guardStreamStall(stalledStream(), 30, AbortSignal.timeout(5000))) seen.push(chunk)
        return null
      } catch (error: unknown) {
        return error
      }
    })()
    expect(failure).toBeInstanceOf(StreamStallError)
    expect(seen).toHaveLength(1)
  })

  it('disables the watchdog when the timeout is 0', async () => {
    const chunks = await collect(guardStreamStall(healthyStream(), 0, AbortSignal.timeout(5000)))
    expect(chunks).toHaveLength(2)
  })

  it('aborts the wait when the step signal fires', async () => {
    const controller = new AbortController()
    const pending = collect(guardStreamStall(stalledStream(), 60_000, controller.signal))
      .then(() => 'resolved', () => 'rejected')
    controller.abort(new Error('steered'))
    await expect(pending).resolves.toBe('rejected')
  })

})
