import crypto from 'crypto';
import { KALSHI_CONFIG } from './kalshi-config';

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type: 'binary' | 'scalar';
  title: string;
  subtitle: string;
  yes_sub_title: string;
  no_sub_title: string;
  created_time: string;
  open_time: string;
  close_time: string;
  expiration_time: string;
  status: string;
  yes_bid: number;
  yes_bid_dollars: string;
  yes_ask: number;
  yes_ask_dollars: string;
  no_bid: number;
  no_bid_dollars: string;
  no_ask: number;
  no_ask_dollars: string;
  last_price: number;
  last_price_dollars: string;
  volume: number;
  volume_24h: number;
  result: 'yes' | 'no' | '';
  open_interest: number;
  liquidity: number;
  liquidity_dollars: string;
  category: string;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  sub_title: string;
  title: string;
  category: string;
  mutually_exclusive: boolean;
}

function generateSignature(timestampMs: string, method: string, path: string): string {
  // Strip query parameters from path before signing
  const pathWithoutQuery = path.split('?')[0];
  const message = `${timestampMs}${method}${pathWithoutQuery}`;
  
  // Use RSA-PSS with SHA256 as per Kalshi docs
  const privateKey = crypto.createPrivateKey(KALSHI_CONFIG.privateKey);
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  
  return signature.toString('base64');
}

async function fetchKalshi(endpoint: string, retries: number = 3): Promise<any> {
  for (let attempt = 0; attempt < retries; attempt++) {
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
    
    if (response.status === 429) {
      const delay = Math.pow(2, attempt + 1) * 2000; // 4s, 8s, 16s
      console.log(`Rate limited, waiting ${delay/1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Kalshi API error: ${response.status} - ${errorText}`);
    }
    
    return response.json();
  }
  throw new Error('Max retries exceeded - rate limited');
}

export async function getEvents(limit: number = 200, category?: string): Promise<KalshiEvent[]> {
  // Events API may have lower limit than markets, use 200 max
  const fetchLimit = Math.min(category ? limit * 3 : limit, 200);
  const endpoint = `/events?limit=${fetchLimit}`;
  const data = await fetchKalshi(endpoint);
  let events = data.events || [];
  
  // Filter by category client-side (API may not support category filter)
  if (category) {
    events = events.filter((e: KalshiEvent) => 
      e.category.toLowerCase() === category.toLowerCase()
    );
  }
  
  return events.slice(0, limit);
}

export async function getSportsEventTickers(): Promise<Set<string>> {
  const events = await getEvents(200, 'Sports');
  const tickers = new Set<string>();
  events.forEach(e => {
    tickers.add(e.event_ticker);
    tickers.add(e.series_ticker);
  });
  return tickers;
}

export async function getMarkets(
  limit: number = 200,  // Kalshi's actual limit per page
  maxCloseHours: number = 48,
  pages: number = 15,
  seriesTicker?: string
): Promise<KalshiMarket[]> {
  const allMarkets: KalshiMarket[] = [];
  let cursor: string | null = null;
  
  // Generate max_close_ts: Unix timestamp for X hours from now
  const maxCloseTs = Math.floor(Date.now() / 1000) + (maxCloseHours * 60 * 60);
  
  for (let page = 0; page < pages; page++) {
    let endpoint = `/markets?limit=${limit}&status=open&max_close_ts=${maxCloseTs}`;
    
    // Add series_ticker filter for sports games
    if (seriesTicker) {
      endpoint += `&series_ticker=${seriesTicker}`;
    }
    
    if (cursor) {
      endpoint += `&cursor=${cursor}`;
    }
    
    console.log(`Fetching page ${page + 1}/${pages}...`);
    const data = await fetchKalshi(endpoint);
    const markets = data.markets || [];
    allMarkets.push(...markets);
    
    // Get cursor for next page
    cursor = data.cursor || null;
    
    // If no more results or no cursor, stop
    if (markets.length === 0 || !cursor) {
      console.log(`No more markets after page ${page + 1}`);
      break;
    }
    
    // Small delay between requests to avoid rate limits (1 second = 60 per minute)
    if (page < pages - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  console.log(`Total markets fetched: ${allMarkets.length}`);
  return allMarkets;
}

export function filterHighOddsMarkets(markets: KalshiMarket[], minOdds: number = 0.92, maxOdds: number = 0.995): KalshiMarket[] {
  return markets.filter((market) => {
    const yesPrice = parseFloat(market.last_price_dollars) || 0;
    const noPrice = 1 - yesPrice;
    const favoriteOdds = Math.max(yesPrice, noPrice);
    return favoriteOdds >= minOdds && favoriteOdds <= maxOdds;
  });
}

export function getMarketOdds(market: KalshiMarket): { yes: number; no: number } {
  const yesPrice = parseFloat(market.last_price_dollars) || 0;
  return { yes: yesPrice, no: 1 - yesPrice };
}

// Order interfaces
export interface KalshiOrder {
  ticker: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  count: number;
  type: 'limit' | 'market';
  yes_price?: number; // Price in cents (1-99) for limit orders on YES side
  no_price?: number;  // Price in cents (1-99) for limit orders on NO side
  client_order_id: string;
}

export interface KalshiOrderResponse {
  order: {
    order_id: string;
    client_order_id: string;
    status: string;
    ticker: string;
    action: string;
    side: string;
    type: string;
    yes_price: number;
    no_price: number;
    count: number;
    created_time: string;
  };
}

// POST request helper for authenticated endpoints
async function postKalshi(endpoint: string, body: object): Promise<any> {
  const timestampMs = Date.now().toString();
  const method = 'POST';
  const fullPath = `/trade-api/v2${endpoint}`;
  
  const signature = generateSignature(timestampMs, method, fullPath);
  
  console.log('=== postKalshi Debug ===');
  console.log('Endpoint:', endpoint);
  console.log('Full URL:', `${KALSHI_CONFIG.baseUrl}${endpoint}`);
  console.log('Timestamp (ms):', timestampMs);
  console.log('Request body:', JSON.stringify(body, null, 2));
  
  const response = await fetch(`${KALSHI_CONFIG.baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': KALSHI_CONFIG.apiKey,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    },
    body: JSON.stringify(body),
  });
  
  console.log('Response status:', response.status);
  
  if (!response.ok) {
    const errorText = await response.text();
    console.log('Error response:', errorText);
    throw new Error(`Kalshi API error: ${response.status} - ${errorText}`);
  }
  
  const result = await response.json();
  console.log('Success response:', JSON.stringify(result, null, 2));
  return result;
}

// Place an order
export async function placeOrder(order: KalshiOrder): Promise<KalshiOrderResponse> {
  const response = await postKalshi('/portfolio/orders', order);
  return response;
}

// Get current positions
export async function getPositions(): Promise<any> {
  const endpoint = '/portfolio/positions';
  return fetchKalshi(endpoint);
}

// Get account balance
export async function getBalance(): Promise<any> {
  const endpoint = '/portfolio/balance';
  return fetchKalshi(endpoint);
}

// Orderbook interfaces
export interface OrderbookLevel {
  price: number;      // Price in cents (1-99)
  count: number;      // Number of contracts available
  dollars: string;    // Price as dollar string (e.g., "0.9500")
}

export interface Orderbook {
  yes: OrderbookLevel[];  // Yes bids, sorted by price descending (best first)
  no: OrderbookLevel[];   // No bids, sorted by price descending (best first)
}

// Get orderbook for a market
export async function getOrderbook(ticker: string, depth: number = 0): Promise<Orderbook> {
  const endpoint = `/markets/${ticker}/orderbook${depth > 0 ? `?depth=${depth}` : ''}`;
  const data = await fetchKalshi(endpoint);
  
  const orderbook = data.orderbook || {};
  
  // Parse yes levels: [[price, count], ...] in cents
  const yesLevels: OrderbookLevel[] = (orderbook.yes || []).map((level: number[]) => ({
    price: level[0],
    count: level[1],
    dollars: (level[0] / 100).toFixed(4),
  }));
  
  // Parse no levels: [[price, count], ...] in cents
  const noLevels: OrderbookLevel[] = (orderbook.no || []).map((level: number[]) => ({
    price: level[0],
    count: level[1],
    dollars: (level[0] / 100).toFixed(4),
  }));
  
  // Sort by price descending (best price first)
  yesLevels.sort((a, b) => b.price - a.price);
  noLevels.sort((a, b) => b.price - a.price);
  
  return { yes: yesLevels, no: noLevels };
}

// Cancel an order
export async function cancelOrder(orderId: string): Promise<any> {
  const timestampMs = Date.now().toString();
  const method = 'DELETE';
  const endpoint = `/portfolio/orders/${orderId}`;
  const fullPath = `/trade-api/v2${endpoint}`;
  
  const signature = generateSignature(timestampMs, method, fullPath);
  
  const response = await fetch(`${KALSHI_CONFIG.baseUrl}${endpoint}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': KALSHI_CONFIG.apiKey,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kalshi API error: ${response.status} - ${errorText}`);
  }
  
  return response.json();
}

