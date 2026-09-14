import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent, type AssistantStreamFrame } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/** Wait for the agent's next transition to idle after a waking send. */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('stream stall recovery', () => {
  it('abandons a silent stream and retries the attempt', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [], streamStallTimeoutMs: 10_000 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      {
        hangAfter: [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: 'partial' },
        ],
      },
      textResponse('recovered'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('stream-stall-retry'), {
      provider: 'mock',
      model: 'mock',
    })
    const frames: AssistantStreamFrame[] = []
    ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject === agent) frames.push(frame)
    })
    const failures: unknown[] = []
    ctx.on('agent/request-error', async ({ failure }) => {
      failures.push(failure)
      return { kind: 'retry' as const }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover me' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(failures).toHaveLength(1)
    expect(frames.filter(frame => frame.type === 'start')).toHaveLength(2)
    expect(frames.filter(frame => frame.type === 'end').map(frame => (
      frame.outcome.kind === 'committed' ? frame.outcome.eventType : frame.outcome.kind
    ))).toEqual(['assistant/attempt', 'assistant/message'])
  }, 30000)
})
