import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getMarkets, filterHighOddsMarkets, getMarketOdds } from '@/lib/kalshi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SnapshotParams {
  units: number;
  minOdds: number;
  maxOdds: number;
  minOpenInterest: number;
}

// Shared snapshot logic
async function handleSnapshot(params: SnapshotParams) {
  const { units, minOdds, maxOdds, minOpenInterest } = params;

  try {
    // Get today's date in YYYY-MM-DD format
    const today = new Date().toISOString().split('T')[0];

    // Check if we already have a snapshot for today
    const { data: existing } = await supabase
      .from('simulation_snapshots')
      .select('id')
      .eq('snapshot_date', today)
      .single();

    if (existing) {
      return NextResponse.json({
        success: false,
        error: `Snapshot already exists for ${today}`,
        snapshot_id: existing.id,
      }, { status: 400 });
    }

    // Fetch current high-odds sports markets (same logic as main page)
    const maxCloseHours = 17 * 24; // 17 days
    const sportsSeries = [
      // Football
      'KXNFLGAME', 'KXNCAAFBGAME', 'KXNCAAFCSGAME', 'KXNCAAFGAME',
      // Basketball
      'KXNBAGAME', 'KXNCAAMBGAME', 'KXNCAAWBGAME', 'KXEUROLEAGUEGAME', 'KXNBLGAME',
      // Hockey
      'KXNHLGAME',
      // Baseball
      'KXMLBGAME',
      // Cricket
      'KXCRICKETTESTMATCH', 'KXCRICKETT20IMATCH',
      // MMA
      'KXUFCFIGHT',
      // Tennis
      'KXTENNISMATCH', 'KXATPTOUR', 'KXWTATOUR',
      // Golf
      'KXPGATOUR', 'KXLPGATOUR', 'KXGOLFTOURNAMENT',
      // Chess
      'KXCHESSMATCH',
      // Motorsport
      'KXF1RACE', 'KXNASCARRACE', 'KXINDYCARRACE',
      // Soccer (EFL only)
      'KXEFLCHAMPIONSHIPGAME',
      // Esports
      'KXDOTA2GAME'
    ];

    let allMarkets: Awaited<ReturnType<typeof getMarkets>> = [];
    for (const series of sportsSeries) {
      try {
        const markets = await getMarkets(200, maxCloseHours, 1, series);
        allMarkets.push(...markets);
      } catch (e) {
        console.log(`No markets for ${series}`);
      }
    }

    // Filter to high-odds favorites with sufficient open interest
    const highOddsMarkets = filterHighOddsMarkets(allMarkets, minOdds, maxOdds)
      .filter(market => market.open_interest >= minOpenInterest);
    
    console.log(`Filtered to ${highOddsMarkets.length} markets with OI >= ${minOpenInterest}`);
    
    // Enrich with favorite info
    const enrichedMarkets = highOddsMarkets.map((market) => {
      const odds = getMarketOdds(market);
      return {
        ...market,
        favorite_side: odds.yes >= odds.no ? 'YES' as const : 'NO' as const,
        favorite_odds: Math.max(odds.yes, odds.no),
      };
    });

    if (enrichedMarkets.length === 0) {
      return NextResponse.json({
        success: false,
        error: `No high-odds markets found with open interest >= ${minOpenInterest}`,
      }, { status: 400 });
    }

    // Calculate totals
    const totalCost = enrichedMarkets.reduce((sum, m) => {
      const priceCents = Math.round(m.favorite_odds * 100);
      return sum + (priceCents * units);
    }, 0);

    // Create the snapshot
    const { data: snapshot, error: snapshotError } = await supabase
      .from('simulation_snapshots')
      .insert({
        snapshot_date: today,
        total_markets: enrichedMarkets.length,
        total_cost_cents: totalCost,
      })
      .select()
      .single();

    if (snapshotError) throw snapshotError;

    // Create simulation orders for each market
    const orders = enrichedMarkets.map(market => {
      const priceCents = Math.round(market.favorite_odds * 100);
      const costCents = priceCents * units;
      const potentialProfitCents = (100 - priceCents) * units;

      return {
        snapshot_id: snapshot.id,
        ticker: market.ticker,
        event_ticker: market.event_ticker,
        title: market.title,
        side: market.favorite_side,
        price_cents: priceCents,
        units: units,
        cost_cents: costCents,
        potential_profit_cents: potentialProfitCents,
        status: 'pending',
        market_close_time: market.close_time,
      };
    });

    const { error: ordersError } = await supabase
      .from('simulation_orders')
      .insert(orders);

    if (ordersError) throw ordersError;

    return NextResponse.json({
      success: true,
      snapshot: {
        id: snapshot.id,
        date: today,
        total_markets: enrichedMarkets.length,
        total_cost_cents: totalCost,
        total_cost_dollars: (totalCost / 100).toFixed(2),
      },
      message: `Created snapshot with ${enrichedMarkets.length} simulated orders`,
    });
  } catch (error) {
    console.error('Error creating snapshot:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// GET - Called by Vercel Cron
export async function GET(request: Request) {
  // Verify cron secret in production (Vercel sends this header)
  const authHeader = request.headers.get('Authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  // Use default parameters for cron
  return handleSnapshot({ units: 10, minOdds: 0.85, maxOdds: 0.995, minOpenInterest: 5000 });
}

// POST - Manual snapshot trigger from UI
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  
  return handleSnapshot({
    units: body.units || 10,
    minOdds: body.minOdds || 0.85,
    maxOdds: body.maxOdds || 0.995,
    minOpenInterest: body.minOpenInterest || 5000,
  });
}
