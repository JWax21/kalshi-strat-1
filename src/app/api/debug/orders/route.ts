import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getBalance, getPositions } from '@/lib/kalshi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

    // Get the batch for specified date
    const { data: batch, error: batchError } = await supabase
      .from('order_batches')
      .select('*')
      .eq('batch_date', date)
      .single();

    if (!batch) {
      return NextResponse.json({ 
        error: `No batch found for ${date}`,
        batchError: batchError?.message 
      });
    }

    // Get ALL orders for this batch
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('*')
      .eq('batch_id', batch.id);

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

    // Count orders with kalshi_order_id (actually sent to Kalshi)
    const ordersWithKalshiId = orders?.filter(o => o.kalshi_order_id) || [];
    const ordersWithoutKalshiId = orders?.filter(o => !o.kalshi_order_id) || [];

    return NextResponse.json({
      date,
      batch: {
        id: batch.id,
        executed_at: batch.executed_at,
        is_paused: batch.is_paused,
        total_orders: batch.total_orders,
      },
      order_breakdown: {
        total: orders?.length || 0,
        with_kalshi_order_id: ordersWithKalshiId.length,
        without_kalshi_order_id: ordersWithoutKalshiId.length,
        by_placement_status: {
          pending: orders?.filter(o => o.placement_status === 'pending').length || 0,
          placed: orders?.filter(o => o.placement_status === 'placed').length || 0,
          confirmed: orders?.filter(o => o.placement_status === 'confirmed').length || 0,
        },
      },
      sample_orders_with_kalshi_id: ordersWithKalshiId.slice(0, 3).map(o => ({
        ticker: o.ticker,
        kalshi_order_id: o.kalshi_order_id,
        placement_status: o.placement_status,
        units: o.units,
      })),
      sample_orders_without_kalshi_id: ordersWithoutKalshiId.slice(0, 3).map(o => ({
        ticker: o.ticker,
        placement_status: o.placement_status,
        units: o.units,
      })),
      kalshi_account: {
        balance_cents: kalshiBalance?.balance,
        balance_dollars: kalshiBalance?.balance ? (kalshiBalance.balance / 100).toFixed(2) : null,
      },
      kalshi_positions: {
        count: kalshiPositions?.market_positions?.length || 0,
        tickers: kalshiPositions?.market_positions?.map((p: any) => p.ticker).slice(0, 10) || [],
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

