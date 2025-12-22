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
  const errors: string[] = [];

  for (const order of orders) {
    try {
      const { settled, result, status } = await getMarketResult(order.ticker);

      if (settled && result) {
        const won = order.side.toLowerCase() === result;
        const resultStatus = won ? 'won' : 'lost';
        const settlementStatus = won ? 'success' : 'closed';

        await supabase
          .from('orders')
          .update({
            result_status: resultStatus,
            result_status_at: new Date().toISOString(),
            settlement_status: settlementStatus,
            settlement_status_at: new Date().toISOString(),
          })
          .eq('id', order.id);

        updatedCount++;
        if (won) wonCount++;
        else lostCount++;

        console.log(`Updated ${order.ticker}: ${resultStatus}`);
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

