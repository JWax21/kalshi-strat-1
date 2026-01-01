import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse .env.local manually
function loadEnv() {
  const envPath = path.join(__dirname, '../.env.local');
  const content = fs.readFileSync(envPath, 'utf-8');
  const env = {};
  let currentKey = null;
  let currentValue = '';
  
  for (const line of content.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    
    if (line.includes('=') && !currentKey) {
      const [key, ...rest] = line.split('=');
      const value = rest.join('=');
      if (value.startsWith('"') && !value.endsWith('"')) {
        // Multi-line value
        currentKey = key;
        currentValue = value.slice(1); // Remove opening quote
      } else {
        env[key] = value.replace(/^"|"$/g, '');
      }
    } else if (currentKey) {
      if (line.endsWith('"')) {
        currentValue += '\n' + line.slice(0, -1); // Remove closing quote
        env[currentKey] = currentValue;
        currentKey = null;
        currentValue = '';
      } else {
        currentValue += '\n' + line;
      }
    }
  }
  return env;
}

const envVars = loadEnv();

const supabase = createClient(
  'https://lnycekbczyhxjlxoooqn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI'
);

// Kalshi API config
const KALSHI_API_KEY = envVars.KALSHI_API_KEY;
const KALSHI_PRIVATE_KEY = envVars.KALSHI_PRIVATE_KEY?.replace(/\\n/g, '\n');
const KALSHI_BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

function generateSignature(timestampMs, method, path) {
  const pathWithoutQuery = path.split('?')[0];
  const message = `${timestampMs}${method}${pathWithoutQuery}`;
  const privateKey = crypto.createPrivateKey(KALSHI_PRIVATE_KEY);
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signature.toString('base64');
}

async function kalshiFetch(endpoint) {
  const timestampMs = Date.now().toString();
  const method = 'GET';
  const fullPath = `/trade-api/v2${endpoint}`;
  const signature = generateSignature(timestampMs, method, fullPath);

  const response = await fetch(`${KALSHI_BASE_URL}${endpoint}`, {
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

// The 4 tickers to fix
const TICKERS_TO_FIX = [
  'KXNCAAWBGAME-25DEC31DAYGMU-GMU',   // Dayton at George Mason
  'KXNCAAWBGAME-25DEC31OSUPUR-PUR',   // Ohio St. at Purdue
  'KXNCAAWBGAME-25DEC31CSUGC-CSU',    // Colorado St. at Grand Canyon
  'KXNBAGAME-25DEC31GSWCHA-GSW',       // Golden State vs Charlotte
];

async function main() {
  console.log('=== FIXING 4 ORDERS ===\n');

  // Get fills from Kalshi to calculate actual costs
  console.log('Fetching fills from Kalshi...');
  const fillsData = await kalshiFetch('/portfolio/fills?limit=1000');
  const fills = fillsData.fills || [];

  // Get settlements from Kalshi
  console.log('Fetching settlements from Kalshi...');
  const settlementsData = await kalshiFetch('/portfolio/settlements?limit=1000');
  const settlements = settlementsData.settlements || [];

  // Build maps
  const fillsByTicker = new Map();
  for (const fill of fills) {
    if (!fillsByTicker.has(fill.ticker)) {
      fillsByTicker.set(fill.ticker, []);
    }
    fillsByTicker.get(fill.ticker).push(fill);
  }

  const settlementsByTicker = new Map();
  for (const s of settlements) {
    settlementsByTicker.set(s.ticker, s);
  }

  // Get current DB records for these 4 tickers
  const { data: dbOrders, error } = await supabase
    .from('orders')
    .select('*')
    .in('ticker', TICKERS_TO_FIX);

  if (error) {
    console.error('Error fetching DB orders:', error);
    return;
  }

  console.log(`\nFound ${dbOrders.length} orders in DB to fix:\n`);

  for (const order of dbOrders) {
    console.log('---');
    console.log('Ticker:', order.ticker);
    console.log('Title:', order.title);
    console.log('');
    console.log('BEFORE (DB):');
    console.log('  Units:', order.units);
    console.log('  Cost:', '$' + (order.executed_cost_cents / 100).toFixed(2));
    console.log('  Potential Payout:', '$' + (order.potential_payout_cents / 100).toFixed(2));
    console.log('  Actual Payout:', order.actual_payout_cents ? '$' + (order.actual_payout_cents / 100).toFixed(2) : 'null');

    // Get fills for this ticker
    const tickerFills = fillsByTicker.get(order.ticker) || [];
    
    // Debug: show raw fill data
    if (tickerFills.length > 0) {
      console.log('');
      console.log('RAW FILLS:');
      tickerFills.forEach((f, i) => {
        console.log(`  Fill ${i+1}: action=${f.action}, count=${f.count}, price=${f.yes_price}/${f.no_price}, side=${f.side}`);
      });
    }
    
    // Calculate what we actually hold based on fills
    // BUY fills add units, SELL fills subtract units
    let netUnits = 0;
    let totalBuyCost = 0;
    let totalBuyUnits = 0;
    let totalSellProceeds = 0;
    let totalSellUnits = 0;

    for (const fill of tickerFills) {
      const units = fill.count || 0;
      // Price is in the yes_price or no_price field depending on side
      const price = fill.side === 'yes' ? (fill.yes_price || 0) : (fill.no_price || 0);
      const cost = units * price;

      if (fill.action === 'buy') {
        netUnits += units;
        totalBuyCost += cost;
        totalBuyUnits += units;
      } else if (fill.action === 'sell') {
        netUnits -= units;
        totalSellProceeds += cost;
        totalSellUnits += units;
      }
    }

    // The remaining cost = buy cost proportional to remaining units
    const avgBuyPrice = totalBuyUnits > 0 ? totalBuyCost / totalBuyUnits : 0;
    const remainingCost = Math.round(netUnits * avgBuyPrice);
    const remainingPayout = netUnits * 100; // $1 per contract on win

    console.log('');
    console.log('KALSHI FILLS:');
    console.log('  Total bought:', totalBuyUnits, 'units for $' + (totalBuyCost / 100).toFixed(2));
    console.log('  Total sold:', totalSellUnits, 'units for $' + (totalSellProceeds / 100).toFixed(2));
    console.log('  Net units held:', netUnits);
    console.log('  Avg buy price:', (avgBuyPrice).toFixed(2) + '¢');
    console.log('  Remaining cost:', '$' + (remainingCost / 100).toFixed(2));
    console.log('  Expected payout:', '$' + (remainingPayout / 100).toFixed(2));

    // Check settlement
    const settlement = settlementsByTicker.get(order.ticker);
    if (settlement) {
      console.log('');
      console.log('KALSHI SETTLEMENT:');
      console.log('  Revenue:', '$' + ((settlement.revenue || 0) / 100).toFixed(2));
      console.log('  Fee:', '$' + (parseFloat(settlement.fee_cost || '0')).toFixed(2));
    }

    // Calculate the fix
    const newUnits = netUnits;
    const newCostCents = remainingCost;
    const newPotentialPayout = newUnits * 100;
    const newPotentialProfit = (100 - Math.round(avgBuyPrice)) * newUnits;

    console.log('');
    console.log('AFTER (FIX):');
    console.log('  Units:', newUnits);
    console.log('  Cost:', '$' + (newCostCents / 100).toFixed(2));
    console.log('  Potential Payout:', '$' + (newPotentialPayout / 100).toFixed(2));
    console.log('  Expected Profit:', '$' + ((newPotentialPayout - newCostCents) / 100).toFixed(2));

    // Apply the fix (without potential_profit_cents which doesn't exist)
    const { error: updateError } = await supabase
      .from('orders')
      .update({
        units: newUnits,
        cost_cents: newCostCents,
        executed_cost_cents: newCostCents,
        potential_payout_cents: newPotentialPayout,
      })
      .eq('id', order.id);

    if (updateError) {
      console.log('  ❌ UPDATE FAILED:', updateError.message);
    } else {
      console.log('  ✅ UPDATED SUCCESSFULLY');
    }
  }

  console.log('\n=== DONE ===');
}

main().catch(console.error);

