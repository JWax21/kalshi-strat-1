import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getBalance, placeOrder, getMarkets, filterHighOddsMarkets, getMarketOdds, KalshiMarket } from '@/lib/kalshi';
import crypto from 'crypto';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_POSITION_PERCENT = 0.03; // 3% max per market
const RESTING_IMPROVE_AFTER_MINUTES = 60; // Improve price after 1 hour
const RESTING_CANCEL_AFTER_MINUTES = 240; // Cancel after 4 hours
const PRICE_IMPROVEMENT_CENTS = 1; // Improve by 1 cent each time

// Helper to make authenticated Kalshi API calls
async function kalshiFetch(endpoint: string, method: string = 'GET', body?: any): Promise<any> {
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
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kalshi API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

interface MonitorResult {
  success: boolean;
  timestamp: string;
  actions: {
    improved_orders: number;
    cancelled_orders: number;
    new_orders_placed: number;
    new_markets_found: number;
  };
  capital: {
    available_cents: number;
    deployed_cents: number;
    remaining_cents: number;
  };
  details: {
    improved: string[];
    cancelled: string[];
    new_placements: string[];
    errors: string[];
  };
}

async function monitorAndOptimize(): Promise<MonitorResult> {
  const result: MonitorResult = {
    success: true,
    timestamp: new Date().toISOString(),
    actions: {
      improved_orders: 0,
      cancelled_orders: 0,
      new_orders_placed: 0,
      new_markets_found: 0,
    },
    capital: {
      available_cents: 0,
      deployed_cents: 0,
      remaining_cents: 0,
    },
    details: {
      improved: [],
      cancelled: [],
      new_placements: [],
      errors: [],
    },
  };

  const today = new Date().toISOString().split('T')[0];

  // Step 1: Get current balance
  let availableBalance = 0;
  try {
    const balanceData = await getBalance();
    availableBalance = balanceData.balance || 0;
    result.capital.available_cents = availableBalance;
  } catch (e) {
    result.details.errors.push(`Failed to fetch balance: ${e}`);
    result.success = false;
    return result;
  }

  // Step 2: Get all "placed" (resting) orders for today
  const { data: restingOrders, error: restingError } = await supabase
    .from('orders')
    .select('*, order_batches!inner(batch_date)')
    .eq('placement_status', 'placed')
    .not('kalshi_order_id', 'is', null);

  if (restingError) {
    result.details.errors.push(`Failed to fetch resting orders: ${restingError.message}`);
  }

  // Step 3: Check Kalshi for actual order status and handle stale orders
  const kalshiOrdersResponse = await kalshiFetch('/portfolio/orders?status=resting');
  const kalshiRestingOrders = new Map(
    (kalshiOrdersResponse.orders || []).map((o: any) => [o.order_id, o])
  );

  // Get our current positions to calculate existing exposure
  const positionsResponse = await kalshiFetch('/portfolio/positions');
  const currentPositions = new Map(
    (positionsResponse.market_positions || []).map((p: any) => [p.ticker, p])
  );

  // Calculate total exposure (capital already deployed)
  let totalExposure = 0;
  for (const [, pos] of currentPositions) {
    totalExposure += (pos as any).position_cost || 0;
  }
  result.capital.deployed_cents = totalExposure;
  result.capital.remaining_cents = availableBalance;

  // Step 4: Process resting orders - improve or cancel
  for (const order of restingOrders || []) {
    const kalshiOrder = kalshiOrdersResponse.orders?.find(
      (o: any) => o.order_id === order.kalshi_order_id
    );

    // If order is no longer resting on Kalshi, it might have filled
    if (!kalshiOrder) {
      // Check if it's now executed
      try {
        const orderDetail = await kalshiFetch(`/portfolio/orders/${order.kalshi_order_id}`);
        if (orderDetail.order?.status === 'executed') {
          // Update to confirmed
          await supabase
            .from('orders')
            .update({
              placement_status: 'confirmed',
              placement_status_at: new Date().toISOString(),
              executed_price_cents: order.side === 'YES' 
                ? orderDetail.order.yes_price 
                : orderDetail.order.no_price,
              executed_cost_cents: order.side === 'YES' 
                ? orderDetail.order.yes_price 
                : orderDetail.order.no_price,
            })
            .eq('id', order.id);
          result.details.improved.push(`${order.ticker}: filled!`);
        }
      } catch (e) {
        // Order might not exist anymore
      }
      continue;
    }

    // Calculate how long it's been resting
    const createdAt = new Date(kalshiOrder.created_time);
    const minutesResting = (Date.now() - createdAt.getTime()) / 60000;

    // If resting too long, cancel and blacklist
    if (minutesResting >= RESTING_CANCEL_AFTER_MINUTES) {
      try {
        // Cancel the order
        await kalshiFetch(`/portfolio/orders/${order.kalshi_order_id}`, 'DELETE');
        
        // Update order status
        await supabase
          .from('orders')
          .update({
            placement_status: 'cancelled',
            placement_status_at: new Date().toISOString(),
            cancelled_at: new Date().toISOString(),
            cancel_reason: `Unfilled for ${Math.round(minutesResting)} minutes`,
          })
          .eq('id', order.id);

        // Add to illiquid markets
        await supabase
          .from('illiquid_markets')
          .upsert({
            ticker: order.ticker,
            event_ticker: order.event_ticker,
            title: order.title,
            reason: `Order unfilled for ${Math.round(minutesResting)} minutes`,
            original_order_id: order.id,
          }, { onConflict: 'ticker' });

        result.actions.cancelled_orders++;
        result.details.cancelled.push(`${order.ticker}: cancelled after ${Math.round(minutesResting)} min`);
        
        // Reclaim the capital
        availableBalance += order.price_cents;
      } catch (e) {
        result.details.errors.push(`Failed to cancel ${order.ticker}: ${e}`);
      }
    }
    // If resting for a while, try to improve the price
    else if (minutesResting >= RESTING_IMPROVE_AFTER_MINUTES) {
      try {
        const currentPrice = order.side === 'YES' 
          ? kalshiOrder.yes_price 
          : kalshiOrder.no_price;
        const newPrice = Math.min(currentPrice + PRICE_IMPROVEMENT_CENTS, 99);

        // Cancel old order
        await kalshiFetch(`/portfolio/orders/${order.kalshi_order_id}`, 'DELETE');

        // Place new order with better price
        const payload: any = {
          ticker: order.ticker,
          action: 'buy',
          side: order.side.toLowerCase(),
          count: order.units || 1,
          type: 'limit',
          client_order_id: `improve_${order.id}_${Date.now()}`,
        };

        if (order.side === 'YES') {
          payload.yes_price = newPrice;
        } else {
          payload.no_price = newPrice;
        }

        const newOrderResult = await placeOrder(payload);
        const newKalshiOrderId = newOrderResult.order?.order_id;
        const newStatus = newOrderResult.order?.status;

        await supabase
          .from('orders')
          .update({
            price_cents: newPrice,
            kalshi_order_id: newKalshiOrderId,
            placement_status: newStatus === 'executed' ? 'confirmed' : 'placed',
            placement_status_at: new Date().toISOString(),
            executed_price_cents: newStatus === 'executed' ? newPrice : null,
            executed_cost_cents: newStatus === 'executed' ? newPrice : null,
          })
          .eq('id', order.id);

        result.actions.improved_orders++;
        result.details.improved.push(
          `${order.ticker}: ${currentPrice}¢ → ${newPrice}¢ (${newStatus})`
        );
      } catch (e) {
        result.details.errors.push(`Failed to improve ${order.ticker}: ${e}`);
      }
    }
  }

  // Step 5: Look for new qualifying markets
  const sportsSeries = [
    'KXNBAGAME', 'KXNFLGAME', 'KXMLBGAME', 'KXNHLGAME',
    'KXNCAAMBGAME', 'KXNCAAWBGAME', 'KXNCAAFBGAME',
    'KXNCAAFCSGAME', 'KXNCAAFGAME',
    'KXEUROLEAGUEGAME', 'KXNBLGAME', 'KXCRICKETTESTMATCH',
    'KXEFLCHAMPIONSHIPGAME', 'KXDOTA2GAME', 'KXUFCFIGHT'
  ];

  let allMarkets: KalshiMarket[] = [];
  for (const series of sportsSeries) {
    try {
      const markets = await getMarkets(200, 17 * 24, 1, series);
      allMarkets.push(...markets);
    } catch (e) {
      // Skip if no markets
    }
  }

  // Filter markets
  let filteredMarkets = filterHighOddsMarkets(allMarkets, 0.85, 0.995);
  filteredMarkets = filteredMarkets.filter(m => m.open_interest >= 1000);

  // Exclude blacklisted markets
  const { data: blacklistedMarkets } = await supabase
    .from('illiquid_markets')
    .select('ticker');
  const blacklistedTickers = new Set((blacklistedMarkets || []).map(m => m.ticker));
  filteredMarkets = filteredMarkets.filter(m => !blacklistedTickers.has(m.ticker));

  // Get existing orders to exclude markets we already have
  const { data: existingOrders } = await supabase
    .from('orders')
    .select('ticker')
    .in('placement_status', ['pending', 'placed', 'confirmed']);
  const existingTickers = new Set((existingOrders || []).map(o => o.ticker));

  // Find new markets we don't have orders for
  const newMarkets = filteredMarkets.filter(m => !existingTickers.has(m.ticker));
  result.actions.new_markets_found = newMarkets.length;

  // Step 6: Deploy remaining capital to new markets (if any)
  if (newMarkets.length > 0 && availableBalance > 0) {
    // Sort by open interest descending
    newMarkets.sort((a, b) => b.open_interest - a.open_interest);

    // Calculate total portfolio for 3% limit
    const totalPortfolio = availableBalance + totalExposure;
    const maxPositionCents = Math.floor(totalPortfolio * MAX_POSITION_PERCENT);

    // Find or create today's batch
    let batchId: string;
    const { data: existingBatch } = await supabase
      .from('order_batches')
      .select('id')
      .eq('batch_date', today)
      .single();

    if (existingBatch) {
      batchId = existingBatch.id;
    } else {
      const { data: newBatch, error: batchError } = await supabase
        .from('order_batches')
        .insert({
          batch_date: today,
          unit_size_cents: 100,
          total_orders: 0,
          total_cost_cents: 0,
          total_potential_payout_cents: 0,
          is_paused: false,
          prepared_at: new Date().toISOString(),
          executed_at: new Date().toISOString(), // Mark as executed since we're placing immediately
        })
        .select()
        .single();

      if (batchError) {
        result.details.errors.push(`Failed to create batch: ${batchError.message}`);
        return result;
      }
      batchId = newBatch.id;
    }

    // Place orders on new markets
    for (const market of newMarkets) {
      if (availableBalance <= 0) break;

      const odds = getMarketOdds(market);
      const favoriteSide = odds.yes >= odds.no ? 'YES' : 'NO';
      const priceCents = Math.round(Math.max(odds.yes, odds.no) * 100);

      // Check 3% limit
      if (priceCents > maxPositionCents) continue;
      if (availableBalance < priceCents) continue;

      // Calculate max units
      const maxUnits = Math.floor(maxPositionCents / priceCents);
      const affordableUnits = Math.floor(availableBalance / priceCents);
      const units = Math.min(maxUnits, affordableUnits, 3); // Cap at 3 units per new market

      if (units <= 0) continue;

      try {
        // Place order on Kalshi
        const payload: any = {
          ticker: market.ticker,
          action: 'buy',
          side: favoriteSide.toLowerCase(),
          count: units,
          type: 'limit',
          client_order_id: `monitor_${market.ticker}_${Date.now()}`,
        };

        if (favoriteSide === 'YES') {
          payload.yes_price = priceCents;
        } else {
          payload.no_price = priceCents;
        }

        const orderResult = await placeOrder(payload);
        const kalshiOrderId = orderResult.order?.order_id;
        const status = orderResult.order?.status;
        const isExecuted = status === 'executed';

        // Save to DB
        await supabase
          .from('orders')
          .insert({
            batch_id: batchId,
            ticker: market.ticker,
            event_ticker: market.event_ticker,
            title: market.title,
            side: favoriteSide,
            price_cents: priceCents,
            units: units,
            cost_cents: priceCents * units,
            potential_payout_cents: 100 * units,
            open_interest: market.open_interest,
            market_close_time: market.close_time,
            placement_status: isExecuted ? 'confirmed' : 'placed',
            placement_status_at: new Date().toISOString(),
            kalshi_order_id: kalshiOrderId,
            executed_price_cents: isExecuted ? priceCents : null,
            executed_cost_cents: isExecuted ? priceCents * units : null,
            result_status: 'undecided',
            settlement_status: 'pending',
          });

        availableBalance -= priceCents * units;
        result.actions.new_orders_placed++;
        result.details.new_placements.push(
          `${market.ticker}: ${units}u @ ${priceCents}¢ (${status})`
        );

        await new Promise(r => setTimeout(r, 200)); // Rate limit
      } catch (e) {
        result.details.errors.push(`Failed to place ${market.ticker}: ${e}`);
      }
    }

    // Update batch totals
    const { data: batchOrders } = await supabase
      .from('orders')
      .select('cost_cents, potential_payout_cents')
      .eq('batch_id', batchId);

    if (batchOrders) {
      const totalCost = batchOrders.reduce((sum, o) => sum + (o.cost_cents || 0), 0);
      const totalPayout = batchOrders.reduce((sum, o) => sum + (o.potential_payout_cents || 0), 0);
      
      await supabase
        .from('order_batches')
        .update({
          total_orders: batchOrders.length,
          total_cost_cents: totalCost,
          total_potential_payout_cents: totalPayout,
        })
        .eq('id', batchId);
    }
  }

  result.capital.remaining_cents = availableBalance;
  return result;
}

// GET - Called by Vercel Cron every 30 minutes
export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await monitorAndOptimize();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error in monitor:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// POST - Manual trigger
export async function POST() {
  try {
    const result = await monitorAndOptimize();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error in monitor:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

