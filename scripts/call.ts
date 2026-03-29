/**
 * CLI helper to trigger a call.
 *
 * Usage:
 *   npx ts-node scripts/call.ts [order.json] [target_number]
 *
 * Reads order JSON from file, POSTs to /api/calls, polls for result.
 */

import fs from 'fs';
import path from 'path';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000';

async function main() {
  const args = process.argv.slice(2);
  const orderFile = args[0] ?? path.join(__dirname, 'test-order.json');
  const targetNumber = args[1];

  // Read order
  if (!fs.existsSync(orderFile)) {
    console.error(`Order file not found: ${orderFile}`);
    process.exit(1);
  }

  const order = JSON.parse(fs.readFileSync(orderFile, 'utf-8'));
  console.log(`\n📞 Placing call for: ${order.customer_name}`);
  console.log(`   Pizza: ${order.pizza.size} ${order.pizza.crust}, ${order.pizza.toppings.join(', ')}`);
  console.log(`   Side: ${order.side.first_choice}`);
  console.log(`   Drink: ${order.drink.first_choice}`);
  console.log(`   Budget: $${order.budget_max}`);
  console.log();

  // POST to /api/calls
  const body: Record<string, unknown> = { order };
  if (targetNumber) body.target_number = targetNumber;

  const response = await fetch(`${API_BASE}/api/calls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json();
    console.error('Failed to initiate call:', err);
    process.exit(1);
  }

  const { call_id, status } = await response.json() as { call_id: string; status: string };
  console.log(`✓ Call initiated: ${call_id} (${status})`);
  console.log(`  Polling for result...\n`);

  // Poll for result
  const pollInterval = 3000;
  const maxPolls = 200; // 10 minutes
  let polls = 0;

  while (polls < maxPolls) {
    await new Promise((r) => setTimeout(r, pollInterval));
    polls++;

    try {
      const statusRes = await fetch(`${API_BASE}/api/calls/${call_id}`);
      if (!statusRes.ok) continue;

      const data = await statusRes.json() as { call_id: string; status: string; result: any };

      if (data.status === 'completed' || data.status === 'failed') {
        console.log(`\n${'─'.repeat(50)}`);
        console.log(`CALL ${data.status.toUpperCase()}`);
        console.log(`${'─'.repeat(50)}`);

        if (data.result) {
          console.log(JSON.stringify(data.result, null, 2));
        } else {
          console.log('No result data available');
        }

        console.log(`\nArtifacts: data/runs/${call_id}/`);
        return;
      }

      // Show status update
      process.stdout.write(`\r  [${polls * 3}s] Status: ${data.status}...`);
    } catch {
      process.stdout.write(`\r  [${polls * 3}s] Polling...`);
    }
  }

  console.log('\nTimeout — call did not complete within 10 minutes');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
