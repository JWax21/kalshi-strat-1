import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://lnycekbczyhxjlxoooqn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI'
);

// Get game date from ticker
const getGameDateFromTicker = (ticker) => {
  const match = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (match) {
    const monthMap = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
    return '20' + match[1] + '-' + monthMap[match[2]] + '-' + match[3];
  }
  return null;
};

async function main() {
  console.log('=== POPULATING DAILY SNAPSHOTS ===\n');
  console.log('Starting with $10,000 on Dec 24, 2025\n');
  
  // Starting values: Dec 24, 2025 with $10,000 cash, $0 positions
  const startDate = '2025-12-24';
  const startingCashCents = 1000000; // $10,000
  
  // Get all confirmed orders
  const { data: allOrders, error } = await supabase
    .from('orders')
    .select('*')
    .eq('placement_status', 'confirmed');
    
  if (error) {
    console.error('Error fetching orders:', error);
    return;
  }
  
  console.log('Total confirmed orders:', allOrders.length);
  
  // Group orders by GAME DATE (from ticker) - this is when they SETTLE
  const ordersByGameDate = {};
  
  // Group orders by PLACEMENT DATE - this is when capital was DEPLOYED
  const ordersByPlacementDate = {};
  
  allOrders.forEach(order => {
    const gameDate = getGameDateFromTicker(order.ticker);
    if (gameDate && gameDate >= startDate) {
      if (!ordersByGameDate[gameDate]) ordersByGameDate[gameDate] = [];
      ordersByGameDate[gameDate].push(order);
    }
    
    // Placement date (when we spent the cash)
    if (order.placement_status_at) {
      const placementDate = new Date(order.placement_status_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (placementDate >= startDate) {
        if (!ordersByPlacementDate[placementDate]) ordersByPlacementDate[placementDate] = [];
        ordersByPlacementDate[placementDate].push(order);
      }
    }
  });
  
  // Get all dates from Dec 24 to today
  const today = new Date().toISOString().split('T')[0];
  const allDates = [];
  let currentDate = new Date(startDate + 'T12:00:00Z');
  const endDate = new Date(today + 'T12:00:00Z');
  
  while (currentDate <= endDate) {
    allDates.push(currentDate.toISOString().split('T')[0]);
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  console.log('Dates to process:', allDates.join(', '));
  
  // Calculate snapshots day by day
  // Model: 
  // - Cash decreases when we PLACE orders (placement date)
  // - Cash increases when orders SETTLE as wins (game date)
  // - Positions = cost of orders that are placed but not yet settled
  
  let runningCash = startingCashCents;
  const snapshots = [];
  
  for (const date of allDates) {
    // Orders that SETTLED today (game date = today)
    const settledOrders = ordersByGameDate[date] || [];
    const wonOrders = settledOrders.filter(o => o.result_status === 'won');
    const lostOrders = settledOrders.filter(o => o.result_status === 'lost');
    
    // Orders that were PLACED today (deployment)
    const placedOrders = ordersByPlacementDate[date] || [];
    const placedCost = placedOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
    
    // Settlement returns from wins
    const wonPayout = wonOrders.reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);
    const wonFees = wonOrders.reduce((sum, o) => sum + (o.fee_cents || 0), 0);
    const lostFees = lostOrders.reduce((sum, o) => sum + (o.fee_cents || 0), 0);
    
    // P&L calculation (based on game date)
    const wonCost = wonOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
    const lostCost = lostOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
    const dayPnl = (wonPayout - wonCost - wonFees) - (lostCost + lostFees);
    
    // Cash flow for today:
    // - Decrease by orders placed today
    // - Increase by payouts from wins that settled today
    // (losses don't return any cash - the cost was already spent when placed)
    const cashOutForPlacements = placedCost;
    const cashInFromSettlements = wonPayout - wonFees; // Net payout after fees
    
    const endCash = runningCash - cashOutForPlacements + cashInFromSettlements;
    
    // Positions = all orders that are placed but not yet settled (game date > today)
    const openPositions = allOrders.filter(o => {
      const gameDate = getGameDateFromTicker(o.ticker);
      if (!gameDate) return false;
      // Placed on or before today, game date is after today = still open
      if (!o.placement_status_at) return false;
      const placedDate = new Date(o.placement_status_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      return placedDate <= date && gameDate > date;
    });
    
    // Also include orders placed today for games today that haven't settled yet (undecided)
    const todayUndecided = settledOrders.filter(o => o.result_status === 'undecided');
    
    const positionsCents = [
      ...openPositions,
      ...todayUndecided
    ].reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
    
    const portfolioValue = endCash + positionsCents;
    const wins = wonOrders.length;
    const losses = lostOrders.length;
    const pending = todayUndecided.length + openPositions.length;
    
    const snapshot = {
      snapshot_date: date,
      balance_cents: endCash,
      positions_cents: positionsCents,
      portfolio_value_cents: portfolioValue,
      wins,
      losses,
      pnl_cents: dayPnl,
      pending,
    };
    
    snapshots.push(snapshot);
    
    console.log(`${date}: Cash=$${(endCash/100).toFixed(0)} | Pos=$${(positionsCents/100).toFixed(0)} | Total=$${(portfolioValue/100).toFixed(0)} | W=${wins} L=${losses} P=${pending} | P&L=$${(dayPnl/100).toFixed(2)}`);
    
    // Update running cash for next day
    runningCash = endCash;
  }
  
  // Insert snapshots into database
  console.log('\nInserting snapshots into database...');
  
  for (const snapshot of snapshots) {
    const { error: upsertError } = await supabase
      .from('daily_snapshots')
      .upsert(snapshot, { onConflict: 'snapshot_date' });
      
    if (upsertError) {
      console.error(`Error upserting ${snapshot.snapshot_date}:`, upsertError.message);
    }
  }
  
  console.log('\n✅ Done! Inserted', snapshots.length, 'snapshots');
  
  // Show final summary
  const finalSnapshot = snapshots[snapshots.length - 1];
  console.log('\n=== CURRENT STATUS ===');
  console.log(`Cash: $${(finalSnapshot.balance_cents / 100).toFixed(2)}`);
  console.log(`Positions: $${(finalSnapshot.positions_cents / 100).toFixed(2)}`);
  console.log(`Portfolio: $${(finalSnapshot.portfolio_value_cents / 100).toFixed(2)}`);
}

main().catch(console.error);

