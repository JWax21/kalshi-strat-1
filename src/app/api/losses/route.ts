import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
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

  const fullUrl = `${KALSHI_CONFIG.baseUrl}${endpoint}`;
  const response = await fetch(fullUrl, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': KALSHI_CONFIG.apiKey,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown');
    console.error(`[kalshiFetch] Error ${response.status} for ${endpoint}: ${errorText}`);
    return null;
  }

  return response.json();
}

// Extract specific league from event ticker
function getLeagueFromTicker(eventTicker: string): string {
  // Football
  if (eventTicker.startsWith('KXNFLGAME')) return 'NFL';
  if (eventTicker.startsWith('KXNCAAFBGAME') || eventTicker.startsWith('KXNCAAFCSGAME') || eventTicker.startsWith('KXNCAAFGAME')) return 'NCAAF';
  
  // Basketball
  if (eventTicker.startsWith('KXNBAGAME')) return 'NBA';
  if (eventTicker.startsWith('KXNCAAMBGAME')) return 'NCAAM';
  if (eventTicker.startsWith('KXNCAAWBGAME')) return 'NCAAW';
  if (eventTicker.startsWith('KXEUROLEAGUEGAME')) return 'EuroLeague';
  if (eventTicker.startsWith('KXNBLGAME')) return 'NBL';
  
  // Hockey
  if (eventTicker.startsWith('KXNHLGAME')) return 'NHL';
  
  // Baseball
  if (eventTicker.startsWith('KXMLBGAME')) return 'MLB';
  
  // MMA
  if (eventTicker.startsWith('KXUFCFIGHT')) return 'UFC';
  
  // Tennis
  if (eventTicker.startsWith('KXTENNISMATCH')) return 'Tennis';
  if (eventTicker.startsWith('KXATPTOUR')) return 'ATP';
  if (eventTicker.startsWith('KXWTATOUR')) return 'WTA';
  
  // Golf
  if (eventTicker.startsWith('KXPGATOUR')) return 'PGA';
  if (eventTicker.startsWith('KXLPGATOUR')) return 'LPGA';
  if (eventTicker.startsWith('KXGOLFTOURNAMENT')) return 'Golf';
  
  // Motorsport
  if (eventTicker.startsWith('KXF1RACE')) return 'F1';
  if (eventTicker.startsWith('KXNASCARRACE')) return 'NASCAR';
  if (eventTicker.startsWith('KXINDYCARRACE')) return 'IndyCar';
  
  // Other
  if (eventTicker.startsWith('KXCRICKET')) return 'Cricket';
  if (eventTicker.startsWith('KXCHESSMATCH')) return 'Chess';
  if (eventTicker.startsWith('KXDOTA2GAME')) return 'Dota2';
  
  return 'Other';
}

// Determine if bet was placed pre-game or live
// Returns 'pre-game', 'live', or 'unknown'
function getBetTiming(placementTime: string | null, marketCloseTime: string | null): 'pre-game' | 'live' | 'unknown' {
  if (!placementTime || !marketCloseTime) return 'unknown';
  
  const placementDate = new Date(placementTime);
  const closeDate = new Date(marketCloseTime);
  
  // Calculate hours before market close
  const hoursBeforeClose = (closeDate.getTime() - placementDate.getTime()) / (1000 * 60 * 60);
  
  // Typical game durations (approximate):
  // NFL/NCAAF: ~3.5 hours
  // NBA/NCAAM: ~2.5 hours
  // NHL: ~2.5 hours
  // MLB: ~3 hours
  // UFC fights: ~0.5 hours per fight
  // Tennis: varies widely
  
  // If placed more than 6 hours before close, definitely pre-game
  // If placed less than 5 hours before close, likely during game (live)
  // In between is ambiguous
  
  if (hoursBeforeClose > 6) {
    return 'pre-game';
  } else if (hoursBeforeClose < 5 && hoursBeforeClose > 0) {
    return 'live';
  } else if (hoursBeforeClose <= 0) {
    // Placed after close time means something is off, but likely was live
    return 'live';
  }
  
  return 'unknown';
}

// Get day of week from date string
function getDayOfWeek(dateStr: string): string {
  const date = new Date(dateStr + 'T12:00:00');
  return date.toLocaleDateString('en-US', { weekday: 'long' });
}

// GET - Fetch all losses with detailed analysis
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '90');

    // Get all lost orders
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data: lostOrders, error } = await supabase
      .from('orders')
      .select('*, order_batches(batch_date)')
      .eq('result_status', 'lost')
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Get all decided orders (won + lost) to calculate stats by league, open interest, odds range, and venue
    const { data: allDecidedOrders, error: allError } = await supabase
      .from('orders')
      .select('event_ticker, result_status, open_interest, executed_price_cents, price_cents, title, side, units, executed_cost_cents, cost_cents, potential_payout_cents')
      .in('result_status', ['won', 'lost'])
      .gte('created_at', startDate.toISOString());

    if (allError) throw allError;

    // First, aggregate orders by event to count unique games (not individual orders)
    const eventAggregates: Record<string, { 
      event_ticker: string;
      result_status: string;
      total_cost: number;
      total_payout: number;
      total_units: number;
      order_count: number;
      open_interest: number;
      title: string;
      side: string;
    }> = {};
    
    for (const order of allDecidedOrders || []) {
      const eventKey = order.event_ticker || order.title || 'unknown';
      const price = order.executed_price_cents || order.price_cents || 0;
      const units = order.units || 1;
      const cost = order.executed_cost_cents || order.cost_cents || (price * units);
      const payout = order.potential_payout_cents || (units * 100);
      
      if (!eventAggregates[eventKey]) {
        eventAggregates[eventKey] = {
          event_ticker: order.event_ticker || '',
          result_status: order.result_status || '',
          total_cost: 0,
          total_payout: 0,
          total_units: 0,
          order_count: 0,
          open_interest: order.open_interest || 0,
          title: order.title || '',
          side: order.side || '',
        };
      }
      eventAggregates[eventKey].total_cost += cost;
      eventAggregates[eventKey].total_payout += payout;
      eventAggregates[eventKey].total_units += units;
      eventAggregates[eventKey].order_count++;
    }
    
    // Convert to array of unique events
    const uniqueEvents = Object.values(eventAggregates);

    // Pre-calculate stats by league (counting unique games, not orders)
    // Use cost-weighted average: total_cost / total_units gives true avg price per unit
    const statsByLeague: Record<string, { wins: number; losses: number; total: number; total_cost: number; total_units: number; total_pnl_cents: number }> = {};
    for (const event of uniqueEvents) {
      const league = getLeagueFromTicker(event.event_ticker || '');
      if (!statsByLeague[league]) {
        statsByLeague[league] = { wins: 0, losses: 0, total: 0, total_cost: 0, total_units: 0, total_pnl_cents: 0 };
      }
      statsByLeague[league].total++;
      statsByLeague[league].total_cost += event.total_cost;
      statsByLeague[league].total_units += event.total_units;
      if (event.result_status === 'won') {
        statsByLeague[league].wins++;
        statsByLeague[league].total_pnl_cents += (event.total_payout - event.total_cost);
      } else {
        statsByLeague[league].losses++;
        statsByLeague[league].total_pnl_cents -= event.total_cost;
      }
    }

    // Pre-calculate stats by open interest range (counting unique games)
    const oiRanges = {
      '1K-10K': { min: 1000, max: 10000 },
      '10K-100K': { min: 10000, max: 100000 },
      '100K-1M': { min: 100000, max: 1000000 },
      '1M+': { min: 1000000, max: Infinity },
    };
    const statsByOI: Record<string, { wins: number; losses: number; total: number; total_cost: number; total_units: number; total_pnl_cents: number }> = {};
    for (const range of Object.keys(oiRanges)) {
      statsByOI[range] = { wins: 0, losses: 0, total: 0, total_cost: 0, total_units: 0, total_pnl_cents: 0 };
    }
    for (const event of uniqueEvents) {
      const oi = event.open_interest || 0;
      let rangeKey: string | null = null;
      for (const [key, { min, max }] of Object.entries(oiRanges)) {
        if (oi >= min && oi < max) {
          rangeKey = key;
          break;
        }
      }
      if (rangeKey) {
        statsByOI[rangeKey].total++;
        statsByOI[rangeKey].total_cost += event.total_cost;
        statsByOI[rangeKey].total_units += event.total_units;
        if (event.result_status === 'won') {
          statsByOI[rangeKey].wins++;
          statsByOI[rangeKey].total_pnl_cents += (event.total_payout - event.total_cost);
        } else {
          statsByOI[rangeKey].losses++;
          statsByOI[rangeKey].total_pnl_cents -= event.total_cost;
        }
      }
    }

    // Pre-calculate stats by odds range (counting unique games)
    // Use cost-weighted average price for categorization: total_cost / total_units
    const statsByOddsRange: Record<string, { wins: number; losses: number; total: number; total_cost: number; total_units: number; total_pnl_cents: number }> = {
      '90-92%': { wins: 0, losses: 0, total: 0, total_cost: 0, total_units: 0, total_pnl_cents: 0 },
      '92-94%': { wins: 0, losses: 0, total: 0, total_cost: 0, total_units: 0, total_pnl_cents: 0 },
      '94-96%': { wins: 0, losses: 0, total: 0, total_cost: 0, total_units: 0, total_pnl_cents: 0 },
      '96-98%': { wins: 0, losses: 0, total: 0, total_cost: 0, total_units: 0, total_pnl_cents: 0 },
      '98-100%': { wins: 0, losses: 0, total: 0, total_cost: 0, total_units: 0, total_pnl_cents: 0 },
      '<90%': { wins: 0, losses: 0, total: 0, total_cost: 0, total_units: 0, total_pnl_cents: 0 },
    };
    for (const event of uniqueEvents) {
      // Cost-weighted average price for this event
      const avgPrice = event.total_units > 0 ? event.total_cost / event.total_units : 0;
      let range = '<90%';
      if (avgPrice >= 98) range = '98-100%';
      else if (avgPrice >= 96) range = '96-98%';
      else if (avgPrice >= 94) range = '94-96%';
      else if (avgPrice >= 92) range = '92-94%';
      else if (avgPrice >= 90) range = '90-92%';
      
      statsByOddsRange[range].total++;
      statsByOddsRange[range].total_cost += event.total_cost;
      statsByOddsRange[range].total_units += event.total_units;
      if (event.result_status === 'won') {
        statsByOddsRange[range].wins++;
        statsByOddsRange[range].total_pnl_cents += (event.total_payout - event.total_cost);
      } else {
        statsByOddsRange[range].losses++;
        statsByOddsRange[range].total_pnl_cents -= event.total_cost;
      }
    }

    // Pre-calculate stats by venue (counting unique games)
    const statsByVenue: Record<string, { wins: number; losses: number; total: number; total_cost: number; total_units: number; total_pnl_cents: number }> = {
      'home': { wins: 0, losses: 0, total: 0, total_cost: 0, total_units: 0, total_pnl_cents: 0 },
      'away': { wins: 0, losses: 0, total: 0, total_cost: 0, total_units: 0, total_pnl_cents: 0 },
      'neutral': { wins: 0, losses: 0, total: 0, total_cost: 0, total_units: 0, total_pnl_cents: 0 },
    };
    for (const event of uniqueEvents) {
      // Determine home/away status
      let venue: 'home' | 'away' | 'neutral' = 'neutral';
      const atMatch = event.title?.match(/^(.+?)\s+at\s+(.+?)\s+Winner\?$/i);
      const vsMatch = event.title?.match(/^(.+?)\s+vs\s+(.+?)\s+Winner\?$/i);
      
      if (atMatch) {
        venue = event.side === 'YES' ? 'away' : 'home';
      } else if (vsMatch) {
        venue = event.side === 'YES' ? 'home' : 'away';
      }
      
      statsByVenue[venue].total++;
      statsByVenue[venue].total_cost += event.total_cost;
      statsByVenue[venue].total_units += event.total_units;
      if (event.result_status === 'won') {
        statsByVenue[venue].wins++;
        statsByVenue[venue].total_pnl_cents += (event.total_payout - event.total_cost);
      } else {
        statsByVenue[venue].losses++;
        statsByVenue[venue].total_pnl_cents -= event.total_cost;
      }
    }

    if (!lostOrders || lostOrders.length === 0) {
      return NextResponse.json({
        success: true,
        losses: [],
        summary: {
          total_losses: 0,
          total_lost_cents: 0,
          by_sport: {},
          by_day_of_week: {},
          by_odds_range: {},
          avg_odds: 0,
        },
      });
    }

    // Enrich each loss with market data from Kalshi
    const enrichedLosses = await Promise.all(
      lostOrders.slice(0, 50).map(async (order) => {
        // Try to get market history/details from Kalshi
        let marketData = null;
        let tradeHistory: any[] = [];
        
        try {
          // Get market details
          const marketResponse = await kalshiFetch(`/markets/${order.ticker}`);
          marketData = marketResponse?.market;
          
          // Small delay to avoid rate limits
          await new Promise(r => setTimeout(r, 100));
        } catch (e) {
          // Market may be closed/delisted
        }

        // Try to get our fills for this ticker
        let fills: any[] = [];
        try {
          const fillsResponse = await kalshiFetch(`/portfolio/fills?ticker=${order.ticker}`);
          fills = fillsResponse?.fills || [];
        } catch (e) {
          // No fills found
        }

        // Try to get candlestick data for price history
        // API: /series/{series_ticker}/markets/{ticker}/candlesticks with start_ts, end_ts, period_interval
        let candlesticks: { ts: string; open: number; high: number; low: number; close: number }[] = [];
        let maxPriceSeen = 0; // Track the highest price seen
        let minPriceSeen = 100; // Track the lowest price seen
        try {
          // Extract series_ticker from event_ticker (e.g., KXNBAGAME-25DEC26BOSIND -> KXNBAGAME)
          // or from market data if available
          const seriesTicker = marketData?.series_ticker || order.event_ticker?.split('-')[0] || '';
          const marketTicker = order.ticker; // The full market ticker
          
          // Calculate time range based on when the order was placed and when market closed
          // Use placement time as reference point to get price history during the trade
          const placementTime = order.placement_status_at 
            ? Math.floor(new Date(order.placement_status_at).getTime() / 1000)
            : null;
          const closeTime = order.market_close_time 
            ? Math.floor(new Date(order.market_close_time).getTime() / 1000)
            : Math.floor(Date.now() / 1000);
          
          // Get data from 2 hours before placement to market close
          const startTs = placementTime ? placementTime - (2 * 60 * 60) : closeTime - (48 * 60 * 60);
          const endTs = closeTime;
          
          console.log(`[Candlestick] Fetching for ${marketTicker}, series=${seriesTicker}, start=${startTs}, end=${endTs}`);
          
          if (seriesTicker && marketTicker) {
            // Use 1-minute candlesticks for accurate min/max price detection
            const url = `/series/${seriesTicker}/markets/${marketTicker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`;
            console.log(`[Candlestick] URL: ${url}`);
            
            const candlestickResponse = await kalshiFetch(url);
            
            console.log(`[Candlestick] Response for ${marketTicker}:`, 
              candlestickResponse ? `${candlestickResponse.candlesticks?.length || 0} candles` : 'null');
            
            if (candlestickResponse?.candlesticks && candlestickResponse.candlesticks.length > 0) {
              // Candlestick data is for YES side - we need to convert for user's actual side
              const userSide = order.side; // 'YES' or 'NO'
              
              candlesticks = candlestickResponse.candlesticks.map((c: any) => {
                const yesOpen = c.price?.open ?? c.yes_bid?.open ?? 0;
                const yesHigh = c.price?.high ?? c.price?.max ?? c.yes_bid?.high ?? 0;
                const yesLow = c.price?.low ?? c.price?.min ?? c.yes_bid?.low ?? 0;
                const yesClose = c.price?.close ?? c.yes_bid?.close ?? 0;
                
                if (userSide === 'YES') {
                  return { ts: String(c.end_period_ts), open: yesOpen, high: yesHigh, low: yesLow, close: yesClose };
                } else {
                  // For NO side: our price = 100 - YES price
                  // Our high = 100 - YES low (when YES is lowest, NO is highest)
                  // Our low = 100 - YES high (when YES is highest, NO is lowest)
                  return {
                    ts: String(c.end_period_ts),
                    open: yesOpen > 0 ? 100 - yesOpen : 0,
                    high: yesLow > 0 ? 100 - yesLow : 0,  // Our high is when YES was at its LOW
                    low: yesHigh > 0 ? 100 - yesHigh : 0, // Our low is when YES was at its HIGH
                    close: yesClose > 0 ? 100 - yesClose : 0,
                  };
                }
              }).filter((c: any) => c.open > 0 || c.close > 0);
              
              // Calculate max and min from all candles (now correctly for user's side)
              for (const c of candlesticks) {
                if (c.high > maxPriceSeen) maxPriceSeen = c.high;
                if (c.low < minPriceSeen && c.low > 0) minPriceSeen = c.low;
              }
              console.log(`[Candlestick] Parsed ${candlesticks.length} candles for ${userSide} side, max=${maxPriceSeen}, min=${minPriceSeen}`);
            }
          }
          await new Promise(r => setTimeout(r, 50)); // Rate limit
        } catch (e) {
          console.error(`[Candlestick] Fetch error for ${order.ticker}:`, e);
        }

        // Calculate details
        const batchDate = order.order_batches?.batch_date || order.created_at?.split('T')[0];
        const league = getLeagueFromTicker(order.event_ticker || '');
        const dayOfWeek = getDayOfWeek(batchDate);
        const betTiming = getBetTiming(order.placement_status_at, order.market_close_time);
        
        // Our entry price
        const entryPriceCents = order.executed_price_cents || order.price_cents;
        
        // Final result (market closed at 0 for our side since we lost)
        const exitPriceCents = 0; // We lost, so our side settled at 0
        
        // Loss amount
        const lostCents = order.executed_cost_cents || order.cost_cents;

        // Determine home/away status
        // Format: "Team A at Team B Winner?" - Team A is AWAY, Team B is HOME
        // Format: "Team A vs Team B Winner?" - Team A is typically HOME
        let venue: 'home' | 'away' | 'neutral' = 'neutral';
        const atMatch = order.title?.match(/^(.+?)\s+at\s+(.+?)\s+Winner\?$/i);
        const vsMatch = order.title?.match(/^(.+?)\s+vs\s+(.+?)\s+Winner\?$/i);
        
        if (atMatch) {
          // "at" format: first team is away, second is home
          // If we bet YES, we bet on first team (away)
          // If we bet NO, we bet on second team (home)
          venue = order.side === 'YES' ? 'away' : 'home';
        } else if (vsMatch) {
          // "vs" format: first team is typically home
          venue = order.side === 'YES' ? 'home' : 'away';
        }

        return {
          id: order.id,
          ticker: order.ticker,
          event_ticker: order.event_ticker,
          title: order.title,
          side: order.side,
          units: order.units,
          entry_price_cents: entryPriceCents,
          exit_price_cents: exitPriceCents,
          cost_cents: lostCents,
          potential_payout_cents: order.potential_payout_cents,
          batch_date: batchDate,
          market_close_time: order.market_close_time,
          result_status_at: order.result_status_at,
          placement_status_at: order.placement_status_at,
          league,
          day_of_week: dayOfWeek,
          venue,
          bet_timing: betTiming,
          open_interest: order.open_interest || 0,
          // Market data if available
          market_result: marketData?.result,
          market_status: marketData?.status,
          // Our fills
          fills: fills.map(f => ({
            price: f.price,
            count: f.count,
            created_time: f.created_time,
            side: f.side,
          })),
          // Candlestick price history
          candlesticks,
          // Max/min prices seen (for stop-loss analysis)
          max_price_cents: maxPriceSeen > 0 ? maxPriceSeen : null,
          min_price_cents: minPriceSeen < 100 ? minPriceSeen : null,
          // Calculate implied odds we paid
          implied_odds_percent: entryPriceCents,
        };
      })
    );

    // Calculate summary statistics
    const totalLostCents = enrichedLosses.reduce((sum, l) => sum + l.cost_cents, 0);
    const avgOdds = enrichedLosses.reduce((sum, l) => sum + l.implied_odds_percent, 0) / enrichedLosses.length;

    // Count unique lost events
    const uniqueLostEvents = new Set(enrichedLosses.map(l => l.event_ticker)).size;

    // Add lost_cents to stats by league (from enrichedLosses)
    for (const loss of enrichedLosses) {
      if (statsByLeague[loss.league]) {
        // lost_cents tracking if needed later
      }
    }

    // Group by day of week
    const byDayOfWeek: Record<string, { count: number; lost_cents: number }> = {};
    for (const loss of enrichedLosses) {
      if (!byDayOfWeek[loss.day_of_week]) {
        byDayOfWeek[loss.day_of_week] = { count: 0, lost_cents: 0 };
      }
      byDayOfWeek[loss.day_of_week].count++;
      byDayOfWeek[loss.day_of_week].lost_cents += loss.cost_cents;
    }

    // Group by month
    const byMonth: Record<string, { count: number; lost_cents: number }> = {};
    for (const loss of enrichedLosses) {
      const month = loss.batch_date?.substring(0, 7) || 'Unknown';
      if (!byMonth[month]) {
        byMonth[month] = { count: 0, lost_cents: 0 };
      }
      byMonth[month].count++;
      byMonth[month].lost_cents += loss.cost_cents;
    }

    // Find patterns - most common losing scenarios
    const titlePatterns: Record<string, number> = {};
    for (const loss of enrichedLosses) {
      // Extract pattern from title (e.g., "Team A vs Team B Winner?")
      const match = loss.title?.match(/(.+?)\s+(?:at|vs)\s+(.+?)\s+Winner\?/i);
      if (match) {
        const losingTeam = loss.side === 'YES' ? match[1] : match[2];
        if (!titlePatterns[losingTeam]) titlePatterns[losingTeam] = 0;
        titlePatterns[losingTeam]++;
      }
    }

    // Sort patterns by frequency
    const topLosingTeams = Object.entries(titlePatterns)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([team, count]) => ({ team, count }));

    // Group by bet timing (pre-game vs live)
    const byTiming: Record<string, { count: number; lost_cents: number }> = {
      'pre-game': { count: 0, lost_cents: 0 },
      'live': { count: 0, lost_cents: 0 },
      'unknown': { count: 0, lost_cents: 0 },
    };
    for (const loss of enrichedLosses) {
      byTiming[loss.bet_timing].count++;
      byTiming[loss.bet_timing].lost_cents += loss.cost_cents;
    }

    return NextResponse.json({
      success: true,
      losses: enrichedLosses,
      summary: {
        total_losses: uniqueLostEvents, // Count unique events, not orders
        total_lost_cents: totalLostCents,
        avg_odds: Math.round(avgOdds),
        by_league: statsByLeague,
        by_day_of_week: byDayOfWeek,
        by_odds_range: statsByOddsRange,
        by_month: byMonth,
        by_venue: statsByVenue,
        by_timing: byTiming,
        by_open_interest: statsByOI,
        top_losing_teams: topLosingTeams,
      },
    });
  } catch (error) {
    console.error('Error fetching losses:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

