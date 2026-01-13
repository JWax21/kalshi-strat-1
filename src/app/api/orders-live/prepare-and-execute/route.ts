import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getMarkets, filterHighOddsMarkets, getMarketOdds, getBalance, placeOrder, KalshiMarket, calculateUnderdogBet } from '@/lib/kalshi';
import crypto from 'crypto';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_POSITION_PERCENT = 0.03; // 3% max per market
const MAX_BET_CENTS = 2500; // SAFEGUARD: $25 max per bet - UNBREAKABLE

// Helper to make authenticated Kalshi API calls
async function kalshiFetch(endpoint: string, method: string = 'GET'): Promise<any> {
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
  });

  if (!response.ok) {
    throw new Error(`Kalshi API error: ${response.status}`);
  }

  // DELETE requests may return empty body
  if (method === 'DELETE') {
    return { success: true };
  }

  return response.json();
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const forToday = body.forToday !== false; // Default to today
    
    const targetDate = new Date();
    if (!forToday) {
      targetDate.setDate(targetDate.getDate() + 1);
    }
    const targetDateStr = targetDate.toISOString().split('T')[0];

    console.log(`=== Prepare and Execute for ${targetDateStr} ===`);

    // Step 1: Delete existing batch and orders for this date (if any)
    // CRITICAL: Cancel any resting Kalshi orders before deleting from DB
    // This prevents orphaned orders on Kalshi that aren't tracked in our DB
    const { data: existingBatches } = await supabase
      .from('order_batches')
      .select('id')
      .eq('batch_date', targetDateStr);

    if (existingBatches && existingBatches.length > 0) {
      for (const batch of existingBatches) {
        // RACE CONDITION GUARD: Check if any orders are in 'pending' status
        // Pending orders might be actively being placed by monitor right now
        // If we delete them mid-placement, we'll orphan Kalshi orders
        const { data: pendingOrders, error: pendingError } = await supabase
          .from('orders')
          .select('id, ticker')
          .eq('batch_id', batch.id)
          .eq('placement_status', 'pending');
        
        if (!pendingError && pendingOrders && pendingOrders.length > 0) {
          console.log(`WARNING: Found ${pendingOrders.length} pending orders that might be mid-placement`);
          return NextResponse.json({
            success: false,
            error: `Cannot run prepare-and-execute while ${pendingOrders.length} orders are pending. They may be actively being placed by monitor. Wait a few minutes and try again, or manually update their status first.`,
            pending_orders: pendingOrders.map(o => o.ticker),
          }, { status: 409 }); // 409 Conflict
        }
        
        console.log(`Deleting existing batch ${batch.id}`);
        
        // First, get all orders with kalshi_order_ids that might be resting
        const { data: ordersToCancel } = await supabase
          .from('orders')
          .select('kalshi_order_id, ticker, placement_status')
          .eq('batch_id', batch.id)
          .not('kalshi_order_id', 'is', null);
        
        // Cancel any resting orders on Kalshi before deleting from DB
        for (const order of ordersToCancel || []) {
          if (order.kalshi_order_id && order.placement_status === 'placed') {
            try {
              await kalshiFetch(`/portfolio/orders/${order.kalshi_order_id}`, 'DELETE');
              console.log(`Cancelled Kalshi order ${order.kalshi_order_id} for ${order.ticker}`);
            } catch (e) {
              // Order might already be filled/cancelled, that's OK
              console.log(`Could not cancel ${order.kalshi_order_id} (may be already filled): ${e}`);
            }
          }
        }
        
        await supabase.from('orders').delete().eq('batch_id', batch.id);
        await supabase.from('order_batches').delete().eq('id', batch.id);
      }
    }
    console.log('Old batches cleared (and any resting Kalshi orders cancelled), proceeding with fresh preparation...');

    // Step 2: Get available balance AND portfolio_value directly from Kalshi
    // CRITICAL: Total portfolio = balance (cash) + portfolio_value (positions value)
    let availableBalance = 0;
    let totalPortfolioCents = 0;
    try {
      const balanceData = await getBalance();
      availableBalance = balanceData.balance || 0;
      const positionsValue = balanceData.portfolio_value || 0;
      // Total portfolio = cash + positions value (Kalshi returns these separately)
      totalPortfolioCents = availableBalance + positionsValue;
      console.log(`Kalshi balance: cash=${availableBalance}¢, positions=${positionsValue}¢, total=${totalPortfolioCents}¢`);
    } catch (e) {
      return NextResponse.json({ success: false, error: 'Could not fetch balance' }, { status: 500 });
    }

    console.log(`Total Portfolio: $${(totalPortfolioCents / 100).toFixed(2)}, available cash: $${(availableBalance / 100).toFixed(2)}`);

    // Get current positions to check existing exposure for each ticker
    // CRITICAL: Must check TOTAL exposure (existing + new) against 3% cap
    let currentPositions = new Map<string, any>();
    try {
      const positionsData = await kalshiFetch('/portfolio/positions');
      currentPositions = new Map(
        (positionsData.market_positions || []).map((p: any) => [p.ticker, p])
      );
      console.log(`Fetched ${currentPositions.size} current positions for exposure check`);
    } catch (e) {
      console.error('Error fetching positions (will proceed without existing exposure check):', e);
    }

    if (availableBalance < 100) { // Less than $1
      return NextResponse.json({ success: false, error: 'Insufficient balance' }, { status: 400 });
    }

    // Step 3: Fetch markets closing within 17 days (same as regular prepare)
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
        console.log(`${series}: ${markets.length} markets`);
      } catch (e) {
        console.log(`No markets for ${series}`);
      }
    }

    console.log(`Total markets found: ${allMarkets.length}`);

    // Step 4: Filter by odds (90-98.5%)
    let filteredMarkets = filterHighOddsMarkets(allMarkets, 0.90, 0.985);
    console.log(`After odds filter: ${filteredMarkets.length}`);

    // Step 5: Filter by open interest (min $1000)
    filteredMarkets = filteredMarkets.filter(m => m.open_interest >= 1000);
    console.log(`After OI filter: ${filteredMarkets.length}`);

    if (filteredMarkets.length === 0) {
      return NextResponse.json({ 
        success: false, 
        error: 'No qualifying markets found for today',
        markets_scanned: allMarkets.length,
      });
    }

    // Step 6: Sort by OI and enrich with UNDERDOG info
    filteredMarkets.sort((a, b) => b.open_interest - a.open_interest);

    const enrichedMarkets = filteredMarkets.map(market => {
      const odds = getMarketOdds(market);
      const favoriteSide = odds.yes >= odds.no ? 'YES' : 'NO';
      const favoriteOdds = Math.max(odds.yes, odds.no);
      const favoritePriceCents = Math.round(favoriteOdds * 100);
      
      // UNDERDOG STRATEGY: We bet on the opposite side
      const underdogSide = favoriteSide === 'YES' ? 'NO' : 'YES';
      const underdogPriceCents = 100 - favoritePriceCents;
      
      return { 
        ...market, 
        favorite_side: favoriteSide, 
        favorite_odds: favoriteOdds, 
        favorite_price_cents: favoritePriceCents,
        underdog_side: underdogSide,
        underdog_price_cents: underdogPriceCents,
        // Keep price_cents as favorite for unit calculation
        price_cents: favoritePriceCents 
      };
    });

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
    // Get existing exposure from current positions (live on Kalshi)
    const existingEventTickers = new Set<string>();
    for (const [ticker, position] of currentPositions) {
      // Extract event_ticker from ticker if possible, or use ticker itself
      // Kalshi tickers often have event info embedded
      existingEventTickers.add(ticker);
    }
    
    // Also check pending/placed/confirmed orders in database
    const { data: existingOrders } = await supabase
      .from('orders')
      .select('event_ticker, ticker, cost_cents, executed_cost_cents, placement_status')
      .in('placement_status', ['pending', 'placed', 'confirmed']);
    
    const existingEventExposure = new Map<string, number>();
    for (const order of existingOrders || []) {
      existingEventTickers.add(order.event_ticker);
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
      return NextResponse.json({ 
        success: false, 
        error: 'All qualifying events already have maximum exposure',
        events_checked: deduplicatedMarkets.length,
      });
    }

    // Step 7: UNDERDOG STRATEGY - Calculate units from favorite price, buy underdog
    // Units = allocation / favorite_price
    // Actual cost = units × underdog_price (much lower!)
    
    const evenDistributionCents = Math.floor(availableBalance / marketsAfterExposureCheck.length);
    const targetAllocationCents = Math.min(evenDistributionCents, maxPositionCents);
    
    console.log(`UNDERDOG STRATEGY: ${availableBalance}¢ / ${marketsAfterExposureCheck.length} markets`);
    console.log(`Target allocation: ${targetAllocationCents}¢ (min of even=${evenDistributionCents}¢, 3% cap=${maxPositionCents}¢)`);
    
    type MarketAllocation = { 
      market: typeof enrichedMarkets[0]; 
      units: number; 
      cost: number;
      underdog_side: 'YES' | 'NO';
      underdog_price_cents: number;
    };
    const allocations: MarketAllocation[] = [];
    let remainingBalance = availableBalance;

    for (const market of marketsAfterExposureCheck) {
      const favoritePriceCents = market.favorite_price_cents;
      const underdogPriceCents = market.underdog_price_cents;
      const underdogSide = market.underdog_side;
      
      // Calculate units based on FAVORITE price (what we'd allocate to a favorite bet)
      let units = Math.floor(targetAllocationCents / favoritePriceCents);
      
      // Calculate ACTUAL cost = units × underdog_price
      let actualCostCents = units * underdogPriceCents;
      
      // SAFEGUARD: Cap at $25 max per bet - UNBREAKABLE
      if (actualCostCents > MAX_BET_CENTS) {
        units = Math.floor(MAX_BET_CENTS / underdogPriceCents);
        actualCostCents = units * underdogPriceCents;
        console.log(`  SAFEGUARD: Capped ${market.ticker} to ${units}u @ ${underdogPriceCents}¢ = ${actualCostCents}¢ (max $25)`);
      }
      
      if (actualCostCents <= remainingBalance && units > 0) {
        allocations.push({
          market,
          units: units,
          cost: actualCostCents,
          underdog_side: underdogSide as 'YES' | 'NO',
          underdog_price_cents: underdogPriceCents,
        });
        remainingBalance -= actualCostCents;
        
        console.log(`  ${market.ticker}: ${units} units @ ${underdogPriceCents}¢ (underdog) = ${actualCostCents}¢`);
      }
    }

    const ordersToPlace = allocations;
    console.log(`Orders to place: ${ordersToPlace.length}`);

    if (ordersToPlace.length === 0) {
      return NextResponse.json({ success: false, error: 'Could not allocate any orders' });
    }

    // Step 8: Create batch
    const { data: batch, error: batchError } = await supabase
      .from('order_batches')
      .insert({
        batch_date: targetDateStr,
        unit_size_cents: 100,
        total_orders: ordersToPlace.length,
        total_cost_cents: ordersToPlace.reduce((s, o) => s + o.cost, 0),
        total_potential_payout_cents: ordersToPlace.reduce((s, o) => s + o.units * 100, 0),
        is_paused: false,
        prepared_at: new Date().toISOString(),
        executed_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (batchError) throw batchError;

    // Step 9: First save all orders to DB (as pending), then try to place on Kalshi
    const results: any[] = [];
    let successCount = 0;
    let failCount = 0;

    // First, insert all orders as pending (UNDERDOG STRATEGY)
    const ordersToInsert = ordersToPlace.map(({ market, units, cost, underdog_side, underdog_price_cents }) => ({
      batch_id: batch.id,
      ticker: market.ticker,
      event_ticker: market.event_ticker,
      title: market.title,
      side: underdog_side, // BET ON UNDERDOG
      price_cents: underdog_price_cents, // UNDERDOG PRICE
      units: units,
      cost_cents: cost,
      potential_payout_cents: units * 100, // Full payout if underdog wins
      open_interest: market.open_interest,
      market_close_time: market.close_time,
      placement_status: 'pending',
      placement_status_at: new Date().toISOString(),
      result_status: 'undecided',
      settlement_status: 'pending',
    }));

    const { data: insertedOrders, error: insertError } = await supabase
      .from('orders')
      .insert(ordersToInsert)
      .select();

    if (insertError) {
      console.error('Failed to insert orders:', insertError);
      return NextResponse.json({ 
        success: false, 
        error: `Failed to save orders: ${insertError.message}`,
        batch_id: batch.id,
      });
    }

    console.log(`Saved ${insertedOrders?.length || 0} orders to database`);

    // Now try to place each order on Kalshi
    // UNDERDOG STRATEGY: We're betting on underdogs (5-10¢ range)
    // No minimum price guard needed - we WANT low prices!
    const hardCapCents = Math.floor(totalPortfolioCents * MAX_POSITION_PERCENT);
    
    // ========================================
    // CRITICAL: Build runtime EVENT-level exposure map 
    // This is a FINAL SAFETY BARRIER during execution
    // ========================================
    const runtimeEventExposure = new Map<string, number>(existingEventExposure);
    
    for (const order of insertedOrders || []) {
      try {
        // UNDERDOG STRATEGY: No minimum price guard - we WANT low underdog prices!
        
        // ========================================
        // HARD CAP GUARD: NEVER exceed 3% of total portfolio
        // This is an UNBREAKABLE barrier - final safety check before placing
        // CRITICAL: Check TOTAL exposure (existing + new), not just new order
        // ========================================
        const existingPosition = currentPositions.get(order.ticker);
        const existingExposureCents = existingPosition 
          ? (existingPosition.market_exposure || 0) 
          : 0;
        const totalPositionCost = existingExposureCents + order.cost_cents;
        
        if (totalPositionCost > hardCapCents) {
          const errorMsg = `HARD CAP BLOCKED: ${order.ticker} total ${totalPositionCost}¢ (existing ${existingExposureCents}¢ + new ${order.cost_cents}¢) exceeds 3% cap (${hardCapCents}¢). Portfolio: ${totalPortfolioCents}¢`;
          console.error(errorMsg);
          
          // Mark as queued instead of placing
          await supabase
            .from('orders')
            .update({
              placement_status: 'queue',
              placement_status_at: new Date().toISOString(),
            })
            .eq('id', order.id);
          
          results.push({
            ticker: order.ticker,
            status: 'blocked',
            reason: errorMsg,
          });
          continue;
        }
        
        // ========================================
        // EVENT-LEVEL CAP GUARD: NEVER exceed 3% on any single EVENT
        // This prevents betting on both sides of the same game
        // CRITICAL: Check at EVENT level, not just ticker level
        // ========================================
        const currentEventExposure = runtimeEventExposure.get(order.event_ticker) || 0;
        const totalEventExposure = currentEventExposure + order.cost_cents;
        
        if (totalEventExposure > hardCapCents) {
          const errorMsg = `EVENT CAP BLOCKED: ${order.ticker} event ${order.event_ticker} total ${totalEventExposure}¢ (existing ${currentEventExposure}¢ + new ${order.cost_cents}¢) exceeds 3% cap (${hardCapCents}¢)`;
          console.error(errorMsg);
          
          // Mark as queued instead of placing
          await supabase
            .from('orders')
            .update({
              placement_status: 'queue',
              placement_status_at: new Date().toISOString(),
            })
            .eq('id', order.id);
          
          results.push({
            ticker: order.ticker,
            status: 'blocked',
            reason: errorMsg,
          });
          continue;
        }
        
        const payload: any = {
          ticker: order.ticker,
          action: 'buy',
          side: order.side.toLowerCase(),
          count: order.units,
          type: 'limit',
          client_order_id: `live_${batch.id}_${order.ticker}_${Date.now()}`,
        };

        if (order.side === 'YES') {
          payload.yes_price = order.price_cents;
        } else {
          payload.no_price = order.price_cents;
        }

        console.log(`Placing: ${order.ticker} x${order.units}`);
        const result = await placeOrder(payload);
        
        const kalshiOrderId = result.order?.order_id;
        const status = result.order?.status;
        const isExecuted = status === 'executed';

        // Update order with Kalshi result
        await supabase
          .from('orders')
          .update({
            placement_status: isExecuted ? 'confirmed' : 'placed',
            placement_status_at: new Date().toISOString(),
            kalshi_order_id: kalshiOrderId,
            executed_price_cents: isExecuted ? order.price_cents : null,
            executed_cost_cents: isExecuted ? order.cost_cents : null,
          })
          .eq('id', order.id);

        successCount++;
        
        // Update event exposure map to prevent over-betting on same event in this batch
        const newEventExposure = (runtimeEventExposure.get(order.event_ticker) || 0) + order.cost_cents;
        runtimeEventExposure.set(order.event_ticker, newEventExposure);
        
        results.push({
          ticker: order.ticker,
          units: order.units,
          cost: `$${(order.cost_cents/100).toFixed(2)}`,
          status,
          kalshi_order_id: kalshiOrderId,
        });

        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        failCount++;
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error(`Failed: ${order.ticker} - ${errMsg}`);
        
        results.push({
          ticker: order.ticker,
          units: order.units,
          status: 'failed',
          error: errMsg,
        });
      }
    }

    return NextResponse.json({
      success: true,
      date: targetDateStr,
      batch_id: batch.id,
      summary: {
        markets_found: allMarkets.length,
        qualifying_markets: filteredMarkets.length,
        orders_placed: successCount,
        orders_failed: failCount,
        total_cost: `$${(ordersToPlace.reduce((s, o) => s + o.cost, 0) / 100).toFixed(2)}`,
        balance_remaining: `$${(remainingBalance / 100).toFixed(2)}`,
      },
      orders: results,
    });

  } catch (error) {
    console.error('Prepare and execute error:', error);
    return NextResponse.json({ 
      success: false, 
      error: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

