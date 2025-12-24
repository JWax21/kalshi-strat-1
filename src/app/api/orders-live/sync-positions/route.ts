import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
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

/**
 * Sync our database with actual Kalshi positions
 * - Mark orders as confirmed if we have positions
 * - Delete pending orders for markets we already have
 */
export async function POST() {
  try {
    // Get current positions from Kalshi
    const positionsData = await kalshiFetch('/portfolio/positions');
    const positions = positionsData.market_positions || [];
    
    // Get all fills to find actual costs
    const fillsData = await kalshiFetch('/portfolio/fills?limit=1000');
    const fills = fillsData.fills || [];
    
    // Build position map
    const positionMap = new Map<string, any>();
    for (const pos of positions) {
      positionMap.set(pos.ticker, pos);
    }
    
    // Build fills map by ticker
    const fillsByTicker = new Map<string, any[]>();
    for (const fill of fills) {
      if (!fillsByTicker.has(fill.ticker)) {
        fillsByTicker.set(fill.ticker, []);
      }
      fillsByTicker.get(fill.ticker)!.push(fill);
    }
    
    // Get all pending/placed orders from our DB
    const { data: dbOrders, error } = await supabase
      .from('orders')
      .select('*')
      .in('placement_status', ['pending', 'placed']);
    
    if (error) throw error;
    
    const results = {
      positions_in_kalshi: positions.length,
      orders_checked: dbOrders?.length || 0,
      confirmed: 0,
      deleted: 0,
      unchanged: 0,
      errors: [] as string[],
    };
    
    for (const order of dbOrders || []) {
      const position = positionMap.get(order.ticker);
      const orderFills = fillsByTicker.get(order.ticker) || [];
      
      if (position) {
        // We have a position in this market!
        // Calculate cost from fills
        const totalFillCost = orderFills.reduce((sum, f) => sum + (f.price * f.count), 0);
        const totalFillCount = orderFills.reduce((sum, f) => sum + f.count, 0);
        const avgPrice = totalFillCount > 0 ? Math.round(totalFillCost / totalFillCount) : order.price_cents;
        
        // Update order to confirmed
        const { error: updateError } = await supabase
          .from('orders')
          .update({
            placement_status: 'confirmed',
            placement_status_at: new Date().toISOString(),
            executed_price_cents: avgPrice,
            executed_cost_cents: avgPrice * (order.units || 1),
          })
          .eq('id', order.id);
        
        if (updateError) {
          results.errors.push(`Failed to update ${order.ticker}: ${updateError.message}`);
        } else {
          results.confirmed++;
        }
      } else {
        // No position - delete the pending order
        const { error: deleteError } = await supabase
          .from('orders')
          .delete()
          .eq('id', order.id);
        
        if (deleteError) {
          results.errors.push(`Failed to delete ${order.ticker}: ${deleteError.message}`);
        } else {
          results.deleted++;
        }
      }
    }
    
    return NextResponse.json({
      success: true,
      message: `Synced ${results.confirmed} positions, deleted ${results.deleted} pending orders`,
      ...results,
    });
  } catch (error) {
    console.error('Error syncing positions:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    // Just show current state without making changes
    const positionsData = await kalshiFetch('/portfolio/positions');
    const positions = positionsData.market_positions || [];
    
    const { data: dbOrders } = await supabase
      .from('orders')
      .select('ticker, placement_status, units')
      .in('placement_status', ['pending', 'placed']);
    
    const positionTickers = new Set(positions.map((p: any) => p.ticker));
    const dbTickers = new Set((dbOrders || []).map(o => o.ticker));
    
    // Find mismatches
    const inKalshiNotDb = positions.filter((p: any) => !dbTickers.has(p.ticker));
    const inDbNotKalshi = (dbOrders || []).filter(o => !positionTickers.has(o.ticker));
    const inBoth = (dbOrders || []).filter(o => positionTickers.has(o.ticker));
    
    return NextResponse.json({
      success: true,
      kalshi_positions: positions.length,
      db_pending_orders: dbOrders?.length || 0,
      in_kalshi_not_db: inKalshiNotDb.map((p: any) => p.ticker),
      in_db_not_kalshi: inDbNotKalshi.map(o => o.ticker),
      in_both: inBoth.map(o => o.ticker),
    });
  } catch (error) {
    console.error('Error checking sync:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

