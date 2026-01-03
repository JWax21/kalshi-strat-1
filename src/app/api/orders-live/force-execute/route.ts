import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getBalance, placeOrder } from '@/lib/kalshi';
import crypto from 'crypto';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    method,
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

    // Get balance AND portfolio_value directly from Kalshi
    // CRITICAL: Total portfolio = balance (cash) + portfolio_value (positions value)
    let availableBalance = 0;
    let totalPortfolioCents = 0;
    try {
      const balanceData = await getBalance();
      availableBalance = balanceData.balance || 0;
      const positionsValue = balanceData.portfolio_value || 0;
      // Total portfolio = cash + positions value (Kalshi returns these separately)
      totalPortfolioCents = availableBalance + positionsValue;
      console.log(`Kalshi balance: cash=${availableBalance}¢, positions=${positionsValue}¢, total=${totalPortfolioCents}¢`);
    } catch (e) {
      return NextResponse.json({ 
        success: false, 
        error: 'Could not fetch Kalshi balance',
        details: String(e)
      });
    }

    // Get current positions to check existing exposure for each ticker AND event
    // CRITICAL: Must check TOTAL exposure (existing + new) against 3% cap
    let currentPositions = new Map<string, any>();
    try {
      const positionsData = await kalshiFetch('/portfolio/positions');
      currentPositions = new Map(
        (positionsData.market_positions || []).map((p: any) => [p.ticker, p])
      );
      console.log(`Fetched ${currentPositions.size} current positions for exposure check`);
    } catch (e) {
      console.error('Error fetching positions (will proceed without existing exposure check):', e);
    }

    // ========================================
    // CRITICAL: Build EVENT-level exposure map to prevent betting both sides of same game
    // This is a FINAL SAFETY BARRIER - even if prepare routes missed it
    // ========================================
    const eventExposureCents = new Map<string, number>();
    
    // Add exposure from existing confirmed/placed orders in database
    const { data: existingOrders } = await supabase
      .from('orders')
      .select('event_ticker, ticker, cost_cents, executed_cost_cents, placement_status')
      .in('placement_status', ['placed', 'confirmed']);
    
    for (const order of existingOrders || []) {
      const cost = order.executed_cost_cents || order.cost_cents || 0;
      const existing = eventExposureCents.get(order.event_ticker) || 0;
      eventExposureCents.set(order.event_ticker, existing + cost);
    }
    console.log(`Built event exposure map: ${eventExposureCents.size} events with exposure`);

    // Calculate hard cap (UNBREAKABLE 3% barrier)
    // CRITICAL: Use portfolio_value from Kalshi directly
    const MAX_POSITION_PERCENT = 0.03;
    const MIN_PRICE_CENTS = 90; // UNBREAKABLE: NEVER bet below 90 cents
    const hardCapCents = Math.floor(totalPortfolioCents * MAX_POSITION_PERCENT);
    
    console.log(`Force execute: ${orders.length} orders, balance: $${(availableBalance / 100).toFixed(2)}, portfolio: $${(totalPortfolioCents / 100).toFixed(2)} (from Kalshi), 3% cap: $${(hardCapCents / 100).toFixed(2)}`);

    const results: any[] = [];
    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;

    for (const order of orders) {
      // Check if we have enough balance for this order's units
      const orderCost = order.price_cents * order.units;
      
      // ========================================
      // MIN PRICE GUARD: NEVER bet on favorites below 90 cents
      // ========================================
      if (order.price_cents < MIN_PRICE_CENTS) {
        results.push({
          ticker: order.ticker,
          status: 'blocked',
          reason: `MIN PRICE: Price ${order.price_cents}¢ below minimum ${MIN_PRICE_CENTS}¢`
        });
        
        // Cancel - odds dropped
        await supabase
          .from('orders')
          .update({
            placement_status: 'cancelled',
            cancelled_at: new Date().toISOString(),
            cancel_reason: `Price ${order.price_cents}¢ below minimum 90¢ - odds dropped`,
          })
          .eq('id', order.id);
        
        skippedCount++;
        continue;
      }
      
      // ========================================
      // HARD CAP GUARD: NEVER exceed 3% of total portfolio
      // This is an UNBREAKABLE barrier - final safety check before placing
      // CRITICAL: Check TOTAL exposure (existing + new), not just new order
      // ========================================
      const existingPosition = currentPositions.get(order.ticker);
      const existingExposureCents = existingPosition 
        ? (existingPosition.market_exposure || 0) 
        : 0;
      const totalPositionCost = existingExposureCents + orderCost;
      
      if (totalPositionCost > hardCapCents) {
        results.push({
          ticker: order.ticker,
          status: 'blocked',
          reason: `HARD CAP: Total $${(totalPositionCost/100).toFixed(2)} (existing $${(existingExposureCents/100).toFixed(2)} + new $${(orderCost/100).toFixed(2)}) exceeds 3% cap ($${(hardCapCents/100).toFixed(2)})`
        });
        
        // Mark as queued
        await supabase
          .from('orders')
          .update({
            placement_status: 'queue',
            placement_status_at: new Date().toISOString(),
          })
          .eq('id', order.id);
        
        skippedCount++;
        continue;
      }
      
      // ========================================
      // EVENT-LEVEL CAP GUARD: NEVER exceed 3% on any single EVENT
      // This prevents betting on both sides of the same game
      // CRITICAL: Check at EVENT level, not just ticker level
      // ========================================
      const currentEventExposure = eventExposureCents.get(order.event_ticker) || 0;
      const totalEventExposure = currentEventExposure + orderCost;
      
      if (totalEventExposure > hardCapCents) {
        results.push({
          ticker: order.ticker,
          status: 'blocked',
          reason: `EVENT CAP: Event ${order.event_ticker} total $${(totalEventExposure/100).toFixed(2)} (existing $${(currentEventExposure/100).toFixed(2)} + new $${(orderCost/100).toFixed(2)}) exceeds 3% cap ($${(hardCapCents/100).toFixed(2)})`
        });
        
        // Mark as queued
        await supabase
          .from('orders')
          .update({
            placement_status: 'queue',
            placement_status_at: new Date().toISOString(),
          })
          .eq('id', order.id);
        
        skippedCount++;
        continue;
      }
      
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
        
        // Update event exposure map to prevent over-betting on same event in this batch
        const newEventExposure = (eventExposureCents.get(order.event_ticker) || 0) + orderCost;
        eventExposureCents.set(order.event_ticker, newEventExposure);
        
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

