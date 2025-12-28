import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Supabase credentials
const SUPABASE_URL = 'https://lnycekbczyhxjlxoooqn.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI';

// Load Kalshi keys from .env.local
const envPath = resolve(process.cwd(), '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=');
  if (key && valueParts.length) {
    env[key.trim()] = valueParts.join('=').trim();
  }
});

const KALSHI_API_KEY = env.KALSHI_API_KEY;
const KALSHI_PRIVATE_KEY = env.KALSHI_PRIVATE_KEY?.replace(/\\n/g, '\n');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function kalshiFetch(endpoint) {
  const timestampMs = Date.now().toString();
  const method = 'GET';
  const pathWithoutQuery = endpoint.split('?')[0];
  const fullPath = `/trade-api/v2${pathWithoutQuery}`;

  const message = `${timestampMs}${method}${fullPath}`;
  const privateKey = crypto.createPrivateKey(KALSHI_PRIVATE_KEY);
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');

  const response = await fetch(`https://api.elections.kalshi.com/trade-api/v2${endpoint}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': KALSHI_API_KEY,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    },
  });

  if (!response.ok) {
    throw new Error(`Kalshi API error: ${response.status}`);
  }

  return response.json();
}

async function main() {
  console.log('Starting CORRECTED order recovery from Kalshi data...');
  console.log('This version groups fills by TICKER (not order_id)\n');
  
  // Get all fills from Kalshi
  let allFills = [];
  let cursor = null;
  do {
    const endpoint = `/portfolio/fills?limit=1000${cursor ? `&cursor=${cursor}` : ''}`;
    const data = await kalshiFetch(endpoint);
    allFills.push(...(data.fills || []));
    cursor = data.cursor;
    await new Promise(r => setTimeout(r, 100));
  } while (cursor);
  
  console.log(`Found ${allFills.length} fills from Kalshi`);
  
  // Get all settlements from Kalshi
  let allSettlements = [];
  cursor = null;
  do {
    const endpoint = `/portfolio/settlements?limit=1000${cursor ? `&cursor=${cursor}` : ''}`;
    const data = await kalshiFetch(endpoint);
    allSettlements.push(...(data.settlements || []));
    cursor = data.cursor;
    await new Promise(r => setTimeout(r, 100));
  } while (cursor);
  
  console.log(`Found ${allSettlements.length} settlements from Kalshi`);
  
  // Create settlement lookup
  const settlementByTicker = new Map();
  for (const s of allSettlements) {
    settlementByTicker.set(s.ticker, s);
  }
  
  // GROUP FILLS BY TICKER (not order_id!)
  // This combines all purchases of the same market
  const fillsByTicker = new Map();
  for (const fill of allFills) {
    const ticker = fill.ticker;
    if (!fillsByTicker.has(ticker)) {
      fillsByTicker.set(ticker, []);
    }
    fillsByTicker.get(ticker).push(fill);
  }
  
  console.log(`Grouped into ${fillsByTicker.size} unique tickers\n`);
  
  // Get existing orders from DB
  const { data: existingOrders } = await supabase
    .from('orders')
    .select('ticker');
  
  const existingTickers = new Set((existingOrders || []).map(o => o.ticker));
  console.log(`Found ${existingOrders?.length || 0} existing orders in DB`);
  
  // Build orders to recover (one per ticker)
  const ordersToRecover = [];
  
  for (const [ticker, fills] of fillsByTicker) {
    // Skip if already in DB
    if (existingTickers.has(ticker)) continue;
    
    // Aggregate all fills for this ticker
    // Kalshi price is in cents (0-100)
    let totalCount = 0;
    let totalCostCents = 0;
    let side = null;
    let firstOrderId = null;
    
    for (const fill of fills) {
      const count = fill.count || 0;
      // Kalshi price is 0.0-1.0 (decimal), so multiply by 100 to get cents
      const priceCents = Math.round((fill.price || 0) * 100);
      totalCount += count;
      totalCostCents += count * priceCents;
      side = side || fill.side?.toUpperCase();
      firstOrderId = firstOrderId || fill.order_id;
    }
    
    if (totalCount === 0) continue;
    
    const avgPriceCents = Math.round(totalCostCents / totalCount);
    
    // Ensure all values are integers
    totalCostCents = Math.round(totalCostCents);
    
    // Extract event_ticker
    const parts = ticker.split('-');
    const eventTicker = parts.slice(0, -1).join('-');
    
    // Determine result status from settlement
    const settlement = settlementByTicker.get(ticker);
    let resultStatus = 'undecided';
    let actualPayoutCents = 0;
    let feeCents = 0;
    
    if (settlement) {
      const marketResult = settlement.market_result;
      const won = side?.toLowerCase() === marketResult;
      resultStatus = won ? 'won' : 'lost';
      // revenue is already in cents
      actualPayoutCents = Math.round(settlement.revenue || 0);
      // fee_cost is a dollar string like "0.7800"
      feeCents = Math.round(parseFloat(settlement.fee_cost || '0') * 100);
    }
    
    // Get market details
    let marketData = null;
    try {
      const marketResponse = await kalshiFetch(`/markets/${ticker}`);
      marketData = marketResponse?.market;
      await new Promise(r => setTimeout(r, 50));
    } catch (e) {
      // Market might not exist anymore
    }
    
    // Determine batch date from ticker
    const dateMatch = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
    let batchDate = new Date().toISOString().split('T')[0];
    if (dateMatch) {
      const monthMap = {
        'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04',
        'MAY': '05', 'JUN': '06', 'JUL': '07', 'AUG': '08',
        'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
      };
      const year = `20${dateMatch[1]}`;
      const month = monthMap[dateMatch[2]] || '01';
      const day = dateMatch[3];
      batchDate = `${year}-${month}-${day}`;
    }
    
    ordersToRecover.push({
      kalshi_order_id: firstOrderId, // Use first order ID as reference
      ticker,
      event_ticker: eventTicker,
      title: marketData?.title || ticker,
      side: side || 'YES',
      price_cents: avgPriceCents,
      units: totalCount,
      cost_cents: totalCostCents,
      executed_price_cents: avgPriceCents,
      executed_cost_cents: totalCostCents,
      potential_payout_cents: totalCount * 100,
      open_interest: marketData?.open_interest || 0,
      market_close_time: marketData?.close_time,
      placement_status: 'confirmed',
      result_status: resultStatus,
      settlement_status: resultStatus === 'won' ? 'success' : (resultStatus === 'lost' ? 'closed' : 'pending'),
      actual_payout_cents: actualPayoutCents,
      fee_cents: feeCents,
      batch_date: batchDate,
    });
  }
  
  console.log(`Found ${ordersToRecover.length} orders to recover\n`);
  
  if (ordersToRecover.length === 0) {
    console.log('No orders to recover!');
    return;
  }
  
  // Group by batch date
  const ordersByDate = new Map();
  for (const order of ordersToRecover) {
    if (!ordersByDate.has(order.batch_date)) {
      ordersByDate.set(order.batch_date, []);
    }
    ordersByDate.get(order.batch_date).push(order);
  }
  
  let totalRecovered = 0;
  let totalUnits = 0;
  let totalCost = 0;
  
  for (const [batchDate, orders] of ordersByDate) {
    console.log(`\nProcessing ${orders.length} orders for ${batchDate}...`);
    
    // Find or create batch
    let batchId;
    const { data: existingBatch } = await supabase
      .from('order_batches')
      .select('id')
      .eq('batch_date', batchDate)
      .single();
    
    if (existingBatch) {
      batchId = existingBatch.id;
    } else {
      const { data: newBatch, error: batchError } = await supabase
        .from('order_batches')
        .insert({
          batch_date: batchDate,
          unit_size_cents: 100,
          total_orders: 0,
          total_cost_cents: 0,
          total_potential_payout_cents: 0,
          is_paused: false,
        })
        .select()
        .single();
      
      if (batchError) {
        console.error(`  Failed to create batch: ${batchError.message}`);
        continue;
      }
      batchId = newBatch.id;
    }
    
    // Insert orders
    for (const order of orders) {
      const { error: insertError } = await supabase
        .from('orders')
        .insert({
          batch_id: batchId,
          ticker: order.ticker,
          event_ticker: order.event_ticker,
          title: order.title,
          side: order.side,
          price_cents: order.price_cents,
          units: order.units,
          cost_cents: order.cost_cents,
          executed_price_cents: order.executed_price_cents,
          executed_cost_cents: order.executed_cost_cents,
          potential_payout_cents: order.potential_payout_cents,
          open_interest: order.open_interest,
          market_close_time: order.market_close_time,
          placement_status: order.placement_status,
          placement_status_at: new Date().toISOString(),
          kalshi_order_id: order.kalshi_order_id,
          result_status: order.result_status,
          result_status_at: order.result_status !== 'undecided' ? new Date().toISOString() : null,
          settlement_status: order.settlement_status,
          settlement_status_at: order.settlement_status !== 'pending' ? new Date().toISOString() : null,
          actual_payout_cents: order.actual_payout_cents,
          fee_cents: order.fee_cents,
        });
      
      if (insertError) {
        console.error(`  ✗ ${order.ticker}: ${insertError.message}`);
      } else {
        totalRecovered++;
        totalUnits += order.units;
        totalCost += order.cost_cents;
        console.log(`  ✓ ${order.ticker} ${order.side} - ${order.units}u @ ${order.price_cents}¢ = $${(order.cost_cents/100).toFixed(2)} (${order.result_status})`);
      }
    }
    
    // Update batch totals
    const { data: batchOrders } = await supabase
      .from('orders')
      .select('cost_cents, potential_payout_cents')
      .eq('batch_id', batchId);
    
    if (batchOrders) {
      await supabase
        .from('order_batches')
        .update({
          total_orders: batchOrders.length,
          total_cost_cents: batchOrders.reduce((sum, o) => sum + (o.cost_cents || 0), 0),
          total_potential_payout_cents: batchOrders.reduce((sum, o) => sum + (o.potential_payout_cents || 0), 0),
        })
        .eq('id', batchId);
    }
  }
  
  console.log(`\n✓ Recovery complete!`);
  console.log(`  Recovered: ${totalRecovered} orders`);
  console.log(`  Total units: ${totalUnits}`);
  console.log(`  Total cost: $${(totalCost/100).toFixed(2)}`);
}

main().catch(console.error);

