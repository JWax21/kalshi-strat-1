import { NextResponse } from 'next/server';
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

// Get all orders with pagination
async function getAllOrders(): Promise<any[]> {
  const allOrders: any[] = [];
  let cursor: string | undefined;
  
  do {
    const endpoint = cursor 
      ? `/portfolio/orders?limit=100&cursor=${cursor}`
      : `/portfolio/orders?limit=100`;
    
    const data = await kalshiFetch(endpoint);
    allOrders.push(...(data.orders || []));
    cursor = data.cursor;
    
    await new Promise(r => setTimeout(r, 100));
  } while (cursor);
  
  return allOrders;
}

// Get all fills with pagination
async function getAllFills(): Promise<any[]> {
  const allFills: any[] = [];
  let cursor: string | undefined;
  
  do {
    const endpoint = cursor 
      ? `/portfolio/fills?limit=100&cursor=${cursor}`
      : `/portfolio/fills?limit=100`;
    
    const data = await kalshiFetch(endpoint);
    allFills.push(...(data.fills || []));
    cursor = data.cursor;
    
    await new Promise(r => setTimeout(r, 100));
  } while (cursor);
  
  return allFills;
}

// Get all positions
async function getPositions(): Promise<any[]> {
  const data = await kalshiFetch('/portfolio/positions?limit=100');
  return data.market_positions || [];
}

export async function GET() {
  try {
    // Fetch from all portfolio endpoints
    const [orders, fills, positions] = await Promise.all([
      getAllOrders(),
      getAllFills(),
      getPositions(),
    ]);

    // Categorize orders by status
    const ordersByStatus: Record<string, number> = {};
    orders.forEach(o => {
      ordersByStatus[o.status] = (ordersByStatus[o.status] || 0) + 1;
    });

    // Get unique tickers with fills
    const tickersWithFills = new Set(fills.map(f => f.ticker));

    // Get positions summary
    const positionsSummary = positions.map(p => ({
      ticker: p.ticker,
      position: p.position,
      market_exposure: p.market_exposure,
      realized_pnl: p.realized_pnl,
    }));

    return NextResponse.json({
      success: true,
      summary: {
        total_orders: orders.length,
        orders_by_status: ordersByStatus,
        total_fills: fills.length,
        unique_tickers_with_fills: tickersWithFills.size,
        total_positions: positions.length,
      },
      // Sample data for debugging
      sample_orders: orders.slice(0, 5).map(o => ({
        order_id: o.order_id,
        ticker: o.ticker,
        status: o.status,
        side: o.side,
        action: o.action,
        count: o.count,
        filled_count: o.filled_count,
        remaining_count: o.remaining_count,
        yes_price: o.yes_price,
        no_price: o.no_price,
        created_time: o.created_time,
      })),
      sample_fills: fills.slice(0, 5).map(f => ({
        trade_id: f.trade_id,
        order_id: f.order_id,
        ticker: f.ticker,
        side: f.side,
        action: f.action,
        count: f.count,
        price: f.price,
        created_time: f.created_time,
      })),
      positions: positionsSummary,
    });
  } catch (error) {
    console.error('Error fetching debug data:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

