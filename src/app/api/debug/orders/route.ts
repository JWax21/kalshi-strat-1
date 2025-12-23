import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getBalance, getPositions } from '@/lib/kalshi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Get today's batch
    const { data: batch, error: batchError } = await supabase
      .from('order_batches')
      .select('*')
      .eq('batch_date', today)
      .single();

    // Get orders for today's batch
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('*')
      .eq('batch_id', batch?.id)
      .limit(10);

    // Get Kalshi balance
    let kalshiBalance = null;
    try {
      kalshiBalance = await getBalance();
    } catch (e) {
      kalshiBalance = { error: String(e) };
    }

    // Get Kalshi positions
    let kalshiPositions = null;
    try {
      kalshiPositions = await getPositions();
    } catch (e) {
      kalshiPositions = { error: String(e) };
    }

    return NextResponse.json({
      today,
      batch: batch || { error: batchError?.message },
      sample_orders: orders?.slice(0, 5).map(o => ({
        id: o.id,
        ticker: o.ticker,
        placement_status: o.placement_status,
        kalshi_order_id: o.kalshi_order_id,
        units: o.units,
        cost_cents: o.cost_cents,
      })),
      order_stats: {
        total: orders?.length,
        pending: orders?.filter(o => o.placement_status === 'pending').length,
        placed: orders?.filter(o => o.placement_status === 'placed').length,
        confirmed: orders?.filter(o => o.placement_status === 'confirmed').length,
      },
      kalshi_balance: kalshiBalance,
      kalshi_positions_count: kalshiPositions?.market_positions?.length || 0,
      kalshi_positions_sample: kalshiPositions?.market_positions?.slice(0, 3),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

