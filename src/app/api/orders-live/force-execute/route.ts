import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getBalance, placeOrder } from '@/lib/kalshi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { batchId, date } = body;

    // Find the batch
    let batch;
    if (batchId) {
      const { data, error } = await supabase
        .from('order_batches')
        .select('*')
        .eq('id', batchId)
        .single();
      if (error) throw new Error(`Batch not found: ${batchId}`);
      batch = data;
    } else if (date) {
      const { data, error } = await supabase
        .from('order_batches')
        .select('*')
        .eq('batch_date', date)
        .single();
      if (error) throw new Error(`No batch for date: ${date}`);
      batch = data;
    } else {
      return NextResponse.json({ error: 'Provide batchId or date' }, { status: 400 });
    }

    // Get pending orders (not yet sent to Kalshi)
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('*')
      .eq('batch_id', batch.id)
      .is('kalshi_order_id', null) // Only orders not yet sent
      .order('open_interest', { ascending: false });

    if (ordersError) throw ordersError;

    if (!orders || orders.length === 0) {
      return NextResponse.json({ 
        success: false, 
        error: 'No unsent orders found',
        hint: 'All orders may have already been sent to Kalshi'
      });
    }

    // Get balance
    let availableBalance = 0;
    try {
      const balanceData = await getBalance();
      availableBalance = balanceData.balance || 0;
    } catch (e) {
      return NextResponse.json({ 
        success: false, 
        error: 'Could not fetch Kalshi balance',
        details: String(e)
      });
    }

    console.log(`Force execute: ${orders.length} orders, balance: $${(availableBalance / 100).toFixed(2)}`);

    const results: any[] = [];
    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;

    for (const order of orders) {
      // Check if we have enough balance for this order's units
      const orderCost = order.price_cents * order.units;
      
      if (availableBalance < orderCost) {
        results.push({
          ticker: order.ticker,
          status: 'skipped',
          reason: `Insufficient balance (need $${(orderCost/100).toFixed(2)}, have $${(availableBalance/100).toFixed(2)})`
        });
        skippedCount++;
        continue;
      }

      try {
        // Build order payload with actual units
        const payload: any = {
          ticker: order.ticker,
          action: 'buy',
          side: order.side.toLowerCase(),
          count: order.units, // Use the actual units from the order!
          type: 'limit',
          client_order_id: `force_${order.id}_${Date.now()}`,
        };

        if (order.side === 'YES') {
          payload.yes_price = order.price_cents;
        } else {
          payload.no_price = order.price_cents;
        }

        console.log(`Placing: ${order.ticker} x${order.units} @ $${(order.price_cents/100).toFixed(2)}`);
        
        const result = await placeOrder(payload);
        const kalshiOrderId = result.order?.order_id;
        const status = result.order?.status;

        // Update order in database
        await supabase
          .from('orders')
          .update({
            kalshi_order_id: kalshiOrderId,
            placement_status: status === 'executed' ? 'confirmed' : 'placed',
            placement_status_at: new Date().toISOString(),
            executed_price_cents: order.side === 'YES' ? result.order?.yes_price : result.order?.no_price,
            executed_cost_cents: status === 'executed' ? (order.price_cents * order.units) : null,
          })
          .eq('id', order.id);

        availableBalance -= orderCost;
        successCount++;
        
        results.push({
          ticker: order.ticker,
          status: 'success',
          kalshi_status: status,
          kalshi_order_id: kalshiOrderId,
          units: order.units,
          cost: `$${(orderCost/100).toFixed(2)}`,
        });

        // Rate limit
        await new Promise(r => setTimeout(r, 250));

      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        failCount++;
        
        results.push({
          ticker: order.ticker,
          status: 'failed',
          error: errorMsg,
        });

        console.error(`Failed: ${order.ticker} - ${errorMsg}`);
      }
    }

    // Update batch
    await supabase
      .from('order_batches')
      .update({
        executed_at: new Date().toISOString(),
        total_orders: successCount,
      })
      .eq('id', batch.id);

    return NextResponse.json({
      success: true,
      batch_id: batch.id,
      summary: {
        total_orders: orders.length,
        success: successCount,
        failed: failCount,
        skipped: skippedCount,
      },
      results,
    });

  } catch (error) {
    console.error('Force execute error:', error);
    return NextResponse.json({ 
      success: false, 
      error: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

