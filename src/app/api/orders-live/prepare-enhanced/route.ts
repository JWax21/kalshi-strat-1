import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getMarkets, filterHighOddsMarkets, getMarketOdds, getOrderbook, KalshiMarket } from '@/lib/kalshi';
import crypto from 'crypto';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes for large portfolios

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

interface LiquidityAnalysis {
  market: KalshiMarket;
  side: 'YES' | 'NO';
  price_cents: number;
  orderbook_depth: number; // Contracts available at or better than our price
  volume_24h: number;
  open_interest: number;
  spread_cents: number;
  liquidity_score: number;
  max_fillable_units: number;
  recommended_units: number;
  recommended_cost_cents: number;
}

interface EnhancedPrepareParams {
  minOdds: number;
  maxOdds: number;
  minOpenInterest: number;
  forToday?: boolean;
  maxPositionPercent?: number; // Default 3%
  minLiquidityScore?: number; // Minimum score to include
}

const MAX_POSITION_PERCENT = 0.03; // 3% max per market
const MIN_LIQUIDITY_SCORE = 10; // Minimum score to be considered

/**
 * Analyze orderbook to determine how many contracts we can realistically fill
 */
async function analyzeLiquidity(
  market: KalshiMarket,
  targetPriceCents: number,
  side: 'YES' | 'NO'
): Promise<{ depth: number; spread: number }> {
  try {
    const orderbook = await getOrderbook(market.ticker, 10);
    
    // For buying YES, we look at YES asks (what we'd buy from)
    // For buying NO, we look at NO asks
    const levels = side === 'YES' ? orderbook.yes : orderbook.no;
    
    // Count contracts available at or better than our limit price
    // For YES side: levels are sorted by price descending
    // We want contracts where ask <= our bid (we're willing to pay targetPrice)
    let depth = 0;
    for (const level of levels) {
      if (level.price <= targetPriceCents) {
        depth += level.count;
      }
    }
    
    // Calculate spread
    const bestYes = orderbook.yes[0]?.price || 0;
    const bestNo = orderbook.no[0]?.price || 0;
    const spread = Math.abs(100 - bestYes - bestNo);
    
    return { depth, spread };
  } catch (e) {
    console.error(`Failed to get orderbook for ${market.ticker}:`, e);
    // Return conservative estimates if orderbook fails
    return { depth: 1, spread: 10 };
  }
}

/**
 * Calculate liquidity score based on multiple factors
 */
function calculateLiquidityScore(
  orderbookDepth: number,
  volume24h: number,
  openInterest: number,
  spreadCents: number
): number {
  // Normalize each factor to a 0-100 scale
  const depthScore = Math.min(orderbookDepth / 10, 100); // 10 contracts = 100 score
  const volumeScore = Math.min(volume24h / 100, 100); // 100 volume = 100 score
  const oiScore = Math.min(openInterest / 10000, 100); // 10k OI = 100 score
  const spreadScore = Math.max(0, 100 - spreadCents * 10); // Tighter spread = higher score
  
  // Weighted average (orderbook depth most important for execution)
  const score = (
    depthScore * 0.4 +
    volumeScore * 0.25 +
    oiScore * 0.2 +
    spreadScore * 0.15
  );
  
  return Math.round(score * 100) / 100;
}

/**
 * Distribute capital based on liquidity scores
 * STRATEGY: Spread first, 3% cap second
 * 1. Calculate even distribution = capital / number of markets
 * 2. Use 3% cap only when we don't have enough markets to deploy all capital
 * If betting both sides of same event, use half the position limit per side
 */
function distributeCapitalByLiquidity(
  analyses: LiquidityAnalysis[],
  totalCapitalCents: number,
  maxPositionPercent: number
): LiquidityAnalysis[] {
  if (analyses.length === 0) return [];
  
  // SPREAD FIRST: Calculate even distribution across all markets
  const evenDistributionCents = Math.floor(totalCapitalCents / analyses.length);
  const baseMaxPositionCents = Math.floor(totalCapitalCents * maxPositionPercent);
  // 3% CAP SECOND: Only use 3% cap if even distribution exceeds it
  const baseTargetCents = Math.min(evenDistributionCents, baseMaxPositionCents);
  
  console.log(`Capital distribution: ${totalCapitalCents}¢ / ${analyses.length} markets = ${evenDistributionCents}¢ each (capped at ${baseMaxPositionCents}¢ = ${baseTargetCents}¢ target)`);
  
  // Group by event_ticker to detect when we're betting both sides
  const eventGroups = new Map<string, LiquidityAnalysis[]>();
  for (const analysis of analyses) {
    const eventTicker = analysis.market.event_ticker;
    if (!eventGroups.has(eventTicker)) {
      eventGroups.set(eventTicker, []);
    }
    eventGroups.get(eventTicker)!.push(analysis);
  }
  
  // Calculate position limits per market based on whether we're betting both sides
  const positionLimits = new Map<string, number>();
  for (const [eventTicker, eventMarkets] of eventGroups) {
    // If betting multiple sides of same event, halve the limit per side
    const limitPerSide = eventMarkets.length > 1 
      ? Math.floor(baseTargetCents / 2)  // Half of target if both sides
      : baseTargetCents;                  // Full target if only one side
    
    for (const market of eventMarkets) {
      positionLimits.set(market.market.ticker, limitPerSide);
    }
  }
  
  // Calculate total liquidity score for proportional allocation (used for ordering)
  const totalScore = analyses.reduce((sum, a) => sum + a.liquidity_score, 0);
  
  let remainingCapital = totalCapitalCents;
  const results: LiquidityAnalysis[] = [];
  
  // Sort by liquidity score descending
  const sortedAnalyses = [...analyses].sort((a, b) => b.liquidity_score - a.liquidity_score);
  
  for (const analysis of sortedAnalyses) {
    if (remainingCapital <= 0) break;
    
    // Get the position limit for this specific market (based on even distribution)
    const targetPositionCents = positionLimits.get(analysis.market.ticker) || baseTargetCents;
    
    // Cap by various limits
    const maxByPosition = targetPositionCents;
    const maxByOrderbook = analysis.max_fillable_units * analysis.price_cents;
    const maxByRemaining = remainingCapital;
    
    const allocationCents = Math.min(
      maxByPosition,
      maxByOrderbook,
      maxByRemaining
    );
    
    // Calculate units
    const units = Math.floor(allocationCents / analysis.price_cents);
    
    if (units > 0) {
      const actualCost = units * analysis.price_cents;
      results.push({
        ...analysis,
        recommended_units: units,
        recommended_cost_cents: actualCost,
      });
      remainingCapital -= actualCost;
    }
  }
  
  // Second pass: if we still have capital and target was less than 3%, distribute up to 3%
  if (remainingCapital > 0 && baseTargetCents < baseMaxPositionCents) {
    console.log(`Second pass: ${remainingCapital}¢ remaining, distributing up to 3% cap...`);
    
    // Recalculate position limits using full 3% cap
    for (const [eventTicker, eventMarkets] of eventGroups) {
      const limitPerSide = eventMarkets.length > 1 
        ? Math.floor(baseMaxPositionCents / 2)
        : baseMaxPositionCents;
      
      for (const market of eventMarkets) {
        positionLimits.set(market.market.ticker, limitPerSide);
      }
    }
    
    while (remainingCapital > 0) {
      let allocated = false;
      
      for (const result of results) {
        if (remainingCapital <= 0) break;
        
        // Get the position limit for this specific market (now using 3% cap)
        const maxPositionCents = positionLimits.get(result.market.ticker) || baseMaxPositionCents;
        
        const currentCost = result.recommended_cost_cents;
        const maxCost = Math.min(maxPositionCents, result.max_fillable_units * result.price_cents);
        
        if (currentCost < maxCost && remainingCapital >= result.price_cents) {
          // Add one more unit
          result.recommended_units += 1;
          result.recommended_cost_cents += result.price_cents;
          remainingCapital -= result.price_cents;
          allocated = true;
        }
      }
      
      // If we couldn't allocate anything, break
      if (!allocated) break;
    }
  }
  
  return results;
}

async function prepareEnhancedOrders(params: EnhancedPrepareParams) {
  const { 
    minOdds, 
    maxOdds, 
    minOpenInterest, 
    forToday,
    maxPositionPercent = MAX_POSITION_PERCENT,
    minLiquidityScore = MIN_LIQUIDITY_SCORE,
  } = params;

  // Get target date
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
    return { success: false, error: 'Failed to fetch account balance from Kalshi' };
  }

  if (availableCapitalCents <= 0) {
    return { success: false, error: 'No available capital to deploy' };
  }

  console.log(`Available capital: $${(availableCapitalCents / 100).toFixed(2)}`);

  // Fetch sports markets
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
      const markets = await getMarkets(200, 15 * 24, 1, series); // 15 days max close
      allMarkets.push(...markets);
    } catch (e) {
      console.log(`No markets for ${series}`);
    }
  }

  console.log(`Found ${allMarkets.length} total markets`);

  // Filter by odds
  let filteredMarkets = filterHighOddsMarkets(allMarkets, minOdds, maxOdds);
  console.log(`After odds filter: ${filteredMarkets.length} markets`);

  // Filter by open interest
  filteredMarkets = filteredMarkets.filter(m => m.open_interest >= minOpenInterest);
  console.log(`After OI filter: ${filteredMarkets.length} markets`);

  // Exclude blacklisted markets
  const { data: blacklistedMarkets } = await supabase
    .from('illiquid_markets')
    .select('ticker');
  const blacklistedTickers = new Set((blacklistedMarkets || []).map(m => m.ticker));
  filteredMarkets = filteredMarkets.filter(m => !blacklistedTickers.has(m.ticker));
  console.log(`After blacklist filter: ${filteredMarkets.length} markets`);

  if (filteredMarkets.length === 0) {
    return { success: false, error: 'No qualifying markets found' };
  }

  // Analyze liquidity for each market
  console.log(`Analyzing liquidity for ${filteredMarkets.length} markets...`);
  const analyses: LiquidityAnalysis[] = [];

  for (const market of filteredMarkets) {
    const odds = getMarketOdds(market);
    const favoriteSide: 'YES' | 'NO' = odds.yes >= odds.no ? 'YES' : 'NO';
    const favoriteOdds = Math.max(odds.yes, odds.no);
    const priceCents = Math.round(favoriteOdds * 100);

    // Get orderbook analysis
    const { depth, spread } = await analyzeLiquidity(market, priceCents, favoriteSide);

    // Calculate liquidity score
    const liquidityScore = calculateLiquidityScore(
      depth,
      market.volume_24h || 0,
      market.open_interest || 0,
      spread
    );

    // Skip markets with very low liquidity
    if (liquidityScore < minLiquidityScore) {
      console.log(`Skipping ${market.ticker}: liquidity score ${liquidityScore} < ${minLiquidityScore}`);
      continue;
    }

    // Max fillable = orderbook depth or volume-based estimate
    const maxFillable = Math.max(
      depth,
      Math.floor((market.volume_24h || 0) / 10), // Assume we can capture 10% of daily volume
      1
    );

    analyses.push({
      market,
      side: favoriteSide,
      price_cents: priceCents,
      orderbook_depth: depth,
      volume_24h: market.volume_24h || 0,
      open_interest: market.open_interest || 0,
      spread_cents: spread,
      liquidity_score: liquidityScore,
      max_fillable_units: maxFillable,
      recommended_units: 0,
      recommended_cost_cents: 0,
    });

    // Rate limit
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`${analyses.length} markets passed liquidity filter`);

  if (analyses.length === 0) {
    return { success: false, error: 'No markets with sufficient liquidity' };
  }

  // CRITICAL: DEDUPLICATE - Only keep ONE market per event (the one with highest favorite odds)
  // This prevents betting on both "Team A wins" and "Team B wins" for the same game
  // which would guarantee a loss (one team MUST lose)
  const eventBestMarket = new Map<string, typeof analyses[0]>();
  for (const analysis of analyses) {
    const eventTicker = analysis.market.event_ticker;
    const existing = eventBestMarket.get(eventTicker);
    if (!existing) {
      eventBestMarket.set(eventTicker, analysis);
    } else {
      // Keep the one with higher favorite price (higher confidence)
      if (analysis.price_cents > existing.price_cents) {
        eventBestMarket.set(eventTicker, analysis);
      }
    }
  }
  
  const deduplicatedAnalyses = Array.from(eventBestMarket.values());
  console.log(`Deduplicated: ${analyses.length} markets -> ${deduplicatedAnalyses.length} unique events`);

  // Distribute capital based on liquidity
  const allocatedMarkets = distributeCapitalByLiquidity(
    deduplicatedAnalyses,
    availableCapitalCents,
    maxPositionPercent
  );

  if (allocatedMarkets.length === 0) {
    return { success: false, error: 'Could not allocate capital to any markets' };
  }

  // Calculate totals
  const totalCost = allocatedMarkets.reduce((sum, m) => sum + m.recommended_cost_cents, 0);
  const totalUnits = allocatedMarkets.reduce((sum, m) => sum + m.recommended_units, 0);
  const totalPayout = totalUnits * 100; // $1 per contract
  const avgUnits = (totalUnits / allocatedMarkets.length).toFixed(1);
  const avgLiquidity = (allocatedMarkets.reduce((sum, m) => sum + m.liquidity_score, 0) / allocatedMarkets.length).toFixed(1);

  // Create the batch
  const { data: batch, error: batchError } = await supabase
    .from('order_batches')
    .insert({
      batch_date: targetDateStr,
      unit_size_cents: 100,
      total_orders: allocatedMarkets.length,
      total_cost_cents: totalCost,
      total_potential_payout_cents: totalPayout,
      is_paused: false,
      prepared_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (batchError) throw batchError;

  // Create orders
  const orders = allocatedMarkets.map(analysis => ({
    batch_id: batch.id,
    ticker: analysis.market.ticker,
    event_ticker: analysis.market.event_ticker,
    title: analysis.market.title,
    side: analysis.side,
    price_cents: analysis.price_cents,
    units: analysis.recommended_units,
    cost_cents: analysis.recommended_cost_cents,
    potential_payout_cents: analysis.recommended_units * 100,
    open_interest: analysis.open_interest,
    volume_24h: analysis.volume_24h,
    market_close_time: analysis.market.close_time,
    placement_status: 'pending',
    placement_status_at: new Date().toISOString(),
    result_status: 'undecided',
    settlement_status: 'pending',
  }));

  const { error: ordersError } = await supabase.from('orders').insert(orders);
  if (ordersError) throw ordersError;

  // Build summary
  const summary = {
    batch_id: batch.id,
    date: targetDateStr,
    markets_analyzed: filteredMarkets.length,
    markets_selected: allocatedMarkets.length,
    total_units: totalUnits,
    avg_units_per_market: avgUnits,
    avg_liquidity_score: avgLiquidity,
    total_cost_cents: totalCost,
    total_cost_dollars: (totalCost / 100).toFixed(2),
    available_capital_cents: availableCapitalCents,
    capital_utilization: ((totalCost / availableCapitalCents) * 100).toFixed(1) + '%',
    expected_payout_cents: totalPayout,
    expected_profit_cents: totalPayout - totalCost,
  };

  // Top 10 allocations by units
  const topAllocations = allocatedMarkets
    .sort((a, b) => b.recommended_units - a.recommended_units)
    .slice(0, 10)
    .map(a => ({
      ticker: a.market.ticker,
      side: a.side,
      units: a.recommended_units,
      cost: `$${(a.recommended_cost_cents / 100).toFixed(2)}`,
      liquidity_score: a.liquidity_score,
      orderbook_depth: a.orderbook_depth,
      volume_24h: a.volume_24h,
    }));

  return {
    success: true,
    summary,
    top_allocations: topAllocations,
    message: `Prepared ${allocatedMarkets.length} orders with ${totalUnits} units ($${(totalCost / 100).toFixed(2)})`,
  };
}

// GET - Cron trigger
export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await prepareEnhancedOrders({
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

// POST - Manual trigger with parameters
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));

    const result = await prepareEnhancedOrders({
      minOdds: body.minOdds || 0.90,
      maxOdds: body.maxOdds || 0.995,
      minOpenInterest: body.minOpenInterest || 1000,
      forToday: body.forToday || false,
      maxPositionPercent: body.maxPositionPercent || MAX_POSITION_PERCENT,
      minLiquidityScore: body.minLiquidityScore || MIN_LIQUIDITY_SCORE,
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

