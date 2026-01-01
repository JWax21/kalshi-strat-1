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
// Called at 5am ET daily to record:
// - END values for previous day
// - START values for current day (same as previous day's END)
export async function POST(request: Request) {
  try {
    // At 5am ET, we're capturing the state at the END of the previous day
    // and the START of the current day (they're the same values at this moment)
    const nowET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const today = nowET; // Current date in ET
    
    // Get current balance from Kalshi (this is the live balance right now)
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

    const portfolioValueCents = balanceCents + positionsCents;

    // This snapshot represents:
    // - The END of the previous day (all games settled)
    // - The START of the current day (before any new activity)
    // At 5am ET, all previous day's games should be settled
    
    // Save as today's snapshot (representing start of day)
    const { data: snapshot, error } = await supabase
      .from('daily_snapshots')
      .upsert({
        snapshot_date: today,
        balance_cents: balanceCents,
        positions_cents: positionsCents,
        portfolio_value_cents: portfolioValueCents,
        wins: 0, // Will be updated throughout the day
        losses: 0,
        pnl_cents: 0,
        pending: 0,
      }, {
        onConflict: 'snapshot_date',
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`[Snapshot] ${today}: Cash=$${balanceCents/100}, Positions=$${positionsCents/100}, Portfolio=$${portfolioValueCents/100}`);

    return NextResponse.json({
      success: true,
      snapshot: {
        date: today,
        balance: balanceCents / 100,
        positions: positionsCents / 100,
        portfolio_value: portfolioValueCents / 100,
        message: 'Captured start-of-day snapshot at 5am ET',
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

// GET - Fetch all snapshots OR capture a new one (for cron)
// If called by cron (Authorization header present), capture a new snapshot
// Otherwise, fetch and return existing snapshots
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    
    // If this is a cron job call, capture a new snapshot
    if (authHeader?.startsWith('Bearer ')) {
      // Verify cron secret if configured
      if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      
      // Capture the snapshot (same logic as POST)
      const nowET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const today = nowET;
      
      let balanceCents = 0;
      try {
        const balanceData = await kalshiFetch('/portfolio/balance');
        balanceCents = balanceData?.balance || 0;
      } catch (e) {
        console.error('Failed to fetch balance:', e);
        return NextResponse.json({ success: false, error: 'Failed to fetch balance' }, { status: 500 });
      }

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

      const portfolioValueCents = balanceCents + positionsCents;

      const { error } = await supabase
        .from('daily_snapshots')
        .upsert({
          snapshot_date: today,
          balance_cents: balanceCents,
          positions_cents: positionsCents,
          portfolio_value_cents: portfolioValueCents,
          wins: 0,
          losses: 0,
          pnl_cents: 0,
          pending: 0,
        }, {
          onConflict: 'snapshot_date',
        });

      if (error) throw error;

      console.log(`[Cron Snapshot] ${today}: Cash=$${balanceCents/100}, Positions=$${positionsCents/100}, Portfolio=$${portfolioValueCents/100}`);

      return NextResponse.json({
        success: true,
        message: `Captured 5am ET snapshot for ${today}`,
        snapshot: {
          date: today,
          balance: balanceCents / 100,
          positions: positionsCents / 100,
          portfolio_value: portfolioValueCents / 100,
        },
      });
    }
    
    // Regular GET - fetch existing snapshots
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
    console.error('Error in snapshot endpoint:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

