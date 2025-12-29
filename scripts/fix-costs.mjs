import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  'https://lnycekbczyhxjlxoooqn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI'
);

// Get all confirmed orders
const { data: orders } = await supabase
  .from('orders')
  .select('id, ticker, units, price_cents, executed_cost_cents, cost_cents')
  .eq('placement_status', 'confirmed');

console.log('Checking', orders.length, 'confirmed orders for cost mismatches...\n');

let fixed = 0;
for (const order of orders) {
  const expectedCost = order.units * order.price_cents;
  const currentCost = order.executed_cost_cents || order.cost_cents || 0;
  
  // If cost is significantly different (more than 1% off), it needs fixing
  if (Math.abs(currentCost - expectedCost) > expectedCost * 0.01 && expectedCost > 0) {
    console.log(`${order.ticker}:`);
    console.log(`  units=${order.units}, price=${order.price_cents}¢`);
    console.log(`  current cost=${currentCost}, expected=${expectedCost}`);
    console.log(`  Fixing...`);
    
    const { error } = await supabase
      .from('orders')
      .update({
        executed_cost_cents: expectedCost,
        cost_cents: expectedCost
      })
      .eq('id', order.id);
    
    if (error) {
      console.log(`  ERROR: ${error.message}`);
    } else {
      fixed++;
      console.log(`  Fixed!`);
    }
    console.log('');
  }
}

console.log(`\nFixed ${fixed} orders with incorrect cost values.`);

// Verify total P&L after fix
const { data: updatedOrders } = await supabase
  .from('orders')
  .select('result_status, units, price_cents, executed_cost_cents, actual_payout_cents, fee_cents')
  .eq('placement_status', 'confirmed')
  .in('result_status', ['won', 'lost']);

let wonPayout = 0, wonCost = 0, wonFees = 0;
let lostCost = 0, lostFees = 0;

updatedOrders.forEach(o => {
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

