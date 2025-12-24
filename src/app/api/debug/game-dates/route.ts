import { NextResponse } from 'next/server';
import { getMarkets } from '@/lib/kalshi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Extract game date from expected_expiration_time
// Subtract 15 hours to account for: ET offset (5h) + game duration (4h) + settlement buffer (6h)
function extractGameDate(market: { expected_expiration_time?: string; close_time: string }): string | null {
  // Prefer expected_expiration_time (actual settlement time)
  if (market.expected_expiration_time) {
    const expirationTime = new Date(market.expected_expiration_time);
    const gameDate = new Date(expirationTime.getTime() - 15 * 60 * 60 * 1000);
    const year = gameDate.getUTCFullYear();
    const month = String(gameDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(gameDate.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  // Fallback: close_time - 15 days
  if (market.close_time) {
    const closeDate = new Date(market.close_time);
    closeDate.setDate(closeDate.getDate() - 15);
    return closeDate.toISOString().split('T')[0];
  }
  return null;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const maxCloseHours = parseInt(searchParams.get('maxCloseHours') || '504'); // 21 days default (games up to 7 days out)
    
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
      // Soccer (EFL only)
      'KXEFLCHAMPIONSHIPGAME',
      // Esports
      'KXDOTA2GAME'
    ];
    
    let allMarkets: any[] = [];
    const seriesResults: Record<string, number> = {};
    
    for (const series of sportsSeries) {
      try {
        const markets = await getMarkets(500, maxCloseHours, 1, series);
        seriesResults[series] = markets.length;
        allMarkets.push(...markets);
      } catch (e) {
        seriesResults[series] = 0;
      }
    }
    
    // Also fetch ALL open markets (no series filter) to see what's available
    let allOpenMarkets: any[] = [];
    try {
      allOpenMarkets = await getMarkets(200, maxCloseHours, 1);
    } catch (e) {
      console.error('Error fetching all markets:', e);
    }
    
    // Count by category for all markets
    const categoryCounts: Record<string, number> = {};
    for (const m of allOpenMarkets) {
      const cat = m.category || 'unknown';
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }
    
    // Group markets by game date
    const marketsByGameDate: Record<string, { count: number; sampleTickers: string[] }> = {};
    const tickersWithoutDate: string[] = [];
    
    for (const m of allMarkets) {
      const gameDate = extractGameDate(m);
      if (gameDate) {
        if (!marketsByGameDate[gameDate]) {
          marketsByGameDate[gameDate] = { count: 0, sampleTickers: [] };
        }
        marketsByGameDate[gameDate].count++;
        if (marketsByGameDate[gameDate].sampleTickers.length < 3) {
          marketsByGameDate[gameDate].sampleTickers.push(m.ticker);
        }
      } else {
        if (tickersWithoutDate.length < 10) {
          tickersWithoutDate.push(m.ticker);
        }
      }
    }
    
    // Sort by date
    const sortedGameDates = Object.entries(marketsByGameDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .reduce((acc, [date, data]) => {
        acc[date] = data;
        return acc;
      }, {} as Record<string, { count: number; sampleTickers: string[] }>);

    return NextResponse.json({
      success: true,
      total_sports_markets: allMarkets.length,
      total_all_markets: allOpenMarkets.length,
      max_close_hours_used: maxCloseHours,
      max_close_date: new Date(Date.now() + maxCloseHours * 60 * 60 * 1000).toISOString(),
      series_results: seriesResults,
      category_counts: categoryCounts,
      markets_by_game_date: sortedGameDates,
      tickers_without_date: tickersWithoutDate,
      sample_sports: allMarkets.slice(0, 5).map(m => ({
        ticker: m.ticker,
        title: m.title,
        close_time: m.close_time,
        expected_expiration_time: m.expected_expiration_time,
        extracted_game_date: extractGameDate(m)
      })),
      sample_all: allOpenMarkets.slice(0, 10).map(m => ({
        ticker: m.ticker,
        title: m.title,
        category: m.category,
        close_time: m.close_time,
        expected_expiration_time: m.expected_expiration_time,
        extracted_game_date: extractGameDate(m)
      }))
    });
  } catch (error) {
    console.error('Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

