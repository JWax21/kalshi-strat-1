import { NextResponse } from 'next/server';
import { getMarkets, filterHighOddsMarkets, getMarketOdds, KalshiMarket } from '@/lib/kalshi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const hours = parseInt(searchParams.get('hours') || '48');
    
    const sportsSeries = [
      'KXNBAGAME', 'KXNFLGAME', 'KXMLBGAME', 'KXNHLGAME',
      'KXNCAAMBGAME', 'KXNCAAWBGAME', 'KXNCAAFBGAME',
    ];

    const seriesResults: any[] = [];
    let allMarkets: KalshiMarket[] = [];

    for (const series of sportsSeries) {
      try {
        const markets = await getMarkets(200, hours, 1, series);
        allMarkets.push(...markets);
        seriesResults.push({ series, count: markets.length });
      } catch (e) {
        seriesResults.push({ series, count: 0, error: String(e) });
      }
    }

    // Apply filters step by step
    const oddsFiltered = filterHighOddsMarkets(allMarkets, 0.85, 0.995);
    const oiFiltered = oddsFiltered.filter(m => m.open_interest >= 1000);
    const oiFilteredLow = oddsFiltered.filter(m => m.open_interest >= 100);

    // Get sample of markets with their odds
    const sampleMarkets = allMarkets.slice(0, 10).map(m => {
      const odds = getMarketOdds(m);
      return {
        ticker: m.ticker,
        title: m.title?.substring(0, 50),
        close_time: m.close_time,
        open_interest: m.open_interest,
        yes_odds: (odds.yes * 100).toFixed(1) + '%',
        no_odds: (odds.no * 100).toFixed(1) + '%',
        favorite_odds: (Math.max(odds.yes, odds.no) * 100).toFixed(1) + '%',
      };
    });

    // Check if any markets pass different OI thresholds
    const oiThresholds = [0, 100, 500, 1000, 5000];
    const oiBreakdown = oiThresholds.map(threshold => ({
      min_oi: threshold,
      count: oddsFiltered.filter(m => m.open_interest >= threshold).length,
    }));

    return NextResponse.json({
      hours_checked: hours,
      series_results: seriesResults,
      total_markets: allMarkets.length,
      filters: {
        after_odds_filter: oddsFiltered.length,
        after_oi_1000: oiFiltered.length,
        after_oi_100: oiFilteredLow.length,
      },
      oi_breakdown: oiBreakdown,
      sample_markets: sampleMarkets,
      qualifying_markets: oiFiltered.slice(0, 5).map(m => ({
        ticker: m.ticker,
        title: m.title?.substring(0, 50),
        open_interest: m.open_interest,
        close_time: m.close_time,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

