import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  'https://lnycekbczyhxjlxoooqn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI'
);

// Fix won orders with missing actual_payout_cents
const { data: wonOrders } = await supabase
  .from('orders')
  .select('id, ticker, units, actual_payout_cents, potential_payout_cents')
  .eq('placement_status', 'confirmed')
  .eq('result_status', 'won');

let fixed = 0;
for (const order of wonOrders) {
  const expectedPayout = order.units * 100;
  
  // Fix if actual_payout is 0 or null
  if (!order.actual_payout_cents || order.actual_payout_cents === 0) {
    console.log(`Fixing ${order.ticker}: actual_payout ${order.actual_payout_cents} -> ${expectedPayout}`);
    
    const { error } = await supabase
      .from('orders')
      .update({ actual_payout_cents: expectedPayout })
      .eq('id', order.id);
    
    if (error) {
      console.log('  Error:', error.message);
    } else {
      fixed++;
    }
  }
}

console.log(`\nFixed ${fixed} orders`);

// Also fix lost orders - they should have actual_payout_cents = 0
const { data: lostOrders } = await supabase
  .from('orders')
  .select('id, ticker, actual_payout_cents')
  .eq('placement_status', 'confirmed')
  .eq('result_status', 'lost')
  .is('actual_payout_cents', null);

console.log(`\nLost orders with null actual_payout_cents: ${lostOrders.length}`);
for (const order of lostOrders) {
  const { error } = await supabase
    .from('orders')
    .update({ actual_payout_cents: 0 })
    .eq('id', order.id);
  
  if (!error) {
    console.log(`Fixed ${order.ticker}: null -> 0`);
  }
}

// Verify total P&L
const { data: allOrders } = await supabase
  .from('orders')
  .select('result_status, executed_cost_cents, actual_payout_cents, fee_cents')
  .eq('placement_status', 'confirmed')
  .in('result_status', ['won', 'lost']);

let totalPnl = 0;
allOrders.forEach(o => {
  const payout = o.actual_payout_cents || 0;
  const cost = o.executed_cost_cents || 0;
  const fee = o.fee_cents || 0;
  totalPnl += payout - cost - fee;
});

console.log(`\nTotal P&L after fix: $${(totalPnl / 100).toFixed(2)}`);

