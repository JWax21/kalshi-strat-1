import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getMarkets, filterHighOddsMarkets, getMarketOdds, getOrderbook, KalshiMarket } from '@/lib/kalshi';
import crypto from 'crypto';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes

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

interface DayResult {
  date: string;
  success: boolean;
  markets_found?: number;
  orders_prepared?: number;
  total_cost_dollars?: string;
  error?: string;
  skipped?: boolean;
}

async function prepareForDay(
  targetDateStr: string,
  allMarkets: KalshiMarket[],
  availableCapitalCents: number,
  minOdds: number,
  maxOdds: number,
  minOpenInterest: number
): Promise<DayResult> {
  try {
    // Check if batch already exists
    const { data: existing } = await supabase
      .from('order_batches')
      .select('id')
      .eq('batch_date', targetDateStr)
      .single();

    if (existing) {
      return {
        date: targetDateStr,
        success: true,
        skipped: true,
        error: 'Batch already exists',
      };
    }

    // Filter markets that close on this date
    // Use noon UTC to avoid timezone issues at midnight boundaries
    const targetDateStart = new Date(targetDateStr + 'T00:00:00Z');
    const targetDateEnd = new Date(targetDateStr + 'T00:00:00Z');
    targetDateEnd.setDate(targetDateEnd.getDate() + 1);

    const dayMarkets = allMarkets.filter(m => {
      const closeTime = new Date(m.close_time);
      // Check if the market closes on this calendar day (in UTC)
      return closeTime >= targetDateStart && closeTime < targetDateEnd;
    });

    if (dayMarkets.length === 0) {
      return {
        date: targetDateStr,
        success: true,
        markets_found: 0,
        orders_prepared: 0,
        total_cost_dollars: '0.00',
      };
    }

    // Filter by odds
    let filteredMarkets = filterHighOddsMarkets(dayMarkets, minOdds, maxOdds);

    // Filter by open interest
    filteredMarkets = filteredMarkets.filter(m => m.open_interest >= minOpenInterest);

    // Exclude blacklisted markets
    const { data: blacklistedMarkets } = await supabase
      .from('illiquid_markets')
      .select('ticker');
    const blacklistedTickers = new Set((blacklistedMarkets || []).map(m => m.ticker));
    filteredMarkets = filteredMarkets.filter(m => !blacklistedTickers.has(m.ticker));

    if (filteredMarkets.length === 0) {
      return {
        date: targetDateStr,
        success: true,
        markets_found: dayMarkets.length,
        orders_prepared: 0,
        total_cost_dollars: '0.00',
      };
    }

    // Enrich with favorite info
    const enrichedMarkets = filteredMarkets.map(market => {
      const odds = getMarketOdds(market);
      const favoriteSide = odds.yes >= odds.no ? 'YES' : 'NO';
      const favoriteOdds = Math.max(odds.yes, odds.no);
      const priceCents = Math.round(favoriteOdds * 100);
      
      return {
        market,
        side: favoriteSide as 'YES' | 'NO',
        price_cents: priceCents,
        open_interest: market.open_interest || 0,
        volume_24h: market.volume_24h || 0,
      };
    });

    // Group by event to handle both-sides logic
    const eventGroups = new Map<string, typeof enrichedMarkets>();
    for (const em of enrichedMarkets) {
      const eventTicker = em.market.event_ticker;
      if (!eventGroups.has(eventTicker)) {
        eventGroups.set(eventTicker, []);
      }
      eventGroups.get(eventTicker)!.push(em);
    }

    // Calculate position limits
    const maxPositionPercent = 0.03;
    const baseMaxPositionCents = Math.floor(availableCapitalCents * maxPositionPercent);
    
    const positionLimits = new Map<string, number>();
    for (const [, eventMarkets] of eventGroups) {
      const limitPerSide = eventMarkets.length > 1 
        ? Math.floor(baseMaxPositionCents / 2)
        : baseMaxPositionCents;
      
      for (const em of eventMarkets) {
        positionLimits.set(em.market.ticker, limitPerSide);
      }
    }

    // Allocate capital
    const allocatedMarkets: Array<{
      market: KalshiMarket;
      side: 'YES' | 'NO';
      price_cents: number;
      units: number;
      cost_cents: number;
      open_interest: number;
      volume_24h: number;
    }> = [];

    for (const em of enrichedMarkets) {
      const maxPositionCents = positionLimits.get(em.market.ticker) || baseMaxPositionCents;
      const maxUnits = Math.floor(maxPositionCents / em.price_cents);
      const units = Math.min(maxUnits, 100); // Cap at 100 units per market for now
      
      if (units > 0) {
        allocatedMarkets.push({
          market: em.market,
          side: em.side,
          price_cents: em.price_cents,
          units,
          cost_cents: units * em.price_cents,
          open_interest: em.open_interest,
          volume_24h: em.volume_24h,
        });
      }
    }

    if (allocatedMarkets.length === 0) {
      return {
        date: targetDateStr,
        success: true,
        markets_found: dayMarkets.length,
        orders_prepared: 0,
        total_cost_dollars: '0.00',
      };
    }

    // Calculate totals
    const totalCost = allocatedMarkets.reduce((sum, m) => sum + m.cost_cents, 0);
    const totalUnits = allocatedMarkets.reduce((sum, m) => sum + m.units, 0);
    const totalPayout = totalUnits * 100;

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
    const orders = allocatedMarkets.map(am => ({
      batch_id: batch.id,
      ticker: am.market.ticker,
      event_ticker: am.market.event_ticker,
      title: am.market.title,
      side: am.side,
      price_cents: am.price_cents,
      units: am.units,
      cost_cents: am.cost_cents,
      potential_payout_cents: am.units * 100,
      open_interest: am.open_interest,
      volume_24h: am.volume_24h,
      market_close_time: am.market.close_time,
      placement_status: 'pending',
      placement_status_at: new Date().toISOString(),
      result_status: 'undecided',
      settlement_status: 'pending',
    }));

    const { error: ordersError } = await supabase.from('orders').insert(orders);
    if (ordersError) throw ordersError;

    return {
      date: targetDateStr,
      success: true,
      markets_found: dayMarkets.length,
      orders_prepared: allocatedMarkets.length,
      total_cost_dollars: (totalCost / 100).toFixed(2),
    };
  } catch (error) {
    return {
      date: targetDateStr,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// Debug endpoint to check what markets are available
export async function GET() {
  try {
    const sportsSeries = [
      'KXNBAGAME', 'KXNFLGAME', 'KXMLBGAME', 'KXNHLGAME',
      'KXNCAAMBGAME', 'KXNCAAWBGAME', 'KXNCAAFBGAME',
      'KXNCAAFCSGAME', 'KXNCAAFGAME',
      'KXEUROLEAGUEGAME', 'KXNBLGAME', 'KXCRICKETTESTMATCH',
      'KXEFLCHAMPIONSHIPGAME', 'KXDOTA2GAME', 'KXUFCFIGHT',
      'KXCRICKETT20IMATCH'
    ];

    const totalWindowHours = 22 * 24; // 22 days
    
    let allMarkets: KalshiMarket[] = [];
    for (const series of sportsSeries) {
      try {
        const markets = await getMarkets(200, totalWindowHours, 1, series);
        allMarkets.push(...markets);
      } catch (e) {
        // Skip if no markets
      }
    }

    // Group by close date
    const marketsByDay: Record<string, { count: number; tickers: string[] }> = {};
    for (const m of allMarkets) {
      const closeDate = new Date(m.close_time).toISOString().split('T')[0];
      if (!marketsByDay[closeDate]) {
        marketsByDay[closeDate] = { count: 0, tickers: [] };
      }
      marketsByDay[closeDate].count++;
      if (marketsByDay[closeDate].tickers.length < 3) {
        marketsByDay[closeDate].tickers.push(m.ticker);
      }
    }

    return NextResponse.json({
      success: true,
      total_markets: allMarkets.length,
      markets_by_date: marketsByDay,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const days = body.days || 7;
    const minOdds = body.minOdds || 0.85;
    const maxOdds = body.maxOdds || 0.995;
    const minOpenInterest = body.minOpenInterest || 100;

    // Get available balance
    let availableCapitalCents = 0;
    try {
      const balanceData = await kalshiFetch('/portfolio/balance');
      availableCapitalCents = balanceData?.balance || 0;
    } catch (e) {
      return NextResponse.json({ success: false, error: 'Failed to fetch balance' }, { status: 500 });
    }

    // Fetch markets with extended window to cover all future days
    // Base window is 15 days, plus the number of days we're preparing for
    const baseWindowDays = 15;
    const totalWindowHours = (baseWindowDays + days) * 24;
    
    const sportsSeries = [
      'KXNBAGAME', 'KXNFLGAME', 'KXMLBGAME', 'KXNHLGAME',
      'KXNCAAMBGAME', 'KXNCAAWBGAME', 'KXNCAAFBGAME',
      'KXNCAAFCSGAME', 'KXNCAAFGAME',
      'KXEUROLEAGUEGAME', 'KXNBLGAME', 'KXCRICKETTESTMATCH',
      'KXEFLCHAMPIONSHIPGAME', 'KXDOTA2GAME', 'KXUFCFIGHT',
      'KXCRICKETT20IMATCH'
    ];

    let allMarkets: KalshiMarket[] = [];
    for (const series of sportsSeries) {
      try {
        const markets = await getMarkets(200, totalWindowHours, 1, series);
        allMarkets.push(...markets);
      } catch (e) {
        // Skip if no markets
      }
    }

    // Prepare for each day
    const results: DayResult[] = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const targetDate = new Date(today);
      targetDate.setDate(targetDate.getDate() + i);
      const targetDateStr = targetDate.toISOString().split('T')[0];

      const result = await prepareForDay(
        targetDateStr,
        allMarkets,
        availableCapitalCents,
        minOdds,
        maxOdds,
        minOpenInterest
      );
      results.push(result);
    }

    const totalOrders = results.reduce((sum, r) => sum + (r.orders_prepared || 0), 0);
    const totalCost = results.reduce((sum, r) => sum + parseFloat(r.total_cost_dollars || '0'), 0);

    // Debug: Show market close time distribution
    const marketsByDay: Record<string, number> = {};
    for (const m of allMarkets) {
      const closeDate = new Date(m.close_time).toISOString().split('T')[0];
      marketsByDay[closeDate] = (marketsByDay[closeDate] || 0) + 1;
    }

    return NextResponse.json({
      success: true,
      summary: {
        days_prepared: days,
        total_orders: totalOrders,
        total_cost_dollars: totalCost.toFixed(2),
        available_capital_dollars: (availableCapitalCents / 100).toFixed(2),
        total_markets_fetched: allMarkets.length,
        fetch_window_hours: totalWindowHours,
      },
      debug: {
        markets_by_close_date: marketsByDay,
      },
      days: results,
    });
  } catch (error) {
    console.error('Error preparing week:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

