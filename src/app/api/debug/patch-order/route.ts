import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import crypto from 'crypto';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Helper to make authenticated Kalshi API calls
async function kalshiFetch(endpoint: string, method: string = 'GET'): Promise<any> {
  const timestampMs = Date.now().toString();
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
    const text = await response.text();
    throw new Error(`Kalshi API error: ${response.status} - ${text}`);
  }

  return response.json();
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = searchParams.get('ticker');

    if (!ticker) {
      return NextResponse.json({ error: 'Please provide ?ticker= parameter' }, { status: 400 });
    }

    // Step 1: Get order history from Kalshi for this ticker
    const ordersResponse = await kalshiFetch(`/portfolio/orders?ticker=${ticker}&status=all`);
    const kalshiOrders = ordersResponse?.orders || [];

    // Step 2: Get fills for this ticker
    const fillsResponse = await kalshiFetch(`/portfolio/fills?ticker=${ticker}`);
    const fills = fillsResponse?.fills || [];

    // Step 3: Get market details
    let marketDetails = null;
    try {
      const marketResponse = await kalshiFetch(`/markets/${ticker}`);
      marketDetails = marketResponse?.market;
    } catch (e) {
      console.log('Could not fetch market details:', e);
    }

    // Step 4: Check what we have in our database
    const { data: dbOrders, error: dbError } = await supabase
      .from('orders')
      .select('*, order_batches(batch_date)')
      .ilike('ticker', `%${ticker}%`);

    return NextResponse.json({
      ticker,
      kalshi: {
        orders: kalshiOrders.map((o: any) => ({
          order_id: o.order_id,
          ticker: o.ticker,
          side: o.side,
          type: o.type,
          status: o.status,
          yes_price: o.yes_price,
          no_price: o.no_price,
          count: o.count,
          filled_count: o.filled_count,
          remaining_count: o.remaining_count,
          created_time: o.created_time,
          expiration_time: o.expiration_time,
        })),
        fills: fills.map((f: any) => ({
          trade_id: f.trade_id,
          order_id: f.order_id,
          ticker: f.ticker,
          side: f.side,
          count: f.count,
          yes_price: f.yes_price,
          no_price: f.no_price,
          created_time: f.created_time,
          is_taker: f.is_taker,
        })),
        market: marketDetails ? {
          ticker: marketDetails.ticker,
          event_ticker: marketDetails.event_ticker,
          title: marketDetails.title,
          subtitle: marketDetails.subtitle,
          status: marketDetails.status,
          result: marketDetails.result,
          close_time: marketDetails.close_time,
          open_interest: marketDetails.open_interest,
        } : null,
      },
      database: {
        orders: dbOrders || [],
        error: dbError?.message,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST - Patch or create order in database
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { ticker, batch_date } = body;

    if (!ticker) {
      return NextResponse.json({ error: 'ticker is required' }, { status: 400 });
    }

    // Fetch Kalshi data
    const ordersResponse = await kalshiFetch(`/portfolio/orders?ticker=${ticker}&status=all`);
    const kalshiOrders = ordersResponse?.orders || [];

    const fillsResponse = await kalshiFetch(`/portfolio/fills?ticker=${ticker}`);
    const fills = fillsResponse?.fills || [];

    let marketDetails = null;
    try {
      const marketResponse = await kalshiFetch(`/markets/${ticker}`);
      marketDetails = marketResponse?.market;
    } catch (e) {
      console.log('Could not fetch market details');
    }

    if (kalshiOrders.length === 0) {
      return NextResponse.json({ error: 'No Kalshi orders found for this ticker' }, { status: 404 });
    }

    // Get or create batch for the specified date (default to today ET)
    const targetDate = batch_date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    
    let { data: batch } = await supabase
      .from('order_batches')
      .select('id')
      .eq('batch_date', targetDate)
      .single();

    if (!batch) {
      const { data: newBatch, error: batchError } = await supabase
        .from('order_batches')
        .insert({
          batch_date: targetDate,
          unit_size_cents: 100,
          total_orders: 0,
          total_cost_cents: 0,
          total_potential_payout_cents: 0,
          is_paused: false,
        })
        .select()
        .single();

      if (batchError) throw batchError;
      if (!newBatch) throw new Error('Failed to create batch');
      batch = newBatch;
    }

    if (!batch) {
      throw new Error('Failed to get or create batch');
    }

    const results: any[] = [];

    for (const kalshiOrder of kalshiOrders) {
      if (kalshiOrder.filled_count === 0) continue; // Skip unfilled orders

      // Calculate costs from fills for this order
      const orderFills = fills.filter((f: any) => f.order_id === kalshiOrder.order_id);
      const totalFilledCost = orderFills.reduce((sum: number, f: any) => {
        const price = kalshiOrder.side === 'yes' ? f.yes_price : f.no_price;
        return sum + (price * f.count);
      }, 0);
      
      const avgPrice = kalshiOrder.filled_count > 0 
        ? Math.round(totalFilledCost / kalshiOrder.filled_count) 
        : (kalshiOrder.side === 'yes' ? kalshiOrder.yes_price : kalshiOrder.no_price);

      // Check if order already exists in DB
      const { data: existingOrder } = await supabase
        .from('orders')
        .select('id')
        .eq('kalshi_order_id', kalshiOrder.order_id)
        .single();

      const orderData = {
        batch_id: batch.id,
        ticker: kalshiOrder.ticker,
        event_ticker: marketDetails?.event_ticker || kalshiOrder.ticker.split('-')[0],
        title: marketDetails?.title || kalshiOrder.ticker,
        side: kalshiOrder.side.toUpperCase(),
        price_cents: avgPrice,
        units: kalshiOrder.filled_count,
        cost_cents: avgPrice * kalshiOrder.filled_count,
        potential_payout_cents: kalshiOrder.filled_count * 100,
        open_interest: marketDetails?.open_interest || 0,
        volume_24h: 0,
        market_close_time: marketDetails?.close_time || new Date().toISOString(),
        placement_status: 'confirmed',
        placement_status_at: kalshiOrder.created_time,
        result_status: marketDetails?.result === 'yes' 
          ? (kalshiOrder.side === 'yes' ? 'won' : 'lost')
          : marketDetails?.result === 'no'
            ? (kalshiOrder.side === 'no' ? 'won' : 'lost')
            : 'undecided',
        settlement_status: marketDetails?.status === 'finalized' ? 'settled' : 'pending',
        executed_price_cents: avgPrice,
        executed_cost_cents: avgPrice * kalshiOrder.filled_count,
        kalshi_order_id: kalshiOrder.order_id,
      };

      if (existingOrder) {
        // Update existing order
        const { error: updateError } = await supabase
          .from('orders')
          .update(orderData)
          .eq('id', existingOrder.id);

        results.push({
          action: 'updated',
          order_id: kalshiOrder.order_id,
          ticker: kalshiOrder.ticker,
          error: updateError?.message,
        });
      } else {
        // Insert new order
        const { error: insertError } = await supabase
          .from('orders')
          .insert(orderData);

        results.push({
          action: 'inserted',
          order_id: kalshiOrder.order_id,
          ticker: kalshiOrder.ticker,
          error: insertError?.message,
        });
      }
    }

    return NextResponse.json({
      success: true,
      batch_id: batch.id,
      batch_date: targetDate,
      results,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

