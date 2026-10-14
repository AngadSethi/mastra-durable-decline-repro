import { Agent } from '@mastra/core/agent';
import { EventedAgent } from '@mastra/core/agent/durable';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { z } from 'zod';

const model = 'openai/gpt-5-mini';

// A tool that must be approved by a human before it runs.
const issueRefund = createTool({
  id: 'issueRefund',
  description: 'Refund an order',
  inputSchema: z.object({ orderId: z.string() }),
  requireApproval: true,
  execute: async ({ orderId }) => ({ refunded: orderId }),
});

// Subagent that owns the approval tool.
const billingAgent = new Agent({
  id: 'billing',
  name: 'billing',
  description: 'Handles refunds',
  instructions: `Issue refunds when asked by calling issueRefund.
If the issueRefund call is declined, do not retry it. Reply with "BILLING SAW DECLINE:" followed by the decline reason, word for word.`,
  model,
  tools: { issueRefund },
});

const supportInstructions = `Delegate every refund request to the billing agent. Never refund anything yourself.
After the billing agent finishes, tell the user exactly what the billing agent replied, word for word, or that the delegation was denied and with what reason.`;

// Supervisor on the regular agent loop: a decline propagates down to the billing agent.
export const supportAgent = new Agent({
  id: 'support',
  name: 'Support (regular)',
  instructions: supportInstructions,
  model,
  memory: new Memory(),
  agents: { billing: billingAgent },
});

// The same supervisor on the durable loop: a decline stops at the supervisor.
export const durableSupportAgent = new EventedAgent({
  agent: new Agent({
    id: 'durable-support',
    name: 'Support (durable)',
    instructions: supportInstructions,
    model,
    memory: new Memory(),
    agents: { billing: billingAgent },
  }),
});
