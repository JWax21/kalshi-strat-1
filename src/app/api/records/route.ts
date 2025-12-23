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
  start_balance_cents: number;
  end_balance_cents: number;
  end_positions_cents: number;
  portfolio_value_cents: number;
  wins: number;
  losses: number;
  pnl_cents: number;
}

// GET - Fetch daily records
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '30');

    // Get all batches
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data: batches, error: batchesError } = await supabase
      .from('order_batches')
      .select('*')
      .gte('batch_date', startDate.toISOString().split('T')[0])
      .order('batch_date', { ascending: true });

    if (batchesError) throw batchesError;

    // Get all orders for these batches
    const batchIds = (batches || []).map(b => b.id);
    
    let orders: any[] = [];
    if (batchIds.length > 0) {
      const { data: ordersData, error: ordersError } = await supabase
        .from('orders')
        .select('*')
        .in('batch_id', batchIds);

      if (ordersError) throw ordersError;
      orders = ordersData || [];
    }

    // Group orders by batch date
    const ordersByDate: Record<string, any[]> = {};
    const batchDateMap: Record<string, string> = {};
    
    batches?.forEach(batch => {
      batchDateMap[batch.id] = batch.batch_date;
    });

    orders.forEach(order => {
      const date = batchDateMap[order.batch_id];
      if (date) {
        if (!ordersByDate[date]) {
          ordersByDate[date] = [];
        }
        ordersByDate[date].push(order);
      }
    });

    // Get current balance for reference
    let currentBalance = 0;
    try {
      const balanceData = await kalshiFetch('/portfolio/balance');
      currentBalance = balanceData?.balance || 0;
    } catch (e) {
      console.error('Failed to fetch balance:', e);
    }

    // Get current positions for exposure
    let currentExposure = 0;
    try {
      const positionsData = await kalshiFetch('/portfolio/positions');
      const positions = positionsData?.market_positions || [];
      currentExposure = positions.reduce((sum: number, p: any) => sum + Math.abs(p.market_exposure || 0), 0);
    } catch (e) {
      console.error('Failed to fetch positions:', e);
    }

    // Calculate daily records
    const records: DailyRecord[] = [];
    const sortedDates = Object.keys(ordersByDate).sort();
    
    // We'll work backwards from today to estimate historical balances
    // This is an approximation since we don't have historical balance snapshots
    let runningBalance = currentBalance;
    let runningExposure = currentExposure;
    
    // Process dates in reverse to calculate historical balances
    const reversedDates = [...sortedDates].reverse();
    const dailyPnL: Record<string, { pnl: number, wins: number, losses: number, positions: number }> = {};
    
    reversedDates.forEach(date => {
      const dayOrders = ordersByDate[date] || [];
      const confirmedOrders = dayOrders.filter(o => o.placement_status === 'confirmed');
      const wonOrders = confirmedOrders.filter(o => o.result_status === 'won');
      const lostOrders = confirmedOrders.filter(o => o.result_status === 'lost');
      const undecidedOrders = confirmedOrders.filter(o => o.result_status === 'undecided');
      
      // Calculate P&L for the day
      const payout = wonOrders.reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);
      const fees = [...wonOrders, ...lostOrders].reduce((sum, o) => sum + (o.fee_cents || 0), 0);
      const wonCost = wonOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
      const lostCost = lostOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
      const dayPnl = payout - fees - wonCost - lostCost;
      
      // Exposure for undecided orders
      const dayExposure = undecidedOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
      
      dailyPnL[date] = {
        pnl: dayPnl,
        wins: wonOrders.length,
        losses: lostOrders.length,
        positions: dayExposure,
      };
    });

    // Now build records going forward
    // Estimate start balance by subtracting all P&L from current balance
    let cumulativePnl = 0;
    sortedDates.forEach(date => {
      cumulativePnl += dailyPnL[date]?.pnl || 0;
    });
    
    let estimatedStartBalance = currentBalance - cumulativePnl;
    let previousEndBalance = estimatedStartBalance;

    sortedDates.forEach(date => {
      const dayData = dailyPnL[date];
      const startBalance = previousEndBalance;
      const endBalance = startBalance + (dayData?.pnl || 0);
      const positions = dayData?.positions || 0;
      
      records.push({
        date,
        start_balance_cents: Math.round(startBalance),
        end_balance_cents: Math.round(endBalance),
        end_positions_cents: positions,
        portfolio_value_cents: Math.round(endBalance) + positions,
        wins: dayData?.wins || 0,
        losses: dayData?.losses || 0,
        pnl_cents: dayData?.pnl || 0,
      });
      
      previousEndBalance = endBalance;
    });

    // Calculate totals
    const totalWins = records.reduce((sum, r) => sum + r.wins, 0);
    const totalLosses = records.reduce((sum, r) => sum + r.losses, 0);
    const totalPnl = records.reduce((sum, r) => sum + r.pnl_cents, 0);

    return NextResponse.json({
      success: true,
      records: records.reverse(), // Most recent first
      current_balance_cents: currentBalance,
      current_exposure_cents: currentExposure,
      totals: {
        wins: totalWins,
        losses: totalLosses,
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

