# [BUG] Durable agents don't propagate a declined subagent tool approval back down to the subagent

### Describe the Bug

The supervisor agent docs on tool approvals say that when a subagent calls a tool with `requireApproval: true`, the approval bubbles up to the supervisor, you approve or decline there, and "the decision propagates back down to the subagent."

With a regular `Agent`, that's what happens for both decisions. With a durable agent (`EventedAgent`), only **approve** propagates down. A **decline** is resolved at the supervisor instead: the supervisor's `agent-<name>` delegation call is marked `tool-output-denied`, the subagent is never resumed, and the decline reason is never delivered to the subagent. The subagent's run stays suspended.

The tool-call steps of the two loops disagree on whether a delegated approval is the supervisor's own approval. Links are to the `@mastra/core@1.77.0` tag; the code is unchanged in substance on `main` as of c8c439d.

**Regular loop**: [`packages/core/src/loop/workflows/agentic-execution/tool-call-step.ts#L505-L538`](https://github.com/mastra-ai/mastra/blob/9eab73f0e54e6714f329dd598c5b31ec7b643f64/packages/core/src/loop/workflows/agentic-execution/tool-call-step.ts#L505-L538) (L510-L540 on `main`). It excludes delegated approvals from the approval gate, and its comment says this matters "especially [for] declines":

```ts
// Nested sub-agent/workflow approvals also write `requireToolApproval` on the
// outer suspend payload, but they additionally set `suspendedToolRunId`. Those
// must resume into the nested tool path — not the outer approval short-circuit —
// even when a live outer `requireToolApproval` policy is still present.
const isDelegatedApproval = Boolean(
  suspendData &&
  typeof suspendData === 'object' &&
  (suspendData as { suspendedToolRunId?: unknown }).suspendedToolRunId,
);
// ...
const approvalGated =
  !isDelegatedApproval && (suspendedForApproval || (toolRequiresApproval && suspendData === undefined));
```

**Durable loop**: [`packages/core/src/agent/durable/workflows/steps/tool-call.ts#L936-L940`](https://github.com/mastra-ai/mastra/blob/9eab73f0e54e6714f329dd598c5b31ec7b643f64/packages/core/src/agent/durable/workflows/steps/tool-call.ts#L936-L940) (L937-L942 on `main`). It has no such exclusion:

```ts
const suspendedForApproval =
  suspendData != null &&
  typeof suspendData === 'object' &&
  (suspendData as { type?: unknown }).type === 'approval';
const approvalGated = suspendedForApproval || (requiresApproval && suspendData === undefined);
```

When a subagent's approval bubbles up, the durable step suspends the delegation call with `{ type: 'approval', requireToolApproval: {...}, suspendedToolRunId }` ([L1308-L1316](https://github.com/mastra-ai/mastra/blob/9eab73f0e54e6714f329dd598c5b31ec7b643f64/packages/core/src/agent/durable/workflows/steps/tool-call.ts#L1308-L1316)). On resume, `type: 'approval'` makes it approval-gated, so the decision is treated as an approval of the delegation tool itself:

- `approved: true` sets `approvalGrant`, and [`isDelegatedApprovalResume`](https://github.com/mastra-ai/mastra/blob/9eab73f0e54e6714f329dd598c5b31ec7b643f64/packages/core/src/agent/durable/workflows/steps/tool-call.ts#L1121-L1136) passes `suspendedToolRunId` to the delegation tool, which resumes the subagent. Approve works.
- `approved: false` takes the [early return at L1005-L1060](https://github.com/mastra-ai/mastra/blob/9eab73f0e54e6714f329dd598c5b31ec7b643f64/packages/core/src/agent/durable/workflows/steps/tool-call.ts#L1005-L1060) (L1058 on `main`), which emits `tool-output-denied` for the delegation call before the delegation tool runs. The subagent never sees the decision.

Related: #20492 fixed the durable **approve** path for delegated approvals (persisting `delegatedRunId`), and #24561 was another case of the durable and regular tool-call steps handling the same approval resume differently. #19753 (open) proposes routing durable resumes by the persisted suspension kind, which may cover this, but it doesn't mention delegated declines.

### Impact

In our production app, a supervisor delegates media searches to a subagent whose video-generation tool requires approval. A reviewer declines a generation with a note such as "Use video 39962 instead." The subagent never sees the note, so it can't act on it. The supervisor gets a bare denial and delegates the same brief again, the new subagent run asks to generate the same video again, and the reviewer ends up approving or declining the same thing repeatedly.

The subagent also can't follow its own instructions for a declined tool (for example "report that no suitable video was found and include the reason"), because it never gets control back.

### Steps To Reproduce

Single file, run with `node repro.mjs` against `@mastra/core@1.77.0` + `@mastra/libsql@1.26.1` + `zod@4`. The models are scripted `LanguageModelV2` objects, so no API key or network access is needed. Each scenario uses fresh agents, and both use the public `declineToolCall()` / `approveToolCall()` methods.

```js
import { rmSync } from 'node:fs';
import { Agent } from '@mastra/core/agent';
import { EventedAgent } from '@mastra/core/agent/durable';
import { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';

// A scripted LanguageModelV2: no network, no API key. `respond` maps the prompt to the parts to stream.
function scriptedModel(modelId, respond) {
  const model = {
    specificationVersion: 'v2',
    provider: 'scripted',
    modelId,
    supportedUrls: {},
    calls: 0,
    async doGenerate() {
      throw new Error('doGenerate is not used by this repro');
    },
    async doStream({ prompt }) {
      model.calls++;
      const parts = respond(prompt);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            parts.forEach((part) => controller.enqueue(part));
            controller.close();
          },
        }),
      };
    },
  };

  return model;
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const callTool = (toolCallId, toolName, input) => [
  { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: 'tool-calls', usage },
];
const reply = (text) => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: 'stop', usage },
];
const lastToolOutput = (prompt) => prompt.filter((message) => message.role === 'tool').at(-1)?.content.at(-1)?.output;

function buildScenario(label) {
  const log = { refundsExecuted: 0, billingSaw: null };

  // A tool that must be approved by a human before it runs.
  const issueRefund = createTool({
    id: 'issueRefund',
    description: 'Refund an order',
    inputSchema: z.object({ orderId: z.string() }),
    requireApproval: true,
    execute: async ({ orderId }) => {
      log.refundsExecuted++;
      return { refunded: orderId };
    },
  });

  // Subagent: calls issueRefund, then reports whatever result it got back for that call.
  const billingModel = scriptedModel('billing', (prompt) => {
    const output = lastToolOutput(prompt);

    if (!output) {
      return callTool('refund-call', 'issueRefund', { orderId: '42' });
    }

    log.billingSaw = output;

    return reply(`billing got: ${JSON.stringify(output)}`);
  });

  const billing = new Agent({
    id: `${label}-billing`,
    name: 'billing',
    description: 'Handles refunds',
    instructions: 'Issue refunds when asked.',
    model: billingModel,
    tools: { issueRefund },
  });

  // Supervisor: delegates to the subagent, then reports the delegation's result.
  const supportModel = scriptedModel('support', (prompt) => {
    const output = lastToolOutput(prompt);

    if (!output) {
      return callTool('delegate-call', 'agent-billing', { prompt: 'Refund order 42' });
    }

    return reply(`support got: ${JSON.stringify(output)}`);
  });

  const support = new Agent({
    id: `${label}-support`,
    name: 'support',
    instructions: 'Delegate refunds to the billing agent.',
    model: supportModel,
    agents: { billing },
  });

  return { support, billing, billingModel, log };
}

async function drain(stream, chunks) {
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
}

async function run(label, agent, scenario, decision, streamOptions = {}) {
  const chunks = [];
  const first = await agent.stream('Refund order 42', streamOptions);
  await drain(first.fullStream, chunks);

  const approval = chunks.find((chunk) => chunk.type === 'tool-call-approval');

  if (!approval) {
    throw new Error(`${label}: the run never asked for approval`);
  }

  const billingCallsBeforeDecision = scenario.billingModel.calls;
  const decisionOptions = { runId: first.runId, toolCallId: approval.payload.toolCallId, ...streamOptions };
  const resumed =
    decision === 'approve'
      ? await agent.approveToolCall(decisionOptions)
      : await agent.declineToolCall({ ...decisionOptions, reason: 'Refund order 43 instead.' });
  const afterDecision = [];
  await drain(resumed.fullStream, afterDecision);

  const delegationOutcome = afterDecision.find(
    (chunk) => ['tool-result', 'tool-output-denied'].includes(chunk.type) && chunk.payload.toolName === 'agent-billing',
  );

  console.log(`\n=== ${label}: ${decision} ===`);
  console.log('approval surfaced at supervisor:', {
    toolCallId: approval.payload.toolCallId,
    toolName: approval.payload.toolName,
  });
  console.log(`subagent model calls after ${decision}:`, scenario.billingModel.calls - billingCallsBeforeDecision);
  console.log('subagent saw for issueRefund:', JSON.stringify(scenario.log.billingSaw));
  console.log('supervisor saw for agent-billing:', delegationOutcome?.type, JSON.stringify(delegationOutcome?.payload.result ?? delegationOutcome?.payload.approval));
  console.log('issueRefund executed:', scenario.log.refundsExecuted);
}

rmSync('./repro.db', { force: true });

const scenarios = {
  regularDecline: buildScenario('regular-decline'),
  durableDecline: buildScenario('durable-decline'),
  regularApprove: buildScenario('regular-approve'),
  durableApprove: buildScenario('durable-approve'),
};

const mastra = new Mastra({
  agents: {
    regularDecline: scenarios.regularDecline.support,
    durableDecline: new EventedAgent({ agent: scenarios.durableDecline.support }),
    regularApprove: scenarios.regularApprove.support,
    durableApprove: new EventedAgent({ agent: scenarios.durableApprove.support }),
  },
  storage: new LibSQLStore({ id: 'repro-storage', url: 'file:./repro.db' }),
  logger: false,
});

await run('Agent (regular loop)', mastra.getAgent('regularDecline'), scenarios.regularDecline, 'decline');
await run('EventedAgent (durable loop)', mastra.getAgent('durableDecline'), scenarios.durableDecline, 'decline', {
  closeOnSuspend: true,
});
await run('Agent (regular loop)', mastra.getAgent('regularApprove'), scenarios.regularApprove, 'approve');
await run('EventedAgent (durable loop)', mastra.getAgent('durableApprove'), scenarios.durableApprove, 'approve', {
  closeOnSuspend: true,
});

process.exit(0);
```

Output (subagent thread and resource IDs trimmed):

```
=== Agent (regular loop): decline ===
approval surfaced at supervisor: { toolCallId: 'delegate-call', toolName: 'issueRefund' }
subagent model calls after decline: 1
subagent saw for issueRefund: {"type":"text","value":"Refund order 43 instead."}
supervisor saw for agent-billing: tool-result {"text":"billing got: {\"type\":\"text\",\"value\":\"Refund order 43 instead.\"}",...,"subAgentToolResults":[]}
issueRefund executed: 0

=== EventedAgent (durable loop): decline ===
approval surfaced at supervisor: { toolCallId: 'delegate-call', toolName: 'issueRefund' }
subagent model calls after decline: 0
subagent saw for issueRefund: null
supervisor saw for agent-billing: tool-output-denied {"id":"delegate-call","approved":false,"reason":"Refund order 43 instead."}
issueRefund executed: 0

=== Agent (regular loop): approve ===
approval surfaced at supervisor: { toolCallId: 'delegate-call', toolName: 'issueRefund' }
subagent model calls after approve: 1
subagent saw for issueRefund: {"type":"json","value":{"refunded":"42"}}
supervisor saw for agent-billing: tool-result {"text":"billing got: {\"type\":\"json\",\"value\":{\"refunded\":\"42\"}}",...,"subAgentToolResults":[{"toolName":"issueRefund","toolCallId":"refund-call","result":{"refunded":"42"},"args":{"orderId":"42"}}]}
issueRefund executed: 1

=== EventedAgent (durable loop): approve ===
approval surfaced at supervisor: { toolCallId: 'delegate-call', toolName: 'issueRefund' }
subagent model calls after approve: 1
subagent saw for issueRefund: {"type":"json","value":{"refunded":"42"}}
supervisor saw for agent-billing: tool-result {"text":"billing got: {\"type\":\"json\",\"value\":{\"refunded\":\"42\"}}",...,"subAgentToolResults":[{"toolName":"issueRefund","toolCallId":"refund-call","result":{"refunded":"42"},"args":{"orderId":"42"}}]}
issueRefund executed: 1
```

The durable decline is the only case where the subagent is not resumed (0 model calls) and the supervisor gets `tool-output-denied` for `agent-billing` instead of the subagent's result.

### Link to Minimal Reproducible Example

Inline above: a single self-contained file, with no model provider and no network access.

### Expected Behavior

A declined subagent tool approval on a durable agent behaves like it does on a regular `Agent`, and as the docs describe: the decision propagates back down. The subagent is resumed, its tool call is declined with the given reason, and the subagent continues. The supervisor then receives the subagent's result for the delegation call.

Applying the regular loop's `isDelegatedApproval` exclusion to `approvalGated` in `packages/core/src/agent/durable/workflows/steps/tool-call.ts` would align the two, so the resume data reaches the delegation tool, which already resumes the subagent via `suspendedToolRunId`. The approve path would then need to keep working without `approvalGrant`, since `isDelegatedApprovalResume` currently depends on it.

### Workaround

None in Mastra that delivers the decline to the subagent. We handle declines in the supervisor's instructions instead, which means telling the supervisor what to do with the reviewer's note, a job that belongs to the subagent.

### Environment

- `@mastra/core`: 1.77.0 (repro); 1.76.0 (production)
- Durable agent: `EventedAgent`
- Storage: `@mastra/libsql` 1.26.1 (repro); `@mastra/mysql` (production)
- Node.js: 23.7.0 (repro)
