import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getMarkets, filterHighOddsMarkets, getMarketOdds, KalshiMarket } from '@/lib/kalshi';
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

interface PrepareParams {
  minOdds: number;
  maxOdds: number;
  minOpenInterest: number;
  forToday?: boolean;
  capitalReservePercent?: number; // Optional: reserve some capital (default 0%)
}

interface MarketWithUnits {
  market: any;
  units: number;
  cost_cents: number;
  potential_payout_cents: number;
}

/**
 * Distribute capital across markets as evenly as possible.
 * Markets are sorted by open interest (highest first).
 * Higher OI markets get priority for extra units.
 */
function distributeCapital(
  markets: any[],
  availableCapitalCents: number
): MarketWithUnits[] {
  if (markets.length === 0 || availableCapitalCents <= 0) {
    return [];
  }

  // Sort by open interest descending (already sorted, but ensure)
  const sortedMarkets = [...markets].sort((a, b) => b.open_interest - a.open_interest);
  
  // Calculate total cost per unit for all markets
  const totalCostPerRound = sortedMarkets.reduce((sum, m) => sum + m.price_cents, 0);
  
  if (totalCostPerRound === 0) {
    return [];
  }

  // Calculate how many complete "rounds" of units we can afford
  // A round = 1 unit for every market
  const completeRounds = Math.floor(availableCapitalCents / totalCostPerRound);
  let remainingCapital = availableCapitalCents - (completeRounds * totalCostPerRound);

  // Initialize each market with the base number of units
  const result: MarketWithUnits[] = sortedMarkets.map(market => ({
    market,
    units: completeRounds,
    cost_cents: market.price_cents * completeRounds,
    potential_payout_cents: 100 * completeRounds, // $1 payout per contract
  }));

  // Distribute remaining capital to markets with highest OI first
  // (they're already sorted by OI)
  for (let i = 0; i < result.length && remainingCapital > 0; i++) {
    const market = result[i];
    const costForOneMore = market.market.price_cents;
    
    if (remainingCapital >= costForOneMore) {
      market.units += 1;
      market.cost_cents += costForOneMore;
      market.potential_payout_cents += 100;
      remainingCapital -= costForOneMore;
    }
  }

  // Filter out markets with 0 units (shouldn't happen if we have capital)
  return result.filter(r => r.units > 0);
}

async function prepareOrders(params: PrepareParams) {
  const { minOdds, maxOdds, minOpenInterest, forToday, capitalReservePercent = 0 } = params;

  // Get target date (today or tomorrow)
  const targetDate = new Date();
  if (!forToday) {
    targetDate.setDate(targetDate.getDate() + 1);
  }
  const targetDateStr = targetDate.toISOString().split('T')[0];

  // Check if batch already exists
  const { data: existing } = await supabase
    .from('order_batches')
    .select('id')
    .eq('batch_date', targetDateStr)
    .single();

  if (existing) {
    return {
      success: false,
      error: `Batch already exists for ${targetDateStr}`,
      batch_id: existing.id,
    };
  }

  // Get available balance from Kalshi
  let availableCapitalCents = 0;
  try {
    const balanceData = await kalshiFetch('/portfolio/balance');
    availableCapitalCents = balanceData?.balance || 0;
  } catch (e) {
    console.error('Failed to fetch balance:', e);
    return {
      success: false,
      error: 'Failed to fetch account balance from Kalshi',
    };
  }

  // Apply reserve if specified
  if (capitalReservePercent > 0) {
    availableCapitalCents = Math.floor(availableCapitalCents * (1 - capitalReservePercent / 100));
  }

  if (availableCapitalCents <= 0) {
    return {
      success: false,
      error: 'No available capital to deploy',
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
  filteredMarkets = filteredMarkets.filter(m => m.open_interest >= minOpenInterest);

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

  // Distribute capital across all markets
  const allocatedMarkets = distributeCapital(enrichedMarkets, availableCapitalCents);

  if (allocatedMarkets.length === 0) {
    return {
      success: false,
      error: 'Insufficient capital to place any orders',
    };
  }

  // Calculate totals
  const totalCost = allocatedMarkets.reduce((sum, m) => sum + m.cost_cents, 0);
  const totalPayout = allocatedMarkets.reduce((sum, m) => sum + m.potential_payout_cents, 0);
  const totalUnits = allocatedMarkets.reduce((sum, m) => sum + m.units, 0);
  const avgUnitsPerMarket = (totalUnits / allocatedMarkets.length).toFixed(1);

  // Create the batch
  const { data: batch, error: batchError } = await supabase
    .from('order_batches')
    .insert({
      batch_date: targetDateStr,
      unit_size_cents: 100, // Base unit is $1
      total_orders: allocatedMarkets.length,
      total_cost_cents: totalCost,
      total_potential_payout_cents: totalPayout,
      is_paused: false,
      prepared_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (batchError) throw batchError;

  // Create orders for each market with variable units
  const orders = allocatedMarkets.map(({ market, units, cost_cents, potential_payout_cents }) => ({
    batch_id: batch.id,
    ticker: market.ticker,
    event_ticker: market.event_ticker,
    title: market.title,
    side: market.favorite_side,
    price_cents: market.price_cents,
    units: units,
    cost_cents: cost_cents,
    potential_payout_cents: potential_payout_cents,
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
      date: targetDateStr,
      total_orders: allocatedMarkets.length,
      total_units: totalUnits,
      avg_units_per_market: avgUnitsPerMarket,
      total_cost_cents: totalCost,
      available_capital_cents: availableCapitalCents,
      capital_utilization: ((totalCost / availableCapitalCents) * 100).toFixed(1) + '%',
    },
    message: `Prepared ${allocatedMarkets.length} orders with ${totalUnits} total units (~${avgUnitsPerMarket} per market)`,
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
      minOdds: 0.85,
      maxOdds: 0.995,
      minOpenInterest: 1000,
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
      minOdds: body.minOdds || 0.85,
      maxOdds: body.maxOdds || 0.995,
      minOpenInterest: body.minOpenInterest || 1000,
      forToday: body.forToday || false,
      capitalReservePercent: body.capitalReservePercent || 0,
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
