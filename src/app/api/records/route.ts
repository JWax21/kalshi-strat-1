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

interface DailyRecord {
  date: string;
  start_cash_cents: number;
  start_portfolio_cents: number;
  end_cash_cents: number;
  end_portfolio_cents: number;
  wins: number;
  losses: number;
  pending: number;
  pnl_cents: number;
  roic_percent: number;
  avg_price_cents: number;
  source: 'snapshot' | 'calculated';
}

// GET - Fetch daily records (uses snapshots when available, calculates when not)
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '90');

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString().split('T')[0];

    // First, try to get snapshots from the database
    const { data: snapshots, error: snapshotsError } = await supabase
      .from('daily_snapshots')
      .select('*')
      .gte('snapshot_date', startDateStr)
      .order('snapshot_date', { ascending: false });

    if (snapshotsError) {
      console.error('Error fetching snapshots:', snapshotsError);
    }

    // Get current balance and positions for live data
    let currentBalance = 0;
    let currentPositions = 0;
    
    try {
      const balanceData = await kalshiFetch('/portfolio/balance');
      currentBalance = balanceData?.balance || 0;
    } catch (e) {
      console.error('Failed to fetch balance:', e);
    }

    try {
      const positionsData = await kalshiFetch('/portfolio/positions');
      const positions = positionsData?.market_positions || [];
      currentPositions = positions.reduce((sum: number, p: any) => {
        return sum + Math.abs(p.position_cost || p.market_exposure || 0);
      }, 0);
    } catch (e) {
      console.error('Failed to fetch positions:', e);
    }

    // Helper function to convert UTC timestamp to ET date (YYYY-MM-DD)
    const getDateFromTimestampET = (isoTimestamp: string): string => {
      const date = new Date(isoTimestamp);
      // Format in ET timezone
      return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    };

    // Get all orders with confirmed placement status
    const { data: allOrders } = await supabase
      .from('orders')
      .select('*')
      .eq('placement_status', 'confirmed')
      .not('placement_status_at', 'is', null);

    const ordersByDate: Record<string, any[]> = {};

    // Group orders by PLACEMENT DATE (in ET), not by batch/game date
    if (allOrders && allOrders.length > 0) {
      allOrders.forEach(order => {
        if (order.placement_status_at) {
          const placementDateET = getDateFromTimestampET(order.placement_status_at);
          // Only include orders within our date range
          if (placementDateET >= startDateStr) {
            if (!ordersByDate[placementDateET]) {
              ordersByDate[placementDateET] = [];
            }
            ordersByDate[placementDateET].push(order);
          }
        }
      });
    }

    // Build snapshot map for quick lookup
    const snapshotMap: Record<string, any> = {};
    if (snapshots && snapshots.length > 0) {
      snapshots.forEach(s => {
        snapshotMap[s.snapshot_date] = s;
      });
    }

    // Get all unique dates and sort ascending
    const allDates = [...new Set([
      ...Object.keys(ordersByDate),
      ...Object.keys(snapshotMap),
    ])].sort();

    // Build records with start/end values
    const records: DailyRecord[] = [];
    let previousEndCash = currentBalance;
    let previousEndPositions = currentPositions;

    // Work backwards to estimate historical start values
    for (let i = allDates.length - 1; i >= 0; i--) {
      const date = allDates[i];
      const dayOrders = ordersByDate[date] || [];
      const confirmedOrders = dayOrders.filter(o => o.placement_status === 'confirmed');
      const wonOrders = confirmedOrders.filter(o => o.result_status === 'won');
      const lostOrders = confirmedOrders.filter(o => o.result_status === 'lost');
      
      const payout = wonOrders.reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);
      const fees = [...wonOrders, ...lostOrders].reduce((sum, o) => sum + (o.fee_cents || 0), 0);
      const wonCost = wonOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
      const lostCost = lostOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
      const dayPnl = payout - fees - wonCost - lostCost;
      
      // Subtract P&L to get previous day's end cash
      previousEndCash = previousEndCash - dayPnl;
    }

    // Now build records going forward
    let runningCash = previousEndCash;
    
    for (const date of allDates) {
      const snapshot = snapshotMap[date];
      const dayOrders = ordersByDate[date] || [];
      const confirmedOrders = dayOrders.filter(o => o.placement_status === 'confirmed');
      const wonOrders = confirmedOrders.filter(o => o.result_status === 'won');
      const lostOrders = confirmedOrders.filter(o => o.result_status === 'lost');
      const pendingOrders = confirmedOrders.filter(o => o.result_status === 'undecided');
      
      const payout = wonOrders.reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);
      const fees = [...wonOrders, ...lostOrders].reduce((sum, o) => sum + (o.fee_cents || 0), 0);
      const wonCost = wonOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
      const lostCost = lostOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
      const dayPnl = payout - fees - wonCost - lostCost;
      
      const startCash = runningCash;
      const endCash = startCash + dayPnl;
      
      // Use snapshot positions if available, otherwise current positions
      const endPositions = snapshot ? snapshot.positions_cents : currentPositions;
      const startPositions = endPositions; // Approximate - positions at start roughly same
      
      const startPortfolio = startCash + startPositions;
      const endPortfolio = endCash + endPositions;
      
      // Calculate ROIC
      const roic = startPortfolio > 0 ? (dayPnl / startPortfolio) * 100 : 0;
      
      // Calculate average price of contracts bet on that day
      const avgPrice = confirmedOrders.length > 0
        ? confirmedOrders.reduce((sum, o) => sum + (o.price_cents || 0), 0) / confirmedOrders.length
        : 0;
      
      records.push({
        date,
        start_cash_cents: Math.round(startCash),
        start_portfolio_cents: Math.round(startPortfolio),
        end_cash_cents: Math.round(endCash),
        end_portfolio_cents: Math.round(endPortfolio),
        wins: wonOrders.length,
        losses: lostOrders.length,
        pending: pendingOrders.length,
        pnl_cents: dayPnl,
        roic_percent: Math.round(roic * 100) / 100,
        avg_price_cents: Math.round(avgPrice),
        source: snapshot ? 'snapshot' : 'calculated',
      });
      
      runningCash = endCash;
    }

    // Sort by date descending (most recent first)
    records.sort((a, b) => b.date.localeCompare(a.date));

    // Calculate totals
    const totalWins = records.reduce((sum, r) => sum + r.wins, 0);
    const totalLosses = records.reduce((sum, r) => sum + r.losses, 0);
    const totalPending = records.reduce((sum, r) => sum + r.pending, 0);
    const totalPnl = records.reduce((sum, r) => sum + r.pnl_cents, 0);

    return NextResponse.json({
      success: true,
      records,
      current_balance_cents: currentBalance,
      current_positions_cents: currentPositions,
      totals: {
        wins: totalWins,
        losses: totalLosses,
        pending: totalPending,
        pnl_cents: totalPnl,
      },
    });
  } catch (error) {
    console.error('Error fetching records:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
