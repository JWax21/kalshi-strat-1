import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  'https://lnycekbczyhxjlxoooqn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI'
);

// First, undo the previous fix by re-inverting orders that were wrongly inverted
// These are orders that now have price > 85 but had price < 85 before my fix
// I need to identify orders that were fixed and shouldn't have been

// Get all orders - we'll check which ones need to be fixed
const { data: orders } = await supabase
  .from('orders')
  .select('id, ticker, side, units, price_cents, executed_cost_cents, cost_cents, result_status')
  .eq('placement_status', 'confirmed');

console.log(`Checking ${orders.length} orders...\n`);

// The rule: we only buy at 85¢ or above
// If an order is showing a price of 91-99¢ (which is 100 - originalPrice where original was 1-9¢)
// Then we need to check: was this a NO bet at 1-9¢ (which is correct) or inverted?

// Actually, let's think about this differently:
// If we bet NO at 1¢, the YES side was 99¢. The implied probability of NO is 1%.
// But we only bet on things with >= 85% implied probability.
// So betting NO at 1¢ is WRONG - we should have bet YES at 99¢.

// The key insight: NO bets should have price >= 85¢ (meaning we think NO has >= 85% chance)
// YES bets should also have price >= 85¢

// So for NO bets with current price in 90-99 range, they were already inverted by my previous script
// But they might have been CORRECTLY recorded as NO at low prices!

// Let me restore the original state first, then be more careful.

// For orders that I inverted (NO bets with prices now 90-99), I need to un-invert
// But only for those that had prices like 1-10¢ before

// Actually, the safest approach: check the actual cost in Kalshi fills
// But since we don't have that, let's use this rule:
// - If the recorded cost (executed_cost_cents) is close to units * price, assume it's correct
// - If the recorded payout (actual_payout_cents) is units * 100 for a win, that's correct

// Let me just identify all orders with prices outside the 85-100 range for review

console.log('=== ORDERS WITH PRICES OUTSIDE 85-100 RANGE ===\n');

const suspicious = orders.filter(o => {
  const price = o.price_cents;
  return price < 85 || price > 100;
});

console.log(`Found ${suspicious.length} suspicious orders:\n`);

suspicious.forEach(o => {
  const inverted = 100 - o.price_cents;
  console.log(`${o.ticker}:`);
  console.log(`  Side: ${o.side}, Result: ${o.result_status}`);
  console.log(`  Price: ${o.price_cents}¢ (inverse would be ${inverted}¢)`);
  console.log(`  Units: ${o.units}, Cost: ${o.executed_cost_cents || o.cost_cents}`);
  console.log(`  Expected cost at ${o.price_cents}¢: ${o.units * o.price_cents}`);
  console.log(`  Expected cost at ${inverted}¢: ${o.units * inverted}`);
  console.log('');
});

// For now, let's restore orders that I incorrectly inverted
// These are orders where price is now 90-99 but should be 1-10
// Actually no - the user wants prices >= 85. So if we bet at 90¢+ that's correct.

// The issue is: some NO bets were recorded with the NO price (1-10¢) 
// but we actually bet NO, meaning we paid 1-10¢ per contract
// In that case, cost = units * 1-10¢ and payout on win = units * 100¢

// If we INCORRECTLY recorded the NO price when we bet YES at 99¢:
// Then the correct cost would be units * 99¢, not units * 1¢

// The distinguishing factor is the ACTUAL cost we paid
// But we don't have that from Kalshi anymore...

// Let's check the pattern: if result is 'won' and profit seems too high, it's likely inverted
console.log('\n=== CHECKING FOR LIKELY INVERTED ORDERS ===\n');

const wonOrders = orders.filter(o => o.result_status === 'won');

wonOrders.forEach(o => {
  const cost = o.executed_cost_cents || (o.units * o.price_cents);
  const payout = o.units * 100; // Won orders get $1 per unit
  const profit = payout - cost;
  const profitPercent = (profit / cost) * 100;
  
  // If profit % is > 100%, it's likely a low-odds bet
  // Normal 85-99% bets have profit % of 1-18%
  if (profitPercent > 20) {
    const expectedProfitIfCorrect = payout - (o.units * (100 - o.price_cents));
    console.log(`${o.ticker}:`);
    console.log(`  Price: ${o.price_cents}¢, Cost: ${cost}, Payout: ${payout}`);
    console.log(`  Profit: $${(profit/100).toFixed(2)} (${profitPercent.toFixed(0)}% return)`);
    console.log(`  If inverted (${100 - o.price_cents}¢), profit would be: $${(expectedProfitIfCorrect/100).toFixed(2)}`);
    console.log('');
  }
});

