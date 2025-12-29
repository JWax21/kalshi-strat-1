import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  'https://lnycekbczyhxjlxoooqn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI'
);

// Get Dec 28 orders (from ticker)
const { data: orders } = await supabase
  .from('orders')
  .select('ticker, result_status, units, price_cents, executed_cost_cents, cost_cents, actual_payout_cents, fee_cents')
  .eq('placement_status', 'confirmed')
  .like('ticker', '%DEC28%');

console.log('Dec 28 orders:', orders.length);

// Group by result
const won = orders.filter(o => o.result_status === 'won');
const lost = orders.filter(o => o.result_status === 'lost');
const pending = orders.filter(o => o.result_status === 'undecided');

console.log('\nWon:', won.length);
console.log('Lost:', lost.length);
console.log('Pending:', pending.length);

// Check won orders
console.log('\n=== WON ORDERS ===');
let totalWonPayout = 0;
let totalWonCost = 0;
let totalWonFees = 0;

won.forEach(o => {
  const cost = o.executed_cost_cents || o.cost_cents || 0;
  const payout = o.actual_payout_cents || 0;
  const fee = o.fee_cents || 0;
  const profit = payout - cost - fee;
  
  // Check if cost makes sense: cost should be units * price
  const expectedCost = o.units * o.price_cents;
  const costMatch = cost === expectedCost ? '✓' : `MISMATCH (expected ${expectedCost})`;
  
  console.log(`${o.ticker}: units=${o.units}, price=${o.price_cents}¢, cost=${cost}, payout=${payout}, fee=${fee}, profit=${profit} ${costMatch}`);
  
  totalWonPayout += payout;
  totalWonCost += cost;
  totalWonFees += fee;
});

console.log('\nWon totals: payout=$' + (totalWonPayout/100).toFixed(2) + ', cost=$' + (totalWonCost/100).toFixed(2) + ', fees=$' + (totalWonFees/100).toFixed(2));
console.log('Won profit: $' + ((totalWonPayout - totalWonCost - totalWonFees)/100).toFixed(2));

// Check lost orders
console.log('\n=== LOST ORDERS ===');
let totalLostCost = 0;
let totalLostFees = 0;

lost.forEach(o => {
  const cost = o.executed_cost_cents || o.cost_cents || 0;
  const fee = o.fee_cents || 0;
  
  console.log(`${o.ticker}: units=${o.units}, price=${o.price_cents}¢, cost=${cost}, fee=${fee}, loss=-${cost + fee}`);
  
  totalLostCost += cost;
  totalLostFees += fee;
});

console.log('\nLost totals: cost=$' + (totalLostCost/100).toFixed(2) + ', fees=$' + (totalLostFees/100).toFixed(2));
console.log('Lost amount: -$' + ((totalLostCost + totalLostFees)/100).toFixed(2));

// Total P&L for Dec 28
const dec28Pnl = totalWonPayout - totalWonCost - totalWonFees - totalLostCost - totalLostFees;
console.log('\n=== DEC 28 P&L ===');
console.log('P&L = $' + (dec28Pnl/100).toFixed(2));

