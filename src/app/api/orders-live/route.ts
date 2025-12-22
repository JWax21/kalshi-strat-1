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
    
    // Result status breakdown (only from confirmed orders)
    const undecidedOrders = confirmedOrders.filter(o => o.result_status === 'undecided');
    const wonOrders = confirmedOrders.filter(o => o.result_status === 'won');
    const lostOrders = confirmedOrders.filter(o => o.result_status === 'lost');
    
    // Settlement status breakdown (only from orders with results)
    const pendingSettlement = allOrders.filter(o => o.settlement_status === 'pending');
    const closedOrders = allOrders.filter(o => o.settlement_status === 'closed');
    const successOrders = allOrders.filter(o => o.settlement_status === 'success');
    
    const decidedOrders = [...wonOrders, ...lostOrders];

    // ===== PLACEMENT-BASED FINANCIALS =====
    // Estimated cost = limit price * units for placed + confirmed orders
    const placementEstimatedCost = [...placedOrders, ...confirmedOrders].reduce((sum, o) => sum + (o.cost_cents || 0), 0);
    // Actual cost = what we actually paid (only confirmed orders with executed_cost_cents)
    const placementActualCost = confirmedOrders.reduce((sum, o) => sum + (o.executed_cost_cents || 0), 0);
    // Total projected payout = if all confirmed orders win
    const placementProjectedPayout = confirmedOrders.reduce((sum, o) => sum + (o.potential_payout_cents || 0), 0);

    // ===== RESULT-BASED FINANCIALS =====
    // Estimated won = payout from orders marked "won" (may not be settled yet)
    const resultEstimatedWon = wonOrders.reduce((sum, o) => sum + (o.potential_payout_cents || 0), 0);
    // Estimated lost = cost of orders marked "lost"
    const resultEstimatedLost = lostOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
    // Estimated P&L based on results
    const resultEstimatedPnl = resultEstimatedWon - resultEstimatedLost;

    // ===== SETTLEMENT-BASED FINANCIALS (ACTUALS) =====
    // Projected payout = from won orders still pending settlement
    const settlementProjectedPayout = wonOrders
      .filter(o => o.settlement_status === 'pending')
      .reduce((sum, o) => sum + (o.potential_payout_cents || 0), 0);
    // Actual payout = from orders with settlement_status = 'success' (cash received)
    const settlementActualPayout = successOrders.reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);
    // Actual lost = from orders with settlement_status = 'closed'
    const settlementActualLost = closedOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
    // Net P&L = actual cash received - actual cash lost
    const settlementNetPnl = settlementActualPayout - settlementActualLost;

    const winRate = decidedOrders.length > 0
      ? (wonOrders.length / decidedOrders.length * 100).toFixed(1)
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
        // Legacy fields for backward compatibility
        total_cost_cents: placementActualCost,
        total_payout_cents: settlementActualPayout,
        net_pnl_cents: settlementNetPnl,
        roi_percent: placementActualCost > 0 ? ((settlementNetPnl / placementActualCost) * 100).toFixed(2) : '0.00',
        // Status breakdowns
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
        // Financials by stage
        placement_financials: {
          estimated_cost_cents: placementEstimatedCost,
          actual_cost_cents: placementActualCost,
          projected_payout_cents: placementProjectedPayout,
        },
        result_financials: {
          estimated_won_cents: resultEstimatedWon,
          estimated_lost_cents: resultEstimatedLost,
          estimated_pnl_cents: resultEstimatedPnl,
        },
        settlement_financials: {
          projected_payout_cents: settlementProjectedPayout,
          actual_payout_cents: settlementActualPayout,
          actual_lost_cents: settlementActualLost,
          net_pnl_cents: settlementNetPnl,
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

