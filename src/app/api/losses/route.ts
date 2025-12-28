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
    return null;
  }

  return response.json();
}

// Extract sport category from event ticker
function getSportFromTicker(eventTicker: string): string {
  if (eventTicker.startsWith('KXNFL') || eventTicker.startsWith('KXNCAAF')) return 'Football';
  if (eventTicker.startsWith('KXNBA') || eventTicker.startsWith('KXNCAAM') || eventTicker.startsWith('KXNCAAW') || eventTicker.startsWith('KXEUROLEAGUE') || eventTicker.startsWith('KXNBL')) return 'Basketball';
  if (eventTicker.startsWith('KXNHL')) return 'Hockey';
  if (eventTicker.startsWith('KXMLB')) return 'Baseball';
  if (eventTicker.startsWith('KXUFC')) return 'MMA';
  if (eventTicker.startsWith('KXTENNIS') || eventTicker.startsWith('KXATP') || eventTicker.startsWith('KXWTA')) return 'Tennis';
  if (eventTicker.startsWith('KXPGA') || eventTicker.startsWith('KXLPGA') || eventTicker.startsWith('KXGOLF')) return 'Golf';
  if (eventTicker.startsWith('KXF1') || eventTicker.startsWith('KXNASCAR') || eventTicker.startsWith('KXINDYCAR')) return 'Motorsport';
  if (eventTicker.startsWith('KXCRICKET')) return 'Cricket';
  if (eventTicker.startsWith('KXCHESS')) return 'Chess';
  if (eventTicker.startsWith('KXDOTA')) return 'Esports';
  return 'Other';
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

        // Calculate details
        const batchDate = order.order_batches?.batch_date || order.created_at?.split('T')[0];
        const sport = getSportFromTicker(order.event_ticker || '');
        const dayOfWeek = getDayOfWeek(batchDate);
        
        // Our entry price
        const entryPriceCents = order.executed_price_cents || order.price_cents;
        
        // Final result (market closed at 0 for our side since we lost)
        const exitPriceCents = 0; // We lost, so our side settled at 0
        
        // Loss amount
        const lostCents = order.executed_cost_cents || order.cost_cents;

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
          sport,
          day_of_week: dayOfWeek,
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
          // Calculate implied odds we paid
          implied_odds_percent: entryPriceCents,
        };
      })
    );

    // Calculate summary statistics
    const totalLostCents = enrichedLosses.reduce((sum, l) => sum + l.cost_cents, 0);
    const avgOdds = enrichedLosses.reduce((sum, l) => sum + l.implied_odds_percent, 0) / enrichedLosses.length;

    // Group by sport
    const bySport: Record<string, { count: number; lost_cents: number; avg_odds: number }> = {};
    for (const loss of enrichedLosses) {
      if (!bySport[loss.sport]) {
        bySport[loss.sport] = { count: 0, lost_cents: 0, avg_odds: 0 };
      }
      bySport[loss.sport].count++;
      bySport[loss.sport].lost_cents += loss.cost_cents;
      bySport[loss.sport].avg_odds += loss.implied_odds_percent;
    }
    // Calculate averages
    for (const sport of Object.keys(bySport)) {
      bySport[sport].avg_odds = Math.round(bySport[sport].avg_odds / bySport[sport].count);
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

    // Group by odds range
    const byOddsRange: Record<string, { count: number; lost_cents: number }> = {
      '90-92%': { count: 0, lost_cents: 0 },
      '92-94%': { count: 0, lost_cents: 0 },
      '94-96%': { count: 0, lost_cents: 0 },
      '96-98%': { count: 0, lost_cents: 0 },
      '98-100%': { count: 0, lost_cents: 0 },
      '<90%': { count: 0, lost_cents: 0 },
    };
    for (const loss of enrichedLosses) {
      const odds = loss.implied_odds_percent;
      let range = '<90%';
      if (odds >= 98) range = '98-100%';
      else if (odds >= 96) range = '96-98%';
      else if (odds >= 94) range = '94-96%';
      else if (odds >= 92) range = '92-94%';
      else if (odds >= 90) range = '90-92%';
      
      byOddsRange[range].count++;
      byOddsRange[range].lost_cents += loss.cost_cents;
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

    return NextResponse.json({
      success: true,
      losses: enrichedLosses,
      summary: {
        total_losses: enrichedLosses.length,
        total_lost_cents: totalLostCents,
        avg_odds: Math.round(avgOdds),
        by_sport: bySport,
        by_day_of_week: byDayOfWeek,
        by_odds_range: byOddsRange,
        by_month: byMonth,
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

