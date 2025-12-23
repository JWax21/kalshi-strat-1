import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getMarkets, filterHighOddsMarkets, getMarketOdds, getBalance, placeOrder, KalshiMarket } from '@/lib/kalshi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_POSITION_PERCENT = 0.03; // 3% max per market

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
    const { data: existingBatches } = await supabase
      .from('order_batches')
      .select('id')
      .eq('batch_date', targetDateStr);

    if (existingBatches && existingBatches.length > 0) {
      for (const batch of existingBatches) {
        console.log(`Deleting existing batch ${batch.id}`);
        await supabase.from('orders').delete().eq('batch_id', batch.id);
        await supabase.from('order_batches').delete().eq('id', batch.id);
      }
    }
    console.log('Old batches cleared, proceeding with fresh preparation...');

    // Step 2: Get available balance
    let availableBalance = 0;
    try {
      const balanceData = await getBalance();
      availableBalance = balanceData.balance || 0;
    } catch (e) {
      return NextResponse.json({ success: false, error: 'Could not fetch balance' }, { status: 500 });
    }

    console.log(`Available balance: $${(availableBalance / 100).toFixed(2)}`);

    if (availableBalance < 100) { // Less than $1
      return NextResponse.json({ success: false, error: 'Insufficient balance' }, { status: 400 });
    }

    // Step 3: Fetch markets closing within 17 days (same as regular prepare)
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
        console.log(`${series}: ${markets.length} markets`);
      } catch (e) {
        console.log(`No markets for ${series}`);
      }
    }

    console.log(`Total markets found: ${allMarkets.length}`);

    // Step 4: Filter by odds (85-99.5%)
    let filteredMarkets = filterHighOddsMarkets(allMarkets, 0.85, 0.995);
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

    // Step 6: Sort by OI and enrich with favorite info
    filteredMarkets.sort((a, b) => b.open_interest - a.open_interest);

    const enrichedMarkets = filteredMarkets.map(market => {
      const odds = getMarketOdds(market);
      const favoriteSide = odds.yes >= odds.no ? 'YES' : 'NO';
      const favoriteOdds = Math.max(odds.yes, odds.no);
      const priceCents = Math.round(favoriteOdds * 100);
      return { ...market, favorite_side: favoriteSide, favorite_odds: favoriteOdds, price_cents: priceCents };
    });

    // Step 7: Distribute capital (3% max per market)
    const maxPositionCents = Math.floor(availableBalance * MAX_POSITION_PERCENT);
    
    type MarketAllocation = { market: typeof enrichedMarkets[0]; units: number; cost: number };
    const allocations: MarketAllocation[] = enrichedMarkets.map(m => ({
      market: m,
      units: 0,
      cost: 0,
    }));

    let remainingBalance = availableBalance;
    let madeProgress = true;

    while (remainingBalance > 0 && madeProgress) {
      madeProgress = false;
      for (const alloc of allocations) {
        if (remainingBalance <= 0) break;
        const costPerUnit = alloc.market.price_cents;
        const maxUnits = Math.floor(maxPositionCents / costPerUnit);
        
        if (alloc.units < maxUnits && remainingBalance >= costPerUnit) {
          alloc.units += 1;
          alloc.cost += costPerUnit;
          remainingBalance -= costPerUnit;
          madeProgress = true;
        }
      }
    }

    const ordersToPlace = allocations.filter(a => a.units > 0);
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

    // First, insert all orders as pending
    const ordersToInsert = ordersToPlace.map(({ market, units, cost }) => ({
      batch_id: batch.id,
      ticker: market.ticker,
      event_ticker: market.event_ticker,
      title: market.title,
      side: market.favorite_side,
      price_cents: market.price_cents,
      units: units,
      cost_cents: cost,
      potential_payout_cents: units * 100,
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
    for (const order of insertedOrders || []) {
      try {
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

