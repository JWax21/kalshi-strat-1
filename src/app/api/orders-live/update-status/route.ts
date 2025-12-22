import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import crypto from 'crypto';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Helper to check market result
async function getMarketResult(ticker: string): Promise<{ 
  settled: boolean; 
  result: 'yes' | 'no' | null;
  status: string;
}> {
  try {
    const timestampMs = Date.now().toString();
    const method = 'GET';
    const endpoint = `/markets/${ticker}`;
    const fullPath = `/trade-api/v2${endpoint}`;

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
      return { settled: false, result: null, status: 'error' };
    }

    const data = await response.json();
    const market = data.market;

    if (market.result === 'yes' || market.result === 'no') {
      return { settled: true, result: market.result, status: market.status };
    }

    if (market.status === 'settled' || market.status === 'finalized') {
      return { settled: true, result: market.result || null, status: market.status };
    }

    return { settled: false, result: null, status: market.status };
  } catch (error) {
    console.error(`Error checking market ${ticker}:`, error);
    return { settled: false, result: null, status: 'error' };
  }
}

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

// Check fills to see if order was executed (from /portfolio/fills)
async function checkOrderFilled(ticker: string, orderId: string): Promise<{
  filled: boolean;
  fillPrice: number | null;
  fillCount: number;
}> {
  try {
    const data = await kalshiFetch(`/portfolio/fills?ticker=${ticker}&limit=50`);
    const fills = data.fills || [];
    
    // Find fills for this order
    const orderFills = fills.filter((f: any) => f.order_id === orderId);
    
    if (orderFills.length > 0) {
      const totalCount = orderFills.reduce((sum: number, f: any) => sum + (f.count || 0), 0);
      const avgPrice = orderFills[0]?.price || null;
      return { filled: true, fillPrice: avgPrice, fillCount: totalCount };
    }
    
    return { filled: false, fillPrice: null, fillCount: 0 };
  } catch (error) {
    console.error(`Error checking fills for ${ticker}:`, error);
    return { filled: false, fillPrice: null, fillCount: 0 };
  }
}

// Check settlements to see if payout was received (from /portfolio/settlements)
// Response: { ticker, event_ticker, market_result, yes_count, yes_total_cost, no_count, no_total_cost, revenue, settled_time, fee_cost, value }
async function checkSettlementReceived(ticker: string, side: string): Promise<{
  settled: boolean;
  market_result: 'yes' | 'no' | null;
  revenue: number;
  count: number;
  total_cost: number;
  fee_cost: number;
  settled_time: string | null;
}> {
  try {
    const data = await kalshiFetch(`/portfolio/settlements?ticker=${ticker}&limit=10`);
    const settlements = data.settlements || [];
    
    // Find settlement for this ticker
    const settlement = settlements.find((s: any) => s.ticker === ticker);
    
    if (settlement) {
      // Get the count and cost for the side we bet on
      const count = side.toLowerCase() === 'yes' ? (settlement.yes_count || 0) : (settlement.no_count || 0);
      const totalCost = side.toLowerCase() === 'yes' ? (settlement.yes_total_cost || 0) : (settlement.no_total_cost || 0);
      
      return { 
        settled: true, 
        market_result: settlement.market_result || null,
        revenue: settlement.revenue || 0, // Revenue in cents (payout for winning)
        count: count,
        total_cost: totalCost,
        fee_cost: parseFloat(settlement.fee_cost || '0') * 100, // Convert to cents
        settled_time: settlement.settled_time || null,
      };
    }
    
    return { 
      settled: false, 
      market_result: null,
      revenue: 0,
      count: 0,
      total_cost: 0,
      fee_cost: 0,
      settled_time: null,
    };
  } catch (error) {
    console.error(`Error checking settlement for ${ticker}:`, error);
    return { 
      settled: false, 
      market_result: null,
      revenue: 0,
      count: 0,
      total_cost: 0,
      fee_cost: 0,
      settled_time: null,
    };
  }
}

async function updateOrderStatuses() {
  // Get all orders that are not in final state
  // Final states: settlement_status = 'closed' or 'success'
  const { data: orders, error } = await supabase
    .from('orders')
    .select('*')
    .in('settlement_status', ['pending'])
    .not('placement_status', 'eq', 'pending'); // Only check placed/confirmed orders

  if (error) throw error;

  if (!orders || orders.length === 0) {
    return {
      success: true,
      message: 'No orders to update',
      updated: 0,
    };
  }

  console.log(`Checking ${orders.length} orders...`);

  let updatedCount = 0;
  let wonCount = 0;
  let lostCount = 0;
  let filledCount = 0;
  const errors: string[] = [];

  for (const order of orders) {
    try {
      // First, check if "placed" orders have been filled using /portfolio/fills
      if (order.placement_status === 'placed' && order.kalshi_order_id) {
        const fillResult = await checkOrderFilled(order.ticker, order.kalshi_order_id);
        
        if (fillResult.filled) {
          // Order has been filled!
          await supabase
            .from('orders')
            .update({
              placement_status: 'confirmed',
              placement_status_at: new Date().toISOString(),
              executed_price_cents: fillResult.fillPrice,
              executed_cost_cents: fillResult.fillPrice ? fillResult.fillPrice * fillResult.fillCount : null,
            })
            .eq('id', order.id);
          
          filledCount++;
          console.log(`Order ${order.ticker} filled: ${fillResult.fillCount} @ ${fillResult.fillPrice}¢`);
        }
        
        await new Promise(r => setTimeout(r, 100));
      }
      
      // Then check if confirmed orders have market results
      if (order.placement_status === 'confirmed' && order.result_status === 'undecided') {
        const { settled, result } = await getMarketResult(order.ticker);

        if (settled && result) {
          const won = order.side.toLowerCase() === result;
          const resultStatus = won ? 'won' : 'lost';
          // If lost, close immediately. If won, keep pending until funds received.
          const settlementStatus = won ? 'pending' : 'closed';

          await supabase
            .from('orders')
            .update({
              result_status: resultStatus,
              result_status_at: new Date().toISOString(),
              settlement_status: settlementStatus,
              settlement_status_at: won ? null : new Date().toISOString(),
            })
            .eq('id', order.id);

          updatedCount++;
          if (won) wonCount++;
          else lostCount++;

          console.log(`Updated ${order.ticker}: ${resultStatus}, settlement: ${settlementStatus}`);
        }
      }
      
      // Check if won orders have received their settlement via /portfolio/settlements
      if (order.result_status === 'won' && order.settlement_status === 'pending') {
        const settlementResult = await checkSettlementReceived(order.ticker, order.side);
        
        if (settlementResult.settled) {
          // Verify we actually won (market_result matches our side)
          const weWon = order.side.toLowerCase() === settlementResult.market_result;
          
          await supabase
            .from('orders')
            .update({
              settlement_status: 'success',
              settlement_status_at: settlementResult.settled_time || new Date().toISOString(),
              // Store actual revenue received
              actual_payout_cents: settlementResult.revenue,
            })
            .eq('id', order.id);
          
          console.log(`Settlement received for ${order.ticker}: revenue=$${(settlementResult.revenue / 100).toFixed(2)}, count=${settlementResult.count}, weWon=${weWon}`);
        }
        
        await new Promise(r => setTimeout(r, 100));
      }
      
      // Also check if LOST orders appear in settlements (to confirm closure)
      if (order.result_status === 'lost' && order.settlement_status !== 'closed') {
        const settlementResult = await checkSettlementReceived(order.ticker, order.side);
        
        if (settlementResult.settled) {
          await supabase
            .from('orders')
            .update({
              settlement_status: 'closed',
              settlement_status_at: settlementResult.settled_time || new Date().toISOString(),
            })
            .eq('id', order.id);
          
          console.log(`Loss confirmed for ${order.ticker} via settlements API`);
        }
        
        await new Promise(r => setTimeout(r, 100));
      }

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      errors.push(`${order.ticker}: ${e instanceof Error ? e.message : 'Unknown'}`);
    }
  }

  return {
    success: true,
    stats: {
      checked: orders.length,
      filled: filledCount,
      updated: updatedCount,
      won: wonCount,
      lost: lostCount,
      still_pending: orders.length - updatedCount,
    },
    errors: errors.length > 0 ? errors : undefined,
  };
}

// GET - Called by Vercel Cron hourly
export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await updateOrderStatuses();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error updating statuses:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// POST - Manual trigger
export async function POST() {
  try {
    const result = await updateOrderStatuses();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error updating statuses:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

