import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getPositions, getOrderbook, placeOrder, KalshiMarket } from '@/lib/kalshi';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STOP_LOSS_THRESHOLD = 0.75; // 75% - sell if odds drop below this
const MIN_SPREAD_FOR_VALID_DATA = 30; // Max spread in cents to consider data valid
const SUSPICIOUS_UNIFORM_PRICE = 50; // If multiple positions show exactly this price, something's wrong
const MAX_POSITIONS_AT_SAME_PRICE = 3; // If more than this many positions show same suspicious price, flag it
const MIN_VOLUME_FOR_RELIABLE_DATA = 10; // Minimum recent volume to trust the data

interface DataValidation {
  isValid: boolean;
  confidence: 'high' | 'medium' | 'low' | 'suspicious';
  issues: string[];
  currentOdds: number | null;
  method: string; // Which method was used to determine odds
}

interface PositionCheck {
  ticker: string;
  title: string;
  side: 'yes' | 'no';
  position_cost: number;
  contracts: number;
  entryPrice: number;
  currentOdds: number | null;
  validation: DataValidation;
  action: 'sell' | 'hold' | 'error';
  reason: string;
}

interface StopLossResult {
  timestamp: string;
  success: boolean;
  positions_checked: number;
  positions_sold: number;
  positions_held: number;
  data_errors: number;
  alerts: string[];
  details: PositionCheck[];
  sells: { ticker: string; result: string }[];
}

function generateSignature(timestampMs: string, method: string, path: string): string {
  const pathWithoutQuery = path.split('?')[0];
  const message = `${timestampMs}${method}${pathWithoutQuery}`;
  const privateKey = crypto.createPrivateKey(KALSHI_CONFIG.privateKey);
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signature.toString('base64');
}

async function fetchKalshiDirect(endpoint: string): Promise<any> {
  const timestampMs = Date.now().toString();
  const method = 'GET';
  const fullPath = `/trade-api/v2${endpoint}`;
  const signature = generateSignature(timestampMs, method, fullPath);
  
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

/**
 * Fetch market data with validation
 * Returns both the market data and validation status
 */
async function fetchMarketWithValidation(ticker: string): Promise<{
  market: KalshiMarket | null;
  validation: DataValidation;
}> {
  const validation: DataValidation = {
    isValid: false,
    confidence: 'suspicious',
    issues: [],
    currentOdds: null,
    method: 'none',
  };

  try {
    // Fetch 1: Get market data
    const marketResponse = await fetchKalshiDirect(`/markets/${ticker}`);
    const market = marketResponse.market as KalshiMarket;

    if (!market) {
      validation.issues.push('Market data returned null');
      return { market: null, validation };
    }

    // Extract all available price data
    const lastPrice = market.last_price || 0; // in cents
    const yesBid = market.yes_bid || 0;
    const yesAsk = market.yes_ask || 0;
    const noBid = market.no_bid || 0;
    const noAsk = market.no_ask || 0;
    const volume24h = market.volume_24h || 0;
    
    // Calculate spread
    const yesSpread = yesAsk - yesBid;
    const noSpread = noAsk - noBid;

    // Validation Check 1: Do we have bid/ask data?
    const hasBidAsk = yesBid > 0 || yesAsk > 0 || noBid > 0 || noAsk > 0;
    if (!hasBidAsk) {
      validation.issues.push('No bid/ask data available');
    }

    // Validation Check 2: Is spread reasonable?
    if (hasBidAsk && (yesSpread > MIN_SPREAD_FOR_VALID_DATA || noSpread > MIN_SPREAD_FOR_VALID_DATA)) {
      validation.issues.push(`Wide spread detected (yes: ${yesSpread}¢, no: ${noSpread}¢)`);
    }

    // Validation Check 3: Does last_price match bid/ask midpoint?
    const yesMidpoint = hasBidAsk ? (yesBid + yesAsk) / 2 : 0;
    const priceDivergence = hasBidAsk ? Math.abs(lastPrice - yesMidpoint) : 0;
    if (hasBidAsk && priceDivergence > 10) {
      validation.issues.push(`Last price (${lastPrice}¢) diverges from midpoint (${yesMidpoint.toFixed(0)}¢)`);
    }

    // Validation Check 4: Recent volume
    if (volume24h < MIN_VOLUME_FOR_RELIABLE_DATA) {
      validation.issues.push(`Low 24h volume: ${volume24h} (need ${MIN_VOLUME_FOR_RELIABLE_DATA}+)`);
    }

    // Fetch 2: Get orderbook to cross-verify
    let orderbookOdds: number | null = null;
    try {
      const orderbook = await getOrderbook(ticker, 5);
      
      // Get best bid for the side we own
      const yesBestBid = orderbook.yes.length > 0 ? orderbook.yes[0].price : 0;
      const noBestBid = orderbook.no.length > 0 ? orderbook.no[0].price : 0;
      
      // If we have YES position, our "odds" is the yes price
      // If we have NO position, our "odds" is the no price (100 - yes price)
      if (yesBestBid > 0 || noBestBid > 0) {
        // Orderbook gives us bids - what we could sell for
        orderbookOdds = yesBestBid / 100; // Convert cents to decimal
        validation.method = 'orderbook_yes_bid';
      }
      
      // Cross-check orderbook vs market data
      if (yesBestBid > 0 && Math.abs(yesBestBid - yesBid) > 5) {
        validation.issues.push(`Orderbook yes bid (${yesBestBid}¢) differs from market yes_bid (${yesBid}¢)`);
      }
    } catch (e) {
      validation.issues.push(`Orderbook fetch failed: ${e}`);
    }

    // Determine current odds using most reliable method
    let currentOdds: number;
    if (orderbookOdds !== null && orderbookOdds > 0) {
      // Prefer orderbook data - it's what we'd actually get when selling
      currentOdds = orderbookOdds;
      validation.method = 'orderbook_best_bid';
    } else if (hasBidAsk && yesBid > 0) {
      // Use market yes_bid - what buyers are willing to pay
      currentOdds = yesBid / 100;
      validation.method = 'market_yes_bid';
    } else if (lastPrice > 0) {
      // Fallback to last trade price
      currentOdds = lastPrice / 100;
      validation.method = 'last_price';
      validation.issues.push('Using last_price as fallback - may be stale');
    } else {
      validation.issues.push('Could not determine current odds from any source');
      return { market, validation };
    }

    validation.currentOdds = currentOdds;

    // Validation Check 5: Suspicious exact 50% price
    if (Math.abs(currentOdds - 0.50) < 0.01) {
      validation.issues.push('Price is exactly 50% - potentially suspicious');
    }

    // Determine confidence level
    if (validation.issues.length === 0) {
      validation.confidence = 'high';
      validation.isValid = true;
    } else if (validation.issues.length <= 2 && !validation.issues.some(i => i.includes('suspicious') || i.includes('null'))) {
      validation.confidence = 'medium';
      validation.isValid = true;
    } else if (validation.issues.length <= 3) {
      validation.confidence = 'low';
      validation.isValid = true; // Still valid but with caveats
    } else {
      validation.confidence = 'suspicious';
      validation.isValid = false;
    }

    return { market, validation };

  } catch (error) {
    validation.issues.push(`Fetch error: ${error}`);
    return { market: null, validation };
  }
}

/**
 * Execute a market sell order
 */
async function executeSell(ticker: string, side: 'yes' | 'no', contracts: number): Promise<{ success: boolean; message: string }> {
  try {
    const payload = {
      ticker,
      action: 'sell' as const,
      side: side.toLowerCase() as 'yes' | 'no',
      count: contracts,
      type: 'market' as const,
      client_order_id: `stoploss_${ticker}_${Date.now()}`,
    };

    console.log(`[STOP-LOSS] Executing sell: ${contracts}x ${side.toUpperCase()} on ${ticker}`);
    const result = await placeOrder(payload);
    
    return {
      success: true,
      message: `Sold ${contracts} contracts. Order ID: ${result.order?.order_id}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Sell failed: ${error}`,
    };
  }
}

async function runStopLoss(): Promise<StopLossResult> {
  const result: StopLossResult = {
    timestamp: new Date().toISOString(),
    success: true,
    positions_checked: 0,
    positions_sold: 0,
    positions_held: 0,
    data_errors: 0,
    alerts: [],
    details: [],
    sells: [],
  };

  try {
    // Step 1: Get all current positions from Kalshi
    const positionsResponse = await getPositions();
    const positions = positionsResponse.market_positions || [];
    
    console.log(`[STOP-LOSS] Checking ${positions.length} positions...`);
    
    if (positions.length === 0) {
      result.alerts.push('No open positions to monitor');
      return result;
    }

    result.positions_checked = positions.length;

    // Step 2: Collect all position data with validation
    const positionChecks: PositionCheck[] = [];
    const priceDistribution: Map<number, string[]> = new Map(); // Track how many positions have same price

    for (const pos of positions) {
      const ticker = pos.ticker;
      const contracts = Math.abs(pos.position || 0);
      const side = pos.position > 0 ? 'yes' : 'no';
      const positionCost = pos.position_cost || 0;
      const entryPrice = contracts > 0 ? positionCost / contracts : 0;

      // Skip if no position
      if (contracts === 0) continue;

      // Fetch market data with validation
      const { market, validation } = await fetchMarketWithValidation(ticker);

      const check: PositionCheck = {
        ticker,
        title: market?.title || ticker,
        side: side as 'yes' | 'no',
        position_cost: positionCost,
        contracts,
        entryPrice: entryPrice / 100, // Convert to decimal
        currentOdds: validation.currentOdds,
        validation,
        action: 'hold',
        reason: '',
      };

      // Track price distribution for anomaly detection
      if (validation.currentOdds !== null) {
        const roundedPrice = Math.round(validation.currentOdds * 100);
        const existing = priceDistribution.get(roundedPrice) || [];
        existing.push(ticker);
        priceDistribution.set(roundedPrice, existing);
      }

      positionChecks.push(check);
      
      // Rate limiting
      await new Promise(r => setTimeout(r, 200));
    }

    // Step 3: Check for suspicious patterns (multiple positions at same unusual price)
    for (const [price, tickers] of priceDistribution) {
      // Flag if many positions have exactly the same price AND it's a suspicious price
      if (tickers.length >= MAX_POSITIONS_AT_SAME_PRICE && 
          (price === SUSPICIOUS_UNIFORM_PRICE || price < 40 || price > 95)) {
        const alert = `⚠️ SUSPICIOUS: ${tickers.length} positions all showing ${price}¢ - possible data error!`;
        result.alerts.push(alert);
        console.error(`[STOP-LOSS] ${alert}`);
        
        // Mark all these positions as having suspicious data
        for (const check of positionChecks) {
          if (tickers.includes(check.ticker)) {
            check.validation.isValid = false;
            check.validation.confidence = 'suspicious';
            check.validation.issues.push('Multiple positions showing identical suspicious price');
          }
        }
      }
    }

    // Step 4: Make sell decisions
    for (const check of positionChecks) {
      // If data validation failed, DO NOT SELL
      if (!check.validation.isValid) {
        check.action = 'error';
        check.reason = `Data validation failed: ${check.validation.issues.join('; ')}`;
        result.data_errors++;
        result.alerts.push(`❌ ${check.ticker}: ${check.reason}`);
        continue;
      }

      // If we couldn't get current odds, DO NOT SELL
      if (check.currentOdds === null) {
        check.action = 'error';
        check.reason = 'Could not determine current odds';
        result.data_errors++;
        result.alerts.push(`❌ ${check.ticker}: ${check.reason}`);
        continue;
      }

      // Determine the odds for our side
      // If we have YES, our odds are the yes price
      // If we have NO, our odds are the no price (100 - yes)
      const ourSideOdds = check.side === 'yes' 
        ? check.currentOdds 
        : (1 - check.currentOdds);

      // Check if below stop-loss threshold
      if (ourSideOdds < STOP_LOSS_THRESHOLD) {
        // Additional safety: if confidence is low, require a second fetch
        if (check.validation.confidence === 'low') {
          console.log(`[STOP-LOSS] Low confidence for ${check.ticker}, re-fetching...`);
          await new Promise(r => setTimeout(r, 1000));
          
          const { validation: revalidation } = await fetchMarketWithValidation(check.ticker);
          
          if (!revalidation.isValid || revalidation.currentOdds === null) {
            check.action = 'error';
            check.reason = `Re-validation failed: ${revalidation.issues.join('; ')}`;
            result.data_errors++;
            result.alerts.push(`⚠️ ${check.ticker}: Skipped sell due to re-validation failure`);
            continue;
          }

          const revalidatedOdds = check.side === 'yes' 
            ? revalidation.currentOdds 
            : (1 - revalidation.currentOdds);

          // If re-fetch shows different odds (>5% difference), don't trust original
          if (Math.abs(revalidatedOdds - ourSideOdds) > 0.05) {
            check.action = 'error';
            check.reason = `Odds changed on re-fetch (${(ourSideOdds * 100).toFixed(0)}% → ${(revalidatedOdds * 100).toFixed(0)}%) - data unstable`;
            result.data_errors++;
            result.alerts.push(`⚠️ ${check.ticker}: ${check.reason}`);
            continue;
          }
        }

        // Safe to sell
        check.action = 'sell';
        check.reason = `Odds dropped to ${(ourSideOdds * 100).toFixed(0)}% (below ${STOP_LOSS_THRESHOLD * 100}% threshold). Confidence: ${check.validation.confidence}`;
        
        console.log(`[STOP-LOSS] 🔴 Selling ${check.ticker}: ${check.reason}`);
        
        // Execute the sell
        const sellResult = await executeSell(check.ticker, check.side, check.contracts);
        result.sells.push({ ticker: check.ticker, result: sellResult.message });
        
        if (sellResult.success) {
          result.positions_sold++;
          result.alerts.push(`✅ SOLD ${check.ticker}: ${check.reason}`);
          
          // Update database
          await supabase
            .from('orders')
            .update({
              result_status: 'stop_loss',
              settlement_status: 'sold',
              notes: `Stop-loss triggered at ${(ourSideOdds * 100).toFixed(0)}%`,
            })
            .eq('ticker', check.ticker)
            .in('placement_status', ['confirmed', 'placed']);
        } else {
          result.alerts.push(`❌ SELL FAILED ${check.ticker}: ${sellResult.message}`);
        }
      } else {
        check.action = 'hold';
        check.reason = `Odds at ${(ourSideOdds * 100).toFixed(0)}% (above ${STOP_LOSS_THRESHOLD * 100}% threshold)`;
        result.positions_held++;
      }
    }

    result.details = positionChecks;

    // Log summary
    console.log(`[STOP-LOSS] Summary: ${result.positions_checked} checked, ${result.positions_sold} sold, ${result.positions_held} held, ${result.data_errors} errors`);
    
    if (result.data_errors > 0) {
      console.error(`[STOP-LOSS] ⚠️ ${result.data_errors} positions had data errors - NOT SOLD`);
    }

  } catch (error) {
    result.success = false;
    result.alerts.push(`Fatal error: ${error}`);
    console.error('[STOP-LOSS] Fatal error:', error);
  }

  return result;
}

// GET - Can be called by Vercel Cron every minute
export async function GET(request: Request) {
  console.log('[STOP-LOSS] Starting stop-loss check...');
  
  const result = await runStopLoss();
  
  // If there are critical alerts, we should notify somehow
  if (result.data_errors > 0 || result.alerts.some(a => a.includes('SUSPICIOUS'))) {
    console.error('[STOP-LOSS] ⚠️ CRITICAL ALERTS:', result.alerts);
  }
  
  return NextResponse.json(result);
}

// POST - Manual trigger with optional parameters
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const dryRun = body.dryRun === true;
  
  console.log(`[STOP-LOSS] Manual trigger (dryRun: ${dryRun})`);
  
  if (dryRun) {
    // For dry run, just check and report but don't sell
    const result: StopLossResult = {
      timestamp: new Date().toISOString(),
      success: true,
      positions_checked: 0,
      positions_sold: 0,
      positions_held: 0,
      data_errors: 0,
      alerts: ['DRY RUN - No sells executed'],
      details: [],
      sells: [],
    };

    try {
      const positionsResponse = await getPositions();
      const positions = positionsResponse.market_positions || [];
      result.positions_checked = positions.length;

      for (const pos of positions) {
        const ticker = pos.ticker;
        const contracts = Math.abs(pos.position || 0);
        const side = pos.position > 0 ? 'yes' : 'no';
        const positionCost = pos.position_cost || 0;
        const entryPrice = contracts > 0 ? positionCost / contracts : 0;

        if (contracts === 0) continue;

        const { market, validation } = await fetchMarketWithValidation(ticker);

        const ourSideOdds = validation.currentOdds !== null
          ? (side === 'yes' ? validation.currentOdds : (1 - validation.currentOdds))
          : null;

        const check: PositionCheck = {
          ticker,
          title: market?.title || ticker,
          side: side as 'yes' | 'no',
          position_cost: positionCost,
          contracts,
          entryPrice: entryPrice / 100,
          currentOdds: validation.currentOdds,
          validation,
          action: !validation.isValid ? 'error' : 
                  (ourSideOdds !== null && ourSideOdds < STOP_LOSS_THRESHOLD ? 'sell' : 'hold'),
          reason: !validation.isValid 
            ? `Data validation failed: ${validation.issues.join('; ')}`
            : (ourSideOdds !== null && ourSideOdds < STOP_LOSS_THRESHOLD 
                ? `Would sell: odds at ${(ourSideOdds * 100).toFixed(0)}%`
                : `Would hold: odds at ${ourSideOdds !== null ? (ourSideOdds * 100).toFixed(0) : '?'}%`),
        };

        result.details.push(check);
        
        if (!validation.isValid) result.data_errors++;
        else if (ourSideOdds !== null && ourSideOdds < STOP_LOSS_THRESHOLD) result.positions_sold++;
        else result.positions_held++;

        await new Promise(r => setTimeout(r, 200));
      }

    } catch (error) {
      result.success = false;
      result.alerts.push(`Error: ${error}`);
    }

    return NextResponse.json(result);
  }
  
  const result = await runStopLoss();
  return NextResponse.json(result);
}

