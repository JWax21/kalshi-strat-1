import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  'https://lnycekbczyhxjlxoooqn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI'
);

const { data: orders } = await supabase
  .from('orders')
  .select('ticker, result_status, units, executed_cost_cents, actual_payout_cents, potential_payout_cents, fee_cents')
  .eq('placement_status', 'confirmed')
  .in('result_status', ['won', 'lost']);

console.log('Checking P&L calculations for', orders.length, 'settled orders:');
let issues = [];

orders.forEach(o => {
  if (o.result_status === 'won') {
    const expectedPayout = o.units * 100;
    const actualPayout = o.actual_payout_cents || 0;
    
    if (actualPayout === 0 || actualPayout === null) {
      issues.push({
        ticker: o.ticker,
        units: o.units,
        expectedPayout,
        actualPayout,
        potential: o.potential_payout_cents
      });
    }
  }
});

console.log('\nWon orders with missing/zero actual_payout_cents:', issues.length);
issues.forEach(i => {
  console.log(`  ${i.ticker}: units=${i.units}, expected=${i.expectedPayout}, actual=${i.actualPayout}, potential=${i.potential}`);
});

// Calculate totals
let wonPayout = 0, wonCost = 0, wonFees = 0;
let lostCost = 0, lostFees = 0;

orders.forEach(o => {
  if (o.result_status === 'won') {
    // Use potential_payout if actual is missing
    wonPayout += o.actual_payout_cents || o.potential_payout_cents || 0;
    wonCost += o.executed_cost_cents || 0;
    wonFees += o.fee_cents || 0;
  } else {
    lostCost += o.executed_cost_cents || 0;
    lostFees += o.fee_cents || 0;
  }
});

console.log('\n=== P&L Breakdown ===');
console.log('Won orders: payout=$' + (wonPayout/100).toFixed(2) + ', cost=$' + (wonCost/100).toFixed(2) + ', fees=$' + (wonFees/100).toFixed(2));
console.log('Lost orders: cost=$' + (lostCost/100).toFixed(2) + ', fees=$' + (lostFees/100).toFixed(2));
console.log('\nP&L = payout - wonCost - lostCost - fees');
console.log('P&L = $' + (wonPayout/100).toFixed(2) + ' - $' + (wonCost/100).toFixed(2) + ' - $' + (lostCost/100).toFixed(2) + ' - $' + ((wonFees+lostFees)/100).toFixed(2));
const totalPnl = wonPayout - wonCost - lostCost - wonFees - lostFees;
console.log('\nTotal P&L: $' + (totalPnl/100).toFixed(2));

