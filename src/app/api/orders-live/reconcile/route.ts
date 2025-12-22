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

// Get all fills from Kalshi
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

// Get all orders from Kalshi
async function getAllKalshiOrders(): Promise<any[]> {
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

async function reconcileOrders() {
  // Get all fills from Kalshi (these are actual executed trades)
  console.log('Fetching all fills from Kalshi...');
  const kalshiFills = await getAllFills();
  console.log(`Found ${kalshiFills.length} fills in Kalshi`);
  
  // Get all orders from Kalshi
  console.log('Fetching all orders from Kalshi...');
  const kalshiOrders = await getAllKalshiOrders();
  console.log(`Found ${kalshiOrders.length} orders in Kalshi`);
  
  // Create lookup by order_id
  const fillsByOrderId = new Map<string, any[]>();
  for (const fill of kalshiFills) {
    const orderId = fill.order_id;
    if (!fillsByOrderId.has(orderId)) {
      fillsByOrderId.set(orderId, []);
    }
    fillsByOrderId.get(orderId)!.push(fill);
  }
  
  const kalshiOrderById = new Map<string, any>();
  for (const order of kalshiOrders) {
    kalshiOrderById.set(order.order_id, order);
  }
  
  // Get all database orders
  const { data: dbOrders, error } = await supabase
    .from('orders')
    .select('*')
    .not('kalshi_order_id', 'is', null);
  
  if (error) throw error;
  
  console.log(`Found ${dbOrders?.length || 0} orders in database with kalshi_order_id`);
  
  const results = {
    total_db_orders: dbOrders?.length || 0,
    confirmed: 0,
    placed_resting: 0,
    cancelled: 0,
    not_found: 0,
    updated: 0,
    errors: [] as string[],
  };
  
  const orderDetails: any[] = [];
  
  for (const dbOrder of dbOrders || []) {
    const kalshiOrderId = dbOrder.kalshi_order_id;
    const kalshiOrder = kalshiOrderById.get(kalshiOrderId);
    const fills = fillsByOrderId.get(kalshiOrderId) || [];
    
    const detail: any = {
      ticker: dbOrder.ticker,
      db_status: dbOrder.placement_status,
      kalshi_order_id: kalshiOrderId,
      kalshi_status: kalshiOrder?.status || 'NOT_FOUND',
      fills_count: fills.length,
      fill_quantity: fills.reduce((sum, f) => sum + (f.count || 0), 0),
      action: 'none',
    };
    
    if (fills.length > 0) {
      // Has fills = confirmed execution
      const totalCount = fills.reduce((sum, f) => sum + (f.count || 0), 0);
      const avgPrice = fills[0]?.price || null;
      const totalCost = fills.reduce((sum, f) => sum + ((f.price || 0) * (f.count || 0)), 0);
      
      if (dbOrder.placement_status !== 'confirmed') {
        // Update to confirmed
        await supabase
          .from('orders')
          .update({
            placement_status: 'confirmed',
            placement_status_at: new Date().toISOString(),
            executed_price_cents: avgPrice,
            executed_cost_cents: totalCost,
          })
          .eq('id', dbOrder.id);
        
        results.updated++;
        detail.action = 'updated_to_confirmed';
      }
      
      detail.executed_price = avgPrice;
      detail.executed_cost = totalCost;
      results.confirmed++;
    } else if (kalshiOrder) {
      // No fills but order exists in Kalshi
      const kalshiStatus = kalshiOrder.status;
      detail.kalshi_status = kalshiStatus;
      
      if (kalshiStatus === 'resting' || kalshiStatus === 'pending') {
        // Order is on the book, waiting to match
        results.placed_resting++;
        detail.action = `resting_on_book (${kalshiStatus})`;
        
        if (dbOrder.placement_status === 'confirmed') {
          // Fix: it's not confirmed, it's just placed
          await supabase
            .from('orders')
            .update({
              placement_status: 'placed',
              placement_status_at: new Date().toISOString(),
              executed_price_cents: null,
              executed_cost_cents: null,
            })
            .eq('id', dbOrder.id);
          
          results.updated++;
          detail.action = 'downgraded_to_placed';
        } else if (dbOrder.placement_status === 'pending') {
          // Was never marked as placed, fix it
          await supabase
            .from('orders')
            .update({
              placement_status: 'placed',
              placement_status_at: new Date().toISOString(),
            })
            .eq('id', dbOrder.id);
          
          results.updated++;
          detail.action = 'upgraded_to_placed';
        }
      } else if (kalshiStatus === 'cancelled' || kalshiStatus === 'expired') {
        results.cancelled++;
        detail.action = `cancelled (${kalshiStatus})`;
        
        // Mark as closed
        await supabase
          .from('orders')
          .update({
            placement_status: 'placed', // It was placed but cancelled
            settlement_status: 'closed',
            settlement_status_at: new Date().toISOString(),
          })
          .eq('id', dbOrder.id);
        
        results.updated++;
      } else if (kalshiStatus === 'executed') {
        // Executed but no fills yet? Check filled_count
        if (kalshiOrder.filled_count > 0) {
          results.confirmed++;
          detail.action = 'executed_filled_count_gt_0';
          
          // Update as confirmed using Kalshi order data
          const price = dbOrder.side === 'YES' ? kalshiOrder.yes_price : kalshiOrder.no_price;
          await supabase
            .from('orders')
            .update({
              placement_status: 'confirmed',
              placement_status_at: new Date().toISOString(),
              executed_price_cents: price,
              executed_cost_cents: price * kalshiOrder.filled_count,
            })
            .eq('id', dbOrder.id);
          
          results.updated++;
        } else {
          results.confirmed++;
          detail.action = 'executed_no_fills_strange';
        }
      } else {
        // Unknown status
        detail.action = `unknown_status: ${kalshiStatus}`;
      }
    } else {
      // Order not found in Kalshi at all
      results.not_found++;
      detail.action = 'not_found_in_kalshi';
      
      // If we think it's confirmed but Kalshi doesn't know about it, something is wrong
      if (dbOrder.placement_status === 'confirmed' || dbOrder.placement_status === 'placed') {
        detail.warning = 'Order marked as placed/confirmed but not found in Kalshi!';
      }
    }
    
    orderDetails.push(detail);
  }
  
  // Also get orders without kalshi_order_id (never sent to Kalshi)
  const { data: pendingOrders } = await supabase
    .from('orders')
    .select('*')
    .is('kalshi_order_id', null);
  
  const neverSent = pendingOrders?.length || 0;
  
  return {
    success: true,
    summary: {
      ...results,
      never_sent_to_kalshi: neverSent,
      total_kalshi_fills: kalshiFills.length,
      total_kalshi_orders: kalshiOrders.length,
    },
    orders: orderDetails,
  };
}

export async function POST() {
  try {
    const result = await reconcileOrders();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error reconciling orders:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const result = await reconcileOrders();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error reconciling orders:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

