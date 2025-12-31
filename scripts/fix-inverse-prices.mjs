import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  'https://lnycekbczyhxjlxoooqn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI'
);

const MIN_ODDS = 85; // We only buy at 85¢ or above

// Get all confirmed orders with low prices
const { data: orders } = await supabase
  .from('orders')
  .select('id, ticker, side, units, price_cents, executed_cost_cents, cost_cents, result_status')
  .eq('placement_status', 'confirmed')
  .lt('price_cents', MIN_ODDS);

console.log(`Found ${orders.length} orders with price < ${MIN_ODDS}¢:\n`);

let fixed = 0;
for (const order of orders) {
  const currentPrice = order.price_cents;
  const correctPrice = 100 - currentPrice; // Inverse price
  const correctCost = order.units * correctPrice;
  
  console.log(`${order.ticker}:`);
  console.log(`  Side: ${order.side}`);
  console.log(`  Units: ${order.units}`);
  console.log(`  Current price: ${currentPrice}¢ -> Correct price: ${correctPrice}¢`);
  console.log(`  Current cost: ${order.executed_cost_cents || order.cost_cents} -> Correct cost: ${correctCost}`);
  console.log(`  Result: ${order.result_status}`);
  
  // Update with correct price and cost
  const { error } = await supabase
    .from('orders')
    .update({
      price_cents: correctPrice,
      executed_cost_cents: correctCost,
      cost_cents: correctCost
    })
    .eq('id', order.id);
  
  if (error) {
    console.log(`  ERROR: ${error.message}`);
  } else {
    console.log(`  ✓ Fixed!`);
    fixed++;
  }
  console.log('');
}

console.log(`\nFixed ${fixed} orders with inverted prices.`);

// Verify total P&L after fix
const { data: allOrders } = await supabase
  .from('orders')
  .select('result_status, units, price_cents, executed_cost_cents, actual_payout_cents, fee_cents')
  .eq('placement_status', 'confirmed')
  .in('result_status', ['won', 'lost']);

let wonPayout = 0, wonCost = 0, wonFees = 0;
let lostCost = 0, lostFees = 0;

allOrders.forEach(o => {
  const cost = o.executed_cost_cents || (o.units * o.price_cents);
  if (o.result_status === 'won') {
    wonPayout += o.actual_payout_cents || 0;
    wonCost += cost;
    wonFees += o.fee_cents || 0;
  } else {
    lostCost += cost;
    lostFees += o.fee_cents || 0;
  }
});

console.log('\n=== VERIFIED P&L ===');
console.log(`Won: payout=$${(wonPayout/100).toFixed(2)}, cost=$${(wonCost/100).toFixed(2)}, fees=$${(wonFees/100).toFixed(2)}`);
console.log(`Lost: cost=$${(lostCost/100).toFixed(2)}, fees=$${(lostFees/100).toFixed(2)}`);
const totalPnl = wonPayout - wonCost - wonFees - lostCost - lostFees;
console.log(`\nTotal P&L: $${(totalPnl/100).toFixed(2)}`);

