import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  'https://lnycekbczyhxjlxoooqn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI'
);

// Restore orders that I incorrectly inverted
// These had prices in the 70-84% range (legitimate, just below threshold)

const fixes = [
  {
    ticker: 'KXNFLGAME-25DEC25DETMIN-DET',
    originalPrice: 78,  // Was 78, I changed to 22, need to restore
  },
  {
    ticker: 'KXNBAGAME-25DEC25DALGSW-GSW', 
    originalPrice: 74,  // Was 74, I changed to 26, need to restore
  }
];

for (const fix of fixes) {
  const { data: order } = await supabase
    .from('orders')
    .select('id, units')
    .eq('ticker', fix.ticker)
    .single();
  
  if (!order) {
    console.log(`Order ${fix.ticker} not found`);
    continue;
  }
  
  const correctCost = order.units * fix.originalPrice;
  
  console.log(`Restoring ${fix.ticker}:`);
  console.log(`  Price: ${fix.originalPrice}¢`);
  console.log(`  Cost: ${correctCost}`);
  
  const { error } = await supabase
    .from('orders')
    .update({
      price_cents: fix.originalPrice,
      executed_cost_cents: correctCost,
      cost_cents: correctCost
    })
    .eq('id', order.id);
  
  if (error) {
    console.log(`  ERROR: ${error.message}`);
  } else {
    console.log(`  ✓ Restored!`);
  }
}

// Verify final P&L
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
    wonPayout += o.actual_payout_cents || (o.units * 100);
    wonCost += cost;
    wonFees += o.fee_cents || 0;
  } else {
    lostCost += cost;
    lostFees += o.fee_cents || 0;
  }
});

console.log('\n=== FINAL P&L ===');
console.log(`Won: payout=$${(wonPayout/100).toFixed(2)}, cost=$${(wonCost/100).toFixed(2)}, fees=$${(wonFees/100).toFixed(2)}`);
console.log(`Lost: cost=$${(lostCost/100).toFixed(2)}, fees=$${(lostFees/100).toFixed(2)}`);
const totalPnl = wonPayout - wonCost - wonFees - lostCost - lostFees;
console.log(`\nTotal P&L: $${(totalPnl/100).toFixed(2)}`);

// Also show breakdown by price range
console.log('\n=== PRICE DISTRIBUTION ===');
const { data: allConfirmed } = await supabase
  .from('orders')
  .select('price_cents')
  .eq('placement_status', 'confirmed');

const ranges = {
  '85-89': 0,
  '90-94': 0,
  '95-99': 0,
  '70-84': 0,
  'other': 0
};

allConfirmed.forEach(o => {
  const p = o.price_cents;
  if (p >= 95 && p <= 99) ranges['95-99']++;
  else if (p >= 90 && p <= 94) ranges['90-94']++;
  else if (p >= 85 && p <= 89) ranges['85-89']++;
  else if (p >= 70 && p <= 84) ranges['70-84']++;
  else ranges['other']++;
});

Object.entries(ranges).forEach(([range, count]) => {
  if (count > 0) console.log(`  ${range}¢: ${count} orders`);
});

