import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/**
 * Test-local stand-in for the todo tool's `todos` projection unit: last
 * `todo/write` wins. Lets the suite exercise the driver's auto-continue
 * without depending on the todo package.
 */
function registerTodosProjection(ctx: Context): void {
  ctx.sessionProjections.register({
    key: 'todos' as never,
    stateVersion: 1,
    stateSchema: z.array(z.object({ content: z.string(), status: z.string() })).nullable(),
    init: () => null,
    apply: (state: unknown, event: { type: string; data?: unknown }) => {
      if (event.type === 'todo/write') {
        return (event.data as { todos: unknown }).todos
      }
      return state
    },
  })
}

async function harnessWithTodos(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  registerTodosProjection(ctx)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

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

describe('todo auto-continue', () => {
  it('continues the turn while todos stay open, bounded by the per-turn cap', async () => {
    const adapter = new MockAdapter([
      textResponse('status announcement'),
      textResponse('still announcing'),
      textResponse('announcing again'),
      textResponse('fourth announcement'),
      textResponse('fifth announcement'),
      textResponse('done after cap'),
    ])
    const ctx = await harnessWithTodos(adapter)
    const agent = await ctx.agentLoop.create(SessionId('todo-auto-continue'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.session.append('todo/write', {
      todos: [{ content: 'unfinished work', status: 'in_progress' }],
    } as never)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // 1 initial step + 5 driver continuations, then the turn ends at the cap.
    expect(adapter.requests).toHaveLength(6)
    const lastReason = agent.session.snapshotEvents().at(-1)
    expect(lastReason).toMatchObject({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }, 30000)

  it('ends normally when every todo is completed', async () => {
    const adapter = new MockAdapter([textResponse('all done')])
    const ctx = await harnessWithTodos(adapter)
    const agent = await ctx.agentLoop.create(SessionId('todo-auto-continue-clean'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.session.append('todo/write', {
      todos: [{ content: 'finished work', status: 'completed' }],
    } as never)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
  }, 30000)

  it('ends normally with no todo list at all', async () => {
    const adapter = new MockAdapter([textResponse('plain reply')])
    const ctx = await harnessWithTodos(adapter)
    const agent = await ctx.agentLoop.create(SessionId('todo-auto-continue-none'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
  }, 30000)
})
