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
        currentKey = key;
        currentValue = value.slice(1);
      } else {
        env[key] = value.replace(/^"|"$/g, '');
      }
    } else if (currentKey) {
      if (line.endsWith('"')) {
        currentValue += '\n' + line.slice(0, -1);
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

async function main() {
  console.log('=== AUDITING ALL CONFIRMED ORDERS vs KALSHI FILLS ===\n');

  // Get all confirmed orders from DB
  const { data: dbOrders, error } = await supabase
    .from('orders')
    .select('*')
    .eq('placement_status', 'confirmed')
    .order('executed_cost_cents', { ascending: false });

  if (error) {
    console.error('Error fetching DB orders:', error);
    return;
  }

  console.log(`Found ${dbOrders.length} confirmed orders in DB\n`);

  // Get all fills from Kalshi
  console.log('Fetching fills from Kalshi...');
  const fillsData = await kalshiFetch('/portfolio/fills?limit=1000');
  const fills = fillsData.fills || [];
  console.log(`Found ${fills.length} fills from Kalshi\n`);

  // Build map of fills by ticker
  const fillsByTicker = new Map();
  for (const fill of fills) {
    if (!fillsByTicker.has(fill.ticker)) {
      fillsByTicker.set(fill.ticker, []);
    }
    fillsByTicker.get(fill.ticker).push(fill);
  }

  // Find discrepancies
  const discrepancies = [];

  for (const order of dbOrders) {
    const tickerFills = fillsByTicker.get(order.ticker) || [];
    
    // Calculate actual units and cost from fills
    let actualUnits = 0;
    let actualCost = 0;

    for (const fill of tickerFills) {
      const units = fill.count || 0;
      const price = fill.side === 'yes' ? (fill.yes_price || 0) : (fill.no_price || 0);
      const cost = units * price;

      if (fill.action === 'buy') {
        actualUnits += units;
        actualCost += cost;
      } else if (fill.action === 'sell') {
        actualUnits -= units;
        actualCost -= cost; // Reduce cost basis when selling
      }
    }

    const dbUnits = order.units || 0;
    const dbCost = order.executed_cost_cents || order.cost_cents || 0;

    // Check for discrepancy
    const unitsDiff = dbUnits - actualUnits;
    const costDiff = dbCost - actualCost;

    if (Math.abs(unitsDiff) > 0 || Math.abs(costDiff) > 10) { // Allow 10 cent tolerance for rounding
      discrepancies.push({
        ticker: order.ticker,
        title: order.title,
        dbUnits,
        actualUnits,
        unitsDiff,
        dbCost,
        actualCost,
        costDiff,
        fills: tickerFills.length,
        id: order.id,
      });
    }
  }

  if (discrepancies.length === 0) {
    console.log('✅ No discrepancies found! All DB records match Kalshi fills.');
  } else {
    console.log(`❌ Found ${discrepancies.length} discrepancies:\n`);
    
    for (const d of discrepancies) {
      console.log('---');
      console.log('Ticker:', d.ticker);
      console.log('Title:', d.title?.substring(0, 50));
      console.log('DB Units:', d.dbUnits, '| Kalshi Units:', d.actualUnits, '| Diff:', d.unitsDiff);
      console.log('DB Cost: $' + (d.dbCost/100).toFixed(2), '| Kalshi Cost: $' + (d.actualCost/100).toFixed(2), '| Diff: $' + (d.costDiff/100).toFixed(2));
      console.log('Fills count:', d.fills);
    }

    console.log('\n=== SUMMARY ===');
    const totalUnitsDiff = discrepancies.reduce((sum, d) => sum + d.unitsDiff, 0);
    const totalCostDiff = discrepancies.reduce((sum, d) => sum + d.costDiff, 0);
    console.log('Total units discrepancy:', totalUnitsDiff);
    console.log('Total cost discrepancy: $' + (totalCostDiff/100).toFixed(2));
  }
}

main().catch(console.error);

