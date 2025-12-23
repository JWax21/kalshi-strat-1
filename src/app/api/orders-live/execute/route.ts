import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getBalance, placeOrder } from '@/lib/kalshi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function executeOrders() {
  // Get today's date
  const today = new Date().toISOString().split('T')[0];

  // Find today's batch
  const { data: batch, error: batchError } = await supabase
    .from('order_batches')
    .select('*')
    .eq('batch_date', today)
    .single();

  if (batchError || !batch) {
    return {
      success: false,
      error: `No batch found for ${today}`,
    };
  }

  // Check if paused
  if (batch.is_paused) {
    return {
      success: false,
      error: `Batch for ${today} is paused`,
      batch_id: batch.id,
    };
  }

  // Check if already executed
  if (batch.executed_at) {
    return {
      success: false,
      error: `Batch for ${today} already executed at ${batch.executed_at}`,
      batch_id: batch.id,
    };
  }

  // Get pending orders for this batch, sorted by OI descending
  const { data: orders, error: ordersError } = await supabase
    .from('orders')
    .select('*')
    .eq('batch_id', batch.id)
    .eq('placement_status', 'pending')
    .order('open_interest', { ascending: false });

  if (ordersError) throw ordersError;

  if (!orders || orders.length === 0) {
    return {
      success: false,
      error: 'No pending orders to execute',
    };
  }

  // Get available balance
  let availableBalance = 0;
  try {
    const balanceData = await getBalance();
    availableBalance = balanceData.balance || 0; // In cents
  } catch (e) {
    console.error('Error fetching balance:', e);
    return {
      success: false,
      error: 'Could not fetch account balance',
    };
  }

  console.log(`Available balance: $${(availableBalance / 100).toFixed(2)}`);

  // Calculate how many orders we can afford
  // Each order costs price_cents * units
  const unitSize = batch.unit_size_cents; // e.g., 100 cents = $1
  
  // Calculate cost per order (assuming 1 unit each initially)
  // We'll place 1 unit per market to maximize diversification
  let remainingBalance = availableBalance;
  const ordersToPlace: typeof orders = [];

  for (const order of orders) {
    const costPerUnit = order.price_cents;
    if (remainingBalance >= costPerUnit) {
      ordersToPlace.push(order);
      remainingBalance -= costPerUnit;
    } else {
      console.log(`Skipping ${order.ticker} - insufficient funds (need ${costPerUnit}, have ${remainingBalance})`);
    }
  }

  if (ordersToPlace.length === 0) {
    return {
      success: false,
      error: `Insufficient balance. Have $${(availableBalance / 100).toFixed(2)}, need at least $${(orders[0].price_cents / 100).toFixed(2)}`,
    };
  }

  console.log(`Placing ${ordersToPlace.length} of ${orders.length} orders`);

  // Execute orders
  let placedCount = 0;
  let confirmedCount = 0;
  const errors: string[] = [];

  for (const order of ordersToPlace) {
    try {
      // Build order payload
      const payload: any = {
        ticker: order.ticker,
        action: 'buy',
        side: order.side.toLowerCase(),
        count: 1, // 1 unit per market for diversification
        type: 'limit',
        client_order_id: `live_${order.id}_${Date.now()}`,
      };

      // Set price based on side
      if (order.side === 'YES') {
        payload.yes_price = order.price_cents;
      } else {
        payload.no_price = order.price_cents;
      }

      console.log(`Placing order for ${order.ticker}...`);
      const result = await placeOrder(payload);

      // Update order status
      const kalshiOrderId = result.order?.order_id;
      const status = result.order?.status;
      
      // Only count as "confirmed" if actually executed (filled)
      // "resting" means the order is on the book waiting to match
      const isExecuted = status === 'executed';
      const isResting = status === 'resting';
      
      // Capture actual execution price only if executed
      let executedPriceCents = null;
      let executedCostCents = null;
      
      if (isExecuted) {
        executedPriceCents = order.side === 'YES' 
          ? result.order?.yes_price 
          : result.order?.no_price;
        // Multiply by filled count (or order units) to get total cost
        const filledCount = (result.order as any)?.filled_count || order.units || 1;
        executedCostCents = executedPriceCents ? executedPriceCents * filledCount : null;
      }

      await supabase
        .from('orders')
        .update({
          placement_status: isExecuted ? 'confirmed' : 'placed', // resting = placed, not confirmed
          placement_status_at: new Date().toISOString(),
          kalshi_order_id: kalshiOrderId,
          executed_price_cents: executedPriceCents,
          executed_cost_cents: executedCostCents,
        })
        .eq('id', order.id);

      placedCount++;
      if (isExecuted) {
        confirmedCount++;
      }
      
      console.log(`Order ${order.ticker}: status=${status}, executed=${isExecuted}, resting=${isResting}`);

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : 'Unknown error';
      errors.push(`${order.ticker}: ${errMsg}`);
      console.error(`Failed to place order for ${order.ticker}:`, e);

      // Mark as failed (keep as pending for retry)
      await supabase
        .from('orders')
        .update({
          placement_status_at: new Date().toISOString(),
        })
        .eq('id', order.id);
    }
  }

  // Mark batch as executed
  await supabase
    .from('order_batches')
    .update({
      executed_at: new Date().toISOString(),
      total_orders: placedCount,
    })
    .eq('id', batch.id);

  // Mark skipped orders (insufficient funds)
  const skippedOrders = orders.filter(o => !ordersToPlace.includes(o));
  if (skippedOrders.length > 0) {
    for (const order of skippedOrders) {
      await supabase
        .from('orders')
        .update({
          placement_status: 'pending', // Keep pending but note it was skipped
          settlement_status: 'closed', // Mark as closed since we're not placing
          settlement_status_at: new Date().toISOString(),
        })
        .eq('id', order.id);
    }
  }

  return {
    success: true,
    batch_id: batch.id,
    stats: {
      total_orders: orders.length,
      placed: placedCount,
      confirmed: confirmedCount,
      skipped: skippedOrders.length,
      available_balance_cents: availableBalance,
      used_balance_cents: availableBalance - remainingBalance,
    },
    errors: errors.length > 0 ? errors : undefined,
  };
}

// GET - Called by Vercel Cron at 10am
export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await executeOrders();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error executing orders:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// POST - Manual trigger
export async function POST() {
  try {
    const result = await executeOrders();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error executing orders:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

