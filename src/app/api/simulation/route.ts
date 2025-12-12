import { NextResponse } from 'next/server';
import { supabase, SimulationSnapshot, SimulationOrder } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET - Fetch all simulation data with stats
export async function GET() {
  try {
    // Get all snapshots ordered by date descending
    const { data: snapshots, error: snapshotsError } = await supabase
      .from('simulation_snapshots')
      .select('*')
      .order('snapshot_date', { ascending: false });

    if (snapshotsError) throw snapshotsError;

    // Get all orders
    const { data: orders, error: ordersError } = await supabase
      .from('simulation_orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (ordersError) throw ordersError;

    // Calculate aggregate stats
    const allOrders = orders || [];
    const settledOrders = allOrders.filter(o => o.status !== 'pending');
    const pendingOrders = allOrders.filter(o => o.status === 'pending');
    const wonOrders = allOrders.filter(o => o.status === 'won');
    const lostOrders = allOrders.filter(o => o.status === 'lost');

    const totalCost = allOrders.reduce((sum, o) => sum + o.cost_cents, 0);
    const totalPnl = settledOrders.reduce((sum, o) => sum + (o.pnl_cents || 0), 0);
    const totalPotentialProfit = pendingOrders.reduce((sum, o) => sum + o.potential_profit_cents, 0);
    
    const winRate = settledOrders.length > 0 
      ? (wonOrders.length / settledOrders.length * 100).toFixed(1)
      : '0.0';

    // Group orders by snapshot
    const ordersBySnapshot: Record<string, SimulationOrder[]> = {};
    allOrders.forEach(order => {
      if (!ordersBySnapshot[order.snapshot_id]) {
        ordersBySnapshot[order.snapshot_id] = [];
      }
      ordersBySnapshot[order.snapshot_id].push(order);
    });

    // Enrich snapshots with their orders and stats
    const enrichedSnapshots = (snapshots || []).map(snapshot => {
      const snapshotOrders = ordersBySnapshot[snapshot.id] || [];
      const settled = snapshotOrders.filter(o => o.status !== 'pending');
      const won = snapshotOrders.filter(o => o.status === 'won');
      const pnl = settled.reduce((sum, o) => sum + (o.pnl_cents || 0), 0);
      
      return {
        ...snapshot,
        orders: snapshotOrders,
        stats: {
          total: snapshotOrders.length,
          pending: snapshotOrders.filter(o => o.status === 'pending').length,
          won: won.length,
          lost: snapshotOrders.filter(o => o.status === 'lost').length,
          pnl_cents: pnl,
          win_rate: settled.length > 0 ? (won.length / settled.length * 100).toFixed(1) : null,
        }
      };
    });

    return NextResponse.json({
      success: true,
      snapshots: enrichedSnapshots,
      stats: {
        total_snapshots: (snapshots || []).length,
        total_orders: allOrders.length,
        pending_orders: pendingOrders.length,
        settled_orders: settledOrders.length,
        won_orders: wonOrders.length,
        lost_orders: lostOrders.length,
        win_rate: winRate,
        total_cost_cents: totalCost,
        total_pnl_cents: totalPnl,
        total_potential_profit_cents: totalPotentialProfit,
        roi_percent: totalCost > 0 ? ((totalPnl / totalCost) * 100).toFixed(2) : '0.00',
      }
    });
  } catch (error) {
    console.error('Error fetching simulation data:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

