import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getMarkets, filterHighOddsMarkets, getMarketOdds, KalshiMarket } from '@/lib/kalshi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PrepareParams {
  unitSizeCents: number;
  minOdds: number;
  maxOdds: number;
  minOpenInterest: number;
  maxOpenInterest: number; // To exclude low OI
}

async function prepareOrders(params: PrepareParams) {
  const { unitSizeCents, minOdds, maxOdds, minOpenInterest, maxOpenInterest } = params;

  // Get tomorrow's date
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  // Check if batch already exists for tomorrow
  const { data: existing } = await supabase
    .from('order_batches')
    .select('id')
    .eq('batch_date', tomorrowStr)
    .single();

  if (existing) {
    return {
      success: false,
      error: `Batch already exists for ${tomorrowStr}`,
      batch_id: existing.id,
    };
  }

  // Fetch sports markets closing within 17 days
  const maxCloseHours = 17 * 24;
  const sportsSeries = [
    'KXNBAGAME', 'KXNFLGAME', 'KXMLBGAME', 'KXNHLGAME',
    'KXNCAAMBGAME', 'KXNCAAWBGAME', 'KXNCAAFBGAME',
    'KXNCAAFCSGAME', 'KXNCAAFGAME',
    'KXEUROLEAGUEGAME', 'KXNBLGAME', 'KXCRICKETTESTMATCH',
    'KXEFLCHAMPIONSHIPGAME', 'KXDOTA2GAME', 'KXUFCFIGHT'
  ];

  let allMarkets: KalshiMarket[] = [];
  for (const series of sportsSeries) {
    try {
      const markets = await getMarkets(200, maxCloseHours, 1, series);
      allMarkets.push(...markets);
    } catch (e) {
      console.log(`No markets for ${series}`);
    }
  }

  // Filter by odds
  let filteredMarkets = filterHighOddsMarkets(allMarkets, minOdds, maxOdds);

  // Filter by open interest (require minimum OI)
  filteredMarkets = filteredMarkets.filter(m => {
    return m.open_interest >= minOpenInterest;
  });

  // Sort by open interest descending
  filteredMarkets.sort((a, b) => b.open_interest - a.open_interest);

  // Enrich with favorite info
  const enrichedMarkets = filteredMarkets.map(market => {
    const odds = getMarketOdds(market);
    const favoriteSide = odds.yes >= odds.no ? 'YES' : 'NO';
    const favoriteOdds = Math.max(odds.yes, odds.no);
    const priceCents = Math.round(favoriteOdds * 100);
    
    return {
      ...market,
      favorite_side: favoriteSide,
      favorite_odds: favoriteOdds,
      price_cents: priceCents,
    };
  });

  if (enrichedMarkets.length === 0) {
    return {
      success: false,
      error: 'No qualifying markets found',
    };
  }

  // Calculate totals
  const totalCost = enrichedMarkets.reduce((sum, m) => sum + (m.price_cents * 1), 0); // 1 unit per market initially
  const totalPayout = enrichedMarkets.reduce((sum, m) => sum + 100, 0); // $1 payout per winning contract

  // Create the batch
  const { data: batch, error: batchError } = await supabase
    .from('order_batches')
    .insert({
      batch_date: tomorrowStr,
      unit_size_cents: unitSizeCents,
      total_orders: enrichedMarkets.length,
      total_cost_cents: totalCost,
      total_potential_payout_cents: totalPayout,
      is_paused: false,
      prepared_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (batchError) throw batchError;

  // Create orders for each market
  const orders = enrichedMarkets.map(market => ({
    batch_id: batch.id,
    ticker: market.ticker,
    event_ticker: market.event_ticker,
    title: market.title,
    side: market.favorite_side,
    price_cents: market.price_cents,
    units: 1, // Will be adjusted at execution based on capital
    cost_cents: market.price_cents,
    potential_payout_cents: 100, // $1 per contract
    open_interest: market.open_interest,
    market_close_time: market.close_time,
    placement_status: 'pending',
    placement_status_at: new Date().toISOString(),
    result_status: 'undecided',
    settlement_status: 'pending',
  }));

  const { error: ordersError } = await supabase
    .from('orders')
    .insert(orders);

  if (ordersError) throw ordersError;

  return {
    success: true,
    batch: {
      id: batch.id,
      date: tomorrowStr,
      total_orders: enrichedMarkets.length,
      total_cost_cents: totalCost,
    },
    message: `Prepared ${enrichedMarkets.length} orders for ${tomorrowStr}`,
  };
}

// GET - Called by Vercel Cron at 7pm
export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await prepareOrders({
      unitSizeCents: 100, // $1 default
      minOdds: 0.85,
      maxOdds: 0.995,
      minOpenInterest: 1000, // Include all markets with 1K+ OI
      maxOpenInterest: 100,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error preparing orders:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// POST - Manual trigger
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));

    const result = await prepareOrders({
      unitSizeCents: body.unitSizeCents || 100,
      minOdds: body.minOdds || 0.85,
      maxOdds: body.maxOdds || 0.995,
      minOpenInterest: body.minOpenInterest || 1000, // Default to 1K+ OI
      maxOpenInterest: body.maxOpenInterest || 100,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error preparing orders:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

