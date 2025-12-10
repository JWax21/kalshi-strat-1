'use client';

import { useState, useEffect, useCallback } from 'react';
import Container from "@/app/_components/container";

interface Market {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle: string;
  yes_sub_title: string;
  no_sub_title: string;
  status: string;
  last_price_dollars: string;
  volume_24h: number;
  open_interest: number;
  liquidity_dollars: string;
  close_time: string;
  calculated_odds: { yes: number; no: number };
  favorite_side: 'YES' | 'NO';
  favorite_odds: number;
}

interface Event {
  event_ticker: string;
  series_ticker: string;
  title: string;
  sub_title: string;
  category: string;
  mutually_exclusive: boolean;
}

interface MarketsResponse {
  success: boolean;
  total_markets: number;
  high_odds_count: number;
  min_odds_filter: number;
  markets: Market[];
  error?: string;
}

interface EventsResponse {
  success: boolean;
  count: number;
  events: Event[];
  error?: string;
}

type Tab = 'markets' | 'events';

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('markets');
  const [marketsData, setMarketsData] = useState<MarketsResponse | null>(null);
  const [marketsLoading, setMarketsLoading] = useState(false);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [loadingSeconds, setLoadingSeconds] = useState(0.0);
  const [minOdds] = useState(0.85); // Default 85%, controlled by display slider
  const sportsOnlyMarkets = true; // Always sports only
  const [eventsData, setEventsData] = useState<EventsResponse | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [sportsOnly, setSportsOnly] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [displayOddsMin, setDisplayOddsMin] = useState(85);
  const [displayOddsMax, setDisplayOddsMax] = useState(99);
  const [selectedSeries, setSelectedSeries] = useState<string>('All');

  const fetchMarkets = useCallback(async () => {
    setMarketsLoading(true);
    setMarketsError(null);
    try {
      // Use 17 days max_close_ts filter (15 days + 48 hours)
      const maxCloseHours = 17 * 24; // 17 days in hours
      const categoryParam = sportsOnlyMarkets ? '&category=Sports' : '';
      const pagesParam = sportsOnlyMarkets ? '' : '&pages=15'; // Sports uses series_ticker approach
      const res = await fetch(`/api/markets?minOdds=${minOdds}&limit=1000&maxCloseHours=${maxCloseHours}${pagesParam}${categoryParam}`);
      const result: MarketsResponse = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to fetch');
      // Only update data after successful fetch (keep old data until new arrives)
      setMarketsData(result);
      setLastUpdated(new Date());
      setNextRefresh(5 * 60); // Reset countdown
    } catch (err) {
      // Keep old data on error, just show error message
      setMarketsError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setMarketsLoading(false);
    }
  }, [minOdds, sportsOnlyMarkets]);

  const fetchEvents = async () => {
    setEventsLoading(true);
    setEventsError(null);
    try {
      const url = sportsOnly ? `/api/events?limit=200&category=Sports` : `/api/events?limit=200`;
      const res = await fetch(url);
      const result: EventsResponse = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to fetch');
      setEventsData(result);
      setLastUpdated(new Date());
    } catch (err) {
      setEventsError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setEventsLoading(false);
    }
  };

  const handleRefresh = () => {
    fetchMarkets();
  };

  // Auto-refresh markets every 5 minutes
  useEffect(() => {
    // Initial fetch on mount
    fetchMarkets();
    
    // Set up 5-minute interval (300000ms)
    const interval = setInterval(() => {
      console.log('Auto-refreshing markets...');
      fetchMarkets();
    }, 5 * 60 * 1000);
    
    return () => clearInterval(interval);
  }, [fetchMarkets]);

  // Calculate next refresh time
  const [nextRefresh, setNextRefresh] = useState<number>(5 * 60);
  useEffect(() => {
    const timer = setInterval(() => {
      setNextRefresh(prev => prev <= 1 ? 5 * 60 : prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [lastUpdated]);

  // Track loading time in seconds (with decimal)
  useEffect(() => {
    if (marketsLoading) {
      setLoadingSeconds(0);
      const timer = setInterval(() => {
        setLoadingSeconds(prev => prev + 0.1);
      }, 100);
      return () => clearInterval(timer);
    }
  }, [marketsLoading]);

  const formatPct = (v: number) => (v * 100).toFixed(1) + '%';
  const formatVol = (v: number) => v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(1)+'K' : v.toString();
  const formatTime = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  // Map series tickers to colloquial tags
  const seriesTagMap: Record<string, string> = {
    'KXNBAGAME': 'NBA',
    'KXNFLGAME': 'NFL',
    'KXMLBGAME': 'MLB',
    'KXNHLGAME': 'NHL',
    'KXNCAAMBGAME': 'NCAAM',
    'KXNCAAWBGAME': 'NCAAW',
    'KXNCAAFBGAME': 'NCAAF',
    'KXNCAAFCSGAME': 'NCAAFCS',
    'KXNCAAFGAME': 'NCAAF',
    'KXEUROLEAGUEGAME': 'EuroLeague',
    'KXNBLGAME': 'NBL',
    'KXCRICKETTESTMATCH': 'Cricket',
    'KXEFLCHAMPIONSHIPGAME': 'EFL',
    'KXDOTA2GAME': 'Dota 2',
    'KXUFCFIGHT': 'UFC',
  };

  const getSeriesTag = (eventTicker: string): string => {
    // Extract series from event ticker (e.g., KXNBAGAME-25DEC10SASLAL -> KXNBAGAME)
    const parts = eventTicker.split('-');
    if (parts.length > 0) {
      const series = parts[0];
      return seriesTagMap[series] || series;
    }
    return 'Other';
  };

  // Extract both teams from title like "Fisher at UMass Lowell Winner?"
  const parseTeamsFromTitle = (title: string): { team1: string; team2: string } | null => {
    // Try different patterns: "at", "vs", "@"
    const patterns = [
      /^(.+?)\s+at\s+(.+?)\s+Winner\??$/i,
      /^(.+?)\s+vs\.?\s+(.+?)\s+Winner\??$/i,
      /^(.+?)\s+@\s+(.+?)\s+Winner\??$/i,
      /^(.+?)\s+at\s+(.+?)$/i,
      /^(.+?)\s+vs\.?\s+(.+?)$/i,
    ];
    
    for (const pattern of patterns) {
      const match = title.match(pattern);
      if (match) {
        return { team1: match[1].trim(), team2: match[2].trim() };
      }
    }
    return null;
  };

  // Get the favorite team name
  const getFavoriteTeam = (m: Market): string => {
    const teams = parseTeamsFromTitle(m.title);
    
    if (m.favorite_side === 'YES') {
      // YES is favorite - that's team1 (the first team in the title)
      return m.yes_sub_title || (teams?.team1) || 'YES';
    } else {
      // NO is favorite - that's team2 (the second team, the opponent)
      return teams?.team2 || m.no_sub_title || 'NO';
    }
  };

  const loading = marketsLoading;

  // Get unique series from current markets
  const availableSeries = ['All', ...Array.from(new Set(
    (marketsData?.markets || []).map(m => getSeriesTag(m.event_ticker))
  )).sort()];

  // Debug: Log first 10 markets data
  if (marketsData?.markets && marketsData.markets.length > 0) {
    console.log('=== First 10 Markets Data ===');
    marketsData.markets.slice(0, 10).forEach((m, i) => {
      console.log(`Market ${i + 1}:`, {
        ticker: m.ticker,
        event_ticker: m.event_ticker,
        title: m.title,
        subtitle: m.subtitle,
        yes_sub_title: m.yes_sub_title,
        no_sub_title: m.no_sub_title,
        favorite_side: m.favorite_side,
        favorite_odds: m.favorite_odds,
        open_interest: m.open_interest,
      });
    });
  }

  // Client-side filtered markets based on display odds slider and series filter
  const filteredMarkets = marketsData?.markets.filter(m => {
    const odds = m.favorite_odds * 100;
    const matchesOdds = odds >= displayOddsMin && odds <= displayOddsMax;
    const matchesSeries = selectedSeries === 'All' || getSeriesTag(m.event_ticker) === selectedSeries;
    return matchesOdds && matchesSeries;
  }) || [];

  // Open interest summary counts
  const oiSummary = {
    '1 - 1K': filteredMarkets.filter(m => m.open_interest >= 1 && m.open_interest < 1000).length,
    '1K - 10K': filteredMarkets.filter(m => m.open_interest >= 1000 && m.open_interest < 10000).length,
    '10K - 100K': filteredMarkets.filter(m => m.open_interest >= 10000 && m.open_interest < 100000).length,
    '100K - 1M': filteredMarkets.filter(m => m.open_interest >= 100000 && m.open_interest < 1000000).length,
    '1M+': filteredMarkets.filter(m => m.open_interest >= 1000000).length,
  };

  return (
    <main className="min-h-screen bg-slate-950">
      <Container>
        <header className="py-8 border-b border-slate-800">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="flex items-center gap-4">
              <img src="/jl.png" alt="Logo" className="w-12 h-12 rounded-lg" />
              <div>
                <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">
                  Kalshi <span className="text-emerald-400">Favorites Fund</span>
                </h1>
                <p className="text-slate-400 mt-1">Prediction Markets Scanner</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <button onClick={handleRefresh} disabled={loading} className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white hover:bg-slate-700 disabled:opacity-60">
                <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                Refresh
              </button>
            </div>
          </div>
          {lastUpdated && (
            <div className="text-xs text-slate-500 mt-3">
              <p>
                Last updated: {lastUpdated.toLocaleTimeString()} • Next refresh in {Math.floor(nextRefresh / 60)}:{(nextRefresh % 60).toString().padStart(2, '0')}
                {marketsLoading && <span className="text-emerald-400 ml-2">⟳ Fetching... {loadingSeconds.toFixed(1)}s</span>}
              </p>
              {marketsData && <p className="mt-1">Total markets fetched: {marketsData.total_markets.toLocaleString()}</p>}
            </div>
          )}
        </header>


        {marketsData && (
          <div className="py-6 border-b border-slate-800">
            {/* Total Count Card */}
            <div className="bg-slate-900 rounded-xl p-6 mb-4 text-center">
              <span className="text-5xl font-bold text-white">{filteredMarkets.length}</span>
              <p className="text-slate-400 mt-1">High-Odds Markets</p>
            </div>

            {/* Odds Range Slider with Tick Marks */}
            <div className="bg-slate-900 rounded-xl p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-slate-400">Display Odds Range</span>
                <span className="text-sm font-mono text-emerald-400">{displayOddsMin}% - {displayOddsMax}%</span>
              </div>
              <div className="flex flex-col gap-1">
                {/* Dual range slider on same track */}
                <div className="relative h-6">
                  {/* Track background */}
                  <div className="absolute top-2 left-0 right-0 h-2 bg-slate-700 rounded-lg" />
                  {/* Selected range highlight */}
                  <div 
                    className="absolute top-2 h-2 bg-emerald-500/30 rounded-lg"
                    style={{
                      left: `${((displayOddsMin - 85) / 14) * 100}%`,
                      right: `${((99 - displayOddsMax) / 14) * 100}%`
                    }}
                  />
                  {/* Min slider */}
                  <input
                    type="range"
                    min="85"
                    max="99"
                    value={displayOddsMin}
                    onChange={(e) => setDisplayOddsMin(Math.min(parseInt(e.target.value), displayOddsMax - 1))}
                    className="absolute inset-0 w-full h-full appearance-none bg-transparent cursor-pointer pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-0"
                  />
                  {/* Max slider */}
                  <input
                    type="range"
                    min="85"
                    max="99"
                    value={displayOddsMax}
                    onChange={(e) => setDisplayOddsMax(Math.max(parseInt(e.target.value), displayOddsMin + 1))}
                    className="absolute inset-0 w-full h-full appearance-none bg-transparent cursor-pointer pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-0"
                  />
                </div>
                {/* Tick marks and labels */}
                <div className="relative h-6 mt-2">
                  <div className="absolute inset-x-0 flex justify-between">
                    {[85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99].map(n => (
                      <div key={n} className="flex flex-col items-center" style={{ width: '1px' }}>
                        <div className="w-px h-2 bg-slate-600" />
                        <span className="text-[10px] text-slate-500 font-mono mt-0.5">{n}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Open Interest Summary Table */}
            <div className="bg-slate-900 rounded-xl p-4">
              <h3 className="text-sm text-slate-400 mb-3">Open Interest Distribution</h3>
              <div className="space-y-2 text-sm">
                <div className="flex border-b border-slate-800 pb-2">
                  <span className="w-24 text-slate-400">1 - 1K</span>
                  <span className="font-mono text-white">{oiSummary['1 - 1K']}</span>
                </div>
                <div className="flex border-b border-slate-800 pb-2">
                  <span className="w-24 text-slate-400">1K - 10K</span>
                  <span className="font-mono text-white">{oiSummary['1K - 10K']}</span>
                </div>
                <div className="flex border-b border-slate-800 pb-2">
                  <span className="w-24 text-slate-400">10K - 100K</span>
                  <span className="font-mono text-white">{oiSummary['10K - 100K']}</span>
                </div>
                <div className="flex border-b border-slate-800 pb-2">
                  <span className="w-24 text-slate-400">100K - 1M</span>
                  <span className="font-mono text-white">{oiSummary['100K - 1M']}</span>
                </div>
                <div className="flex border-b border-slate-800 pb-2">
                  <span className="w-24 text-slate-400">1M+</span>
                  <span className="font-mono text-white">{oiSummary['1M+']}</span>
                </div>
                <div className="flex border-t-2 border-slate-600 pt-2">
                  <span className="w-24 text-white font-medium">Total</span>
                  <span className="font-mono text-white font-bold">{filteredMarkets.length}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Series Toggle Bar - Below divider */}
        {marketsData && (
          <div className="py-4">
            <div className="bg-slate-900 rounded-xl p-4">
              <div className="text-sm text-slate-400 mb-3">Filter by League</div>
              <div className="flex flex-wrap gap-2">
                {availableSeries.map((series) => (
                  <button
                    key={series}
                    onClick={() => setSelectedSeries(series)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                      selectedSeries === series
                        ? 'bg-emerald-500 text-slate-950'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                    }`}
                  >
                    {series}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}


        <div className="py-8">
              {marketsLoading && !marketsData ? (
                <div className="flex flex-col items-center py-20 text-slate-400"><div className="w-10 h-10 border-4 border-slate-700 border-t-emerald-400 rounded-full animate-spin" /><p className="mt-4">Loading markets... <span className="font-mono text-emerald-400">{loadingSeconds.toFixed(1)}s</span></p></div>
              ) : marketsError ? (
                <div className="text-center py-20"><p className="text-red-400 text-xl">Error: {marketsError}</p><button onClick={fetchMarkets} className="mt-4 bg-emerald-500 text-slate-950 px-6 py-3 rounded-lg">Try Again</button></div>
              ) : filteredMarkets.length === 0 ? (
                <div className="text-center py-20 text-slate-400"><p className="text-xl">No markets found in the {displayOddsMin}% - {displayOddsMax}% range</p></div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredMarkets.map((m) => (
                    <article key={m.ticker} className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-emerald-500/50">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-bold text-white bg-blue-600 px-2 py-1 rounded">{getSeriesTag(m.event_ticker)}</span>
                        <h3 className="text-sm font-semibold text-white leading-snug">{m.title}</h3>
                      </div>
                      {m.subtitle && <p className="text-xs text-slate-500 mb-2">{m.subtitle}</p>}
                      <div className="mb-4"><span className="text-xs text-slate-500 uppercase">Favorite</span><div className="font-semibold text-emerald-400">{getFavoriteTeam(m)} @ {formatPct(m.favorite_odds)}</div></div>
                      <div className="grid grid-cols-3 gap-2 pt-4 border-t border-slate-800 text-center">
                        <div><div className="text-[10px] text-slate-500 uppercase">Vol 24h</div><div className="font-mono text-sm text-white">{formatVol(m.volume_24h)}</div></div>
                        <div><div className="text-[10px] text-slate-500 uppercase">Open Int</div><div className="font-mono text-sm text-white">{formatVol(m.open_interest)}</div></div>
                        <div><div className="text-[10px] text-slate-500 uppercase">Closes</div><div className="font-mono text-sm text-white">{formatTime(m.close_time)}</div></div>
                      </div>
                      <a href={`https://kalshi.com/markets/${m.event_ticker}`} target="_blank" rel="noopener noreferrer" className="mt-4 flex items-center justify-center gap-2 w-full border border-slate-700 rounded-lg py-2.5 text-slate-400 text-sm hover:bg-emerald-500 hover:border-emerald-500 hover:text-slate-950">View on Kalshi</a>
                    </article>
                  ))}
                </div>
              )}
        </div>

        <footer className="py-8 border-t border-slate-800 text-center text-slate-500 text-sm">
          Data from <a href="https://kalshi.com" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">Kalshi</a> • Click Refresh to update
        </footer>
      </Container>
    </main>
  );
}
