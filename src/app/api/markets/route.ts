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

    const pages = parseInt(searchParams.get('pages') || '30'); // Increased to get more markets
    const category = searchParams.get('category') || undefined;
    
    // Fetch ALL open markets and filter client-side for sports
    // This avoids issues with series_ticker filter not working properly
    let allMarkets = await getMarkets(limit, maxCloseHours, pages);
    
    // If sports category requested, filter to known sports series
    if (category?.toLowerCase() === 'sports') {
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
      
      // Filter to sports markets only (check if event_ticker starts with any series)
      allMarkets = allMarkets.filter(m => 
        sportsSeries.some(series => m.event_ticker.startsWith(series))
      );
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

