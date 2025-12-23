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

// POST - Capture a daily snapshot
export async function POST(request: Request) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Get current balance from Kalshi
    let balanceCents = 0;
    try {
      const balanceData = await kalshiFetch('/portfolio/balance');
      balanceCents = balanceData?.balance || 0;
    } catch (e) {
      console.error('Failed to fetch balance:', e);
      return NextResponse.json({ success: false, error: 'Failed to fetch balance' }, { status: 500 });
    }

    // Get current positions from Kalshi
    let positionsCents = 0;
    try {
      const positionsData = await kalshiFetch('/portfolio/positions');
      const positions = positionsData?.market_positions || [];
      positionsCents = positions.reduce((sum: number, p: any) => {
        return sum + Math.abs(p.position_cost || p.market_exposure || 0);
      }, 0);
    } catch (e) {
      console.error('Failed to fetch positions:', e);
    }

    // Get today's W-L and P&L from orders
    const { data: batches } = await supabase
      .from('order_batches')
      .select('id')
      .eq('batch_date', today);

    let wins = 0;
    let losses = 0;
    let pnlCents = 0;

    if (batches && batches.length > 0) {
      const batchIds = batches.map(b => b.id);
      const { data: orders } = await supabase
        .from('orders')
        .select('*')
        .in('batch_id', batchIds)
        .eq('placement_status', 'confirmed');

      if (orders) {
        const wonOrders = orders.filter(o => o.result_status === 'won');
        const lostOrders = orders.filter(o => o.result_status === 'lost');

        wins = wonOrders.length;
        losses = lostOrders.length;

        const payout = wonOrders.reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);
        const fees = [...wonOrders, ...lostOrders].reduce((sum, o) => sum + (o.fee_cents || 0), 0);
        const wonCost = wonOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
        const lostCost = lostOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
        pnlCents = payout - fees - wonCost - lostCost;
      }
    }

    const portfolioValueCents = balanceCents + positionsCents;

    // Upsert the snapshot (update if exists for today, insert if not)
    const { data: snapshot, error } = await supabase
      .from('daily_snapshots')
      .upsert({
        snapshot_date: today,
        balance_cents: balanceCents,
        positions_cents: positionsCents,
        portfolio_value_cents: portfolioValueCents,
        wins,
        losses,
        pnl_cents: pnlCents,
      }, {
        onConflict: 'snapshot_date',
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({
      success: true,
      snapshot: {
        date: today,
        balance: balanceCents / 100,
        positions: positionsCents / 100,
        portfolio_value: portfolioValueCents / 100,
        wins,
        losses,
        pnl: pnlCents / 100,
      },
    });
  } catch (error) {
    console.error('Error capturing snapshot:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

// GET - Fetch all snapshots
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '90');

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data: snapshots, error } = await supabase
      .from('daily_snapshots')
      .select('*')
      .gte('snapshot_date', startDate.toISOString().split('T')[0])
      .order('snapshot_date', { ascending: false });

    if (error) throw error;

    return NextResponse.json({
      success: true,
      snapshots: snapshots || [],
    });
  } catch (error) {
    console.error('Error fetching snapshots:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

