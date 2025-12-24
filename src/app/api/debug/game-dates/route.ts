import { NextResponse } from 'next/server';
import { getMarkets } from '@/lib/kalshi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Game date = close_time - 14 days (markets close 14 days after game)
function extractGameDate(closeTime: string): string | null {
  if (!closeTime) return null;
  const closeDate = new Date(closeTime);
  closeDate.setDate(closeDate.getDate() - 14);
  return closeDate.toISOString().split('T')[0];
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const maxCloseHours = parseInt(searchParams.get('maxCloseHours') || '336'); // 14 days default
    
    const sportsSeries = [
      'KXNBAGAME', 'KXNFLGAME', 'KXMLBGAME', 'KXNHLGAME',
      'KXNCAAMBGAME', 'KXNCAAWBGAME', 'KXNCAAFBGAME',
      'KXEUROLEAGUEGAME', 'KXNBLGAME', 'KXCRICKETTESTMATCH',
      'KXCRICKETT20IMATCH', 'KXUFCFIGHT'
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
    
    // Group markets by game date
    const marketsByGameDate: Record<string, { count: number; sampleTickers: string[] }> = {};
    const tickersWithoutDate: string[] = [];
    
    for (const m of allMarkets) {
      const gameDate = extractGameDate(m.close_time);
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
      total_markets: allMarkets.length,
      max_close_hours_used: maxCloseHours,
      series_results: seriesResults,
      markets_by_game_date: sortedGameDates,
      tickers_without_date: tickersWithoutDate,
      sample_tickers: allMarkets.slice(0, 5).map(m => ({
        ticker: m.ticker,
        title: m.title,
        close_time: m.close_time,
        extracted_game_date: extractGameDate(m.close_time)
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

