'use client';

import { useState, useEffect, useCallback } from 'react';
import Container from "@/app/_components/container";
import { IoInformationCircleSharp } from "react-icons/io5";

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
  expected_expiration_time?: string;  // Actual game end time
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

type Tab = 'records' | 'orders' | 'markets' | 'positions' | 'losses' | 'whatif';

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
  avg_price_cents: number;
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

interface LossEntry {
  id: string;
  ticker: string;
  event_ticker: string;
  title: string;
  side: string;
  units: number;
  entry_price_cents: number;
  exit_price_cents: number;
  cost_cents: number;
  potential_payout_cents: number;
  batch_date: string;
  market_close_time: string;
  result_status_at: string;
  sport: string;
  day_of_week: string;
  venue: 'home' | 'away' | 'neutral';
  implied_odds_percent: number;
  fills: { price: number; count: number; created_time: string; side: string }[];
}

interface LossesSummary {
  total_losses: number;
  total_lost_cents: number;
  avg_odds: number;
  by_sport: Record<string, { count: number; lost_cents: number; avg_odds: number }>;
  by_day_of_week: Record<string, { count: number; lost_cents: number }>;
  by_odds_range: Record<string, { count: number; lost_cents: number }>;
  by_month: Record<string, { count: number; lost_cents: number }>;
  by_venue: Record<string, { count: number; lost_cents: number }>;
  top_losing_teams: { team: string; count: number }[];
}

interface LossesData {
  success: boolean;
  losses: LossEntry[];
  summary: LossesSummary;
}

interface WhatIfOrderAnalysis {
  id: string;
  ticker: string;
  title: string;
  side: string;
  units: number;
  entry_price_cents: number;
  cost_cents: number;
  result_status: 'won' | 'lost';
  price_history: { timestamp: string; yes_price: number; no_price: number }[];
  min_price_after_entry: number | null;
  max_price_after_entry: number | null;
  would_trigger_at: Record<number, boolean>;
  recovery_at: Record<number, number>;
}

interface WhatIfStopLossResult {
  lossesTriggered: number;
  winsTriggered: number;
  lossRecovery: number;
  missedWinProfit: number;
  simulatedPnL: number;
  improvement: number;
}

interface WhatIfData {
  success: boolean;
  orders: WhatIfOrderAnalysis[];
  summary: {
    total_orders: number;
    won: number;
    lost: number;
    actual_pnl_cents: number;
    stop_loss_results: Record<number, WhatIfStopLossResult>;
    optimal_stop_loss: WhatIfStopLossResult & { price: number };
    has_price_history: number;
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
  event_ticker: string;
  title: string;
  side: 'YES' | 'NO';
  price_cents: number;
  units: number;
  cost_cents: number;
  potential_payout_cents: number;
  open_interest: number;
  volume_24h: number | null;
  market_close_time: string;
  placement_status: 'pending' | 'placed' | 'confirmed';
  placement_status_at: string | null;
  result_status: 'undecided' | 'won' | 'lost';
  result_status_at: string | null;
  settlement_status: 'pending' | 'closed' | 'success';
  settlement_status_at: string | null;
  executed_price_cents: number | null;
  executed_cost_cents: number | null;
  actual_payout_cents: number | null;
  fee_cents: number | null;
  kalshi_order_id: string | null;
  current_price_cents: number | null;
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

// Helper to get current date in Eastern Time (YYYY-MM-DD format)
function getTodayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Helper to convert a UTC ISO timestamp to ET date (YYYY-MM-DD format)
function getDateFromTimestampET(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Helper to add days to an ET date string and return ET date string
function addDaysToDateET(dateStr: string, days: number): string {
  // Parse the date as UTC noon to avoid timezone issues
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  // Return as YYYY-MM-DD
  return d.toISOString().split('T')[0];
}

// Helper to format an ET date string for display
function formatDateForDisplay(dateStr: string): string {
  // Parse as UTC noon to avoid timezone issues
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
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
  const [positionsSubTab, setPositionsSubTab] = useState<'active' | 'historical'>('active');
  const [historicalDays, setHistoricalDays] = useState<7 | 30 | 90>(7);
  const [marketsData, setMarketsData] = useState<MarketsResponse | null>(null);
  const [marketsLoading, setMarketsLoading] = useState(false);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [loadingSeconds, setLoadingSeconds] = useState(0.0);
  const [minOdds] = useState(0.90);
  const sportsOnlyMarkets = true;
  const [eventsData, setEventsData] = useState<EventsResponse | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [sportsOnly, setSportsOnly] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [displayOddsMin, setDisplayOddsMin] = useState(85);
  const [displayOddsMax, setDisplayOddsMax] = useState(99);
  const [selectedSeries, setSelectedSeries] = useState<string>('All');
  const [selectedGameDate, setSelectedGameDate] = useState<string>('all');
  const [selectedMarkets, setSelectedMarkets] = useState<Map<string, SelectedMarket>>(new Map());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [orderCount, setOrderCount] = useState(1);
  const [orderBatches, setOrderBatches] = useState<OrderBatch[]>([]);
  const [liveOrdersStats, setLiveOrdersStats] = useState<LiveOrdersStats | null>(null);
  const [liveOrdersLoading, setLiveOrdersLoading] = useState(false);
  const [dailySnapshots, setDailySnapshots] = useState<Record<string, number>>({});
  const [preparingOrders, setPreparingOrders] = useState(false);
  
  // Records state
  const [recordsData, setRecordsData] = useState<RecordsData | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [showRulesModal, setShowRulesModal] = useState(false);
  
  // Losses state
  const [lossesData, setLossesData] = useState<LossesData | null>(null);
  const [lossesLoading, setLossesLoading] = useState(false);
  
  // What-If simulation state
  const [stopLossPrice, setStopLossPrice] = useState(50); // Default 50 cents
  const [whatIfData, setWhatIfData] = useState<WhatIfData | null>(null);
  const [whatIfLoading, setWhatIfLoading] = useState(false);
  const [executingOrders, setExecutingOrders] = useState(false);
  const [updatingStatuses, setUpdatingStatuses] = useState(false);
  const [reconcilingOrders, setReconcilingOrders] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<any>(null);
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null);
  const [preparingWeek, setPreparingWeek] = useState(false);
  
  // Calculate default day based on 4am ET cutoff
  // Before 4am ET = previous day, after 4am ET = current day
  const getDefaultDay = () => {
    const now = new Date();
    // Convert to ET (UTC-5 or UTC-4 depending on DST)
    // Get current hour in ET to check if before 4am
    const etTimeStr = now.toLocaleString('en-US', { 
      timeZone: 'America/New_York', 
      hour: 'numeric', 
      hour12: false 
    });
    const etHours = parseInt(etTimeStr);
    
    // Get today's date in ET
    const todayET = getTodayET();
    
    // If before 4am ET, use yesterday
    if (etHours < 4) {
      return addDaysToDateET(todayET, -1);
    }
    return todayET;
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

  const handleRefresh = async () => {
    // Tab-aware refresh
    if (activeTab === 'orders') {
      await refreshAll();
    } else if (activeTab === 'records') {
      await fetchRecords();
    } else {
      fetchMarkets();
    }
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
      const res = await fetch('/api/orders-live?days=90');
      const data = await res.json();
      if (data.success) {
        setOrderBatches(data.batches || []);
        setLiveOrdersStats(data.stats || null);
      }
      
      // Also fetch daily snapshots for portfolio values
      const snapshotRes = await fetch('/api/snapshot?days=90');
      const snapshotData = await snapshotRes.json();
      if (snapshotData.success && snapshotData.snapshots) {
        const snapshotMap: Record<string, number> = {};
        snapshotData.snapshots.forEach((s: any) => {
          snapshotMap[s.snapshot_date] = s.portfolio_value_cents;
        });
        setDailySnapshots(snapshotMap);
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

  // Fetch losses data
  const fetchLosses = async () => {
    setLossesLoading(true);
    try {
      const res = await fetch('/api/losses?days=90');
      const data = await res.json();
      if (data.success) {
        setLossesData(data);
      }
    } catch (err) {
      console.error('Error fetching losses:', err);
    } finally {
      setLossesLoading(false);
    }
  };

  // Fetch what-if analysis data
  const fetchWhatIf = async () => {
    setWhatIfLoading(true);
    try {
      const res = await fetch('/api/whatif?days=90');
      const data = await res.json();
      if (data.success) {
        setWhatIfData(data);
      }
    } catch (err) {
      console.error('Error fetching what-if data:', err);
    } finally {
      setWhatIfLoading(false);
    }
  };

  // Prepare orders
  const prepareOrders = async (forToday: boolean = false) => {
    setPreparingOrders(true);
    try {
      const res = await fetch('/api/orders-live/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unitSizeCents: 100, minOdds: 0.90, maxOdds: 0.995, minOpenInterest: 1000, forToday }),
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

  // Prepare orders for the next 7 days
  const prepareWeek = async () => {
    if (!confirm('Prepare orders for the next 7 days? This will create batches for each day.')) return;
    setPreparingWeek(true);
    try {
      const res = await fetch('/api/orders-live/prepare-week', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 7, minOdds: 0.90, maxOdds: 0.995, minOpenInterest: 100 }),
      });
      const data = await res.json();
      if (data.success) {
        const summary = data.summary;
        const dayResults = data.days.map((d: any) => 
          `${d.date}: ${d.skipped ? 'Already exists' : d.orders_prepared + ' orders ($' + d.total_cost_dollars + ')'}`
        ).join('\n');
        alert(`Prepared ${summary.total_orders} orders across ${summary.days_prepared} days\n\n${dayResults}`);
        fetchLiveOrders();
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err) {
      alert('Error preparing week');
    } finally {
      setPreparingWeek(false);
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

  // Combined refresh: update statuses, reconcile, monitor, then fetch
  const [refreshingAll, setRefreshingAll] = useState(false);
  const refreshAll = async () => {
    setRefreshingAll(true);
    try {
      // 1. Update statuses from Kalshi
      await fetch('/api/orders-live/update-status', { method: 'POST' });
      // 2. Reconcile orders (fees, settlements)
      await fetch('/api/orders-live/reconcile', { method: 'POST' });
      // 3. Monitor & optimize (improve stale orders, find new markets, deploy capital)
      await fetch('/api/orders-live/monitor', { method: 'POST' });
      // 4. Fetch fresh data
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
    if (activeTab === 'orders' || activeTab === 'positions') {
      fetchLiveOrders();
      fetchRecords(); // Also fetch records for Capital Deployment table
    } else if (activeTab === 'records') {
      fetchRecords();
    } else if (activeTab === 'losses') {
      fetchLosses();
    } else if (activeTab === 'whatif') {
      fetchWhatIf();
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

  // Extract game date from event_ticker (most reliable for sports)
  // Format: KXNBAGAME-25DEC26BOSIND = Season 2025 + Dec 26 = Dec 26, 2025
  const extractGameDate = (market: Market): string | null => {
    // Try to parse from event_ticker first (e.g., KXNBAGAME-25DEC26BOSIND)
    // Pattern: -{SEASON_YY}{MONTH}{DAY}
    const tickerMatch = market.event_ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
    if (tickerMatch) {
      const [, seasonStr, monthStr, dayStr] = tickerMatch;
      const monthMap: Record<string, string> = {
        'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04',
        'MAY': '05', 'JUN': '06', 'JUL': '07', 'AUG': '08',
        'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
      };
      const month = monthMap[monthStr];
      if (month) {
        return `20${seasonStr}-${month}-${dayStr}`;
      }
    }
    
    // Fallback: use expected_expiration_time - 15 hours
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
  };

  // Generate next 7 days for game date filter (in ET)
  const getNext7Days = (): { label: string; value: string }[] => {
    const days: { label: string; value: string }[] = [];
    const todayET = getTodayET();
    
    for (let i = 0; i < 7; i++) {
      const dateStr = addDaysToDateET(todayET, i);
      const label = formatDateForDisplay(dateStr);
      days.push({ label, value: dateStr });
    }
    
    return days;
  };

  const gameDateOptions = getNext7Days();

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


  // Client-side filtered markets based on display odds slider, series filter, and game date
  const filteredMarkets = marketsData?.markets.filter(m => {
    const odds = m.favorite_odds * 100;
    const matchesOdds = odds >= displayOddsMin && odds <= displayOddsMax;
    const matchesSeries = selectedSeries === 'All' || getSeriesTag(m.event_ticker) === selectedSeries;
    const gameDate = extractGameDate(m);
    const matchesGameDate = selectedGameDate === 'all' || gameDate === selectedGameDate;
    return matchesOdds && matchesSeries && matchesGameDate;
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
              <button 
                onClick={handleRefresh} 
                disabled={loading || refreshingAll || liveOrdersLoading || recordsLoading} 
                className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white hover:bg-slate-700 disabled:opacity-60"
              >
                <svg className={`w-4 h-4 ${(loading || refreshingAll || liveOrdersLoading || recordsLoading) ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
            <button onClick={() => setActiveTab('records')} className={`px-6 py-2 rounded-md text-sm font-medium ${activeTab === 'records' ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-white'}`}>Records</button>
            <button onClick={() => setActiveTab('positions')} className={`px-6 py-2 rounded-md text-sm font-medium ${activeTab === 'positions' ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-white'}`}>Positions</button>
            <button onClick={() => setActiveTab('losses')} className={`px-6 py-2 rounded-md text-sm font-medium ${activeTab === 'losses' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-white'}`}>Losses</button>
            <button onClick={() => setActiveTab('whatif')} className={`px-6 py-2 rounded-md text-sm font-medium ${activeTab === 'whatif' ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-white'}`}>What If</button>
            <button onClick={() => setActiveTab('orders')} className={`px-6 py-2 rounded-md text-sm font-medium ${activeTab === 'orders' ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-white'}`}>Schedule</button>
            <button onClick={() => setActiveTab('markets')} className={`px-6 py-2 rounded-md text-sm font-medium ${activeTab === 'markets' ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-white'}`}>Events</button>
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
            {/* Game Date Toggle Bar */}
            <div className="bg-slate-900 rounded-xl p-4 mb-4">
              <div className="text-sm text-slate-400 mb-3">Filter by Game Date</div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setSelectedGameDate('all')}
                  className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                    selectedGameDate === 'all'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                  }`}
                >
                  All
                </button>
                {gameDateOptions.map(day => (
                  <button
                    key={day.value}
                    onClick={() => setSelectedGameDate(day.value)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                      selectedGameDate === day.value
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                    }`}
                  >
                    {day.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Daily Summary Table - Unique EVENTS (not markets) */}
            <div className="bg-slate-900 rounded-xl p-4 mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-800">
                    <th className="text-left py-2 font-medium">Day</th>
                    <th className="text-right py-2 font-medium">All Events</th>
                    <th className="text-right py-2 font-medium">High-Odds</th>
                  </tr>
                </thead>
                <tbody>
                  {gameDateOptions.map(day => {
                    const dayMarkets = marketsData?.markets.filter(m => extractGameDate(m) === day.value) || [];
                    // Count unique events (deduplicate by event_ticker)
                    const uniqueEvents = new Set(dayMarkets.map(m => m.event_ticker));
                    // For high-odds, get unique events where at least one market qualifies
                    const highOddsEvents = new Set(
                      dayMarkets
                        .filter(m => {
                          const odds = m.favorite_odds * 100;
                          return odds >= displayOddsMin && odds <= displayOddsMax;
                        })
                        .map(m => m.event_ticker)
                    );
                    return (
                      <tr 
                        key={day.value} 
                        className={`border-b border-slate-800/50 cursor-pointer hover:bg-slate-800/50 ${selectedGameDate === day.value ? 'bg-slate-800' : ''}`}
                        onClick={() => setSelectedGameDate(day.value)}
                      >
                        <td className="py-2 text-white">{day.label}</td>
                        <td className="py-2 text-right text-white font-mono">{uniqueEvents.size}</td>
                        <td className="py-2 text-right text-emerald-400 font-mono">{highOddsEvents.size}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  {(() => {
                    const gameDateSet = new Set(gameDateOptions.map(d => d.value));
                    const otherMarkets = marketsData?.markets.filter(m => {
                      const gameDate = extractGameDate(m);
                      return !gameDate || !gameDateSet.has(gameDate);
                    }) || [];
                    const otherEvents = new Set(otherMarkets.map(m => m.event_ticker));
                    const otherHighOddsEvents = new Set(
                      otherMarkets
                        .filter(m => {
                          const odds = m.favorite_odds * 100;
                          return odds >= displayOddsMin && odds <= displayOddsMax;
                        })
                        .map(m => m.event_ticker)
                    );
                    // Calculate totals for 7-day window
                    const allEventsInWindow = new Set<string>();
                    const highOddsEventsInWindow = new Set<string>();
                    gameDateOptions.forEach(day => {
                      const dayMarkets = marketsData?.markets.filter(m => extractGameDate(m) === day.value) || [];
                      dayMarkets.forEach(m => allEventsInWindow.add(m.event_ticker));
                      dayMarkets
                        .filter(m => {
                          const odds = m.favorite_odds * 100;
                          return odds >= displayOddsMin && odds <= displayOddsMax;
                        })
                        .forEach(m => highOddsEventsInWindow.add(m.event_ticker));
                    });
                    return (
                      <>
                        {otherEvents.size > 0 && (
                          <tr className="border-t border-slate-800 text-slate-500">
                            <td className="py-2">Other dates</td>
                            <td className="py-2 text-right font-mono">{otherEvents.size}</td>
                            <td className="py-2 text-right font-mono">{otherHighOddsEvents.size}</td>
                          </tr>
                        )}
                        <tr className="border-t-2 border-slate-700">
                          <td className="py-2 text-slate-400 font-medium">Total (7 days)</td>
                          <td className="py-2 text-right text-white font-mono font-bold">{allEventsInWindow.size}</td>
                          <td className="py-2 text-right text-emerald-400 font-mono font-bold">{highOddsEventsInWindow.size}</td>
                        </tr>
                      </>
                    );
                  })()}
                </tfoot>
              </table>
            </div>

            {/* Sports/Series Summary Table - Unique EVENTS */}
            <div className="bg-slate-900 rounded-xl p-4 mb-4">
              <h3 className="text-sm text-slate-400 mb-3">Events by Sport</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-800">
                    <th className="text-left py-2 font-medium">Sport</th>
                    <th className="text-right py-2 font-medium">All Events</th>
                    <th className="text-right py-2 font-medium">High-Odds</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    // Get markets filtered by selected game date
                    const dateFilteredMarkets = selectedGameDate === 'all'
                      ? (marketsData?.markets || [])
                      : (marketsData?.markets || []).filter(m => extractGameDate(m) === selectedGameDate);
                    
                    // Group by series - count unique EVENTS (not markets)
                    const seriesData: Record<string, { allEvents: Set<string>; highOddsEvents: Set<string> }> = {};
                    
                    for (const m of dateFilteredMarkets) {
                      const series = getSeriesTag(m.event_ticker);
                      if (!seriesData[series]) {
                        seriesData[series] = { allEvents: new Set(), highOddsEvents: new Set() };
                      }
                      seriesData[series].allEvents.add(m.event_ticker);
                      const odds = m.favorite_odds * 100;
                      if (odds >= displayOddsMin && odds <= displayOddsMax) {
                        seriesData[series].highOddsEvents.add(m.event_ticker);
                      }
                    }
                    
                    // Convert to counts and sort
                    const seriesCounts = Object.entries(seriesData).map(([series, data]) => ({
                      series,
                      all: data.allEvents.size,
                      highOdds: data.highOddsEvents.size,
                    }));
                    seriesCounts.sort((a, b) => b.all - a.all);
                    
                    const totalAll = seriesCounts.reduce((sum, d) => sum + d.all, 0);
                    const totalHighOdds = seriesCounts.reduce((sum, d) => sum + d.highOdds, 0);
                    
                    return (
                      <>
                        {seriesCounts.map(({ series, all, highOdds }) => (
                          <tr key={series} className="border-b border-slate-800/50">
                            <td className="py-2 text-white">{series}</td>
                            <td className="py-2 text-right text-white font-mono">{all}</td>
                            <td className="py-2 text-right text-emerald-400 font-mono">{highOdds}</td>
                          </tr>
                        ))}
                        <tr className="border-t-2 border-slate-700">
                          <td className="py-2 text-slate-400 font-medium">Total</td>
                          <td className="py-2 text-right text-white font-mono font-bold">{totalAll}</td>
                          <td className="py-2 text-right text-emerald-400 font-mono font-bold">{totalHighOdds}</td>
                        </tr>
                      </>
                    );
                  })()}
                </tbody>
              </table>
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

        {/* Positions Tab */}
        {activeTab === 'positions' && (
          <div className="py-8">
            {/* Sub-tabs: Active / Historical */}
            <div className="flex gap-2 mb-6">
              <button
                onClick={() => setPositionsSubTab('active')}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  positionsSubTab === 'active'
                    ? 'bg-amber-500 text-slate-950'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Active
              </button>
              <button
                onClick={() => setPositionsSubTab('historical')}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  positionsSubTab === 'historical'
                    ? 'bg-amber-500 text-slate-950'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Historical
              </button>
            </div>

            {/* Historical Timespan Filters */}
            {positionsSubTab === 'historical' && (
              <div className="flex gap-2 mb-4">
                <span className="text-sm text-slate-500 py-1">Timespan:</span>
                {([7, 30, 90] as const).map(days => (
                  <button
                    key={days}
                    onClick={() => setHistoricalDays(days)}
                    className={`px-3 py-1 text-sm rounded-lg transition-colors ${
                      historicalDays === days
                        ? 'bg-slate-700 text-white'
                        : 'bg-slate-800/50 text-slate-400 hover:text-white'
                    }`}
                  >
                    {days}D
                  </button>
                ))}
              </div>
            )}

            {/* Summary Stats - Above Table */}
            {(() => {
              const allOrders = orderBatches.flatMap(b => b.orders || []);
              const activeOrders = allOrders.filter(o => o.placement_status === 'confirmed' && o.result_status === 'undecided');
              
              // Filter historical orders by timespan (in ET)
              const todayET = getTodayET();
              const cutoffDateStr = addDaysToDateET(todayET, -historicalDays);
              
              const historicalOrders = allOrders.filter(o => {
                if (o.result_status !== 'won' && o.result_status !== 'lost') return false;
                // Find the batch date for this order
                const batch = orderBatches.find(b => b.orders?.some(bo => bo.id === o.id));
                return batch ? batch.batch_date >= cutoffDateStr : false;
              });
              
              const activeCost = activeOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
              const activePayout = activeOrders.reduce((sum, o) => sum + o.potential_payout_cents, 0);
              
              const wonOrders = historicalOrders.filter(o => o.result_status === 'won');
              const lostOrders = historicalOrders.filter(o => o.result_status === 'lost');
              const wonPayout = wonOrders.reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents), 0);
              const wonCost = wonOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
              const wonProfit = wonPayout - wonCost;
              const lostCost = lostOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
              const totalFees = historicalOrders.reduce((sum, o) => sum + (o.fee_cents || 0), 0);
              const historicalPnl = wonPayout - wonCost - lostCost - totalFees;
              
              // Show different cards based on which sub-tab is active
              if (positionsSubTab === 'active') {
                return (
                  <div className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <div className="text-xs text-slate-500 uppercase mb-1">Active Positions</div>
                      <div className="text-2xl font-bold text-white">{activeOrders.length}</div>
                    </div>
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <div className="text-xs text-slate-500 uppercase mb-1">Active Exposure</div>
                      <div className="text-2xl font-bold text-amber-400">${(activeCost / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    </div>
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <div className="text-xs text-slate-500 uppercase mb-1">Potential Payout</div>
                      <div className="text-2xl font-bold text-emerald-400">${(activePayout / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    </div>
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <div className="text-xs text-slate-500 uppercase mb-1">Potential Profit</div>
                      <div className="text-2xl font-bold text-emerald-400">+${((activePayout - activeCost) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    </div>
                  </div>
                );
              } else {
                return (
                  <div className="mb-6 grid grid-cols-2 md:grid-cols-5 gap-4">
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <div className="text-xs text-slate-500 uppercase mb-1">W/L ({historicalDays}D)</div>
                      <div className="text-2xl font-bold">
                        <span className="text-emerald-400">{wonOrders.length}W</span>
                        <span className="text-slate-500 mx-1">/</span>
                        <span className="text-red-400">{lostOrders.length}L</span>
                      </div>
                    </div>
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <div className="text-xs text-slate-500 uppercase mb-1">Won Profit</div>
                      <div className="text-2xl font-bold text-emerald-400">+${(wonProfit / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    </div>
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <div className="text-xs text-slate-500 uppercase mb-1">Lost Cost</div>
                      <div className="text-2xl font-bold text-red-400">-${(lostCost / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    </div>
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <div className="text-xs text-slate-500 uppercase mb-1">Total Fees</div>
                      <div className="text-2xl font-bold text-amber-400">-${(totalFees / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    </div>
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <div className="text-xs text-slate-500 uppercase mb-1">Net P&L</div>
                      <div className={`text-2xl font-bold ${historicalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {historicalPnl >= 0 ? '+' : ''}${(historicalPnl / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    </div>
                  </div>
                );
              }
            })()}

            {/* Positions Table */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-x-auto">
              <table className="w-full text-sm min-w-[1100px]">
                <thead className="bg-slate-800/50">
                  <tr>
                    <th className="text-left p-3 text-slate-400 font-medium">Market</th>
                    <th className="text-center p-3 text-slate-400 font-medium">Side</th>
                    <th className="text-right p-3 text-slate-400 font-medium">Units</th>
                    <th className="text-right p-3 text-slate-400 font-medium">Avg Price</th>
                    <th className="text-right p-3 text-slate-400 font-medium">Current Price</th>
                    <th className="text-right p-3 text-slate-400 font-medium">Cost</th>
                    <th className="text-right p-3 text-slate-400 font-medium">Payout</th>
                    <th className="text-right p-3 text-slate-400 font-medium">Fees</th>
                    <th className="text-right p-3 text-slate-400 font-medium">Profit</th>
                    <th className="text-center p-3 text-slate-400 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    // Get all orders from all batches
                    const allOrders = orderBatches.flatMap(b => b.orders || []);
                    
                    // Calculate cutoff date for historical filter (in ET)
                    const todayET = getTodayET();
                    const cutoffDateStr = addDaysToDateET(todayET, -historicalDays);
                    
                    // Filter by sub-tab (with timespan for historical)
                    const filteredOrders = positionsSubTab === 'active'
                      ? allOrders.filter(o => o.placement_status === 'confirmed' && o.result_status === 'undecided')
                      : allOrders.filter(o => {
                          if (o.result_status !== 'won' && o.result_status !== 'lost') return false;
                          const batch = orderBatches.find(b => b.orders?.some(bo => bo.id === o.id));
                          return batch ? batch.batch_date >= cutoffDateStr : false;
                        });
                    
                    // Helper to extract team abbreviation from title
                    const getTeamAbbrev = (title: string, side: string): string => {
                      // Format: "Denver at Kansas City Winner?" or "Cleveland vs New York Winner?"
                      const match = title.match(/^(.+?)\s+(?:at|vs)\s+(.+?)\s+Winner\?$/i);
                      if (match) {
                        const [, team1, team2] = match;
                        // YES typically means first team (away/first listed), NO means second team (home/second listed)
                        const selectedTeam = side === 'YES' ? team1 : team2;
                        // Get first 3 chars as abbreviation, or first word if short
                        const words = selectedTeam.trim().split(' ');
                        if (words.length === 1 && words[0].length <= 4) {
                          return words[0].toUpperCase();
                        }
                        // Use first 3 letters of first significant word
                        return words[0].substring(0, 3).toUpperCase();
                      }
                      return side;
                    };
                    
                    if (filteredOrders.length === 0) {
                      return (
                        <tr>
                          <td colSpan={10} className="p-8 text-center text-slate-500">
                            No {positionsSubTab} positions
                          </td>
                        </tr>
                      );
                    }
                    
                      return filteredOrders.map(order => {
                      const avgPrice = order.executed_cost_cents 
                        ? Math.round(order.executed_cost_cents / order.units) 
                        : order.price_cents;
                      const currentPrice = order.current_price_cents || order.price_cents;
                      
                      return (
                        <tr key={order.id} className="border-t border-slate-800 hover:bg-slate-800/30">
                          <td className="p-3 text-white">{order.title}</td>
                          <td className="p-3 text-center">
                            <span className={`px-2 py-1 rounded text-xs font-bold ${
                              order.side === 'YES' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                            }`}>
                              {getTeamAbbrev(order.title, order.side)}
                            </span>
                          </td>
                          <td className="p-3 text-right text-white font-mono">{order.units.toLocaleString()}</td>
                          <td className="p-3 text-right text-slate-400 font-mono">{avgPrice}¢</td>
                          <td className="p-3 text-right text-white font-mono">{currentPrice}¢</td>
                          <td className="p-3 text-right text-white font-mono">
                            ${((order.executed_cost_cents || order.cost_cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="p-3 text-right text-white font-mono">
                            ${(order.potential_payout_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="p-3 text-right text-white font-mono">
                            ${((order.fee_cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="p-3 text-right font-mono">
                            {(() => {
                              const cost = order.executed_cost_cents || order.cost_cents;
                              const fees = order.fee_cents || 0;
                              const payout = order.potential_payout_cents;
                              const profit = order.result_status === 'won' 
                                ? payout - cost - fees 
                                : order.result_status === 'lost' 
                                  ? -cost 
                                  : 0;
                              return (
                                <span className={profit >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                  {profit >= 0 ? '+' : ''}${(profit / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="p-3 text-center">
                            <span className={`px-2 py-1 rounded text-xs font-medium ${
                              order.result_status === 'won' ? 'bg-emerald-500/20 text-emerald-400' :
                              order.result_status === 'lost' ? 'bg-red-500/20 text-red-400' :
                              'bg-slate-700 text-slate-400'
                            }`}>
                              {order.result_status.toUpperCase()}
                            </span>
                          </td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Orders Tab (Live Trading) */}
        {activeTab === 'orders' && (
          <div className="py-8">
            {/* Capital Deployment Table */}
            <div className="bg-slate-900 rounded-xl p-4 mb-6 overflow-x-auto">
              <h3 className="text-sm text-slate-400 mb-3">Capital Deployment</h3>
              <table className="w-full text-sm min-w-[500px]">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-800">
                    <th className="text-left py-2 font-medium">Day</th>
                    <th className="text-right py-2 font-medium">Projected</th>
                    <th className="text-right py-2 font-medium">Actual</th>
                    <th className="text-right py-2 font-medium">%</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    // Generate 7 days centered on today (in ET)
                    const todayET = getTodayET();
                    const currentPortfolioValue = liveOrdersStats?.portfolio_value_cents || 1;
                    
                    const days: { date: string; label: string; isToday: boolean }[] = [];
                    for (let i = -3; i <= 3; i++) {
                      const dateStr = addDaysToDateET(todayET, i);
                      days.push({
                        date: dateStr,
                        label: formatDateForDisplay(dateStr),
                        isToday: i === 0
                      });
                    }
                    
                    // Get all orders from all batches
                    const allOrders = orderBatches.flatMap(b => b.orders || []);
                    
                    return days.map(day => {
                      // Filter orders by placement_status_at date (when they were actually placed)
                      const ordersForDay = allOrders.filter(o => {
                        if (!o.placement_status_at) return false;
                        const placedDate = getDateFromTimestampET(o.placement_status_at);
                        return placedDate === day.date;
                      });
                      
                      // Also get pending orders from batches for this day (for projected)
                      const batch = orderBatches.find(b => b.batch_date === day.date);
                      const pendingOrders = (batch?.orders || []).filter(o => o.placement_status === 'pending' || o.placement_status === 'placed');
                      
                      // Confirmed orders (placed on this day)
                      const confirmedOrders = ordersForDay.filter(o => o.placement_status === 'confirmed');
                      
                      // Actual = confirmed orders cost
                      const actualCents = confirmedOrders
                        .reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
                      
                      // Projected = pending orders for this batch + confirmed orders placed this day
                      const projectedCents = [...pendingOrders, ...confirmedOrders]
                        .reduce((sum, o) => sum + (o.cost_cents || 0), 0);
                      
                      // Count unique events (by event_ticker)
                      const projectedEvents = new Set([...pendingOrders, ...confirmedOrders].map(o => o.event_ticker)).size;
                      const actualEvents = new Set(confirmedOrders.map(o => o.event_ticker)).size;
                      
                      // Get starting portfolio value for that day from records data
                      const dayRecord = recordsData?.records?.find(r => r.date === day.date);
                      const startPortfolioForDay = dayRecord?.start_portfolio_cents || currentPortfolioValue;
                      
                      // Percentage = actual capital deployed / starting portfolio value
                      const pctOfPortfolio = startPortfolioForDay > 0 
                        ? Math.round((actualCents / startPortfolioForDay) * 100)
                        : 0;
                      
                      return (
                        <tr 
                          key={day.date} 
                          className={`border-b border-slate-800/50 ${day.isToday ? 'bg-blue-500/10' : ''}`}
                        >
                          <td className={`py-2 ${day.isToday ? 'text-blue-400 font-medium' : 'text-white'}`}>
                            {day.label} {day.isToday && <span className="text-xs bg-blue-500 text-white px-1.5 py-0.5 rounded ml-2">TODAY</span>}
                          </td>
                          <td className="py-2 text-right text-slate-400 font-mono">
                            <span className="text-slate-500">{projectedEvents}</span> | ${(projectedCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="py-2 text-right text-emerald-400 font-mono">
                            <span className="text-emerald-600">{actualEvents}</span> | ${(actualCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="py-2 text-right text-amber-400 font-mono">
                            {pctOfPortfolio}%
                          </td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
                <tfoot>
                  {(() => {
                    const todayET = getTodayET();
                    const currentPortfolioValue = liveOrdersStats?.portfolio_value_cents || 1;
                    let totalProjected = 0;
                    let totalActual = 0;
                    const allProjectedEvents = new Set<string>();
                    const allActualEvents = new Set<string>();
                    
                    // Get all orders from all batches
                    const allOrders = orderBatches.flatMap(b => b.orders || []);
                    
                    for (let i = -3; i <= 3; i++) {
                      const dateStr = addDaysToDateET(todayET, i);
                      
                      // Filter orders by placement_status_at date
                      const ordersForDay = allOrders.filter(o => {
                        if (!o.placement_status_at) return false;
                        const placedDate = getDateFromTimestampET(o.placement_status_at);
                        return placedDate === dateStr;
                      });
                      
                      // Also get pending orders from batches for this day
                      const batch = orderBatches.find(b => b.batch_date === dateStr);
                      const pendingOrders = (batch?.orders || []).filter(o => o.placement_status === 'pending' || o.placement_status === 'placed');
                      
                      const confirmedOrders = ordersForDay.filter(o => o.placement_status === 'confirmed');
                      
                      totalActual += confirmedOrders
                        .reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
                      totalProjected += [...pendingOrders, ...confirmedOrders].reduce((sum, o) => sum + (o.cost_cents || 0), 0);
                      
                      // Track unique events
                      [...pendingOrders, ...confirmedOrders].forEach(o => allProjectedEvents.add(o.event_ticker));
                      confirmedOrders.forEach(o => allActualEvents.add(o.event_ticker));
                    }
                    
                    // Use current portfolio value for total percentage
                    const totalPct = currentPortfolioValue > 0 
                      ? Math.round((totalActual / currentPortfolioValue) * 100)
                      : 0;
                    
                    return (
                      <tr className="border-t-2 border-slate-700">
                        <td className="py-2 text-slate-400 font-medium">Total (7 days)</td>
                        <td className="py-2 text-right text-white font-mono font-bold"><span className="text-slate-400">{allProjectedEvents.size}</span> | ${(totalProjected / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className="py-2 text-right text-emerald-400 font-mono font-bold"><span className="text-emerald-600">{allActualEvents.size}</span> | ${(totalActual / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className="py-2 text-right text-amber-400 font-mono font-bold">{totalPct}%</td>
                      </tr>
                    );
                  })()}
                </tfoot>
              </table>
            </div>

            {/* Day Toggle Bar */}
            {/* Day Filter and Actions Bar */}
            <div className="bg-slate-900 rounded-xl p-4 mb-6">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm text-slate-400">Filter by Day</div>
                <button
                  onClick={prepareWeek}
                  disabled={preparingWeek}
                  className="px-4 py-1.5 text-sm font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 transition-colors"
                >
                  {preparingWeek ? 'Preparing...' : 'Prepare Week'}
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {orderBatches.length > 0 ? (
                  [...orderBatches].sort((a, b) => a.batch_date.localeCompare(b.batch_date)).map((batch) => {
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
                  })
                ) : (
                  <span className="text-slate-500 text-sm">No batches yet. Click &quot;Prepare Week&quot; to create orders for the next 7 days.</span>
                )}
              </div>
            </div>

            {/* Order Summary - filtered by selected day */}
            {(() => {
              // Get orders for the selected day (or all if no day selected)
              const filteredBatches = orderBatches.filter(b => b.batch_date === selectedDay);
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
              // Won profit = payout - cost paid (profit before fees)
              const wonPayout = wonOrders.reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);
              const wonCost = wonOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
              const wonProfit = wonPayout - wonCost;
              const estimatedLost = lostOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
              const estimatedPnl = wonProfit - estimatedLost;
              
              // Calculate settlement breakdown
              const settledOrders = [...wonOrders, ...lostOrders];
              const pendingSettlement = settledOrders.filter(o => o.settlement_status === 'pending');
              const successOrders = settledOrders.filter(o => o.settlement_status === 'success');
              const closedOrders = settledOrders.filter(o => o.settlement_status === 'closed');
              // Pending profit = projected payout - cost
              const pendingWonOrders = pendingSettlement.filter(o => o.result_status === 'won');
              const pendingPayout = pendingWonOrders.reduce((sum, o) => sum + (o.potential_payout_cents || 0), 0);
              const pendingCost = pendingWonOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
              const projectedProfit = pendingPayout - pendingCost;
              // Success profit = actual payout - cost
              const successWonOrders = successOrders.filter(o => o.result_status === 'won');
              const actualPayout = successWonOrders.reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);
              const successCost = successWonOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
              const successProfit = actualPayout - successCost;
              const actualLost = closedOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
              const feesPaid = settledOrders.reduce((sum, o) => sum + (o.fee_cents || 0), 0);
              const netProfit = successProfit - actualLost - feesPaid;

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
                            <td className="py-1.5 text-right font-mono text-emerald-400">+${(wonProfit / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
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
                            <td className="py-1.5 text-right font-mono text-white">+${(projectedProfit / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                          </tr>
                          <tr>
                            <td className="py-1.5 text-slate-400">Success</td>
                            <td className="py-1.5 text-right text-emerald-400">{successOrders.length}</td>
                            <td className="py-1.5 text-right font-mono text-emerald-400">+${(successProfit / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
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
                {!orderBatches.some(b => b.batch_date === getTodayET()) && (
                  <button
                    onClick={() => prepareOrders(true)}
                    disabled={preparingOrders}
                    className="px-3 py-1.5 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50"
                  >
                    {preparingOrders ? '...' : '+ Prepare Today'}
                  </button>
                )}
                {!orderBatches.some(b => b.batch_date === addDaysToDateET(getTodayET(), 1)) && (
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
                  .filter(batch => batch.batch_date === selectedDay)
                  .map((batch) => {
                    // Add T12:00:00 to avoid timezone shift issues
                    const batchDate = new Date(batch.batch_date + 'T12:00:00Z');
                    const todayStr = getTodayET();
                    const tomorrowStr = addDaysToDateET(todayStr, 1);
                    const isToday = batch.batch_date === todayStr;
                    const isTomorrow = batch.batch_date === tomorrowStr;
                    
                    // Calculate batch stats (use actual cost when available)
                    const confirmedOrders = batch.orders.filter(o => o.placement_status === 'confirmed');
                    const wonOrders = batch.orders.filter(o => o.result_status === 'won');
                    const lostOrders = batch.orders.filter(o => o.result_status === 'lost');
                    const pendingOrders = batch.orders.filter(o => o.result_status === 'undecided');
                    const batchCost = confirmedOrders.reduce((sum, o) => sum + (o.executed_cost_cents ?? o.cost_cents), 0);
                    const batchPayout = wonOrders.reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents), 0);
                    // P&L = Payout received - Cost paid for wins - Cost paid for losses - Fees
                    const wonCost = wonOrders.reduce((sum, o) => sum + (o.executed_cost_cents ?? o.cost_cents), 0);
                    const lostCost = lostOrders.reduce((sum, o) => sum + (o.executed_cost_cents ?? o.cost_cents), 0);
                    const batchFees = [...wonOrders, ...lostOrders].reduce((sum, o) => sum + (o.fee_cents || 0), 0);
                    const batchPnl = batchPayout - wonCost - lostCost - batchFees;

                    return (
                      <div key={batch.id} className="bg-slate-900 rounded-xl overflow-hidden">
                        {/* Batch Header */}
                        <div
                          onClick={() => setExpandedBatch(expandedBatch === batch.id ? null : batch.id)}
                          className="p-4 flex items-center justify-between cursor-pointer hover:bg-slate-800/50 overflow-x-auto"
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
                            {/* Re-prepare & Execute button */}
                            {(isToday || isTomorrow) && (
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  const action = confirmedOrders.length > 0 
                                    ? 'This will DELETE existing orders and re-prepare with fresh markets. Continue?' 
                                    : 'Re-prepare batch with fresh markets and execute? This will place real orders!';
                                  if (!confirm(action)) return;
                                  setPreparingOrders(true);
                                  try {
                                    const res = await fetch('/api/orders-live/prepare-and-execute', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ forToday: isToday }),
                                    });
                                    const data = await res.json();
                                    if (data.success) {
                                      alert(`Success! Placed ${data.summary.orders_placed} orders. Cost: ${data.summary.total_cost}`);
                                      refreshAll();
                                    } else {
                                      alert(`Error: ${data.error}`);
                                    }
                                  } catch (err) {
                                    alert('Error preparing orders');
                                  } finally {
                                    setPreparingOrders(false);
                                  }
                                }}
                                disabled={preparingOrders}
                                className="px-3 py-1 rounded text-xs font-medium bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50"
                              >
                                {preparingOrders ? '...' : '🔄 Re-prepare'}
                              </button>
                            )}
                            {/* Execute button - for batches with pending orders */}
                            {batch.orders.filter((o: LiveOrder) => o.placement_status === 'pending' && !o.kalshi_order_id).length > 0 && (
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (!confirm(`Execute ${batch.orders.filter((o: LiveOrder) => !o.kalshi_order_id).length} pending orders? This will place real orders on Kalshi!`)) return;
                                  setExecutingOrders(true);
                                  try {
                                    const res = await fetch('/api/orders-live/force-execute', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ batchId: batch.id }),
                                    });
                                    const data = await res.json();
                                    if (data.success) {
                                      alert(`Executed! Success: ${data.summary.success}, Failed: ${data.summary.failed}, Skipped: ${data.summary.skipped}`);
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
                          <div className="border-t border-slate-800 overflow-x-auto">
                            <table className="w-full text-sm min-w-[800px]">
                              <thead className="bg-slate-800/50">
                                <tr>
                                  <th className="text-left p-3 text-slate-400 font-medium">Market</th>
                                  <th className="text-center p-3 text-slate-400 font-medium">Side</th>
                                  <th className="text-right p-3 text-slate-400 font-medium">Units</th>
                                  <th className="text-right p-3 text-slate-400 font-medium">Est. Cost</th>
                                  <th className="text-right p-3 text-slate-400 font-medium">Actual Cost</th>
                                  <th className="text-right p-3 text-slate-400 font-medium">Payout</th>
                                  <th className="text-right p-3 text-slate-400 font-medium">Open Int</th>
                                  <th className="text-right p-3 text-slate-400 font-medium">Vol 24h</th>
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
                                    <td className="p-3 text-right text-slate-400 font-mono text-sm">{order.open_interest?.toLocaleString() || '-'}</td>
                                    <td className="p-3 text-right text-slate-400 font-mono text-sm">{order.volume_24h?.toLocaleString() || '-'}</td>
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
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">Daily Records</h2>
            </div>

            {/* Summary Cards */}
            {recordsData && (
              <div className="flex flex-wrap gap-4 mb-6">
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-500 uppercase mb-2">Cash | Positions | Portfolio</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-lg text-white">${Math.round((recordsData.current_balance_cents || 0) / 100).toLocaleString('en-US')}</span>
                    <span className="text-slate-600">|</span>
                    <span className="text-lg text-amber-400">${Math.round((recordsData.current_positions_cents || 0) / 100).toLocaleString('en-US')}</span>
                    <span className="text-slate-600">|</span>
                    <span className="text-lg text-white">${Math.round(((recordsData.current_balance_cents || 0) + (recordsData.current_positions_cents || 0)) / 100).toLocaleString('en-US')}</span>
                  </div>
                </div>
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-500 uppercase mb-2">Total W-L</div>
                  <div className="text-lg font-bold text-white">
                    {recordsData.totals?.wins || 0}W / {recordsData.totals?.losses || 0}L
                  </div>
                </div>
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-500 uppercase mb-2">Total P&L</div>
                  <div className={`text-lg ${(recordsData.totals?.pnl_cents || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {(recordsData.totals?.pnl_cents || 0) >= 0 ? '+' : ''}${Math.round((recordsData.totals?.pnl_cents || 0) / 100).toLocaleString('en-US')}
                  </div>
                </div>
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-500 uppercase mb-2">Avg Daily ROIC</div>
                  {(() => {
                    const today = getTodayET();
                    // Only include past days (not today or tomorrow)
                    const pastRecords = (recordsData.records || []).filter(r => 
                      r.date < today
                    );
                    const avgRoic = pastRecords.length > 0 
                      ? pastRecords.reduce((sum, r) => sum + parseFloat(String(r.roic_percent || 0)), 0) / pastRecords.length
                      : 0;
                    return (
                      <div className={`text-lg font-bold ${avgRoic >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {avgRoic >= 0 ? '+' : ''}{avgRoic.toFixed(2)}%
                      </div>
                    );
                  })()}
                </div>
                <button
                  onClick={() => setShowRulesModal(true)}
                  className="bg-slate-900 rounded-xl p-4 border border-slate-800 hover:border-slate-600 transition-colors flex items-center gap-2"
                >
                  <span className="text-sm text-slate-300">Rules</span>
                  <IoInformationCircleSharp className="w-5 h-5 text-slate-400" />
                </button>
              </div>
            )}

            {/* Records Table */}
            {recordsLoading && !recordsData ? (
              <div className="text-center py-12 text-slate-400">Loading records...</div>
            ) : recordsData?.records && recordsData.records.length > 0 ? (
              <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-x-auto">
                <table className="w-full min-w-[800px]">
                  <thead className="bg-slate-800/50">
                    <tr>
                      <th className="text-left p-4 text-slate-400 font-medium text-sm">Date</th>
                      <th className="text-center p-4 text-slate-400 font-medium text-sm">Start</th>
                      <th className="text-center p-4 text-slate-400 font-medium text-sm">End</th>
                      <th className="text-center p-4 text-slate-400 font-medium text-sm">W/L/P</th>
                      <th className="text-right p-4 text-slate-400 font-medium text-sm">Deployed</th>
                      <th className="text-center p-4 text-slate-400 font-medium text-sm">Odds(¢) | Win%</th>
                      <th className="text-right p-4 text-slate-400 font-medium text-sm">P&L</th>
                      <th className="text-right p-4 text-slate-400 font-medium text-sm">ROIC</th>
                      <th className="text-center p-4 text-slate-400 font-medium text-sm">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recordsData.records
                      .filter(record => record.date <= getTodayET())
                      .map((record, idx) => {
                      // Get deployed amount for this day based on placement_status_at timestamp
                      const allOrders = orderBatches.flatMap(b => b.orders || []);
                      const confirmedOrders = allOrders.filter(o => {
                        if (o.placement_status !== 'confirmed' || !o.placement_status_at) return false;
                        const placedDate = getDateFromTimestampET(o.placement_status_at);
                        return placedDate === record.date;
                      });
                      const deployedCents = confirmedOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
                      const numEvents = new Set(confirmedOrders.map(o => o.event_ticker)).size;
                      
                      return (
                        <tr key={record.date} className={`border-t border-slate-800 ${idx % 2 === 0 ? 'bg-slate-900' : 'bg-slate-900/50'}`}>
                          <td className="p-4 text-white font-medium">
                            {new Date(record.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                          </td>
                          <td className="p-4 text-center font-mono">
                            <span className="text-slate-300">${Math.round(record.start_cash_cents / 100).toLocaleString('en-US')}</span>
                            <span className="text-slate-500 mx-1">|</span>
                            <span className="text-slate-400">${Math.round(record.start_portfolio_cents / 100).toLocaleString('en-US')}</span>
                          </td>
                          <td className="p-4 text-center font-mono">
                            <span className="text-slate-300">${Math.round(record.end_cash_cents / 100).toLocaleString('en-US')}</span>
                            <span className="text-slate-500 mx-1">|</span>
                            <span className="text-white">${Math.round(record.end_portfolio_cents / 100).toLocaleString('en-US')}</span>
                          </td>
                          <td className="p-4 text-center">
                            <span className="text-emerald-400">{record.wins}</span>
                            <span className="text-slate-500">/</span>
                            <span className="text-red-400">{record.losses}</span>
                            <span className="text-slate-500">/</span>
                            <span className="text-amber-400">{record.pending}</span>
                          </td>
                          <td className="p-4 text-right font-mono text-emerald-400">
                            {deployedCents > 0 ? (
                              <><span className="text-emerald-600">{numEvents}</span>|${Math.round(deployedCents / 100).toLocaleString('en-US')}</>
                            ) : '—'}
                          </td>
                          <td className="p-4 text-center font-mono">
                            {(() => {
                              const odds = record.avg_price_cents;
                              const winPct = record.wins + record.losses > 0 
                                ? Math.round((record.wins / (record.wins + record.losses)) * 100) 
                                : null;
                              const oddsHigher = winPct !== null && odds > winPct;
                              const winHigher = winPct !== null && winPct > odds;
                              return (
                                <>
                                  <span className={oddsHigher ? 'text-red-400' : 'text-slate-300'}>
                                    {odds > 0 ? odds : '—'}
                                  </span>
                                  <span className="text-slate-500 mx-1">|</span>
                                  <span className={winHigher ? 'text-emerald-400' : 'text-slate-300'}>
                                    {winPct !== null ? winPct : '—'}
                                  </span>
                                </>
                              );
                            })()}
                          </td>
                          <td className={`p-4 text-right font-mono ${record.pnl_cents >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {record.pnl_cents >= 0 ? '+' : ''}${Math.round(record.pnl_cents / 100).toLocaleString('en-US')}
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
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-12 text-slate-400">No records found. Daily snapshots are captured automatically at 11:55pm ET.</div>
            )}
          </div>
        )}

        {/* Losses Tab */}
        {activeTab === 'losses' && (
          <div className="py-8">
            {/* Header */}
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">Loss Analysis</h2>
              <p className="text-slate-400 text-sm mt-1">Detailed breakdown of losing trades</p>
            </div>

            {lossesLoading && !lossesData ? (
              <div className="text-center py-12 text-slate-400">Loading loss data...</div>
            ) : lossesData?.losses && lossesData.losses.length > 0 ? (
              <>
                {/* Summary Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                  <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                    <div className="text-xs text-slate-500 uppercase mb-1">Total Losses</div>
                    <div className="text-2xl font-bold text-red-400">{lossesData.summary.total_losses}</div>
                  </div>
                  <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                    <div className="text-xs text-slate-500 uppercase mb-1">Total Lost</div>
                    <div className="text-2xl font-bold text-red-400">
                      -${(lossesData.summary.total_lost_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </div>
                  </div>
                  <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                    <div className="text-xs text-slate-500 uppercase mb-1">Avg Odds Paid</div>
                    <div className="text-2xl font-bold text-amber-400">{lossesData.summary.avg_odds}¢</div>
                  </div>
                  <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                    <div className="text-xs text-slate-500 uppercase mb-1">Avg Loss/Trade</div>
                    <div className="text-2xl font-bold text-red-400">
                      -${(lossesData.summary.total_lost_cents / lossesData.summary.total_losses / 100).toFixed(2)}
                    </div>
                  </div>
                </div>

                {/* Pattern Analysis */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
                  {/* By Sport */}
                  <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                    <h3 className="text-sm font-medium text-slate-400 mb-3">Losses by Sport</h3>
                    <div className="space-y-2">
                      {Object.entries(lossesData.summary.by_sport)
                        .sort((a, b) => b[1].lost_cents - a[1].lost_cents)
                        .map(([sport, data]) => (
                          <div key={sport} className="flex justify-between items-center">
                            <span className="text-white">{sport}</span>
                            <div className="text-right">
                              <span className="text-red-400 font-mono">-${(data.lost_cents / 100).toLocaleString()}</span>
                              <span className="text-slate-500 text-xs ml-2">({data.count})</span>
                              <span className="text-slate-400 text-xs ml-2">{data.avg_odds}¢</span>
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>

                  {/* By Odds Range */}
                  <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                    <h3 className="text-sm font-medium text-slate-400 mb-3">Losses by Odds Range</h3>
                    <div className="space-y-2">
                      {Object.entries(lossesData.summary.by_odds_range)
                        .filter(([, data]) => data.count > 0)
                        .sort((a, b) => b[1].lost_cents - a[1].lost_cents)
                        .map(([range, data]) => (
                          <div key={range} className="flex justify-between items-center">
                            <span className="text-white">{range}</span>
                            <div className="text-right">
                              <span className="text-red-400 font-mono">-${(data.lost_cents / 100).toLocaleString()}</span>
                              <span className="text-slate-500 text-xs ml-2">({data.count})</span>
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>

                  {/* By Day of Week */}
                  <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                    <h3 className="text-sm font-medium text-slate-400 mb-3">Losses by Day</h3>
                    <div className="space-y-2">
                      {Object.entries(lossesData.summary.by_day_of_week)
                        .sort((a, b) => b[1].lost_cents - a[1].lost_cents)
                        .map(([day, data]) => (
                          <div key={day} className="flex justify-between items-center">
                            <span className="text-white">{day}</span>
                            <div className="text-right">
                              <span className="text-red-400 font-mono">-${(data.lost_cents / 100).toLocaleString()}</span>
                              <span className="text-slate-500 text-xs ml-2">({data.count})</span>
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>

                  {/* By Venue (Home/Away) */}
                  <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                    <h3 className="text-sm font-medium text-slate-400 mb-3">Losses by Venue</h3>
                    <div className="space-y-2">
                      {lossesData.summary.by_venue && Object.entries(lossesData.summary.by_venue)
                        .filter(([, data]) => data.count > 0)
                        .sort((a, b) => b[1].lost_cents - a[1].lost_cents)
                        .map(([venue, data]) => (
                          <div key={venue} className="flex justify-between items-center">
                            <span className="text-white capitalize flex items-center gap-2">
                              {venue === 'home' && '🏠'}
                              {venue === 'away' && '✈️'}
                              {venue === 'neutral' && '⚖️'}
                              {venue}
                            </span>
                            <div className="text-right">
                              <span className="text-red-400 font-mono">-${(data.lost_cents / 100).toLocaleString()}</span>
                              <span className="text-slate-500 text-xs ml-2">({data.count})</span>
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                </div>

                {/* Top Losing Teams */}
                {lossesData.summary.top_losing_teams && lossesData.summary.top_losing_teams.length > 0 && (
                  <div className="bg-slate-900 rounded-xl p-4 border border-slate-800 mb-6">
                    <h3 className="text-sm font-medium text-slate-400 mb-3">Teams We Lost Betting On (Most Frequent)</h3>
                    <div className="flex flex-wrap gap-2">
                      {lossesData.summary.top_losing_teams.map(({ team, count }) => (
                        <span key={team} className="px-3 py-1 bg-red-500/20 text-red-400 rounded-full text-sm">
                          {team} <span className="text-red-300">({count})</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Monthly Breakdown */}
                {lossesData.summary.by_month && Object.keys(lossesData.summary.by_month).length > 0 && (
                  <div className="bg-slate-900 rounded-xl p-4 border border-slate-800 mb-6">
                    <h3 className="text-sm font-medium text-slate-400 mb-3">Losses by Month</h3>
                    <div className="flex flex-wrap gap-4">
                      {Object.entries(lossesData.summary.by_month)
                        .sort((a, b) => b[0].localeCompare(a[0]))
                        .map(([month, data]) => (
                          <div key={month} className="text-center">
                            <div className="text-slate-400 text-xs">{month}</div>
                            <div className="text-red-400 font-mono">-${(data.lost_cents / 100).toLocaleString()}</div>
                            <div className="text-slate-500 text-xs">{data.count} losses</div>
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                {/* Detailed Losses Table */}
                <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-x-auto">
                  <table className="w-full text-sm min-w-[1100px]">
                    <thead className="bg-slate-800/50">
                      <tr>
                        <th className="text-left p-3 text-slate-400 font-medium">Date</th>
                        <th className="text-left p-3 text-slate-400 font-medium">Market</th>
                        <th className="text-center p-3 text-slate-400 font-medium">Sport</th>
                        <th className="text-center p-3 text-slate-400 font-medium">Venue</th>
                        <th className="text-center p-3 text-slate-400 font-medium">Side</th>
                        <th className="text-right p-3 text-slate-400 font-medium">Units</th>
                        <th className="text-right p-3 text-slate-400 font-medium">Entry Price</th>
                        <th className="text-right p-3 text-slate-400 font-medium">Lost</th>
                        <th className="text-left p-3 text-slate-400 font-medium">Fill History</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lossesData.losses.map((loss) => (
                        <tr key={loss.id} className="border-t border-slate-800 hover:bg-slate-800/30">
                          <td className="p-3 text-slate-400 font-mono text-xs">
                            {new Date(loss.batch_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </td>
                          <td className="p-3 text-white max-w-[300px] truncate" title={loss.title}>
                            {loss.title}
                          </td>
                          <td className="p-3 text-center">
                            <span className="px-2 py-1 rounded text-xs bg-slate-700 text-slate-300">
                              {loss.sport}
                            </span>
                          </td>
                          <td className="p-3 text-center">
                            <span className={`px-2 py-1 rounded text-xs ${
                              loss.venue === 'home' ? 'bg-blue-500/20 text-blue-400' : 
                              loss.venue === 'away' ? 'bg-orange-500/20 text-orange-400' : 
                              'bg-slate-700 text-slate-400'
                            }`}>
                              {loss.venue === 'home' && '🏠 '}
                              {loss.venue === 'away' && '✈️ '}
                              {loss.venue.toUpperCase()}
                            </span>
                          </td>
                          <td className="p-3 text-center">
                            <span className={`px-2 py-1 rounded text-xs font-bold ${
                              loss.side === 'YES' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                            }`}>
                              {loss.side}
                            </span>
                          </td>
                          <td className="p-3 text-right text-white font-mono">{loss.units.toLocaleString()}</td>
                          <td className="p-3 text-right text-amber-400 font-mono">{loss.entry_price_cents}¢</td>
                          <td className="p-3 text-right text-red-400 font-mono">
                            -${(loss.cost_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="p-3 text-slate-400 text-xs">
                            {loss.fills && loss.fills.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {loss.fills.slice(0, 3).map((fill, i) => (
                                  <span key={i} className="px-1.5 py-0.5 bg-slate-800 rounded text-xs">
                                    {fill.count.toLocaleString()}@{fill.price}¢
                                  </span>
                                ))}
                                {loss.fills.length > 3 && (
                                  <span className="text-slate-500">+{loss.fills.length - 3} more</span>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="text-center py-12 text-slate-400">
                No losses found in the last 90 days. 🎉
              </div>
            )}
          </div>
        )}

        {/* What If Tab */}
        {activeTab === 'whatif' && (
          <div className="py-8">
            {/* Header */}
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">What If Analysis</h2>
              <p className="text-slate-400 text-sm mt-1">Simulate automatic stop-loss selling with historical price data</p>
            </div>

            {whatIfLoading && !whatIfData ? (
              <div className="text-center py-12 text-slate-400">
                Loading historical data from Kalshi...
              </div>
            ) : whatIfData?.summary ? (
              <>
                {/* Data Quality Indicator */}
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800 mb-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-slate-400">Orders analyzed:</span>
                      <span className="text-white ml-2">{whatIfData.summary.total_orders}</span>
                      <span className="text-slate-500 mx-2">|</span>
                      <span className="text-emerald-400">{whatIfData.summary.won}W</span>
                      <span className="text-slate-500 mx-1">/</span>
                      <span className="text-red-400">{whatIfData.summary.lost}L</span>
                    </div>
                    <div>
                      <span className="text-slate-400">With price history:</span>
                      <span className={`ml-2 ${whatIfData.summary.has_price_history > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {whatIfData.summary.has_price_history} / {whatIfData.summary.total_orders}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Stop-Loss Slider */}
                <div className="bg-slate-900 rounded-xl p-6 border border-slate-800 mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-lg font-medium text-white">Stop-Loss Price</h3>
                      <p className="text-sm text-slate-400">Auto-sell when price drops below this level</p>
                    </div>
                    <div className="text-3xl font-bold text-purple-400">{stopLossPrice}¢</div>
                  </div>
                  <input
                    type="range"
                    min="30"
                    max="85"
                    step="5"
                    value={stopLossPrice}
                    onChange={(e) => setStopLossPrice(parseInt(e.target.value))}
                    className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                  />
                  <div className="flex justify-between text-xs text-slate-500 mt-2">
                    <span>30¢ (aggressive)</span>
                    <span>60¢</span>
                    <span>85¢ (conservative)</span>
                  </div>
                </div>

                {/* Comparison Cards */}
                {whatIfData.summary.stop_loss_results[stopLossPrice] && (
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <div className="text-xs text-slate-500 uppercase mb-1">Actual P&L</div>
                      <div className={`text-2xl font-bold ${whatIfData.summary.actual_pnl_cents >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {whatIfData.summary.actual_pnl_cents >= 0 ? '+' : ''}${(whatIfData.summary.actual_pnl_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </div>
                    </div>
                    <div className="bg-slate-900 rounded-xl p-4 border border-purple-500/50">
                      <div className="text-xs text-slate-500 uppercase mb-1">Simulated @ {stopLossPrice}¢</div>
                      <div className={`text-2xl font-bold ${whatIfData.summary.stop_loss_results[stopLossPrice].simulatedPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {whatIfData.summary.stop_loss_results[stopLossPrice].simulatedPnL >= 0 ? '+' : ''}${(whatIfData.summary.stop_loss_results[stopLossPrice].simulatedPnL / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </div>
                    </div>
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <div className="text-xs text-slate-500 uppercase mb-1">Improvement</div>
                      <div className={`text-2xl font-bold ${whatIfData.summary.stop_loss_results[stopLossPrice].improvement >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {whatIfData.summary.stop_loss_results[stopLossPrice].improvement >= 0 ? '+' : ''}${(whatIfData.summary.stop_loss_results[stopLossPrice].improvement / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </div>
                    </div>
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <div className="text-xs text-slate-500 uppercase mb-1">Trades Affected</div>
                      <div className="text-lg font-bold">
                        <span className="text-red-400">{whatIfData.summary.stop_loss_results[stopLossPrice].lossesTriggered}L</span>
                        <span className="text-slate-500 mx-1">/</span>
                        <span className="text-emerald-400">{whatIfData.summary.stop_loss_results[stopLossPrice].winsTriggered}W</span>
                      </div>
                      <div className="text-xs text-slate-500 mt-1">would trigger stop</div>
                    </div>
                  </div>
                )}

                {/* Breakdown */}
                {whatIfData.summary.stop_loss_results[stopLossPrice] && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <h3 className="text-sm font-medium text-slate-400 mb-3">Loss Recovery @ {stopLossPrice}¢</h3>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-slate-400">Losses that would trigger</span>
                          <span className="text-white">{whatIfData.summary.stop_loss_results[stopLossPrice].lossesTriggered} / {whatIfData.summary.lost}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Amount recovered</span>
                          <span className="text-emerald-400">+${(whatIfData.summary.stop_loss_results[stopLossPrice].lossRecovery / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                        </div>
                      </div>
                    </div>
                    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                      <h3 className="text-sm font-medium text-slate-400 mb-3">Missed Wins @ {stopLossPrice}¢</h3>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-slate-400">Wins that would trigger</span>
                          <span className="text-white">{whatIfData.summary.stop_loss_results[stopLossPrice].winsTriggered} / {whatIfData.summary.won}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Profit missed</span>
                          <span className="text-red-400">-${(whatIfData.summary.stop_loss_results[stopLossPrice].missedWinProfit / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Optimal Stop-Loss Finder */}
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-800 mb-6">
                  <h3 className="text-sm font-medium text-slate-400 mb-3">Find Optimal Stop-Loss</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-slate-400 border-b border-slate-700">
                          <th className="text-left py-2">Stop-Loss</th>
                          <th className="text-right py-2">Losses Triggered</th>
                          <th className="text-right py-2">Wins Triggered</th>
                          <th className="text-right py-2">Recovery</th>
                          <th className="text-right py-2">Missed Profit</th>
                          <th className="text-right py-2">Simulated P&L</th>
                          <th className="text-right py-2">vs Actual</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(whatIfData.summary.stop_loss_results)
                          .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
                          .map(([sl, result]) => {
                            const isOptimal = parseInt(sl) === whatIfData.summary.optimal_stop_loss.price;
                            return (
                              <tr 
                                key={sl} 
                                className={`border-b border-slate-800 ${isOptimal ? 'bg-purple-500/10' : ''} ${parseInt(sl) === stopLossPrice ? 'ring-1 ring-purple-500' : ''}`}
                              >
                                <td className="py-2">
                                  <span className={isOptimal ? 'text-purple-400 font-bold' : 'text-white'}>
                                    {sl}¢ {isOptimal && '⭐'}
                                  </span>
                                </td>
                                <td className="py-2 text-right text-red-400">{result.lossesTriggered}</td>
                                <td className="py-2 text-right text-amber-400">{result.winsTriggered}</td>
                                <td className="py-2 text-right text-emerald-400 font-mono">
                                  +${(result.lossRecovery / 100).toLocaleString()}
                                </td>
                                <td className="py-2 text-right text-red-400 font-mono">
                                  -${(result.missedWinProfit / 100).toLocaleString()}
                                </td>
                                <td className={`py-2 text-right font-mono ${result.simulatedPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {result.simulatedPnL >= 0 ? '+' : ''}${(result.simulatedPnL / 100).toLocaleString()}
                                </td>
                                <td className={`py-2 text-right font-mono font-bold ${result.improvement >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {result.improvement >= 0 ? '+' : ''}${(result.improvement / 100).toLocaleString()}
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 text-sm text-slate-400">
                    <span className="text-purple-400">⭐ Optimal stop-loss: {whatIfData.summary.optimal_stop_loss.price}¢</span>
                    {' '}would have improved P&L by{' '}
                    <span className={whatIfData.summary.optimal_stop_loss.improvement >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      ${(whatIfData.summary.optimal_stop_loss.improvement / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>

                {/* Individual Trade Analysis */}
                {whatIfData.orders.filter(o => o.price_history.length > 0 || o.min_price_after_entry !== null).length > 0 && (
                  <div className="bg-slate-900 rounded-xl p-4 border border-slate-800 mb-6">
                    <h3 className="text-sm font-medium text-slate-400 mb-3">
                      Trades with Price History ({whatIfData.orders.filter(o => o.price_history.length > 0).length} orders)
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-slate-400 border-b border-slate-700">
                            <th className="text-left py-2">Market</th>
                            <th className="text-center py-2">Result</th>
                            <th className="text-right py-2">Entry</th>
                            <th className="text-right py-2">Min Price</th>
                            <th className="text-right py-2">Max Price</th>
                            <th className="text-center py-2">Would Trigger @ {stopLossPrice}¢</th>
                          </tr>
                        </thead>
                        <tbody>
                          {whatIfData.orders
                            .filter(o => o.min_price_after_entry !== null)
                            .slice(0, 20)
                            .map((order) => (
                              <tr key={order.id} className="border-b border-slate-800">
                                <td className="py-2 text-white max-w-[200px] truncate" title={order.title}>
                                  {order.title}
                                </td>
                                <td className="py-2 text-center">
                                  <span className={`px-2 py-0.5 rounded text-xs ${order.result_status === 'won' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                                    {order.result_status.toUpperCase()}
                                  </span>
                                </td>
                                <td className="py-2 text-right text-white font-mono">{order.entry_price_cents}¢</td>
                                <td className="py-2 text-right text-red-400 font-mono">
                                  {order.min_price_after_entry !== null ? `${order.min_price_after_entry}¢` : '—'}
                                </td>
                                <td className="py-2 text-right text-emerald-400 font-mono">
                                  {order.max_price_after_entry !== null ? `${order.max_price_after_entry}¢` : '—'}
                                </td>
                                <td className="py-2 text-center">
                                  {order.would_trigger_at[stopLossPrice] ? (
                                    <span className="text-amber-400">✓ Yes</span>
                                  ) : (
                                    <span className="text-slate-500">No</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Note about data */}
                <div className="bg-purple-500/10 border border-purple-500/30 rounded-xl p-4 text-purple-300 text-sm">
                  <strong>📊 Data Source:</strong> Historical price data is fetched from Kalshi&apos;s candlestick API where available.
                  For orders without price history, estimates are used based on entry price proximity to stop-loss.
                </div>
              </>
            ) : (
              <div className="text-center py-12 text-slate-400">
                No settled orders to analyze yet.
              </div>
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

      {/* Rules Modal */}
      {showRulesModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setShowRulesModal(false)}>
          <div 
            className="bg-slate-900 rounded-xl border border-slate-700 max-w-lg w-full p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-white">Investment Rules</h3>
              <button 
                onClick={() => setShowRulesModal(false)}
                className="text-slate-400 hover:text-white transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <ul className="text-sm text-slate-400 space-y-2">
              <li>— <span className="text-emerald-400">Only bet on games happening TODAY</span></li>
              <li>— <span className="text-red-400 font-bold">ONLY 90-99.5% odds</span> (NEVER below 90%)</li>
              <li>— Execute orders starting at <span className="text-white">6am ET</span> on game day</li>
              <li>— Maximum <span className="text-white">3% of portfolio per EVENT</span></li>
              <li>— Can add to event if under 3% (tracks remaining capacity)</li>
              <li>— Monitor every <span className="text-white">5 minutes</span> for new opportunities</li>
              <li>— Improve resting order price by 1¢ after 1 hour</li>
              <li>— Cancel unfilled orders after 4 hours</li>
              <li>— Blacklist illiquid markets that fail to fill</li>
            </ul>
          </div>
        </div>
      )}
    </main>
  );
}
