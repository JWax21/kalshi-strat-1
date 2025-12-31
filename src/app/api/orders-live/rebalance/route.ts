import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import crypto from 'crypto';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': KALSHI_CONFIG.apiKey,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${KALSHI_CONFIG.baseUrl}${endpoint}`, options);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kalshi API error: ${response.status} - ${text}`);
  }

  return response.json();
}

const STALE_ORDER_HOURS = 4;
const MAX_POSITION_PERCENT = 0.03; // 3% max per market

interface RebalanceResult {
  cancelled: number;
  blacklisted: string[];
  redeployed: number;
  redeployed_units: number;
  errors: string[];
}

async function rebalanceOrders(): Promise<RebalanceResult> {
  const result: RebalanceResult = {
    cancelled: 0,
    blacklisted: [],
    redeployed: 0,
    redeployed_units: 0,
    errors: [],
  };

  // Get current balance
  let availableCapitalCents = 0;
  try {
    const balanceData = await kalshiFetch('/portfolio/balance');
    availableCapitalCents = balanceData?.balance || 0;
  } catch (e) {
    result.errors.push('Failed to fetch balance');
    return result;
  }

  // Find orders that have been "placed" (resting) for more than 4 hours
  const staleTime = new Date();
  staleTime.setHours(staleTime.getHours() - STALE_ORDER_HOURS);

  const { data: staleOrders, error: staleError } = await supabase
    .from('orders')
    .select('*')
    .eq('placement_status', 'placed')
    .lt('placement_status_at', staleTime.toISOString());

  if (staleError) {
    result.errors.push(`Error fetching stale orders: ${staleError.message}`);
    return result;
  }

  if (!staleOrders || staleOrders.length === 0) {
    return result; // Nothing to rebalance
  }

  // Cancel each stale order and blacklist the market
  for (const order of staleOrders) {
    try {
      // Cancel the order on Kalshi
      if (order.kalshi_order_id) {
        try {
          await kalshiFetch(`/portfolio/orders/${order.kalshi_order_id}`, 'DELETE');
        } catch (cancelError) {
          // Order might already be cancelled or filled
          console.log(`Could not cancel order ${order.kalshi_order_id}:`, cancelError);
        }
      }

      // Update order status
      await supabase
        .from('orders')
        .update({
          placement_status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          cancel_reason: `Not filled after ${STALE_ORDER_HOURS} hours - market illiquid`,
        })
        .eq('id', order.id);

      result.cancelled++;

      // Add to illiquid markets blacklist
      const { error: blacklistError } = await supabase
        .from('illiquid_markets')
        .upsert({
          ticker: order.ticker,
          event_ticker: order.event_ticker,
          title: order.title,
          reason: `Order not filled after ${STALE_ORDER_HOURS} hours`,
          original_order_id: order.id,
          flagged_at: new Date().toISOString(),
        }, {
          onConflict: 'ticker',
        });

      if (!blacklistError) {
        result.blacklisted.push(order.ticker);
      }

      // Add the freed capital back
      availableCapitalCents += order.cost_cents;

    } catch (error) {
      result.errors.push(`Error processing order ${order.id}: ${error}`);
    }
  }

  // Now redeploy the freed capital to existing confirmed positions
  if (availableCapitalCents > 0) {
    // FIRST: Get TOTAL portfolio value from Kalshi positions (not just today's orders)
    let totalExistingExposureCents = 0;
    try {
      const positionsResponse = await kalshiFetch('/portfolio/positions');
      const positions = positionsResponse.market_positions || [];
      totalExistingExposureCents = positions.reduce((sum: number, p: any) => sum + (p.position_cost || 0), 0);
    } catch (e) {
      result.errors.push(`Failed to fetch positions for portfolio calculation: ${e}`);
    }
    
    // Calculate TOTAL portfolio value = cash + all positions
    const totalPortfolioCents = availableCapitalCents + totalExistingExposureCents;
    const hardCapCents = Math.floor(totalPortfolioCents * MAX_POSITION_PERCENT);
    
    console.log(`Rebalance: Portfolio=${totalPortfolioCents}¢ (cash=${availableCapitalCents}¢ + positions=${totalExistingExposureCents}¢), 3% cap=${hardCapCents}¢`);

    // Get today's batch
    const today = new Date().toISOString().split('T')[0];
    const { data: todayBatch } = await supabase
      .from('order_batches')
      .select('id')
      .eq('batch_date', today)
      .single();

    if (todayBatch) {
      // Get confirmed orders from today, sorted by open interest
      const { data: confirmedOrders } = await supabase
        .from('orders')
        .select('*')
        .eq('batch_id', todayBatch.id)
        .eq('placement_status', 'confirmed')
        .order('open_interest', { ascending: false });

      if (confirmedOrders && confirmedOrders.length > 0) {
        // Try to add units to existing positions (highest OI first)
        for (const order of confirmedOrders) {
          if (availableCapitalCents <= 0) break;

          const currentPositionValue = order.executed_cost_cents || order.cost_cents;
          const roomToAdd = hardCapCents - currentPositionValue;

          if (roomToAdd > 0) {
            const unitCost = order.price_cents;
            const unitsToAdd = Math.min(
              Math.floor(roomToAdd / unitCost),
              Math.floor(availableCapitalCents / unitCost)
            );

            if (unitsToAdd > 0) {
              const orderCostCents = unitsToAdd * unitCost;
              const newPositionValue = currentPositionValue + orderCostCents;
              
              // HARD CAP GUARD: Verify the NEW position won't exceed 3%
              if (newPositionValue > hardCapCents) {
                console.log(`Skipping ${order.ticker} - new position ${newPositionValue}¢ would exceed 3% cap ${hardCapCents}¢`);
                continue;
              }
              
              // Place additional order for this market
              try {
                const orderResponse = await kalshiFetch('/portfolio/orders', 'POST', {
                  ticker: order.ticker,
                  action: 'buy',
                  side: order.side.toLowerCase(),
                  type: 'market',
                  count: unitsToAdd,
                });

                if (orderResponse?.order) {
                  const additionalCost = unitsToAdd * unitCost;
                  
                  // Update the existing order with additional units
                  await supabase
                    .from('orders')
                    .update({
                      units: order.units + unitsToAdd,
                      cost_cents: order.cost_cents + additionalCost,
                      potential_payout_cents: order.potential_payout_cents + (unitsToAdd * 100),
                      executed_cost_cents: (order.executed_cost_cents || 0) + additionalCost,
                    })
                    .eq('id', order.id);

                  availableCapitalCents -= additionalCost;
                  result.redeployed++;
                  result.redeployed_units += unitsToAdd;
                }
              } catch (orderError) {
                result.errors.push(`Error adding to position ${order.ticker}: ${orderError}`);
              }
            }
          }
        }
      }
    }
  }

  return result;
}

// GET - Called by Vercel Cron hourly
export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await rebalanceOrders();

    return NextResponse.json({
      success: true,
      ...result,
      message: `Cancelled ${result.cancelled} stale orders, redeployed ${result.redeployed_units} units to ${result.redeployed} positions`,
    });
  } catch (error) {
    console.error('Error rebalancing orders:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// POST - Manual trigger
export async function POST(request: Request) {
  try {
    const result = await rebalanceOrders();

    return NextResponse.json({
      success: true,
      ...result,
      message: `Cancelled ${result.cancelled} stale orders, redeployed ${result.redeployed_units} units to ${result.redeployed} positions`,
    });
  } catch (error) {
    console.error('Error rebalancing orders:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

