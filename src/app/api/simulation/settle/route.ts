import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Kalshi API helper to check market result
async function getMarketResult(ticker: string): Promise<{ settled: boolean; result: 'yes' | 'no' | null }> {
  try {
    const crypto = await import('crypto');
    const { KALSHI_CONFIG } = await import('@/lib/kalshi-config');
    
    const timestampMs = Date.now().toString();
    const method = 'GET';
    const endpoint = `/markets/${ticker}`;
    const fullPath = `/trade-api/v2${endpoint}`;
    
    // Generate signature
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
      console.log(`Market ${ticker} not found or error: ${response.status}`);
      return { settled: false, result: null };
    }
    
    const data = await response.json();
    const market = data.market;
    
    // Check if market has a result
    if (market.result === 'yes' || market.result === 'no') {
      return { settled: true, result: market.result };
    }
    
    // Check if market status indicates settlement
    if (market.status === 'settled' || market.status === 'finalized') {
      return { settled: true, result: market.result || null };
    }
    
    return { settled: false, result: null };
  } catch (error) {
    console.error(`Error checking market ${ticker}:`, error);
    return { settled: false, result: null };
  }
}

// POST - Check and settle pending orders
export async function POST() {
  try {
    // Get all pending orders
    const { data: pendingOrders, error: fetchError } = await supabase
      .from('simulation_orders')
      .select('*')
      .eq('status', 'pending');

    if (fetchError) throw fetchError;

    if (!pendingOrders || pendingOrders.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No pending orders to settle',
        settled: 0,
      });
    }

    console.log(`Checking ${pendingOrders.length} pending orders...`);

    let settledCount = 0;
    let wonCount = 0;
    let lostCount = 0;
    let totalPnl = 0;
    const errors: string[] = [];

    // Check each pending order (with rate limiting)
    for (const order of pendingOrders) {
      try {
        const { settled, result } = await getMarketResult(order.ticker);
        
        if (settled && result) {
          // Determine if we won or lost
          const won = (order.side.toLowerCase() === result);
          const status = won ? 'won' : 'lost';
          
          // Calculate P&L
          // If won: profit = (100 - price) * units
          // If lost: loss = -price * units (we lose our cost)
          const pnlCents = won 
            ? order.potential_profit_cents 
            : -order.cost_cents;

          // Update the order
          const { error: updateError } = await supabase
            .from('simulation_orders')
            .update({
              status,
              pnl_cents: pnlCents,
              settled_at: new Date().toISOString(),
            })
            .eq('id', order.id);

          if (updateError) {
            errors.push(`Failed to update ${order.ticker}: ${updateError.message}`);
          } else {
            settledCount++;
            if (won) {
              wonCount++;
            } else {
              lostCount++;
            }
            totalPnl += pnlCents;
            console.log(`Settled ${order.ticker}: ${status} (P&L: ${pnlCents / 100})`);
          }
        }
        
        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 100));
      } catch (orderError) {
        errors.push(`Error checking ${order.ticker}: ${orderError instanceof Error ? orderError.message : 'Unknown'}`);
      }
    }

    return NextResponse.json({
      success: true,
      message: `Settled ${settledCount} orders`,
      stats: {
        checked: pendingOrders.length,
        settled: settledCount,
        won: wonCount,
        lost: lostCount,
        total_pnl_cents: totalPnl,
        total_pnl_dollars: (totalPnl / 100).toFixed(2),
        still_pending: pendingOrders.length - settledCount,
      },
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Error settling orders:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

