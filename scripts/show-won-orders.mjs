import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://lnycekbczyhxjlxoooqn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI'
);

async function getWonOrders() {
  const today = new Date().toISOString().split('T')[0];
  
  // Get today's batch
  const { data: batch } = await supabase
    .from('order_batches')
    .select('id')
    .eq('batch_date', today)
    .single();
  
  if (!batch) {
    console.log('No batch found for today:', today);
    return;
  }
  
  // Get won orders from today
  const { data: orders, error } = await supabase
    .from('orders')
    .select('*')
    .eq('batch_id', batch.id)
    .eq('result_status', 'won')
    .order('executed_cost_cents', { ascending: false });
  
  if (error) {
    console.error('Error:', error);
    return;
  }
  
  console.log('=== WON ORDERS FOR TODAY (' + today + ') ===');
  console.log('Total won orders:', orders.length);
  console.log('');
  
  let totalPayout = 0;
  let totalCost = 0;
  let totalFees = 0;
  
  for (const o of orders) {
    const payout = o.actual_payout_cents || o.potential_payout_cents || 0;
    const cost = o.executed_cost_cents || o.cost_cents || 0;
    const fees = o.fee_cents || 0;
    const profit = payout - cost - fees;
    
    totalPayout += payout;
    totalCost += cost;
    totalFees += fees;
    
    console.log('---');
    console.log('Ticker:', o.ticker);
    console.log('Title:', o.title?.substring(0, 50));
    console.log('Units:', o.units);
    console.log('Cost: $' + (cost/100).toFixed(2), '(executed_cost_cents:', o.executed_cost_cents, ', cost_cents:', o.cost_cents, ')');
    console.log('Payout: $' + (payout/100).toFixed(2), '(actual_payout_cents:', o.actual_payout_cents, ', potential_payout_cents:', o.potential_payout_cents, ')');
    console.log('Fees: $' + (fees/100).toFixed(2));
    console.log('Profit: $' + (profit/100).toFixed(2));
  }
  
  console.log('');
  console.log('=== TOTALS ===');
  console.log('Total Payout: $' + (totalPayout/100).toFixed(2));
  console.log('Total Cost: $' + (totalCost/100).toFixed(2));
  console.log('Total Fees: $' + (totalFees/100).toFixed(2));
  console.log('Total Profit: $' + ((totalPayout - totalCost - totalFees)/100).toFixed(2));
}

getWonOrders();

