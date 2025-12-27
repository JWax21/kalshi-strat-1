import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getBalance, placeOrder, getMarkets, filterHighOddsMarkets, getMarketOdds, KalshiMarket } from '@/lib/kalshi';
import crypto from 'crypto';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_POSITION_PERCENT = 0.03; // 3% max per market
const MAX_POSITION_PERCENT_SPLIT = 0.015; // 1.5% max when betting both YES and NO on same event
const RESTING_IMPROVE_AFTER_MINUTES = 60; // Improve price after 1 hour
const RESTING_CANCEL_AFTER_MINUTES = 240; // Cancel after 4 hours
const PRICE_IMPROVEMENT_CENTS = 1; // Improve by 1 cent each time
const MIN_ODDS = 0.85; // Minimum favorite odds (85%)
const MAX_ODDS = 0.995; // Maximum favorite odds (99.5%)
const MIN_OPEN_INTEREST = 50; // Minimum open interest

// Extract game date from expected_expiration_time (in ET)
// Subtract 15 hours to account for: ET offset (5h) + game duration (4h) + settlement buffer (6h)
// Extract game date from event_ticker (most reliable for sports)
// Format: KXNBAGAME-25DEC26BOSIND = Season 2025 + Dec 26 = Dec 26, 2025
function extractGameDate(market: KalshiMarket): string | null {
  // Try to parse from event_ticker first
  // Pattern: -{SEASON_YY}{MONTH}{DAY}
  const tickerMatch = market.event_ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (tickerMatch) {
    const [, seasonStr, monthStr, dayStr] = tickerMatch;
    const monthMap: Record<string, string> = {
      'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04',
      'MAY': '05', 'JUN': '06', 'JUL': '07', 'AUG': '08',
      'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
    };
    const month = monthMap[monthStr];
    if (month) {
      return `20${seasonStr}-${month}-${dayStr}`;
    }
  }
  
  // Fallback: use expected_expiration_time - 15 hours
  if (market.expected_expiration_time) {
    const expirationTime = new Date(market.expected_expiration_time);
    const gameDate = new Date(expirationTime.getTime() - 15 * 60 * 60 * 1000);
    const year = gameDate.getUTCFullYear();
    const month = String(gameDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(gameDate.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return null;
}

// Get today's date in ET (day changes at 4 AM ET)
function getTodayET(): string {
  const now = new Date();
  // Get current hour in ET to check if before 4am
  const etTimeStr = now.toLocaleString('en-US', { 
    timeZone: 'America/New_York', 
    hour: 'numeric', 
    hour12: false 
  });
  const etHours = parseInt(etTimeStr);
  
  // Get today's date in ET
  const todayET = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  
  // If before 4 AM ET, consider it "yesterday"
  if (etHours < 4) {
    const d = new Date(todayET + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  }
  return todayET;
}

// Check if it's after 6am ET (when orders can be executed)
function isAfter6amET(): boolean {
  const now = new Date();
  // Get current hour in ET
  const etTimeStr = now.toLocaleString('en-US', { 
    timeZone: 'America/New_York', 
    hour: 'numeric', 
    hour12: false 
  });
  const etHours = parseInt(etTimeStr);
  return etHours >= 6; // 6am ET or later
}

// Get current time in ET for logging
function getCurrentTimeET(): string {
  const now = new Date();
  const etTime = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  return etTime.toISOString().replace('T', ' ').substring(0, 19) + ' ET';
}

// Helper to make authenticated Kalshi API calls
async function kalshiFetch(endpoint: string, method: string = 'GET', body?: any): Promise<any> {
  const timestampMs = Date.now().toString();
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
    method,
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': KALSHI_CONFIG.apiKey,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kalshi API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

interface MonitorResult {
  success: boolean;
  timestamp: string;
  actions: {
    improved_orders: number;
    cancelled_orders: number;
    new_orders_placed: number;
    new_markets_found: number;
  };
  capital: {
    available_cents: number;
    deployed_cents: number;
    remaining_cents: number;
  };
  details: {
    improved: string[];
    cancelled: string[];
    new_placements: string[];
    errors: string[];
  };
}

async function monitorAndOptimize(): Promise<MonitorResult> {
  const result: MonitorResult = {
    success: true,
    timestamp: new Date().toISOString(),
    actions: {
      improved_orders: 0,
      cancelled_orders: 0,
      new_orders_placed: 0,
      new_markets_found: 0,
    },
    capital: {
      available_cents: 0,
      deployed_cents: 0,
      remaining_cents: 0,
    },
    details: {
      improved: [],
      cancelled: [],
      new_placements: [],
      errors: [],
    },
  };

  const today = new Date().toISOString().split('T')[0];

  // Step 1: Get current balance
  let availableBalance = 0;
  try {
    const balanceData = await getBalance();
    availableBalance = balanceData.balance || 0;
    result.capital.available_cents = availableBalance;
  } catch (e) {
    result.details.errors.push(`Failed to fetch balance: ${e}`);
    result.success = false;
    return result;
  }

  // Step 2: Get all "placed" (resting) orders for today
  const { data: restingOrders, error: restingError } = await supabase
    .from('orders')
    .select('*, order_batches!inner(batch_date)')
    .eq('placement_status', 'placed')
    .not('kalshi_order_id', 'is', null);

  if (restingError) {
    result.details.errors.push(`Failed to fetch resting orders: ${restingError.message}`);
  }

  // Step 3: Check Kalshi for actual order status and handle stale orders
  const kalshiOrdersResponse = await kalshiFetch('/portfolio/orders?status=resting');
  const kalshiRestingOrders = new Map(
    (kalshiOrdersResponse.orders || []).map((o: any) => [o.order_id, o])
  );

  // Get our current positions to calculate existing exposure
  const positionsResponse = await kalshiFetch('/portfolio/positions');
  const currentPositions = new Map(
    (positionsResponse.market_positions || []).map((p: any) => [p.ticker, p])
  );

  // Calculate total exposure (capital already deployed)
  let totalExposure = 0;
  for (const [, pos] of currentPositions) {
    totalExposure += (pos as any).position_cost || 0;
  }
  result.capital.deployed_cents = totalExposure;
  result.capital.remaining_cents = availableBalance;

  // Step 4: Process resting orders - improve or cancel
  for (const order of restingOrders || []) {
    const kalshiOrder = kalshiOrdersResponse.orders?.find(
      (o: any) => o.order_id === order.kalshi_order_id
    );

    // If order is no longer resting on Kalshi, it might have filled
    if (!kalshiOrder) {
      // Check if it's now executed
      try {
        const orderDetail = await kalshiFetch(`/portfolio/orders/${order.kalshi_order_id}`);
        if (orderDetail.order?.status === 'executed') {
          // Update to confirmed
          const executedPrice = order.side === 'YES' 
            ? orderDetail.order.yes_price 
            : orderDetail.order.no_price;
          const filledCount = orderDetail.order.filled_count || order.units || 1;
          await supabase
            .from('orders')
            .update({
              placement_status: 'confirmed',
              placement_status_at: new Date().toISOString(),
              executed_price_cents: executedPrice,
              executed_cost_cents: executedPrice * filledCount,
            })
            .eq('id', order.id);
          result.details.improved.push(`${order.ticker}: filled!`);
        }
      } catch (e) {
        // Order might not exist anymore
      }
      continue;
    }

    // Calculate how long it's been resting
    const createdAt = new Date(kalshiOrder.created_time);
    const minutesResting = (Date.now() - createdAt.getTime()) / 60000;

    // If resting too long, cancel and blacklist
    if (minutesResting >= RESTING_CANCEL_AFTER_MINUTES) {
      try {
        // Cancel the order
        await kalshiFetch(`/portfolio/orders/${order.kalshi_order_id}`, 'DELETE');
        
        // Update order status
        await supabase
          .from('orders')
          .update({
            placement_status: 'cancelled',
            placement_status_at: new Date().toISOString(),
            cancelled_at: new Date().toISOString(),
            cancel_reason: `Unfilled for ${Math.round(minutesResting)} minutes`,
          })
          .eq('id', order.id);

        // Add to illiquid markets
        await supabase
          .from('illiquid_markets')
          .upsert({
            ticker: order.ticker,
            event_ticker: order.event_ticker,
            title: order.title,
            reason: `Order unfilled for ${Math.round(minutesResting)} minutes`,
            original_order_id: order.id,
          }, { onConflict: 'ticker' });

        result.actions.cancelled_orders++;
        result.details.cancelled.push(`${order.ticker}: cancelled after ${Math.round(minutesResting)} min`);
        
        // Reclaim the capital
        availableBalance += order.price_cents;
      } catch (e) {
        result.details.errors.push(`Failed to cancel ${order.ticker}: ${e}`);
      }
    }
    // If resting for a while, try to improve the price
    else if (minutesResting >= RESTING_IMPROVE_AFTER_MINUTES) {
      try {
        const currentPrice = order.side === 'YES' 
          ? kalshiOrder.yes_price 
          : kalshiOrder.no_price;
        const newPrice = Math.min(currentPrice + PRICE_IMPROVEMENT_CENTS, 99);

        // Cancel old order
        await kalshiFetch(`/portfolio/orders/${order.kalshi_order_id}`, 'DELETE');

        // Place new order with better price
        const payload: any = {
          ticker: order.ticker,
          action: 'buy',
          side: order.side.toLowerCase(),
          count: order.units || 1,
          type: 'limit',
          client_order_id: `improve_${order.id}_${Date.now()}`,
        };

        if (order.side === 'YES') {
          payload.yes_price = newPrice;
        } else {
          payload.no_price = newPrice;
        }

        const newOrderResult = await placeOrder(payload);
        const newKalshiOrderId = newOrderResult.order?.order_id;
        const newStatus = newOrderResult.order?.status;
        const filledCount = (newOrderResult.order as any)?.filled_count || order.units || 1;

        await supabase
          .from('orders')
          .update({
            price_cents: newPrice,
            kalshi_order_id: newKalshiOrderId,
            placement_status: newStatus === 'executed' ? 'confirmed' : 'placed',
            placement_status_at: new Date().toISOString(),
            executed_price_cents: newStatus === 'executed' ? newPrice : null,
            executed_cost_cents: newStatus === 'executed' ? newPrice * filledCount : null,
          })
          .eq('id', order.id);

        result.actions.improved_orders++;
        result.details.improved.push(
          `${order.ticker}: ${currentPrice}¢ → ${newPrice}¢ (${newStatus})`
        );
      } catch (e) {
        result.details.errors.push(`Failed to improve ${order.ticker}: ${e}`);
      }
    }
  }

  // Step 5: Execute PENDING orders for today's games (from prepare-week)
  // Only execute after 6am ET
  if (isAfter6amET()) {
    const todayForPending = getTodayET();
    const { data: pendingOrders, error: pendingError } = await supabase
      .from('orders')
      .select('*, order_batches!inner(batch_date)')
      .eq('placement_status', 'pending')
      .eq('order_batches.batch_date', todayForPending);
    
    if (pendingError) {
      result.details.errors.push(`Failed to fetch pending orders: ${pendingError.message}`);
    } else if (pendingOrders && pendingOrders.length > 0) {
      console.log(`[${getCurrentTimeET()}] Found ${pendingOrders.length} pending orders for today (${todayForPending})`);
      
      for (const order of pendingOrders) {
        try {
          // Place order on Kalshi
          const payload: any = {
            ticker: order.ticker,
            action: 'buy',
            side: order.side.toLowerCase(),
            count: order.units || 1,
            type: 'limit',
            client_order_id: `pending_${order.id}_${Date.now()}`,
          };

          if (order.side === 'YES') {
            payload.yes_price = order.price_cents;
          } else {
            payload.no_price = order.price_cents;
          }

          const orderResult = await placeOrder(payload);
          const kalshiOrderId = orderResult.order?.order_id;
          const status = orderResult.order?.status;
          const isExecuted = status === 'executed';
          const filledCount = (orderResult.order as any)?.filled_count || order.units || 1;

          // Update order in DB
          await supabase
            .from('orders')
            .update({
              kalshi_order_id: kalshiOrderId,
              placement_status: isExecuted ? 'confirmed' : 'placed',
              placement_status_at: new Date().toISOString(),
              executed_price_cents: isExecuted ? order.price_cents : null,
              executed_cost_cents: isExecuted ? order.price_cents * filledCount : null,
            })
            .eq('id', order.id);

          result.actions.new_orders_placed++;
          result.details.new_placements.push(
            `[PENDING] ${order.ticker}: ${order.units}u @ ${order.price_cents}¢ ${order.side} (${status})`
          );
          console.log(`Executed pending: ${order.ticker} - ${order.units}u @ ${order.price_cents}¢ ${order.side} (${status})`);
          
          await new Promise(r => setTimeout(r, 300)); // Rate limit
        } catch (e) {
          result.details.errors.push(`Failed to execute pending ${order.ticker}: ${e}`);
          console.error(`Failed to execute pending ${order.ticker}:`, e);
        }
      }
    }
  }

  // Step 6: Look for NEW qualifying markets (85%+ odds, today's games)
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

  // Fetch markets BY SERIES (bulk fetch misses some series like NBA)
  let allMarkets: KalshiMarket[] = [];
  const seriesCounts: Record<string, number> = {};
  
  for (const series of sportsSeries) {
    try {
      const markets = await getMarkets(500, 30 * 24, 2, series);
      seriesCounts[series] = markets.length;
      allMarkets.push(...markets);
    } catch (e) {
      seriesCounts[series] = 0;
    }
  }
  console.log(`Fetched ${allMarkets.length} sports markets across ${Object.keys(seriesCounts).length} series`);

  // Filter markets by odds and open interest
  let filteredMarkets = filterHighOddsMarkets(allMarkets, MIN_ODDS, MAX_ODDS);
  filteredMarkets = filteredMarkets.filter(m => m.open_interest >= MIN_OPEN_INTEREST);

  // IMPORTANT: Only bet on games happening TODAY
  const todayET = getTodayET();
  filteredMarkets = filteredMarkets.filter(m => {
    const gameDate = extractGameDate(m);
    return gameDate === todayET;
  });
  console.log(`Today (ET): ${todayET}, Games today with 85%+ odds: ${filteredMarkets.length}`);

  // Exclude blacklisted markets
  const { data: blacklistedMarkets } = await supabase
    .from('illiquid_markets')
    .select('ticker');
  const blacklistedTickers = new Set((blacklistedMarkets || []).map(m => m.ticker));
  filteredMarkets = filteredMarkets.filter(m => !blacklistedTickers.has(m.ticker));

  // Get existing orders - check both ticker AND event_ticker to avoid double-dipping
  const { data: existingOrders } = await supabase
    .from('orders')
    .select('ticker, event_ticker')
    .in('placement_status', ['pending', 'placed', 'confirmed']);
  
  const existingTickers = new Set((existingOrders || []).map(o => o.ticker));
  const existingEventTickers = new Set((existingOrders || []).map(o => o.event_ticker));

  // Calculate TOTAL EXPOSURE per EVENT (not just if we've bet, but HOW MUCH)
  // This allows us to add more to an event if we haven't hit 3% yet
  const eventExposureCents: Map<string, number> = new Map();
  
  // Add exposure from DB orders (confirmed/placed/pending)
  for (const order of existingOrders || []) {
    const existing = eventExposureCents.get(order.event_ticker) || 0;
    // We need to get the cost from the order - fetch it if needed
    eventExposureCents.set(order.event_ticker, existing);
  }
  
  // Fetch full order details to get costs
  const { data: ordersWithCosts } = await supabase
    .from('orders')
    .select('event_ticker, cost_cents, executed_cost_cents')
    .in('placement_status', ['pending', 'placed', 'confirmed']);
  
  for (const order of ordersWithCosts || []) {
    const cost = order.executed_cost_cents || order.cost_cents || 0;
    const existing = eventExposureCents.get(order.event_ticker) || 0;
    eventExposureCents.set(order.event_ticker, existing + cost);
  }
  
  // Add exposure from Kalshi positions (in case DB is out of sync)
  for (const [ticker, position] of currentPositions) {
    const parts = (ticker as string).split('-');
    const eventTicker = parts.slice(0, -1).join('-');
    const positionCost = (position as any).position_cost || 0;
    const existing = eventExposureCents.get(eventTicker) || 0;
    // Only add if not already counted from DB (avoid double-counting)
    if (!ordersWithCosts?.some(o => o.event_ticker === eventTicker)) {
      eventExposureCents.set(eventTicker, existing + positionCost);
    }
  }
  
  // Add exposure from resting orders on Kalshi
  for (const order of kalshiOrdersResponse.orders || []) {
    const parts = (order.ticker as string).split('-');
    const eventTicker = parts.slice(0, -1).join('-');
    const orderCost = (order.yes_price || order.no_price || 0) * (order.count || 1);
    const existing = eventExposureCents.get(eventTicker) || 0;
    eventExposureCents.set(eventTicker, existing + orderCost);
  }
  
  console.log(`Event exposures calculated: ${eventExposureCents.size} events`);
  
  // Calculate total portfolio for 3% limit
  const totalPortfolio = availableBalance + totalExposure;
  const maxEventExposureCents = Math.floor(totalPortfolio * MAX_POSITION_PERCENT);
  
  // Filter markets: exclude ones we've already bet on (same ticker)
  // Check event exposure to ensure we don't exceed 3% per event
  const preFilteredMarkets = filteredMarkets.filter(m => {
    // Never bet on the same ticker twice
    if (existingTickers.has(m.ticker)) return false;
    
    // Check remaining capacity for this event (allow partial fills up to 3%)
    const currentExposure = eventExposureCents.get(m.event_ticker) || 0;
    const remainingCapacity = maxEventExposureCents - currentExposure;
    
    // Need at least some capacity to bet
    return remainingCapacity > 0;
  });
  
  // DEDUPLICATE: Only keep ONE market per event (the one with highest favorite odds)
  // This prevents betting on both NE-wins and NYJ-wins markets
  const eventBestMarket = new Map<string, KalshiMarket>();
  for (const m of preFilteredMarkets) {
    const existing = eventBestMarket.get(m.event_ticker);
    if (!existing) {
      eventBestMarket.set(m.event_ticker, m);
    } else {
      // Keep the one with higher favorite odds
      const existingOdds = getMarketOdds(existing);
      const newOdds = getMarketOdds(m);
      const existingFavorite = Math.max(existingOdds.yes, existingOdds.no);
      const newFavorite = Math.max(newOdds.yes, newOdds.no);
      if (newFavorite > existingFavorite) {
        eventBestMarket.set(m.event_ticker, m);
      }
    }
  }
  
  const eligibleMarkets = Array.from(eventBestMarket.values());
  console.log(`Deduplicated: ${preFilteredMarkets.length} markets -> ${eligibleMarkets.length} unique events`);
  
  result.actions.new_markets_found = eligibleMarkets.length;
  console.log(`Found ${eligibleMarkets.length} eligible markets (portfolio: ${totalPortfolio}¢, max per event: ${maxEventExposureCents}¢)`);

  // Step 7: Deploy remaining capital to eligible markets (if any)
  // IMPORTANT: Only execute orders after 6am ET on the game day
  if (!isAfter6amET()) {
    console.log(`Skipping execution - before 6am ET (current: ${getCurrentTimeET()}). Found ${eligibleMarkets.length} eligible markets.`);
    result.details.errors.push(`Before 6am ET - execution paused. ${eligibleMarkets.length} markets ready.`);
    return result;
  }
  
  if (eligibleMarkets.length > 0 && availableBalance > 0) {
    // Sort by open interest descending (prefer more liquid markets)
    eligibleMarkets.sort((a, b) => b.open_interest - a.open_interest);
    
    console.log(`[${getCurrentTimeET()}] Deploying to ${eligibleMarkets.length} markets, max ${maxEventExposureCents}¢ per event, ${availableBalance}¢ available`);

    // Find or create today's batch
    let batchId: string;
    const { data: existingBatch } = await supabase
      .from('order_batches')
      .select('id')
      .eq('batch_date', today)
      .single();

    if (existingBatch) {
      batchId = existingBatch.id;
    } else {
      const { data: newBatch, error: batchError } = await supabase
        .from('order_batches')
        .insert({
          batch_date: today,
          unit_size_cents: 100,
          total_orders: 0,
          total_cost_cents: 0,
          total_potential_payout_cents: 0,
          is_paused: false,
          prepared_at: new Date().toISOString(),
          executed_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (batchError) {
        result.details.errors.push(`Failed to create batch: ${batchError.message}`);
        return result;
      }
      batchId = newBatch.id;
    }

    // Track exposure per event during this session (to update as we place orders)
    const sessionEventExposure: Map<string, number> = new Map(eventExposureCents);

    // Place orders on eligible markets
    for (const market of eligibleMarkets) {
      if (availableBalance <= 0) break;

      const odds = getMarketOdds(market);
      const favoriteSide = odds.yes >= odds.no ? 'YES' : 'NO';
      const priceCents = Math.round(Math.max(odds.yes, odds.no) * 100);

      // Calculate REMAINING CAPACITY for this event (3% - existing exposure)
      const currentExposure = sessionEventExposure.get(market.event_ticker) || 0;
      const remainingCapacity = maxEventExposureCents - currentExposure;
      
      if (remainingCapacity <= 0) {
        console.log(`Skipping ${market.ticker} - event ${market.event_ticker} already at 3% (${currentExposure}¢/${maxEventExposureCents}¢)`);
        continue;
      }

      // Skip if single unit exceeds remaining capacity
      if (priceCents > remainingCapacity) {
        console.log(`Skipping ${market.ticker} - price ${priceCents}¢ exceeds remaining capacity ${remainingCapacity}¢`);
        continue;
      }
      
      if (availableBalance < priceCents) {
        console.log(`Skipping ${market.ticker} - insufficient balance (${availableBalance}¢ < ${priceCents}¢)`);
        continue;
      }

      // Calculate units: fill up to REMAINING CAPACITY (not full 3%), respecting available balance
      const maxUnitsForEvent = Math.floor(remainingCapacity / priceCents);
      const affordableUnits = Math.floor(availableBalance / priceCents);
      const units = Math.min(maxUnitsForEvent, affordableUnits);

      if (units <= 0) continue;
      
      const thisBetCost = units * priceCents;

      try {
        // Place order on Kalshi
        const payload: any = {
          ticker: market.ticker,
          action: 'buy',
          side: favoriteSide.toLowerCase(),
          count: units,
          type: 'limit',
          client_order_id: `monitor_${market.ticker}_${Date.now()}`,
        };

        if (favoriteSide === 'YES') {
          payload.yes_price = priceCents;
        } else {
          payload.no_price = priceCents;
        }

        const orderResult = await placeOrder(payload);
        const kalshiOrderId = orderResult.order?.order_id;
        const status = orderResult.order?.status;
        const isExecuted = status === 'executed';
        const filledCount = (orderResult.order as any)?.filled_count || units;

        // Save to DB
        await supabase
          .from('orders')
          .insert({
            batch_id: batchId,
            ticker: market.ticker,
            event_ticker: market.event_ticker,
            title: market.title,
            side: favoriteSide,
            price_cents: priceCents,
            units: units,
            cost_cents: priceCents * units,
            potential_payout_cents: 100 * units,
            open_interest: market.open_interest,
            market_close_time: market.close_time,
            placement_status: isExecuted ? 'confirmed' : 'placed',
            placement_status_at: new Date().toISOString(),
            kalshi_order_id: kalshiOrderId,
            executed_price_cents: isExecuted ? priceCents : null,
            executed_cost_cents: isExecuted ? priceCents * filledCount : null,
            result_status: 'undecided',
            settlement_status: 'pending',
          });

        // Track this event's new exposure to prevent exceeding 3%
        const newExposure = (sessionEventExposure.get(market.event_ticker) || 0) + thisBetCost;
        sessionEventExposure.set(market.event_ticker, newExposure);
        
        availableBalance -= thisBetCost;
        result.actions.new_orders_placed++;
        result.details.new_placements.push(
          `${market.ticker}: ${units}u @ ${priceCents}¢ ${favoriteSide} (${status}) [event: ${newExposure}¢/${maxEventExposureCents}¢]`
        );

        console.log(`Placed: ${market.ticker} - ${units}u @ ${priceCents}¢ ${favoriteSide} (event exposure: ${newExposure}¢/${maxEventExposureCents}¢)`);
        await new Promise(r => setTimeout(r, 300)); // Rate limit
      } catch (e) {
        result.details.errors.push(`Failed to place ${market.ticker}: ${e}`);
        console.error(`Failed to place ${market.ticker}:`, e);
      }
    }

    // Update batch totals
    const { data: batchOrders } = await supabase
      .from('orders')
      .select('cost_cents, potential_payout_cents')
      .eq('batch_id', batchId);

    if (batchOrders) {
      const totalCost = batchOrders.reduce((sum, o) => sum + (o.cost_cents || 0), 0);
      const totalPayout = batchOrders.reduce((sum, o) => sum + (o.potential_payout_cents || 0), 0);
      
      await supabase
        .from('order_batches')
        .update({
          total_orders: batchOrders.length,
          total_cost_cents: totalCost,
          total_potential_payout_cents: totalPayout,
        })
        .eq('id', batchId);
    }
  }

  result.capital.remaining_cents = availableBalance;
  return result;
}

// GET - Called by Vercel Cron every 30 minutes
export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await monitorAndOptimize();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error in monitor:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// POST - Manual trigger
export async function POST() {
  try {
    const result = await monitorAndOptimize();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error in monitor:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}


