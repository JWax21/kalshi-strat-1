import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getMarkets, filterHighOddsMarkets, getMarketOdds, calculateUnderdogBet, KalshiMarket } from '@/lib/kalshi';
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
  underdog_side: 'YES' | 'NO';
  underdog_price_cents: number;
  favorite_price_cents: number;
}

const MAX_POSITION_PERCENT = 0.03; // 3% max per market
const MAX_BET_CENTS = 2500; // SAFEGUARD: $25 max per bet - UNBREAKABLE

/**
 * UNDERDOG STRATEGY: Distribute capital across markets
 * 
 * KEY INSIGHT: Units are calculated based on what we'd buy of the FAVORITE,
 * but we actually BUY THE UNDERDOG at a much lower price.
 * 
 * Example: Portfolio $5000, 3% = $150, Favorite at 95¢
 * - Units = $150 / 95¢ = 158 units  
 * - Underdog price = 5¢
 * - Actual cost = 158 × 5¢ = $7.90
 * 
 * @param totalPortfolioCents - Total portfolio value for 3% cap calculation
 */
function distributeCapital(
  markets: any[],
  availableCapitalCents: number,
  totalPortfolioCents: number
): MarketWithUnits[] {
  if (markets.length === 0 || availableCapitalCents <= 0) {
    return [];
  }

  // Sort by open interest descending
  const sortedMarkets = [...markets].sort((a, b) => b.open_interest - a.open_interest);
  
  // 3% CAP: Based on FAVORITE price (determines how many units we'd buy)
  const maxPositionCents = Math.floor(totalPortfolioCents * MAX_POSITION_PERCENT);
  
  // SPREAD: Calculate even distribution across all markets (based on favorite prices)
  const evenDistributionCents = Math.floor(availableCapitalCents / sortedMarkets.length);
  const targetAllocationCents = Math.min(evenDistributionCents, maxPositionCents);
  
  console.log(`UNDERDOG STRATEGY: ${availableCapitalCents}¢ / ${sortedMarkets.length} markets`);
  console.log(`Target allocation per market: ${targetAllocationCents}¢ (min of even=${evenDistributionCents}¢, 3% cap=${maxPositionCents}¢)`);

  // Calculate underdog bets for each market
  const result: MarketWithUnits[] = [];
  let remainingCapital = availableCapitalCents;

  for (const market of sortedMarkets) {
    const favoritePriceCents = market.price_cents; // This is the favorite's price
    const underdogPriceCents = 100 - favoritePriceCents;
    const underdogSide = market.favorite_side === 'YES' ? 'NO' : 'YES';
    
    // Calculate units based on FAVORITE price (what we'd buy if betting favorites)
    let units = Math.floor(targetAllocationCents / favoritePriceCents);
    
    // Calculate ACTUAL cost = units × underdog_price
    let actualCostCents = units * underdogPriceCents;
    
    // SAFEGUARD: Cap at $25 max per bet - UNBREAKABLE
    if (actualCostCents > MAX_BET_CENTS) {
      units = Math.floor(MAX_BET_CENTS / underdogPriceCents);
      actualCostCents = units * underdogPriceCents;
      console.log(`  SAFEGUARD: Capped ${market.ticker} to ${units}u @ ${underdogPriceCents}¢ = ${actualCostCents}¢ (max $25)`);
    }
    
    // Check if we can afford this
    if (actualCostCents <= remainingCapital && units > 0) {
      result.push({
        market,
        units: units,
        cost_cents: actualCostCents,
        potential_payout_cents: units * 100, // Full payout if underdog wins
        underdog_side: underdogSide,
        underdog_price_cents: underdogPriceCents,
        favorite_price_cents: favoritePriceCents,
      });
      remainingCapital -= actualCostCents;
      
      console.log(`  ${market.ticker}: ${units} units @ ${underdogPriceCents}¢ (underdog) = ${actualCostCents}¢ cost`);
    }
  }

  console.log(`Allocated ${result.length} markets, remaining capital: ${remainingCapital}¢`);
  return result;
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

  // Get available balance AND portfolio_value directly from Kalshi
  // CRITICAL: Total portfolio = balance (cash) + portfolio_value (positions value)
  let availableCapitalCents = 0;
  let totalPortfolioCents = 0;
  try {
    const balanceData = await kalshiFetch('/portfolio/balance');
    availableCapitalCents = balanceData?.balance || 0;
    const positionsValue = balanceData?.portfolio_value || 0;
    // Total portfolio = cash + positions value (Kalshi returns these separately)
    totalPortfolioCents = availableCapitalCents + positionsValue;
    console.log(`Kalshi balance: cash=${availableCapitalCents}¢, positions=${positionsValue}¢, total=${totalPortfolioCents}¢`);
  } catch (e) {
    console.error('Failed to fetch balance:', e);
    return {
      success: false,
      error: 'Failed to fetch account balance from Kalshi',
    };
  }

  console.log(`Total Portfolio: ${totalPortfolioCents}¢, available cash: ${availableCapitalCents}¢`);

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
    // Esports
    'KXDOTA2GAME'
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

  // Exclude blacklisted (illiquid) markets
  const { data: blacklistedMarkets } = await supabase
    .from('illiquid_markets')
    .select('ticker');
  
  const blacklistedTickers = new Set((blacklistedMarkets || []).map(m => m.ticker));
  filteredMarkets = filteredMarkets.filter(m => !blacklistedTickers.has(m.ticker));

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

  // ========================================
  // CRITICAL: DEDUPLICATE BY EVENT
  // Only keep ONE market per event (the favorite with highest odds)
  // This prevents betting on BOTH sides of the same game
  // ========================================
  const eventBestMarket = new Map<string, typeof enrichedMarkets[0]>();
  for (const market of enrichedMarkets) {
    const eventTicker = market.event_ticker;
    const existing = eventBestMarket.get(eventTicker);
    if (!existing) {
      eventBestMarket.set(eventTicker, market);
    } else {
      // Keep the one with higher favorite odds
      if (market.favorite_odds > existing.favorite_odds) {
        eventBestMarket.set(eventTicker, market);
      }
    }
  }
  const deduplicatedMarkets = Array.from(eventBestMarket.values());
  console.log(`DEDUPLICATION: ${enrichedMarkets.length} markets -> ${deduplicatedMarkets.length} unique events`);

  // ========================================
  // CRITICAL: CHECK EXISTING POSITIONS/ORDERS
  // Skip events where we already have exposure
  // ========================================
  const { data: existingOrders } = await supabase
    .from('orders')
    .select('event_ticker, ticker, cost_cents, executed_cost_cents, placement_status')
    .in('placement_status', ['pending', 'placed', 'confirmed']);
  
  const existingEventExposure = new Map<string, number>();
  for (const order of existingOrders || []) {
    const cost = order.executed_cost_cents || order.cost_cents || 0;
    const existing = existingEventExposure.get(order.event_ticker) || 0;
    existingEventExposure.set(order.event_ticker, existing + cost);
  }
  console.log(`Found existing exposure on ${existingEventExposure.size} events`);

  // Filter out events we already have positions on
  const maxPositionCents = Math.floor(totalPortfolioCents * MAX_POSITION_PERCENT);
  const marketsAfterExposureCheck = deduplicatedMarkets.filter(market => {
    const eventTicker = market.event_ticker;
    const existingExposure = existingEventExposure.get(eventTicker) || 0;
    const remainingCapacity = maxPositionCents - existingExposure;
    
    if (remainingCapacity <= 0) {
      console.log(`Skipping ${market.ticker} - event ${eventTicker} already at max exposure (${existingExposure}¢ >= ${maxPositionCents}¢)`);
      return false;
    }
    return true;
  });
  console.log(`After exposure check: ${marketsAfterExposureCheck.length} markets`);

  if (marketsAfterExposureCheck.length === 0) {
    return {
      success: false,
      error: 'All qualifying events already have maximum exposure',
    };
  }

  // Distribute capital across all markets (use total portfolio for 3% cap calculation)
  const allocatedMarkets = distributeCapital(marketsAfterExposureCheck, availableCapitalCents, totalPortfolioCents);

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

  // Create orders for each market with UNDERDOG strategy
  const orders = allocatedMarkets.map(({ market, units, cost_cents, potential_payout_cents, underdog_side, underdog_price_cents, favorite_price_cents }) => ({
    batch_id: batch.id,
    ticker: market.ticker,
    event_ticker: market.event_ticker,
    title: market.title,
    side: underdog_side, // BET ON UNDERDOG
    price_cents: underdog_price_cents, // UNDERDOG PRICE (much lower than favorite)
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
      minOdds: 0.90,
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
      minOdds: body.minOdds || 0.90,
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
