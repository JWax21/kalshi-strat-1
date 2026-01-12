import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import crypto from 'crypto';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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

// Recover orders from Kalshi fills and settlements data
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { dryRun = false } = body;
    
    console.log('Starting order recovery from Kalshi data...');
    
    // Get all fills from Kalshi
    let allFills: any[] = [];
    let cursor: string | null = null;
    do {
      const endpoint = `/portfolio/fills?limit=1000${cursor ? `&cursor=${cursor}` : ''}`;
      const data = await kalshiFetch(endpoint);
      allFills.push(...(data.fills || []));
      cursor = data.cursor;
      await new Promise(r => setTimeout(r, 100));
    } while (cursor);
    
    console.log(`Found ${allFills.length} fills from Kalshi`);
    
    // Get all settlements from Kalshi
    let allSettlements: any[] = [];
    cursor = null;
    do {
      const endpoint = `/portfolio/settlements?limit=1000${cursor ? `&cursor=${cursor}` : ''}`;
      const data = await kalshiFetch(endpoint);
      allSettlements.push(...(data.settlements || []));
      cursor = data.cursor;
      await new Promise(r => setTimeout(r, 100));
    } while (cursor);
    
    console.log(`Found ${allSettlements.length} settlements from Kalshi`);
    
    // Create lookup maps
    const settlementByTicker = new Map<string, any>();
    for (const s of allSettlements) {
      settlementByTicker.set(s.ticker, s);
    }
    
    // Group fills by order_id
    const fillsByOrderId = new Map<string, any[]>();
    for (const fill of allFills) {
      if (!fillsByOrderId.has(fill.order_id)) {
        fillsByOrderId.set(fill.order_id, []);
      }
      fillsByOrderId.get(fill.order_id)!.push(fill);
    }
    
    // Get existing orders from DB
    const { data: existingOrders } = await supabase
      .from('orders')
      .select('kalshi_order_id, ticker');
    
    const existingOrderIds = new Set((existingOrders || []).map(o => o.kalshi_order_id));
    const existingTickers = new Set((existingOrders || []).map(o => o.ticker));
    
    // Find orders that need to be recovered (have fills but not in DB)
    const ordersToRecover: any[] = [];
    
    for (const [orderId, fills] of fillsByOrderId) {
      if (existingOrderIds.has(orderId)) continue; // Already in DB
      
      const firstFill = fills[0];
      const ticker = firstFill.ticker;
      
      // Check if we already have an order for this ticker (might be a duplicate)
      if (existingTickers.has(ticker)) continue;
      
      const totalCount = fills.reduce((sum: number, f: any) => sum + (f.count || 0), 0);
      const avgPrice = fills.reduce((sum: number, f: any) => sum + (f.price || 0) * (f.count || 0), 0) / totalCount;
      const totalCost = Math.round(avgPrice * totalCount);
      const side = firstFill.side?.toUpperCase() || 'YES';
      const settlement = settlementByTicker.get(ticker);
      
      // Extract event_ticker from ticker (e.g., KXNFLGAME-25DEC28NENYJ-NE -> KXNFLGAME-25DEC28NENYJ)
      const parts = ticker.split('-');
      const eventTicker = parts.slice(0, -1).join('-');
      
      // Determine result status
      let resultStatus = 'undecided';
      let actualPayout = 0;
      let feeCents = 0;
      
      if (settlement) {
        const marketResult = settlement.market_result;
        const won = side.toLowerCase() === marketResult;
        resultStatus = won ? 'won' : 'lost';
        actualPayout = settlement.revenue || 0;
        feeCents = Math.round(parseFloat(settlement.fee_cost || '0') * 100);
      }
      
      // Get market details
      let marketData: any = null;
      try {
        const marketResponse = await kalshiFetch(`/markets/${ticker}`);
        marketData = marketResponse?.market;
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {
        console.log(`Could not fetch market details for ${ticker}`);
      }
      
      // Determine batch date from ticker
      const dateMatch = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
      let batchDate = new Date().toISOString().split('T')[0];
      if (dateMatch) {
        const monthMap: Record<string, string> = {
          'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04',
          'MAY': '05', 'JUN': '06', 'JUL': '07', 'AUG': '08',
          'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
        };
        const year = `20${dateMatch[1]}`;
        const month = monthMap[dateMatch[2]] || '01';
        const day = dateMatch[3];
        batchDate = `${year}-${month}-${day}`;
      }
      
      ordersToRecover.push({
        kalshi_order_id: orderId,
        ticker,
        event_ticker: eventTicker,
        title: marketData?.title || ticker,
        side,
        price_cents: Math.round(avgPrice),
        units: totalCount,
        cost_cents: totalCost,
        executed_price_cents: Math.round(avgPrice),
        executed_cost_cents: totalCost,
        potential_payout_cents: totalCount * 100,
        potential_profit_cents: totalCount * (100 - Math.round(avgPrice)),
        open_interest: marketData?.open_interest || 0,
        market_close_time: marketData?.close_time,
        placement_status: 'confirmed',
        result_status: resultStatus,
        settlement_status: resultStatus === 'won' ? 'success' : (resultStatus === 'lost' ? 'closed' : 'pending'),
        actual_payout_cents: actualPayout,
        fee_cents: feeCents,
        batch_date: batchDate,
      });
    }
    
    console.log(`Found ${ordersToRecover.length} orders to recover`);
    
    if (dryRun) {
      return NextResponse.json({
        success: true,
        dryRun: true,
        ordersToRecover: ordersToRecover.length,
        samples: ordersToRecover.slice(0, 10),
      });
    }
    
    // Create batches for each date
    const ordersByDate = new Map<string, typeof ordersToRecover>();
    for (const order of ordersToRecover) {
      if (!ordersByDate.has(order.batch_date)) {
        ordersByDate.set(order.batch_date, []);
      }
      ordersByDate.get(order.batch_date)!.push(order);
    }
    
    let totalRecovered = 0;
    const recoveryDetails: any[] = [];
    
    for (const [batchDate, orders] of ordersByDate) {
      // Find or create batch
      let batchId: string;
      const { data: existingBatch } = await supabase
        .from('order_batches')
        .select('id')
        .eq('batch_date', batchDate)
        .single();
      
      if (existingBatch) {
        batchId = existingBatch.id;
      } else {
        const { data: newBatch, error: batchError } = await supabase
          .from('order_batches')
          .insert({
            batch_date: batchDate,
            unit_size_cents: 100,
            total_orders: 0,
            total_cost_cents: 0,
            total_potential_payout_cents: 0,
            is_paused: false,
          })
          .select()
          .single();
        
        if (batchError) {
          console.error(`Failed to create batch for ${batchDate}:`, batchError);
          continue;
        }
        batchId = newBatch.id;
      }
      
      // Insert orders
      for (const order of orders) {
        const { error: insertError } = await supabase
          .from('orders')
          .insert({
            batch_id: batchId,
            ticker: order.ticker,
            event_ticker: order.event_ticker,
            title: order.title,
            side: order.side,
            price_cents: order.price_cents,
            units: order.units,
            cost_cents: order.cost_cents,
            executed_price_cents: order.executed_price_cents,
            executed_cost_cents: order.executed_cost_cents,
            potential_payout_cents: order.potential_payout_cents,
            potential_profit_cents: order.potential_profit_cents,
            open_interest: order.open_interest,
            market_close_time: order.market_close_time,
            placement_status: order.placement_status,
            placement_status_at: new Date().toISOString(),
            kalshi_order_id: order.kalshi_order_id,
            result_status: order.result_status,
            result_status_at: order.result_status !== 'undecided' ? new Date().toISOString() : null,
            settlement_status: order.settlement_status,
            settled_at: order.settlement_status !== 'pending' ? new Date().toISOString() : null,
            actual_payout_cents: order.actual_payout_cents,
            fee_cents: order.fee_cents,
          });
        
        if (insertError) {
          console.error(`Failed to insert order ${order.ticker}:`, insertError);
        } else {
          totalRecovered++;
          recoveryDetails.push({
            ticker: order.ticker,
            side: order.side,
            units: order.units,
            result: order.result_status,
          });
        }
      }
      
      // Update batch totals
      const { data: batchOrders } = await supabase
        .from('orders')
        .select('cost_cents, potential_payout_cents')
        .eq('batch_id', batchId);
      
      if (batchOrders) {
        await supabase
          .from('order_batches')
          .update({
            total_orders: batchOrders.length,
            total_cost_cents: batchOrders.reduce((sum, o) => sum + (o.cost_cents || 0), 0),
            total_potential_payout_cents: batchOrders.reduce((sum, o) => sum + (o.potential_payout_cents || 0), 0),
          })
          .eq('id', batchId);
      }
    }
    
    return NextResponse.json({
      success: true,
      totalRecovered,
      byDate: Object.fromEntries([...ordersByDate].map(([date, orders]) => [date, orders.length])),
      samples: recoveryDetails.slice(0, 20),
    });
    
  } catch (error) {
    console.error('Recovery error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'POST to this endpoint to recover orders from Kalshi fills. Use {"dryRun": true} to preview.',
  });
}

