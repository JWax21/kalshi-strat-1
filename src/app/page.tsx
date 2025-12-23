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

type Tab = 'records' | 'orders' | 'markets';

interface DailyRecord {
  date: string;
  start_cash_cents: number;
  start_portfolio_cents: number;
  end_cash_cents: number;
  end_portfolio_cents: number;
  wins: number;
  losses: number;
  pending: number;
  pnl_cents: number;
  roic_percent: number;
  source: 'snapshot' | 'calculated';
}

interface RecordsData {
  records: DailyRecord[];
  current_balance_cents: number;
  current_positions_cents: number;
  totals: {
    wins: number;
    losses: number;
    pnl_cents: number;
  };
}

interface OrderBatch {
  id: string;
  batch_date: string;
  unit_size_cents: number;
  total_orders: number;
  total_cost_cents: number;
  total_potential_payout_cents: number;
  is_paused: boolean;
  prepared_at: string | null;
  executed_at: string | null;
  orders: LiveOrder[];
}

interface LiveOrder {
  id: string;
  ticker: string;
  title: string;
  side: 'YES' | 'NO';
  price_cents: number;
  units: number;
  cost_cents: number;
  potential_payout_cents: number;
  open_interest: number;
  market_close_time: string;
  placement_status: 'pending' | 'placed' | 'confirmed';
  placement_status_at: string | null;
  result_status: 'undecided' | 'won' | 'lost';
  result_status_at: string | null;
  settlement_status: 'pending' | 'closed' | 'success';
  settlement_status_at: string | null;
  executed_price_cents: number | null;
  executed_cost_cents: number | null;
}

interface LiveOrdersStats {
  // Account info
  balance_cents: number;
  portfolio_value_cents: number;
  total_exposure_cents: number;
  // Today's stats
  today: {
    date: string;
    orders: number;
    confirmed: number;
    won: number;
    lost: number;
    payout_cents: number;
    fees_cents: number;
    cost_cents: number;
    lost_cents: number;
    profit_cents: number;
  };
  total_batches: number;
  total_orders: number;
  confirmed_orders: number;
  won_orders: number;
  lost_orders: number;
  pending_orders: number;
  win_rate: string;
  total_cost_cents: number;
  total_payout_cents: number;
  total_fees_cents: number;
  net_pnl_cents: number;
  roi_percent: string;
  placement_breakdown: {
    pending: number;
    placed: number;
    confirmed: number;
  };
  result_breakdown: {
    undecided: number;
    won: number;
    lost: number;
  };
  settlement_breakdown: {
    pending: number;
    closed: number;
    success: number;
  };
  placement_financials: {
    estimated_cost_cents: number;
    actual_cost_cents: number;
    projected_payout_cents: number;
  };
  result_financials: {
    undecided_exposure_cents: number;
    estimated_won_cents: number;
    estimated_lost_cents: number;
    estimated_pnl_cents: number;
  };
  settlement_financials: {
    projected_payout_cents: number;
    actual_payout_cents: number;
    won_cost_cents: number;
    fees_paid_cents: number;
    actual_lost_cents: number;
    net_profit_cents: number;
  };
}

interface OrderbookLevel {
  price: number;
  count: number;
  dollars: string;
}

interface Orderbook {
  yes: OrderbookLevel[];
  no: OrderbookLevel[];
}

interface SelectedMarket {
  ticker: string;
  title: string;
  favorite_side: 'YES' | 'NO';
  favorite_odds: number;
  count: number;
  orderbook?: Orderbook;
  orderbookLoading?: boolean;
}

export default function Dashboard() {
  // Auth state (must be first)
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authUsername, setAuthUsername] = useState('');
  const [authPin, setAuthPin] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // All other state hooks (must come before any conditional returns)
  const [activeTab, setActiveTab] = useState<Tab>('records');
  const [marketsData, setMarketsData] = useState<MarketsResponse | null>(null);
  const [marketsLoading, setMarketsLoading] = useState(false);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [loadingSeconds, setLoadingSeconds] = useState(0.0);
  const [minOdds] = useState(0.85);
  const sportsOnlyMarkets = true;
  const [eventsData, setEventsData] = useState<EventsResponse | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [sportsOnly, setSportsOnly] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [displayOddsMin, setDisplayOddsMin] = useState(85);
  const [displayOddsMax, setDisplayOddsMax] = useState(99);
  const [selectedSeries, setSelectedSeries] = useState<string>('All');
  const [selectedMarkets, setSelectedMarkets] = useState<Map<string, SelectedMarket>>(new Map());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [orderCount, setOrderCount] = useState(1);
  const [orderBatches, setOrderBatches] = useState<OrderBatch[]>([]);
  const [liveOrdersStats, setLiveOrdersStats] = useState<LiveOrdersStats | null>(null);
  const [liveOrdersLoading, setLiveOrdersLoading] = useState(false);
  const [preparingOrders, setPreparingOrders] = useState(false);
  
  // Records state
  const [recordsData, setRecordsData] = useState<RecordsData | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [executingOrders, setExecutingOrders] = useState(false);
  const [updatingStatuses, setUpdatingStatuses] = useState(false);
  const [reconcilingOrders, setReconcilingOrders] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<any>(null);
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null);
  
  // Calculate default day based on 4am ET cutoff
  // Before 4am ET = previous day, after 4am ET = current day
  const getDefaultDay = () => {
    const now = new Date();
    // Convert to ET (UTC-5 or UTC-4 depending on DST)
    const etOffset = -5; // EST (adjust for EDT if needed)
    const utcHours = now.getUTCHours();
    const etHours = (utcHours + etOffset + 24) % 24;
    
    // If before 4am ET, use yesterday
    if (etHours < 4) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return yesterday.toISOString().split('T')[0];
    }
    return now.toISOString().split('T')[0];
  };
  
  const [selectedDay, setSelectedDay] = useState<string | null>(getDefaultDay());
  const [nextRefresh, setNextRefresh] = useState<number>(5 * 60);

  // Check for existing auth on mount
  useEffect(() => {
    const savedAuth = sessionStorage.getItem('kalshi_auth');
    if (savedAuth === 'true') {
      setIsAuthenticated(true);
    }
  }, []);

  const handleLogin = async () => {
    setAuthLoading(true);
    setAuthError('');
    
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: authUsername, pin: authPin }),
      });
      const data = await res.json();
      
      if (data.success) {
        setIsAuthenticated(true);
        sessionStorage.setItem('kalshi_auth', 'true');
      } else {
        setAuthError(data.error || 'Invalid credentials');
      }
    } catch (err) {
      setAuthError('Authentication failed');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    sessionStorage.removeItem('kalshi_auth');
    setAuthUsername('');
    setAuthPin('');
  };

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

  // Fetch orderbook for a market
  const fetchOrderbook = async (ticker: string) => {
    try {
      const res = await fetch(`/api/orderbook/${ticker}`);
      const data = await res.json();
      if (data.success) {
        setSelectedMarkets(prev => {
          const newMap = new Map(prev);
          const market = newMap.get(ticker);
          if (market) {
            newMap.set(ticker, { ...market, orderbook: data.orderbook, orderbookLoading: false });
          }
          return newMap;
        });
      }
    } catch (err) {
      console.error('Error fetching orderbook:', err);
      setSelectedMarkets(prev => {
        const newMap = new Map(prev);
        const market = newMap.get(ticker);
        if (market) {
          newMap.set(ticker, { ...market, orderbookLoading: false });
        }
        return newMap;
      });
    }
  };

  // Toggle market selection for batch order
  const toggleMarketSelection = (market: Market) => {
    const newSelected = new Map(selectedMarkets);
    if (newSelected.has(market.ticker)) {
      newSelected.delete(market.ticker);
    } else {
      newSelected.set(market.ticker, {
        ticker: market.ticker,
        title: market.title,
        favorite_side: market.favorite_side,
        favorite_odds: market.favorite_odds,
        count: orderCount,
        orderbookLoading: true,
      });
      // Fetch orderbook after adding
      fetchOrderbook(market.ticker);
    }
    setSelectedMarkets(newSelected);
    if (newSelected.size > 0) setSidebarOpen(true);
  };

  // Select all visible markets
  const selectAllMarkets = () => {
    const newSelected = new Map(selectedMarkets);
    const newTickers: string[] = [];
    filteredMarkets.forEach(m => {
      if (!newSelected.has(m.ticker)) {
        newSelected.set(m.ticker, {
          ticker: m.ticker,
          title: m.title,
          favorite_side: m.favorite_side,
          favorite_odds: m.favorite_odds,
          count: orderCount,
          orderbookLoading: true,
        });
        newTickers.push(m.ticker);
      }
    });
    setSelectedMarkets(newSelected);
    setSidebarOpen(true);
    // Fetch orderbooks for newly added markets (with slight delays to avoid rate limits)
    newTickers.forEach((ticker, i) => {
      setTimeout(() => fetchOrderbook(ticker), i * 200);
    });
  };

  // Clear all selections
  const clearSelections = () => {
    setSelectedMarkets(new Map());
  };

  // Submit batch order
  const submitBatchOrder = async () => {
    if (selectedMarkets.size === 0) return;
    
    setOrderSubmitting(true);
    const results: { ticker: string; success: boolean; error?: string }[] = [];
    
    for (const [ticker, market] of selectedMarkets) {
      // Price in cents (1-99), based on favorite odds
      const priceInCents = Math.round(market.favorite_odds * 100);
      const side = market.favorite_side.toLowerCase();
      
      const payload: Record<string, any> = {
        ticker,
        action: 'buy',
        side,
        count: market.count,
        type: 'limit', // Kalshi requires limit orders with price
      };
      
      // Set price based on which side we're buying
      if (side === 'yes') {
        payload.yes_price = priceInCents;
      } else {
        payload.no_price = priceInCents;
      }
      
      console.log('Order payload:', payload);
      try {
        const res = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        console.log('Order response:', { status: res.status, data });
        results.push({ ticker, success: data.success, error: data.error });
      } catch (err) {
        results.push({ ticker, success: false, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
    
    setOrderSubmitting(false);
    const successCount = results.filter(r => r.success).length;
    alert(`Orders submitted: ${successCount}/${results.length} successful`);
    if (successCount > 0) {
      clearSelections();
    }
  };

  // Handle Enter key for submitting orders
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && selectedMarkets.size > 0 && !orderSubmitting) {
        submitBatchOrder();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedMarkets, orderSubmitting]);

  // Fetch live orders data
  const fetchLiveOrders = async () => {
    setLiveOrdersLoading(true);
    try {
      const res = await fetch('/api/orders-live?days=30');
      const data = await res.json();
      if (data.success) {
        setOrderBatches(data.batches || []);
        setLiveOrdersStats(data.stats || null);
      }
    } catch (err) {
      console.error('Error fetching live orders:', err);
    } finally {
      setLiveOrdersLoading(false);
    }
  };

  // Fetch records data
  const fetchRecords = async () => {
    setRecordsLoading(true);
    try {
      const res = await fetch('/api/records?days=90');
      const data = await res.json();
      if (data.success) {
        setRecordsData(data);
      }
    } catch (err) {
      console.error('Error fetching records:', err);
    } finally {
      setRecordsLoading(false);
    }
  };

  // Prepare orders
  const prepareOrders = async (forToday: boolean = false) => {
    setPreparingOrders(true);
    try {
      const res = await fetch('/api/orders-live/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unitSizeCents: 100, minOdds: 0.85, maxOdds: 0.995, minOpenInterest: 1000, forToday }),
      });
      const data = await res.json();
      if (data.success) {
        alert(`Prepared ${data.batch.total_orders} orders for ${forToday ? 'today' : 'tomorrow'}`);
        fetchLiveOrders();
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err) {
      alert('Error preparing orders');
    } finally {
      setPreparingOrders(false);
    }
  };

  // Execute today's orders
  const executeTodayOrders = async () => {
    if (!confirm('Execute all pending orders for today? This will place real orders!')) return;
    setExecutingOrders(true);
    try {
      const res = await fetch('/api/orders-live/execute', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert(`Executed: ${data.stats.placed} placed, ${data.stats.confirmed} confirmed, ${data.stats.skipped} skipped`);
        fetchLiveOrders();
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err) {
      alert('Error executing orders');
    } finally {
      setExecutingOrders(false);
    }
  };

  // Update order statuses
  const updateOrderStatuses = async () => {
    setUpdatingStatuses(true);
    try {
      const res = await fetch('/api/orders-live/update-status', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert(`Updated ${data.stats.updated} orders: ${data.stats.won} won, ${data.stats.lost} lost`);
        fetchLiveOrders();
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err) {
      alert('Error updating statuses');
    } finally {
      setUpdatingStatuses(false);
    }
  };

  // Reconcile orders with Kalshi
  const reconcileOrders = async () => {
    setReconcilingOrders(true);
    setReconcileResult(null);
    try {
      const res = await fetch('/api/orders-live/reconcile', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setReconcileResult(data);
      } else {
        console.error('Reconcile error:', data.error);
      }
    } catch (err) {
      console.error('Error reconciling orders:', err);
    } finally {
      setReconcilingOrders(false);
    }
  };

  // Combined refresh: update statuses, reconcile, then fetch
  const [refreshingAll, setRefreshingAll] = useState(false);
  const refreshAll = async () => {
    setRefreshingAll(true);
    try {
      // 1. Update statuses from Kalshi
      await fetch('/api/orders-live/update-status', { method: 'POST' });
      // 2. Reconcile orders
      await fetch('/api/orders-live/reconcile', { method: 'POST' });
      // 3. Fetch fresh data
      await fetchLiveOrders();
    } catch (err) {
      console.error('Error refreshing:', err);
    } finally {
      setRefreshingAll(false);
    }
  };

  // Toggle pause for a batch
  const togglePause = async (batchId: string, currentPaused: boolean) => {
    try {
      const res = await fetch('/api/orders-live/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: batchId, is_paused: !currentPaused }),
      });
      const data = await res.json();
      if (data.success) {
        fetchLiveOrders();
      }
    } catch (err) {
      console.error('Error toggling pause:', err);
    }
  };

  // Fetch data when tab changes
  useEffect(() => {
    if (activeTab === 'orders') {
      fetchLiveOrders();
    } else if (activeTab === 'records') {
      fetchRecords();
    }
  }, [activeTab]);

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

  // Show login screen if not authenticated
  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="bg-slate-900 rounded-2xl p-8 w-full max-w-md border border-slate-800 shadow-2xl">
          <div className="text-center mb-8">
            <img src="/jl.png" alt="Logo" className="w-16 h-16 rounded-lg mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-white">Kalshi Favorites Fund</h1>
            <p className="text-slate-400 mt-2">Enter credentials to continue</p>
          </div>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Username</label>
              <input
                type="text"
                value={authUsername}
                onChange={(e) => setAuthUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                placeholder="Enter username"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">PIN</label>
              <input
                type="password"
                value={authPin}
                onChange={(e) => setAuthPin(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                placeholder="Enter PIN"
              />
            </div>
            
            {authError && (
              <div className="text-red-400 text-sm text-center py-2 bg-red-500/10 rounded-lg">
                {authError}
              </div>
            )}
            
            <button
              onClick={handleLogin}
              disabled={authLoading}
              className="w-full py-3 bg-emerald-500 text-slate-950 font-bold rounded-lg hover:bg-emerald-400 transition-colors disabled:opacity-50"
            >
              {authLoading ? 'Verifying...' : 'Login'}
            </button>
          </div>
        </div>
      </main>
    );
  }

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
              <button 
                onClick={handleLogout}
                className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-400 hover:text-white hover:bg-slate-700"
              >
                Logout
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

        {/* Main Tabs */}
        <div className="flex items-center justify-between mt-6">
          <div className="flex gap-1 bg-slate-900 p-1 rounded-lg">
            <button onClick={() => setActiveTab('records')} className={`px-6 py-2 rounded-md text-sm font-medium ${activeTab === 'records' ? 'bg-purple-500 text-white' : 'text-slate-400 hover:text-white'}`}>Records</button>
            <button onClick={() => setActiveTab('orders')} className={`px-6 py-2 rounded-md text-sm font-medium ${activeTab === 'orders' ? 'bg-blue-500 text-white' : 'text-slate-400 hover:text-white'}`}>Orders</button>
            <button onClick={() => setActiveTab('markets')} className={`px-6 py-2 rounded-md text-sm font-medium ${activeTab === 'markets' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400 hover:text-white'}`}>Markets</button>
          </div>
          
          {activeTab === 'markets' && filteredMarkets.length > 0 && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-400">{selectedMarkets.size} selected</span>
              <button onClick={selectAllMarkets} className="px-4 py-2 text-sm bg-slate-800 border border-slate-700 rounded-lg text-white hover:bg-slate-700">Select All</button>
              {selectedMarkets.size > 0 && (
                <button onClick={clearSelections} className="px-4 py-2 text-sm bg-slate-800 border border-slate-700 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700">Clear</button>
              )}
            </div>
          )}
        </div>

        {activeTab === 'markets' && marketsData && (
          <div className="py-6 border-b border-slate-800">
            {/* Total Count Card */}
            <div className="bg-slate-900 rounded-xl p-6 mb-4">
              <span className="text-5xl font-bold text-white">{filteredMarkets.length}</span>
              <p className="text-slate-400 mt-1">High-Odds Markets</p>
            </div>

            {/* Odds Range Slider with Tick Marks */}
            <div className="bg-slate-900 rounded-xl p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-slate-400">Filter Odds Range</span>
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
        {activeTab === 'markets' && marketsData && (
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

        {activeTab === 'markets' && (
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
                    <article key={m.ticker} className={`bg-slate-900 border rounded-xl p-5 transition-colors ${selectedMarkets.has(m.ticker) ? 'border-emerald-500 bg-emerald-500/5' : 'border-slate-800 hover:border-emerald-500/50'}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white bg-blue-600 px-2 py-1 rounded">{getSeriesTag(m.event_ticker)}</span>
                          <h3 className="text-sm font-semibold text-white leading-snug">{m.title}</h3>
                        </div>
                        <button
                          onClick={() => toggleMarketSelection(m)}
                          className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                            selectedMarkets.has(m.ticker)
                              ? 'bg-emerald-500 text-slate-950'
                              : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                          }`}
                        >
                          {selectedMarkets.has(m.ticker) ? '✓' : '+'}
                        </button>
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
        )}

        {/* Orders Tab (Live Trading) */}
        {activeTab === 'orders' && (
          <div className="py-8">
            {/* Action Buttons */}
            <div className="flex flex-wrap gap-4 mb-6">
              <button
                onClick={refreshAll}
                disabled={refreshingAll || updatingStatuses || reconcilingOrders || liveOrdersLoading}
                className="flex items-center gap-2 px-6 py-3 bg-slate-800 border border-slate-700 text-white rounded-lg hover:bg-slate-700 disabled:opacity-50"
              >
                {(refreshingAll || updatingStatuses || reconcilingOrders || liveOrdersLoading) ? (
                  <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Syncing...</>
                ) : (
                  <>↻ Refresh</>
                )}
              </button>
            </div>

            {/* Top Summary Cards */}
            {liveOrdersStats && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-500 uppercase">Balance</div>
                  <div className="text-2xl font-bold text-white">${((liveOrdersStats.balance_cents || 0) / 100).toFixed(2)}</div>
                  <div className="text-xs text-slate-500">Available cash</div>
                </div>
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-500 uppercase">Total Exposure</div>
                  <div className="text-2xl font-bold text-blue-400">${((liveOrdersStats.total_exposure_cents || 0) / 100).toFixed(2)}</div>
                  <div className="text-xs text-slate-500">Portfolio value</div>
                </div>
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-500 uppercase">W-L (Today)</div>
                  <div className="text-2xl font-bold text-white">
                    <span className="text-emerald-400">{liveOrdersStats.today?.won || 0}W</span>
                    {' - '}
                    <span className="text-red-400">{liveOrdersStats.today?.lost || 0}L</span>
                  </div>
                  <div className="text-xs text-slate-500">{liveOrdersStats.today?.confirmed || 0} confirmed today</div>
                </div>
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-500 uppercase">Fees Paid</div>
                  <div className="text-2xl font-bold text-orange-400">${((liveOrdersStats.total_fees_cents || 0) / 100).toFixed(2)}</div>
                  <div className="text-xs text-slate-500">On settled trades</div>
                </div>
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-500 uppercase">Profit (Today)</div>
                  <div className={`text-2xl font-bold ${(liveOrdersStats.today?.profit_cents || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {(liveOrdersStats.today?.profit_cents || 0) >= 0 ? '+' : ''}${((liveOrdersStats.today?.profit_cents || 0) / 100).toFixed(2)}
                  </div>
                  <div className="text-xs text-slate-500">
                    ${((liveOrdersStats.today?.payout_cents || 0) / 100).toFixed(2)} - ${((liveOrdersStats.today?.fees_cents || 0) / 100).toFixed(2)} - ${((liveOrdersStats.today?.cost_cents || 0) / 100).toFixed(2)}
                  </div>
                </div>
              </div>
            )}

            {/* Day Toggle Bar */}
            {orderBatches.length > 0 && (
              <div className="bg-slate-900 rounded-xl p-4 mb-6">
                <div className="text-sm text-slate-400 mb-3">Filter by Day</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setSelectedDay(null)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                      selectedDay === null
                        ? 'bg-blue-500 text-white'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                    }`}
                  >
                    All
                  </button>
                  {orderBatches.map((batch) => {
                    const date = new Date(batch.batch_date + 'T12:00:00');
                    const dayLabel = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                    return (
                      <button
                        key={batch.id}
                        onClick={() => setSelectedDay(batch.batch_date)}
                        className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors flex items-center gap-2 ${
                          selectedDay === batch.batch_date
                            ? 'bg-blue-500 text-white'
                            : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                        }`}
                      >
                        {dayLabel}
                        {batch.is_paused && <span className="text-amber-400">⏸</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Order Summary - filtered by selected day */}
            {(() => {
              // Get orders for the selected day (or all if no day selected)
              const filteredBatches = selectedDay 
                ? orderBatches.filter(b => b.batch_date === selectedDay)
                : orderBatches;
              const allOrders = filteredBatches.flatMap(b => b.orders || []);
              
              // Calculate placement breakdown
              const pendingOrders = allOrders.filter(o => o.placement_status === 'pending');
              const placedOrders = allOrders.filter(o => o.placement_status === 'placed');
              const confirmedOrders = allOrders.filter(o => o.placement_status === 'confirmed');
              const actualCost = confirmedOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
              
              // Calculate result breakdown
              const undecidedOrders = confirmedOrders.filter(o => o.result_status === 'undecided');
              const wonOrders = confirmedOrders.filter(o => o.result_status === 'won');
              const lostOrders = confirmedOrders.filter(o => o.result_status === 'lost');
              const undecidedExposure = undecidedOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
              const estimatedWon = wonOrders.reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);
              const estimatedLost = lostOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
              const estimatedPnl = estimatedWon - estimatedLost;
              
              // Calculate settlement breakdown
              const settledOrders = [...wonOrders, ...lostOrders];
              const pendingSettlement = settledOrders.filter(o => o.settlement_status === 'pending');
              const successOrders = settledOrders.filter(o => o.settlement_status === 'success');
              const closedOrders = settledOrders.filter(o => o.settlement_status === 'closed');
              const projectedPayout = pendingSettlement.filter(o => o.result_status === 'won').reduce((sum, o) => sum + (o.potential_payout_cents || 0), 0);
              const actualPayout = successOrders.reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);
              const actualLost = closedOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
              const feesPaid = settledOrders.reduce((sum, o) => sum + (o.fee_cents || 0), 0);
              const netProfit = actualPayout - actualLost - feesPaid;

              if (allOrders.length === 0) return null;

              return (
                <div className="bg-slate-900 rounded-xl p-6 mb-6">
                  <h3 className="text-lg font-bold text-white mb-4">
                    Order Summary {selectedDay && `- ${new Date(selectedDay + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`}
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    
                    {/* Placement Status */}
                    <div className="bg-slate-800/50 rounded-lg p-4">
                      <div className="text-sm font-medium text-white mb-3">Placement</div>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-slate-500 text-xs uppercase">
                            <th className="text-left pb-2">Status</th>
                            <th className="text-right pb-2">Orders</th>
                            <th className="text-right pb-2">Cost</th>
                          </tr>
                        </thead>
                        <tbody className="text-sm">
                          <tr>
                            <td className="py-1.5 text-slate-400">Pending</td>
                            <td className="py-1.5 text-right text-white">{pendingOrders.length}</td>
                            <td className="py-1.5 text-right font-mono text-slate-500">-</td>
                          </tr>
                          <tr>
                            <td className="py-1.5 text-slate-400">Placed</td>
                            <td className="py-1.5 text-right text-white">{placedOrders.length}</td>
                            <td className="py-1.5 text-right font-mono text-slate-500">-</td>
                          </tr>
                          <tr>
                            <td className="py-1.5 text-slate-400">Confirmed</td>
                            <td className="py-1.5 text-right text-white">{confirmedOrders.length}</td>
                            <td className="py-1.5 text-right font-mono text-white">${(actualCost / 100).toFixed(2)}</td>
                          </tr>
                          <tr className="border-t border-slate-700">
                            <td className="py-2 text-white font-medium">Total</td>
                            <td className="py-2 text-right text-white font-medium">{allOrders.length}</td>
                            <td className="py-2 text-right font-mono text-white font-medium">${(actualCost / 100).toFixed(2)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    {/* Result Status */}
                    <div className="bg-slate-800/50 rounded-lg p-4">
                      <div className="text-sm font-medium text-white mb-3">Results</div>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-slate-500 text-xs uppercase">
                            <th className="text-left pb-2">Status</th>
                            <th className="text-right pb-2">Orders</th>
                            <th className="text-right pb-2">Value</th>
                          </tr>
                        </thead>
                        <tbody className="text-sm">
                          <tr>
                            <td className="py-1.5 text-slate-400">Undecided</td>
                            <td className="py-1.5 text-right text-white">{undecidedOrders.length}</td>
                            <td className="py-1.5 text-right font-mono text-white">${(undecidedExposure / 100).toFixed(2)}</td>
                          </tr>
                          <tr>
                            <td className="py-1.5 text-slate-400">Won</td>
                            <td className="py-1.5 text-right text-emerald-400">{wonOrders.length}</td>
                            <td className="py-1.5 text-right font-mono text-emerald-400">${(estimatedWon / 100).toFixed(2)}</td>
                          </tr>
                          <tr>
                            <td className="py-1.5 text-slate-400">Lost</td>
                            <td className="py-1.5 text-right text-red-400">{lostOrders.length}</td>
                            <td className="py-1.5 text-right font-mono text-red-400">-${(estimatedLost / 100).toFixed(2)}</td>
                          </tr>
                          <tr className="border-t border-slate-700">
                            <td className="py-2 text-white font-medium">Est. P&L</td>
                            <td className="py-2 text-right text-white font-medium">{confirmedOrders.length}</td>
                            <td className={`py-2 text-right font-mono font-medium ${estimatedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {estimatedPnl >= 0 ? '+' : ''}${(estimatedPnl / 100).toFixed(2)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    {/* Settlement Status */}
                    <div className="bg-slate-800/50 rounded-lg p-4">
                      <div className="text-sm font-medium text-white mb-3">Settlement</div>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-slate-500 text-xs uppercase">
                            <th className="text-left pb-2">Status</th>
                            <th className="text-right pb-2">Orders</th>
                            <th className="text-right pb-2">Cash</th>
                          </tr>
                        </thead>
                        <tbody className="text-sm">
                          <tr>
                            <td className="py-1.5 text-slate-400">Pending</td>
                            <td className="py-1.5 text-right text-white">{pendingSettlement.length}</td>
                            <td className="py-1.5 text-right font-mono text-white">${(projectedPayout / 100).toFixed(2)}</td>
                          </tr>
                          <tr>
                            <td className="py-1.5 text-slate-400">Success</td>
                            <td className="py-1.5 text-right text-emerald-400">{successOrders.length}</td>
                            <td className="py-1.5 text-right font-mono text-emerald-400">+${(actualPayout / 100).toFixed(2)}</td>
                          </tr>
                          <tr>
                            <td className="py-1.5 text-slate-400">Closed</td>
                            <td className="py-1.5 text-right text-red-400">{closedOrders.length}</td>
                            <td className="py-1.5 text-right font-mono text-red-400">-${(actualLost / 100).toFixed(2)}</td>
                          </tr>
                          <tr className="border-t border-slate-700">
                            <td className="py-1.5 text-slate-400">Fees</td>
                            <td className="py-1.5 text-right text-slate-500">-</td>
                            <td className="py-1.5 text-right font-mono text-red-400">-${(feesPaid / 100).toFixed(2)}</td>
                          </tr>
                          <tr>
                            <td className="py-2 text-white font-medium">Net Profit</td>
                            <td className="py-2 text-right text-white font-medium">{settledOrders.length}</td>
                            <td className={`py-2 text-right font-mono font-medium ${netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {netProfit >= 0 ? '+' : ''}${(netProfit / 100).toFixed(2)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                  </div>
                </div>
              );
            })()}

            {/* Quick Prepare Buttons for missing batches */}
            {!liveOrdersLoading && orderBatches.length > 0 && (
              <div className="flex gap-2 mb-4">
                {!orderBatches.some(b => b.batch_date === new Date().toISOString().split('T')[0]) && (
                  <button
                    onClick={() => prepareOrders(true)}
                    disabled={preparingOrders}
                    className="px-3 py-1.5 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50"
                  >
                    {preparingOrders ? '...' : '+ Prepare Today'}
                  </button>
                )}
                {!orderBatches.some(b => b.batch_date === new Date(Date.now() + 86400000).toISOString().split('T')[0]) && (
                  <button
                    onClick={() => prepareOrders(false)}
                    disabled={preparingOrders}
                    className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50"
                  >
                    {preparingOrders ? '...' : '+ Prepare Tomorrow'}
                  </button>
                )}
              </div>
            )}

            {/* Batches List */}
            {liveOrdersLoading ? (
              <div className="flex flex-col items-center py-20 text-slate-400">
                <div className="w-10 h-10 border-4 border-slate-700 border-t-blue-400 rounded-full animate-spin" />
                <p className="mt-4">Loading orders...</p>
              </div>
            ) : orderBatches.length === 0 ? (
              <div className="text-center py-20 text-slate-400">
                <p className="text-xl mb-4">No order batches yet</p>
                <div className="flex justify-center gap-4 mt-4">
                  <button
                    onClick={() => prepareOrders(true)}
                    disabled={preparingOrders}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50"
                  >
                    {preparingOrders ? 'Preparing...' : '📋 Prepare Today'}
                  </button>
                  <button
                    onClick={() => prepareOrders(false)}
                    disabled={preparingOrders}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50"
                  >
                    {preparingOrders ? 'Preparing...' : '📋 Prepare Tomorrow'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {orderBatches
                  .filter(batch => !selectedDay || batch.batch_date === selectedDay)
                  .map((batch) => {
                    // Add T12:00:00 to avoid timezone shift issues
                    const batchDate = new Date(batch.batch_date + 'T12:00:00');
                    const todayStr = new Date().toISOString().split('T')[0];
                    const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0];
                    const isToday = batch.batch_date === todayStr;
                    const isTomorrow = batch.batch_date === tomorrowStr;
                    
                    // Calculate batch stats (use actual cost when available)
                    const confirmedOrders = batch.orders.filter(o => o.placement_status === 'confirmed');
                    const wonOrders = batch.orders.filter(o => o.result_status === 'won');
                    const lostOrders = batch.orders.filter(o => o.result_status === 'lost');
                    const pendingOrders = batch.orders.filter(o => o.result_status === 'undecided');
                    const batchCost = confirmedOrders.reduce((sum, o) => sum + (o.executed_cost_cents ?? o.cost_cents), 0);
                    const batchPayout = wonOrders.reduce((sum, o) => sum + o.potential_payout_cents, 0);
                    const batchLoss = lostOrders.reduce((sum, o) => sum + (o.executed_cost_cents ?? o.cost_cents), 0);
                    const batchPnl = batchPayout - batchLoss;

                    return (
                      <div key={batch.id} className="bg-slate-900 rounded-xl overflow-hidden">
                        {/* Batch Header */}
                        <div
                          onClick={() => setExpandedBatch(expandedBatch === batch.id ? null : batch.id)}
                          className="p-4 flex items-center justify-between cursor-pointer hover:bg-slate-800/50"
                        >
                          <div className="flex items-center gap-4">
                            <div>
                              <div className="text-lg font-bold text-white flex items-center gap-2">
                                Games for {batchDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                                {isToday && <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded">TODAY</span>}
                                {isTomorrow && <span className="text-xs bg-purple-600 text-white px-2 py-0.5 rounded">TOMORROW</span>}
                                {batch.is_paused && <span className="text-xs bg-amber-600 text-white px-2 py-0.5 rounded">PAUSED</span>}
                              </div>
                              <div className="text-xs text-slate-500">
                                {batch.orders.length} orders • {confirmedOrders.length} confirmed
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-6">
                            <div className="text-right">
                              <div className="text-xs text-slate-500">Cost</div>
                              <div className="text-white font-mono">${(batchCost / 100).toFixed(2)}</div>
                            </div>
                            <div className="text-right">
                              <div className="text-xs text-slate-500">Payout</div>
                              <div className="text-emerald-400 font-mono">${(batchPayout / 100).toFixed(2)}</div>
                            </div>
                            <div className="text-right">
                              <div className="text-xs text-slate-500">P&L</div>
                              <div className={`font-mono font-bold ${batchPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                ${(batchPnl / 100).toFixed(2)}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="text-xs text-slate-500">Status</div>
                              <div className="text-sm">
                                <span className="text-emerald-400">{wonOrders.length}W</span>
                                <span className="text-slate-500"> / </span>
                                <span className="text-red-400">{lostOrders.length}L</span>
                                <span className="text-slate-500"> / </span>
                                <span className="text-slate-400">{pendingOrders.length}P</span>
                              </div>
                            </div>
                            {/* Prepare button - disabled since batch already exists */}
                            <button
                              disabled
                              className="px-3 py-1 rounded text-xs font-medium bg-slate-700 text-slate-500 cursor-not-allowed"
                            >
                              ✓ Prepared
                            </button>
                            {/* Execute button - only for today's batch with pending orders */}
                            {isToday && confirmedOrders.length === 0 && batch.orders.filter(o => o.placement_status === 'pending').length > 0 && (
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (!confirm('Execute all pending orders? This will place real orders!')) return;
                                  setExecutingOrders(true);
                                  try {
                                    const res = await fetch('/api/orders-live/execute', { method: 'POST' });
                                    const data = await res.json();
                                    if (data.success) {
                                      alert(`Executed ${data.results?.filter((r: any) => r.success).length || 0} orders!`);
                                      refreshAll();
                                    } else {
                                      alert(`Error: ${data.error}`);
                                    }
                                  } catch (err) {
                                    alert('Error executing orders');
                                  } finally {
                                    setExecutingOrders(false);
                                  }
                                }}
                                disabled={executingOrders}
                                className="px-3 py-1 rounded text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
                              >
                                {executingOrders ? '...' : '🚀 Execute'}
                              </button>
                            )}
                            {/* Recalculate button - only for pending batches */}
                            {confirmedOrders.length === 0 && (
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  try {
                                    const res = await fetch('/api/orders-live/recalculate', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ batchId: batch.id }),
                                    });
                                    const data = await res.json();
                                    if (data.success) {
                                      alert(`Recalculated: ${data.total_units} units across ${data.total_orders} orders (${data.capital_utilization} utilization)`);
                                      fetchLiveOrders();
                                    } else {
                                      alert(`Error: ${data.error}`);
                                    }
                                  } catch (err) {
                                    alert('Error recalculating');
                                  }
                                }}
                                className="px-3 py-1 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-500"
                              >
                                ⚡ Recalculate
                              </button>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); togglePause(batch.id, batch.is_paused); }}
                              className={`px-3 py-1 rounded text-xs font-medium ${
                                batch.is_paused 
                                  ? 'bg-emerald-600 text-white hover:bg-emerald-500' 
                                  : 'bg-amber-600 text-white hover:bg-amber-500'
                              }`}
                            >
                              {batch.is_paused ? '▶ Resume' : '⏸ Pause'}
                            </button>
                            <div className="text-slate-400">
                              {expandedBatch === batch.id ? '▲' : '▼'}
                            </div>
                          </div>
                        </div>

                        {/* Expanded Orders */}
                        {expandedBatch === batch.id && (
                          <div className="border-t border-slate-800">
                            <table className="w-full text-sm">
                              <thead className="bg-slate-800/50">
                                <tr>
                                  <th className="text-left p-3 text-slate-400 font-medium">Market</th>
                                  <th className="text-center p-3 text-slate-400 font-medium">Side</th>
                                  <th className="text-right p-3 text-slate-400 font-medium">Units</th>
                                  <th className="text-right p-3 text-slate-400 font-medium">Est. Cost</th>
                                  <th className="text-right p-3 text-slate-400 font-medium">Actual Cost</th>
                                  <th className="text-right p-3 text-slate-400 font-medium">Payout</th>
                                  <th className="text-center p-3 text-slate-400 font-medium">Placement</th>
                                  <th className="text-center p-3 text-slate-400 font-medium">Result</th>
                                  <th className="text-center p-3 text-slate-400 font-medium">Settlement</th>
                                </tr>
                              </thead>
                              <tbody>
                                {batch.orders.map((order) => (
                                  <tr key={order.id} className="border-t border-slate-800/50">
                                    <td className="p-3 text-white max-w-xs">
                                      <div className="truncate">{order.title}</div>
                                      <div className="text-xs text-slate-500">OI: {order.open_interest.toLocaleString()}</div>
                                    </td>
                                    <td className="p-3 text-center">
                                      <span className={`px-2 py-0.5 rounded text-xs font-bold ${order.side === 'YES' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                                        {order.side}
                                      </span>
                                    </td>
                                    <td className="p-3 text-right text-white font-mono">{order.units}</td>
                                    <td className="p-3 text-right text-slate-500 font-mono">${(order.cost_cents / 100).toFixed(2)}</td>
                                    <td className="p-3 text-right font-mono">
                                      {order.executed_cost_cents !== null ? (
                                        <span className={order.executed_cost_cents < order.cost_cents ? 'text-emerald-400' : 'text-white'}>
                                          ${(order.executed_cost_cents / 100).toFixed(2)}
                                        </span>
                                      ) : (
                                        <span className="text-slate-500">-</span>
                                      )}
                                    </td>
                                    <td className="p-3 text-right text-emerald-400 font-mono">${(order.potential_payout_cents / 100).toFixed(2)}</td>
                                    <td className="p-3 text-center">
                                      <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                                        order.placement_status === 'confirmed' ? 'bg-emerald-500/20 text-emerald-400' :
                                        order.placement_status === 'placed' ? 'bg-blue-500/20 text-blue-400' :
                                        'bg-slate-700 text-slate-400'
                                      }`}>
                                        {order.placement_status.toUpperCase()}
                                      </div>
                                      {order.placement_status_at && (
                                        <div className="text-[10px] text-slate-500 mt-0.5">
                                          {new Date(order.placement_status_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                      )}
                                    </td>
                                    <td className="p-3 text-center">
                                      <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                                        order.result_status === 'won' ? 'bg-emerald-500/20 text-emerald-400' :
                                        order.result_status === 'lost' ? 'bg-red-500/20 text-red-400' :
                                        'bg-slate-700 text-slate-400'
                                      }`}>
                                        {order.result_status.toUpperCase()}
                                      </div>
                                      {order.result_status_at && (
                                        <div className="text-[10px] text-slate-500 mt-0.5">
                                          {new Date(order.result_status_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                      )}
                                    </td>
                                    <td className="p-3 text-center">
                                      <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                                        order.settlement_status === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
                                        order.settlement_status === 'closed' ? 'bg-red-500/20 text-red-400' :
                                        'bg-amber-500/20 text-amber-400'
                                      }`}>
                                        {order.settlement_status.toUpperCase()}
                                      </div>
                                      {order.settlement_status_at && (
                                        <div className="text-[10px] text-slate-500 mt-0.5">
                                          {new Date(order.settlement_status_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        )}

        {/* Records Tab */}
        {activeTab === 'records' && (
          <div className="py-8">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold text-white">Daily Records</h2>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    try {
                      const res = await fetch('/api/snapshot', { method: 'POST' });
                      const data = await res.json();
                      if (data.success) {
                        alert(`Snapshot captured: Balance $${data.snapshot.balance.toFixed(2)}, Positions $${data.snapshot.positions.toFixed(2)}`);
                        fetchRecords();
                      } else {
                        alert(`Error: ${data.error}`);
                      }
                    } catch (err) {
                      alert('Error capturing snapshot');
                    }
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
                >
                  📸 Capture Snapshot
                </button>
                <button
                  onClick={fetchRecords}
                  disabled={recordsLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-slate-800 border border-slate-700 text-white rounded-lg hover:bg-slate-700 disabled:opacity-50"
                >
                  {recordsLoading ? 'Loading...' : '↻ Refresh'}
                </button>
              </div>
            </div>

            {/* Summary Cards */}
            {recordsData && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-500 uppercase mb-2">Cash | Positions | Portfolio</div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-white">${((recordsData.current_balance_cents || 0) / 100).toFixed(2)}</span>
                    <span className="text-slate-500">|</span>
                    <span className="text-2xl font-bold text-amber-400">${((recordsData.current_positions_cents || 0) / 100).toFixed(2)}</span>
                    <span className="text-slate-500">|</span>
                    <span className="text-2xl font-bold text-white">${(((recordsData.current_balance_cents || 0) + (recordsData.current_positions_cents || 0)) / 100).toFixed(2)}</span>
                  </div>
                </div>
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-500 uppercase">Total W-L</div>
                  <div className="text-2xl font-bold text-white">
                    {recordsData.totals?.wins || 0}W / {recordsData.totals?.losses || 0}L
                  </div>
                </div>
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-500 uppercase">Total P&L</div>
                  <div className={`text-2xl font-bold ${(recordsData.totals?.pnl_cents || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {(recordsData.totals?.pnl_cents || 0) >= 0 ? '+' : ''}${((recordsData.totals?.pnl_cents || 0) / 100).toFixed(2)}
                  </div>
                </div>
              </div>
            )}

            {/* Investment Rules */}
            <div className="bg-slate-900 rounded-xl p-4 mb-6 border border-slate-800">
              <div className="text-sm font-medium text-white mb-3">Investment Rules</div>
              <ul className="text-sm text-slate-400 space-y-1">
                <li>— Target markets with favorites at 85-99.5% odds</li>
                <li>— Minimum open interest of $1,000</li>
                <li>— Deploy 100% of available capital daily</li>
                <li>— Distribute evenly across all qualifying markets</li>
                <li>— Prioritize deepest markets (highest OI) for extra units</li>
                <li>— Maximum 3% of portfolio in any single market</li>
                <li>— Cancel unfilled orders after 4 hours and redeploy</li>
                <li>— Blacklist illiquid markets that fail to fill</li>
              </ul>
            </div>

            {/* Records Table */}
            {recordsLoading && !recordsData ? (
              <div className="text-center py-12 text-slate-400">Loading records...</div>
            ) : recordsData?.records && recordsData.records.length > 0 ? (
              <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
                <table className="w-full">
                  <thead className="bg-slate-800/50">
                    <tr>
                      <th className="text-left p-4 text-slate-400 font-medium text-sm">Date</th>
                      <th className="text-right p-4 text-slate-400 font-medium text-sm">Start Cash</th>
                      <th className="text-right p-4 text-slate-400 font-medium text-sm">Start Portfolio</th>
                      <th className="text-right p-4 text-slate-400 font-medium text-sm">End Cash</th>
                      <th className="text-right p-4 text-slate-400 font-medium text-sm">End Portfolio</th>
                      <th className="text-center p-4 text-slate-400 font-medium text-sm">W/L/P</th>
                      <th className="text-right p-4 text-slate-400 font-medium text-sm">P&L</th>
                      <th className="text-right p-4 text-slate-400 font-medium text-sm">ROIC</th>
                      <th className="text-center p-4 text-slate-400 font-medium text-sm">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recordsData.records.map((record, idx) => (
                      <tr key={record.date} className={`border-t border-slate-800 ${idx % 2 === 0 ? 'bg-slate-900' : 'bg-slate-900/50'}`}>
                        <td className="p-4 text-white font-medium">
                          {new Date(record.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                        </td>
                        <td className="p-4 text-right font-mono text-slate-300">
                          ${(record.start_cash_cents / 100).toFixed(2)}
                        </td>
                        <td className="p-4 text-right font-mono text-slate-400">
                          ${(record.start_portfolio_cents / 100).toFixed(2)}
                        </td>
                        <td className="p-4 text-right font-mono text-slate-300">
                          ${(record.end_cash_cents / 100).toFixed(2)}
                        </td>
                        <td className="p-4 text-right font-mono text-white font-medium">
                          ${(record.end_portfolio_cents / 100).toFixed(2)}
                        </td>
                        <td className="p-4 text-center text-sm">
                          <span className="text-emerald-400">{record.wins}</span>
                          <span className="text-slate-500">/</span>
                          <span className="text-red-400">{record.losses}</span>
                          <span className="text-slate-500">/</span>
                          <span className="text-amber-400">{record.pending}</span>
                        </td>
                        <td className={`p-4 text-right font-mono font-bold ${record.pnl_cents >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {record.pnl_cents >= 0 ? '+' : ''}${(record.pnl_cents / 100).toFixed(2)}
                        </td>
                        <td className={`p-4 text-right font-mono text-sm ${record.roic_percent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {record.roic_percent >= 0 ? '+' : ''}{record.roic_percent.toFixed(2)}%
                        </td>
                        <td className="p-4 text-center">
                          <span className={`px-2 py-0.5 rounded text-xs ${record.source === 'snapshot' ? 'bg-purple-500/20 text-purple-400' : 'bg-slate-700 text-slate-400'}`}>
                            {record.source === 'snapshot' ? '📸' : '~'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-12 text-slate-400">No records found. Click &quot;Capture Snapshot&quot; to start recording daily data.</div>
            )}
          </div>
        )}

        <footer className="py-8 border-t border-slate-800 text-center text-slate-500 text-sm">
          Data from <a href="https://kalshi.com" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">Kalshi</a> • Click Refresh to update
        </footer>
      </Container>

      {/* Order Sidebar */}
      {sidebarOpen && (
        <div className="fixed right-0 top-0 h-full w-80 bg-slate-900 border-l border-slate-800 shadow-2xl z-50 flex flex-col">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Batch Order</h2>
            <button onClick={() => setSidebarOpen(false)} className="text-slate-400 hover:text-white text-xl">×</button>
          </div>
          
          <div className="p-4 border-b border-slate-800">
            <label className="text-sm text-slate-400">Contracts per order</label>
            <input
              type="number"
              min="1"
              value={orderCount}
              onChange={(e) => setOrderCount(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white"
            />
          </div>
          
          <div className="flex-1 overflow-y-auto p-4">
            <p className="text-xs text-slate-500 mb-3">{selectedMarkets.size} markets selected</p>
            <div className="space-y-3">
              {Array.from(selectedMarkets.values()).map((m) => {
                // Calculate cumulative fills at each price level for the favorite side
                // BUY side: bids on the favorite side (people wanting to buy)
                const buyLevels = m.favorite_side === 'YES' ? m.orderbook?.yes : m.orderbook?.no;
                let buyCumulativeCount = 0;
                const cumulativeBuyLevels = (buyLevels || []).map(level => {
                  buyCumulativeCount += level.count;
                  return { ...level, cumulative: buyCumulativeCount };
                });

                // SELL side: bids on the opposite side (converted to sell orders)
                // NO bid at price P = YES sell at (100-P), and vice versa
                const sellLevelsRaw = m.favorite_side === 'YES' ? m.orderbook?.no : m.orderbook?.yes;
                const sellLevels = (sellLevelsRaw || []).map(level => ({
                  ...level,
                  price: 100 - level.price, // Convert to equivalent sell price
                })).sort((a, b) => a.price - b.price); // Sort ascending (lowest ask first)
                
                let sellCumulativeCount = 0;
                const cumulativeSellLevels = sellLevels.map(level => {
                  sellCumulativeCount += level.count;
                  return { ...level, cumulative: sellCumulativeCount };
                });

                return (
                  <div key={m.ticker} className="bg-slate-800 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{m.title}</p>
                        <p className="text-xs text-emerald-400">{m.favorite_side} @ {(m.favorite_odds * 100).toFixed(0)}%</p>
                      </div>
                      <button
                        onClick={() => {
                          const newSelected = new Map(selectedMarkets);
                          newSelected.delete(m.ticker);
                          setSelectedMarkets(newSelected);
                        }}
                        className="ml-2 text-slate-400 hover:text-red-400"
                      >
                        ×
                      </button>
                    </div>
                    
                    {/* Orderbook depth visualization */}
                    {m.orderbookLoading ? (
                      <div className="text-xs text-slate-500 py-2">Loading orderbook...</div>
                    ) : m.orderbook ? (
                      <div className="mt-2 border-t border-slate-700 pt-2">
                        {/* Two-column layout: Sell (asks) on left, Buy (bids) on right */}
                        <div className="grid grid-cols-2 gap-2">
                          {/* SELL SIDE (Asks) - people selling to you */}
                          <div>
                            <div className="text-[10px] text-red-400 uppercase mb-1 text-center">
                              Sells (Asks)
                            </div>
                            <div className="space-y-0.5 max-h-28 overflow-y-auto">
                              {cumulativeSellLevels.length > 0 ? (
                                cumulativeSellLevels.slice(0, 8).map((level, i) => (
                                  <div 
                                    key={i} 
                                    className="flex justify-between text-xs font-mono text-red-400"
                                  >
                                    <span>{level.price}¢</span>
                                    <span>{level.count.toLocaleString()}</span>
                                  </div>
                                ))
                              ) : (
                                <div className="text-xs text-slate-500 text-center">No asks</div>
                              )}
                            </div>
                          </div>

                          {/* BUY SIDE (Bids) - people buying from you */}
                          <div>
                            <div className="text-[10px] text-emerald-400 uppercase mb-1 text-center">
                              Buys (Bids)
                            </div>
                            <div className="space-y-0.5 max-h-28 overflow-y-auto">
                              {cumulativeBuyLevels.length > 0 ? (
                                cumulativeBuyLevels.slice(0, 8).map((level, i) => (
                                  <div 
                                    key={i} 
                                    className="flex justify-between text-xs font-mono text-emerald-400"
                                  >
                                    <span>{level.price}¢</span>
                                    <span>{level.count.toLocaleString()}</span>
                                  </div>
                                ))
                              ) : (
                                <div className="text-xs text-slate-500 text-center">No bids</div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Best prices summary */}
                        <div className="mt-2 pt-2 border-t border-slate-700">
                          <div className="flex justify-between text-xs">
                            <div>
                              <span className="text-slate-500">Best Ask: </span>
                              <span className="text-red-400 font-mono">
                                {cumulativeSellLevels.length > 0 ? `${cumulativeSellLevels[0].price}¢` : '-'}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-500">Best Bid: </span>
                              <span className="text-emerald-400 font-mono">
                                {cumulativeBuyLevels.length > 0 ? `${cumulativeBuyLevels[0].price}¢` : '-'}
                              </span>
                            </div>
                          </div>
                          <div className="text-center text-xs mt-1">
                            <span className="text-slate-500">Spread: </span>
                            <span className="text-amber-400 font-mono">
                              {cumulativeSellLevels.length > 0 && cumulativeBuyLevels.length > 0
                                ? `${cumulativeSellLevels[0].price - cumulativeBuyLevels[0].price}¢`
                                : '-'}
                            </span>
                          </div>
                        </div>

                        {/* Fill Summary for buying */}
                        {cumulativeSellLevels.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-slate-700">
                            <div className="text-[10px] text-slate-500 uppercase mb-1">Buy Fill (from asks)</div>
                            <div className="grid grid-cols-3 gap-1 text-xs">
                              {[100, 250, 500].map(qty => {
                                let worstPrice = 0;
                                let canFill = false;
                                for (const level of cumulativeSellLevels) {
                                  if (level.cumulative >= qty) {
                                    worstPrice = level.price;
                                    canFill = true;
                                    break;
                                  }
                                }
                                if (!canFill && cumulativeSellLevels.length > 0) {
                                  worstPrice = cumulativeSellLevels[cumulativeSellLevels.length - 1].price;
                                }
                                const totalAvailable = cumulativeSellLevels.length > 0 
                                  ? cumulativeSellLevels[cumulativeSellLevels.length - 1].cumulative 
                                  : 0;
                                
                                return (
                                  <div key={qty} className="bg-slate-900 rounded p-1.5 text-center">
                                    <div className="text-slate-400">{qty}</div>
                                    <div className={canFill ? 'text-emerald-400' : 'text-amber-400'}>
                                      {canFill ? `${worstPrice}¢` : `${Math.min(qty, totalAvailable)}@${worstPrice}¢`}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          
          {/* Deployment Summary */}
          {selectedMarkets.size > 0 && (
            <div className="p-4 border-t border-slate-800 bg-slate-900/50">
              <div className="text-[10px] text-slate-500 uppercase mb-2">Deployment Summary (at best ask)</div>
              <div className="space-y-1 max-h-32 overflow-y-auto mb-3">
                {Array.from(selectedMarkets.values()).map((m) => {
                  // Get sell side (asks) for the favorite
                  const sellLevelsRaw = m.favorite_side === 'YES' ? m.orderbook?.no : m.orderbook?.yes;
                  const bestAskRaw = sellLevelsRaw?.[0];
                  const bestAskPrice = bestAskRaw ? 100 - bestAskRaw.price : null;
                  const availableAtBest = bestAskRaw?.count || 0;
                  const maxCostCents = bestAskPrice ? bestAskPrice * availableAtBest : 0;
                  
                  return (
                    <div key={m.ticker} className="flex justify-between text-xs">
                      <span className="text-slate-400 truncate max-w-[140px]">{m.title.split(' ').slice(0, 3).join(' ')}...</span>
                      <span className="text-white font-mono">
                        {availableAtBest.toLocaleString()} @ {bestAskPrice || '-'}¢ = ${(maxCostCents / 100).toFixed(0)}
                      </span>
                    </div>
                  );
                })}
              </div>
              
              {/* Totals */}
              {(() => {
                let totalAvailable = 0;
                let totalMaxCost = 0;
                
                Array.from(selectedMarkets.values()).forEach((m) => {
                  const sellLevelsRaw = m.favorite_side === 'YES' ? m.orderbook?.no : m.orderbook?.yes;
                  const bestAskRaw = sellLevelsRaw?.[0];
                  const bestAskPrice = bestAskRaw ? 100 - bestAskRaw.price : 0;
                  const availableAtBest = bestAskRaw?.count || 0;
                  totalAvailable += availableAtBest;
                  totalMaxCost += bestAskPrice * availableAtBest;
                });
                
                return (
                  <div className="border-t border-slate-700 pt-2">
                    <div className="flex justify-between text-sm font-bold">
                      <span className="text-slate-300">Total at Best Ask</span>
                      <span className="text-emerald-400 font-mono">{totalAvailable.toLocaleString()} units</span>
                    </div>
                    <div className="flex justify-between text-sm font-bold mt-1">
                      <span className="text-slate-300">Max Deployable</span>
                      <span className="text-amber-400 font-mono">${(totalMaxCost / 100).toLocaleString()}</span>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          <div className="p-4 border-t border-slate-800 space-y-2">
            <p className="text-xs text-slate-500 text-center">Press Enter to submit</p>
            <button
              onClick={submitBatchOrder}
              disabled={orderSubmitting || selectedMarkets.size === 0}
              className="w-full py-3 bg-emerald-500 text-slate-950 font-bold rounded-lg hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {orderSubmitting ? 'Submitting...' : `Place ${selectedMarkets.size} Orders`}
            </button>
            <button
              onClick={clearSelections}
              className="w-full py-2 bg-slate-800 text-slate-400 rounded-lg hover:bg-slate-700 hover:text-white"
            >
              Clear All
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
