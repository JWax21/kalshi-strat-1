import { NextResponse } from 'next/server';
import { getMarkets, filterHighOddsMarkets, getMarketOdds } from '@/lib/kalshi';

// Force Node.js runtime for crypto module
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const minOdds = parseFloat(searchParams.get('minOdds') || '0.92');
    const maxOdds = parseFloat(searchParams.get('maxOdds') || '0.995');
    const limit = parseInt(searchParams.get('limit') || '1000');
    const maxCloseHours = parseInt(searchParams.get('maxCloseHours') || '504'); // 21 days (games up to 7 days out)

    const pages = parseInt(searchParams.get('pages') || '15');
    const category = searchParams.get('category') || undefined;
    
    let allMarkets: Awaited<ReturnType<typeof getMarkets>> = [];
    
    // For sports, fetch from multiple known sports series_tickers
    if (category?.toLowerCase() === 'sports') {
      const sportsSeries = [
        'KXNBAGAME', 'KXNFLGAME', 'KXMLBGAME', 'KXNHLGAME',
        'KXNCAAMBGAME', 'KXNCAAWBGAME', 'KXNCAAFBGAME',
        'KXNCAAFCSGAME', 'KXNCAAFGAME',
        'KXEUROLEAGUEGAME', 'KXNBLGAME', 'KXCRICKETTESTMATCH',
        'KXCRICKETT20IMATCH', 'KXEFLCHAMPIONSHIPGAME', 'KXDOTA2GAME', 'KXUFCFIGHT'
      ];
      
      // Fetch from each series with larger limit for 14-day window
      for (const series of sportsSeries) {
        try {
          const markets = await getMarkets(500, maxCloseHours, 1, series);
          allMarkets.push(...markets);
        } catch (e) {
          console.log(`No markets for ${series}`);
        }
      }
    } else {
      allMarkets = await getMarkets(limit, maxCloseHours, pages);
    }
    
    const highOddsMarkets = filterHighOddsMarkets(allMarkets, minOdds, maxOdds);

    const enrichedMarkets = highOddsMarkets.map((market) => {
      const odds = getMarketOdds(market);
      return {
        ...market,
        calculated_odds: odds,
        favorite_side: odds.yes >= odds.no ? 'YES' : 'NO',
        favorite_odds: Math.max(odds.yes, odds.no),
      };
    });

    enrichedMarkets.sort((a, b) => b.open_interest - a.open_interest);

    return NextResponse.json({
      success: true,
      total_markets: allMarkets.length,
      high_odds_count: enrichedMarkets.length,
      min_odds_filter: minOdds,
      max_odds_filter: maxOdds,
      markets: enrichedMarkets,
    });
  } catch (error) {
    console.error('Error fetching markets:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

