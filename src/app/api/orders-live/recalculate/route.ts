import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import crypto from 'crypto';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_POSITION_PERCENT = 0.03; // 3% max per market

// Helper to make authenticated Kalshi API calls
async function kalshiFetch(endpoint: string): Promise<any> {
  const timestampMs = Date.now().toString();
  const method = 'GET';
  const pathWithoutQuery = endpoint.split('?')[0];
  const fullPath = `/trade-api/v2${pathWithoutQuery}`;

  const message = `${timestampMs}${method}${fullPath}`;
  const privateKey = crypto.createPrivateKey(KALSHI_CONFIG.privateKey);
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');

  const response = await fetch(`${KALSHI_CONFIG.baseUrl}${endpoint}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': KALSHI_CONFIG.apiKey,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    },
  });

  if (!response.ok) {
    throw new Error(`Kalshi API error: ${response.status}`);
  }

  return response.json();
}

// POST - Recalculate units for a pending batch based on current capital
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { batchId } = body;

    if (!batchId) {
      return NextResponse.json({ success: false, error: 'batchId is required' }, { status: 400 });
    }

    // Get the batch
    const { data: batch, error: batchError } = await supabase
      .from('order_batches')
      .select('*')
      .eq('id', batchId)
      .single();

    if (batchError || !batch) {
      return NextResponse.json({ success: false, error: 'Batch not found' }, { status: 404 });
    }

    // Get pending orders for this batch
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('*')
      .eq('batch_id', batchId)
      .eq('placement_status', 'pending')
      .order('open_interest', { ascending: false });

    if (ordersError) {
      return NextResponse.json({ success: false, error: ordersError.message }, { status: 500 });
    }

    if (!orders || orders.length === 0) {
      return NextResponse.json({ 
        success: false, 
        error: 'No pending orders to recalculate (orders may already be placed)' 
      }, { status: 400 });
    }

    // Get available balance and existing positions from Kalshi
    let availableCapitalCents = 0;
    let totalExposureCents = 0;
    try {
      const balanceData = await kalshiFetch('/portfolio/balance');
      availableCapitalCents = balanceData?.balance || 0;
      
      // Fetch existing positions to calculate total portfolio value
      const positionsData = await kalshiFetch('/portfolio/positions');
      for (const pos of positionsData?.market_positions || []) {
        totalExposureCents += pos.position_cost || 0;
      }
    } catch (e) {
      return NextResponse.json({ success: false, error: 'Failed to fetch balance from Kalshi' }, { status: 500 });
    }

    if (availableCapitalCents <= 0) {
      return NextResponse.json({ success: false, error: 'No available capital' }, { status: 400 });
    }

    // Calculate total portfolio (available + deployed) for 3% cap
    const totalPortfolioCents = availableCapitalCents + totalExposureCents;
    console.log(`Portfolio: ${totalPortfolioCents}¢ (available: ${availableCapitalCents}¢, deployed: ${totalExposureCents}¢)`);

    // Calculate max per market based on 3% of TOTAL PORTFOLIO
    const maxPositionCents = Math.floor(totalPortfolioCents * MAX_POSITION_PERCENT);

    // Distribute capital across orders
    const updatedOrders: any[] = [];
    let remainingCapital = availableCapitalCents;
    let madeProgress = true;

    // Initialize units to 0
    const orderUnits: Record<string, number> = {};
    orders.forEach(o => { orderUnits[o.id] = 0; });

    // Keep distributing until we can't anymore
    while (remainingCapital > 0 && madeProgress) {
      madeProgress = false;
      
      for (const order of orders) {
        if (remainingCapital <= 0) break;
        
        const currentUnits = orderUnits[order.id];
        const currentValue = currentUnits * order.price_cents;
        const maxUnits = Math.floor(maxPositionCents / order.price_cents);
        
        // Check if we can add another unit
        if (currentUnits < maxUnits && remainingCapital >= order.price_cents) {
          orderUnits[order.id] += 1;
          remainingCapital -= order.price_cents;
          madeProgress = true;
        }
      }
    }

    // Update each order with new units
    let totalUnits = 0;
    let totalCost = 0;
    let totalPayout = 0;

    for (const order of orders) {
      const units = orderUnits[order.id];
      if (units > 0) {
        const cost = units * order.price_cents;
        const payout = units * 100;
        
        await supabase
          .from('orders')
          .update({
            units,
            cost_cents: cost,
            potential_payout_cents: payout,
          })
          .eq('id', order.id);

        totalUnits += units;
        totalCost += cost;
        totalPayout += payout;
        updatedOrders.push({ ticker: order.ticker, units, cost_cents: cost });
      }
    }

    // Update batch totals
    await supabase
      .from('order_batches')
      .update({
        total_cost_cents: totalCost,
        total_potential_payout_cents: totalPayout,
      })
      .eq('id', batchId);

    return NextResponse.json({
      success: true,
      batch_id: batchId,
      available_capital_cents: availableCapitalCents,
      total_orders: orders.length,
      total_units: totalUnits,
      total_cost_cents: totalCost,
      capital_utilization: ((totalCost / availableCapitalCents) * 100).toFixed(1) + '%',
      avg_units_per_order: (totalUnits / orders.length).toFixed(1),
      message: `Recalculated ${orders.length} orders with ${totalUnits} total units`,
    });

  } catch (error) {
    console.error('Error recalculating units:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

