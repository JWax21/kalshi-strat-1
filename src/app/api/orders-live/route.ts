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
    
    // Placement status breakdown
    const pendingPlacement = allOrders.filter(o => o.placement_status === 'pending');
    const placedOrders = allOrders.filter(o => o.placement_status === 'placed');
    const confirmedOrders = allOrders.filter(o => o.placement_status === 'confirmed');
    
    // Result status breakdown
    const undecidedOrders = allOrders.filter(o => o.result_status === 'undecided');
    const wonOrders = allOrders.filter(o => o.result_status === 'won');
    const lostOrders = allOrders.filter(o => o.result_status === 'lost');
    
    // Settlement status breakdown
    const pendingSettlement = allOrders.filter(o => o.settlement_status === 'pending');
    const closedOrders = allOrders.filter(o => o.settlement_status === 'closed');
    const successOrders = allOrders.filter(o => o.settlement_status === 'success');
    
    const settledOrders = [...wonOrders, ...lostOrders];

    // Cost calculations
    // Estimated cost = price_cents (what we expected to pay)
    const totalEstimatedCost = confirmedOrders.reduce((sum, o) => sum + (o.cost_cents || 0), 0);
    // Actual cost = executed_cost_cents (what we actually paid)
    const totalActualCost = confirmedOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
    // Potential payout for confirmed orders
    const totalPotentialPayout = confirmedOrders.reduce((sum, o) => sum + (o.potential_payout_cents || 0), 0);
    // Actual payout received (from won orders that are settled)
    const totalActualPayout = wonOrders.reduce((sum, o) => sum + (o.potential_payout_cents || 0), 0);
    // Total lost
    const totalLost = lostOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
    // Net P&L (actual payout - actual cost of lost orders)
    const netPnl = totalActualPayout - totalLost;

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
        pending_orders: undecidedOrders.length,
        win_rate: winRate,
        total_cost_cents: totalActualCost,
        total_payout_cents: totalActualPayout,
        net_pnl_cents: netPnl,
        roi_percent: totalActualCost > 0 ? ((netPnl / totalActualCost) * 100).toFixed(2) : '0.00',
        // Detailed breakdowns
        placement_breakdown: {
          pending: pendingPlacement.length,
          placed: placedOrders.length,
          confirmed: confirmedOrders.length,
        },
        result_breakdown: {
          undecided: undecidedOrders.length,
          won: wonOrders.length,
          lost: lostOrders.length,
        },
        settlement_breakdown: {
          pending: pendingSettlement.length,
          closed: closedOrders.length,
          success: successOrders.length,
        },
        cost_breakdown: {
          estimated_cost_cents: totalEstimatedCost,
          actual_cost_cents: totalActualCost,
          potential_payout_cents: totalPotentialPayout,
          actual_payout_cents: totalActualPayout,
          total_lost_cents: totalLost,
          net_pnl_cents: netPnl,
        },
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

