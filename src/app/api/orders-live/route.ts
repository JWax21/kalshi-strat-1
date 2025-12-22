import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET - Fetch all batches and orders with stats
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '30');

    // Get batches from the last N days
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data: batches, error: batchesError } = await supabase
      .from('order_batches')
      .select('*')
      .gte('batch_date', startDate.toISOString().split('T')[0])
      .order('batch_date', { ascending: false });

    if (batchesError) throw batchesError;

    // Get all orders for these batches
    const batchIds = (batches || []).map(b => b.id);
    
    let orders: any[] = [];
    if (batchIds.length > 0) {
      const { data: ordersData, error: ordersError } = await supabase
        .from('orders')
        .select('*')
        .in('batch_id', batchIds)
        .order('open_interest', { ascending: false });

      if (ordersError) throw ordersError;
      orders = ordersData || [];
    }

    // Group orders by batch
    const ordersByBatch: Record<string, any[]> = {};
    orders.forEach(order => {
      if (!ordersByBatch[order.batch_id]) {
        ordersByBatch[order.batch_id] = [];
      }
      ordersByBatch[order.batch_id].push(order);
    });

    // Calculate aggregate stats
    const allOrders = orders;
    const confirmedOrders = allOrders.filter(o => o.placement_status === 'confirmed');
    const wonOrders = allOrders.filter(o => o.result_status === 'won');
    const lostOrders = allOrders.filter(o => o.result_status === 'lost');
    const settledOrders = [...wonOrders, ...lostOrders];

    const totalCost = confirmedOrders.reduce((sum, o) => sum + o.cost_cents, 0);
    const totalPayout = wonOrders.reduce((sum, o) => sum + o.potential_payout_cents, 0);
    const totalLost = lostOrders.reduce((sum, o) => sum + o.cost_cents, 0);
    const netPnl = totalPayout - totalLost;

    const winRate = settledOrders.length > 0
      ? (wonOrders.length / settledOrders.length * 100).toFixed(1)
      : '0.0';

    // Enrich batches with their orders
    const enrichedBatches = (batches || []).map(batch => ({
      ...batch,
      orders: ordersByBatch[batch.id] || [],
    }));

    return NextResponse.json({
      success: true,
      batches: enrichedBatches,
      stats: {
        total_batches: (batches || []).length,
        total_orders: allOrders.length,
        confirmed_orders: confirmedOrders.length,
        won_orders: wonOrders.length,
        lost_orders: lostOrders.length,
        pending_orders: allOrders.filter(o => o.result_status === 'undecided').length,
        win_rate: winRate,
        total_cost_cents: totalCost,
        total_payout_cents: totalPayout,
        net_pnl_cents: netPnl,
        roi_percent: totalCost > 0 ? ((netPnl / totalCost) * 100).toFixed(2) : '0.00',
      },
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// PATCH - Update settings (unit size, pause status)
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const { batch_id, unit_size_cents, is_paused } = body;

    if (!batch_id) {
      return NextResponse.json({ success: false, error: 'batch_id required' }, { status: 400 });
    }

    const updates: any = {};
    if (unit_size_cents !== undefined) updates.unit_size_cents = unit_size_cents;
    if (is_paused !== undefined) updates.is_paused = is_paused;

    const { error } = await supabase
      .from('order_batches')
      .update(updates)
      .eq('id', batch_id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating batch:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

