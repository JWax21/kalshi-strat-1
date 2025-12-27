import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const orderId = searchParams.get('id');
    const kalshiOrderId = searchParams.get('kalshi_id');
    const ticker = searchParams.get('ticker');

    if (!orderId && !kalshiOrderId && !ticker) {
      return NextResponse.json({ 
        error: 'Please provide ?id=, ?kalshi_id=, or ?ticker= parameter' 
      }, { status: 400 });
    }

    let query = supabase.from('orders').select('*, order_batches(batch_date)');
    
    if (orderId) {
      query = query.eq('id', orderId);
    } else if (kalshiOrderId) {
      query = query.eq('kalshi_order_id', kalshiOrderId);
    } else if (ticker) {
      query = query.ilike('ticker', `%${ticker}%`);
    }

    const { data: orders, error } = await query.limit(10);

    if (error) throw error;

    if (!orders || orders.length === 0) {
      return NextResponse.json({ 
        message: 'No orders found',
        search: { orderId, kalshiOrderId, ticker }
      });
    }

    return NextResponse.json({
      count: orders.length,
      orders: orders.map(o => ({
        id: o.id,
        ticker: o.ticker,
        title: o.title,
        side: o.side,
        units: o.units,
        price_cents: o.price_cents,
        cost_cents: o.cost_cents,
        executed_cost_cents: o.executed_cost_cents,
        placement_status: o.placement_status,
        placement_status_at: o.placement_status_at,
        result_status: o.result_status,
        settlement_status: o.settlement_status,
        kalshi_order_id: o.kalshi_order_id,
        batch_date: o.order_batches?.batch_date,
        market_close_time: o.market_close_time,
        created_at: o.created_at,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

