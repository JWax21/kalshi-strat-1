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
    const maxCloseHours = parseInt(searchParams.get('maxCloseHours') || '720'); // 30 days
    const category = searchParams.get('category') || 'sports';
    
    // Step 1: Fetch sports markets BY SERIES (more reliable than bulk fetch)
    // Bulk fetch misses some series like NBA
    let sportsMarkets: KalshiMarket[] = [];
    const seriesResults: Record<string, number> = {};
    
    if (category?.toLowerCase() === 'sports') {
      // Fetch each sports series individually
      for (const series of SPORTS_SERIES) {
        try {
          const markets = await getMarkets(500, maxCloseHours, 2, series);
          seriesResults[series] = markets.length;
          sportsMarkets.push(...markets);
        } catch (e) {
          seriesResults[series] = 0;
        }
      }
    } else {
      // For non-sports, use bulk fetch
      sportsMarkets = await getMarkets(1000, maxCloseHours, 20);
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
      total_markets: sportsMarkets.length,  // All sports markets (before odds filter)
      high_odds_count: highOddsMarkets.length,
      min_odds_filter: minOdds,
      max_odds_filter: maxOdds,
      series_results: seriesResults,  // Debug: show counts per series
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
