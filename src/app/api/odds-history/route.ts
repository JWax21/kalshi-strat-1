import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getPositions, getOrderbook } from '@/lib/kalshi';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DROP_ALERT_THRESHOLD = 0.10; // 10% drop triggers alert
const DROP_ALERT_WINDOW_MINUTES = 10; // Look back 10 minutes
const RETENTION_DAYS = 7; // Keep data for 7 days

interface OddsLogEntry {
  ticker: string;
  event_ticker: string;
  title: string;
  side: 'yes' | 'no';
  yes_price_cents: number;
  our_side_odds_cents: number;
  logged_at: string;
  drop_alert: boolean;
  drop_percent: number | null;
  data_quality: 'high' | 'medium' | 'low' | 'error';
}

function generateSignature(timestampMs: string, method: string, path: string): string {
  const pathWithoutQuery = path.split('?')[0];
  const message = `${timestampMs}${method}${pathWithoutQuery}`;
  const privateKey = crypto.createPrivateKey(KALSHI_CONFIG.privateKey);
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signature.toString('base64');
}

async function fetchKalshiDirect(endpoint: string): Promise<any> {
  const timestampMs = Date.now().toString();
  const method = 'GET';
  const fullPath = `/trade-api/v2${endpoint}`;
  const signature = generateSignature(timestampMs, method, fullPath);
  
  const response = await fetch(`${KALSHI_CONFIG.baseUrl}${endpoint}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': KALSHI_CONFIG.apiKey,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    },
  });
  
  if (!response.ok) {
    throw new Error(`Kalshi API error: ${response.status}`);
  }
  
  return response.json();
}

async function logOddsAndCheckAlerts(): Promise<{
  logged: number;
  alerts: { ticker: string; title: string; currentOdds: number; previousOdds: number; dropPercent: number }[];
  errors: string[];
  cleaned: number;
}> {
  const result = {
    logged: 0,
    alerts: [] as { ticker: string; title: string; currentOdds: number; previousOdds: number; dropPercent: number }[],
    errors: [] as string[],
    cleaned: 0,
  };

  const now = new Date();
  const nowISO = now.toISOString();

  try {
    // Step 1: Get all current positions from Kalshi
    const positionsResponse = await getPositions();
    const positions = positionsResponse.market_positions || [];
    
    if (positions.length === 0) {
      return result;
    }

    // Step 2: Get orders from our database to get titles
    const { data: orders } = await supabase
      .from('orders')
      .select('ticker, event_ticker, title, side')
      .in('placement_status', ['confirmed', 'placed'])
      .eq('result_status', 'undecided');
    
    const orderMap = new Map(orders?.map(o => [o.ticker, o]) || []);

    // Step 3: Fetch current odds for each position
    const entries: OddsLogEntry[] = [];

    for (const pos of positions) {
      const ticker = pos.ticker;
      const contracts = Math.abs(pos.position || 0);
      if (contracts === 0) continue;

      const side = pos.position > 0 ? 'yes' : 'no';
      const orderInfo = orderMap.get(ticker);

      try {
        // Fetch market data
        const marketResponse = await fetchKalshiDirect(`/markets/${ticker}`);
        const market = marketResponse.market;
        
        if (!market) {
          result.errors.push(`No market data for ${ticker}`);
          continue;
        }

        // Get yes price (use bid for what we could sell at)
        const yesBid = market.yes_bid || 0;
        const yesAsk = market.yes_ask || 0;
        const lastPrice = market.last_price || 0;
        
        // Determine data quality
        let dataQuality: 'high' | 'medium' | 'low' | 'error' = 'high';
        let yesPriceCents = yesBid;
        
        if (yesBid === 0 && yesAsk === 0) {
          if (lastPrice > 0) {
            yesPriceCents = lastPrice;
            dataQuality = 'low';
          } else {
            dataQuality = 'error';
            result.errors.push(`No price data for ${ticker}`);
            continue;
          }
        } else if (Math.abs(yesAsk - yesBid) > 20) {
          dataQuality = 'medium';
        }

        // Calculate our side's odds
        const ourSideOddsCents = side === 'yes' ? yesPriceCents : (100 - yesPriceCents);

        entries.push({
          ticker,
          event_ticker: orderInfo?.event_ticker || ticker.split('-').slice(0, -1).join('-'),
          title: orderInfo?.title || market.title || ticker,
          side: side as 'yes' | 'no',
          yes_price_cents: yesPriceCents,
          our_side_odds_cents: ourSideOddsCents,
          logged_at: nowISO,
          drop_alert: false, // Will be updated after checking history
          drop_percent: null,
          data_quality: dataQuality,
        });

        // Rate limiting
        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        result.errors.push(`Error fetching ${ticker}: ${err}`);
      }
    }

    if (entries.length === 0) {
      return result;
    }

    // Step 4: Check for 10% drops in last 10 minutes
    const windowStart = new Date(now.getTime() - DROP_ALERT_WINDOW_MINUTES * 60 * 1000).toISOString();
    
    // Get historical data for comparison
    const { data: historicalData } = await supabase
      .from('odds_history')
      .select('ticker, our_side_odds_cents, logged_at')
      .gte('logged_at', windowStart)
      .order('logged_at', { ascending: true });

    // Group historical data by ticker
    const historyByTicker = new Map<string, { odds: number; time: string }[]>();
    for (const h of historicalData || []) {
      if (!historyByTicker.has(h.ticker)) {
        historyByTicker.set(h.ticker, []);
      }
      historyByTicker.get(h.ticker)!.push({ odds: h.our_side_odds_cents, time: h.logged_at });
    }

    // Check each entry for drops
    for (const entry of entries) {
      const history = historyByTicker.get(entry.ticker);
      
      if (history && history.length > 0) {
        // Get the oldest price in the window (10 minutes ago)
        const oldestEntry = history[0];
        const oldestOdds = oldestEntry.odds;
        const currentOdds = entry.our_side_odds_cents;
        
        if (oldestOdds > 0) {
          const dropPercent = (oldestOdds - currentOdds) / oldestOdds;
          entry.drop_percent = Math.round(dropPercent * 1000) / 10; // Store as percentage with 1 decimal
          
          if (dropPercent >= DROP_ALERT_THRESHOLD) {
            entry.drop_alert = true;
            result.alerts.push({
              ticker: entry.ticker,
              title: entry.title,
              currentOdds: currentOdds,
              previousOdds: oldestOdds,
              dropPercent: Math.round(dropPercent * 100),
            });
          }
        }
      }
    }

    // Step 5: Insert new entries
    const { error: insertError } = await supabase
      .from('odds_history')
      .insert(entries.map(e => ({
        ticker: e.ticker,
        event_ticker: e.event_ticker,
        title: e.title,
        side: e.side,
        yes_price_cents: e.yes_price_cents,
        our_side_odds_cents: e.our_side_odds_cents,
        logged_at: e.logged_at,
        drop_alert: e.drop_alert,
        drop_percent: e.drop_percent,
        data_quality: e.data_quality,
      })));

    if (insertError) {
      result.errors.push(`Insert error: ${insertError.message}`);
    } else {
      result.logged = entries.length;
    }

    // Step 6: Clean up old data (older than RETENTION_DAYS)
    const retentionCutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: deletedData } = await supabase
      .from('odds_history')
      .delete()
      .lt('logged_at', retentionCutoff)
      .select('id');
    
    result.cleaned = deletedData?.length || 0;

  } catch (err) {
    result.errors.push(`Fatal error: ${err}`);
  }

  return result;
}

// GET - Called by Vercel Cron every minute
export async function GET(request: Request) {
  console.log('[ODDS-HISTORY] Logging odds...');
  
  const result = await logOddsAndCheckAlerts();
  
  console.log(`[ODDS-HISTORY] Logged ${result.logged} positions, ${result.alerts.length} alerts, ${result.errors.length} errors, cleaned ${result.cleaned}`);
  
  if (result.alerts.length > 0) {
    console.warn('[ODDS-HISTORY] ⚠️ DROP ALERTS:', result.alerts);
  }
  
  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    ...result,
  });
}

// POST - Get recent odds history and alerts for a ticker
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { ticker, minutes = 60 } = body;
  
  const windowStart = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  
  let query = supabase
    .from('odds_history')
    .select('*')
    .gte('logged_at', windowStart)
    .order('logged_at', { ascending: false });
  
  if (ticker) {
    query = query.eq('ticker', ticker);
  }
  
  const { data, error } = await query;
  
  if (error) {
    return NextResponse.json({ success: false, error: error.message });
  }
  
  // Get current alerts
  const alerts = (data || []).filter(d => d.drop_alert);
  
  return NextResponse.json({
    success: true,
    count: data?.length || 0,
    alerts: alerts.length,
    data: data || [],
  });
}

