import { NextResponse } from 'next/server';
import { getMarkets, getMarketOdds, KalshiMarket } from '@/lib/kalshi';

// Force Node.js runtime for crypto module
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow up to 60 seconds for fetching

// Sports series we track
const SPORTS_SERIES = [
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

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const minOdds = parseFloat(searchParams.get('minOdds') || '0.85');
    const maxOdds = parseFloat(searchParams.get('maxOdds') || '0.995');
    const maxCloseHours = parseInt(searchParams.get('maxCloseHours') || '504'); // 21 days
    const category = searchParams.get('category') || 'sports';
    
    // Step 1: Fetch ALL open markets from Kalshi (no filters except max_close_ts)
    // Use limit=1000 (Kalshi's max) and fetch multiple pages
    const rawMarkets = await getMarkets(1000, maxCloseHours, 20);
    
    // Step 2: Filter to sports markets (client-side)
    let sportsMarkets: KalshiMarket[];
    if (category?.toLowerCase() === 'sports') {
      sportsMarkets = rawMarkets.filter(m => 
        SPORTS_SERIES.some(series => m.event_ticker.startsWith(series))
      );
    } else {
      sportsMarkets = rawMarkets;
    }
    
    // Step 3: Enrich ALL sports markets with calculated odds
    const enrichedAll = sportsMarkets.map((market) => {
      const odds = getMarketOdds(market);
      return {
        ...market,
        calculated_odds: odds,
        favorite_side: odds.yes >= odds.no ? 'YES' : 'NO',
        favorite_odds: Math.max(odds.yes, odds.no),
      };
    });
    
    // Step 4: Filter to high-odds markets
    const highOddsMarkets = enrichedAll.filter(m => 
      m.favorite_odds >= minOdds && m.favorite_odds <= maxOdds
    );

    // Sort by open interest (most liquid first)
    highOddsMarkets.sort((a, b) => b.open_interest - a.open_interest);

    return NextResponse.json({
      success: true,
      raw_markets_fetched: rawMarkets.length,
      total_markets: sportsMarkets.length,  // All sports markets (before odds filter)
      high_odds_count: highOddsMarkets.length,
      min_odds_filter: minOdds,
      max_odds_filter: maxOdds,
      markets: enrichedAll,  // Return ALL enriched markets, let frontend filter by odds
    });
  } catch (error) {
    console.error('Error fetching markets:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
