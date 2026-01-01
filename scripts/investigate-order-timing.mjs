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

async function main() {
  console.log('=== Investigating Order Timing ===\n');
  
  // Get fills for the problematic positions
  const problemTickers = [
    'KXNCAAWBGAME-26JAN01SMULOU-LOU',  // Louisville
    'KXNCAAWBGAME-26JAN01NDGT-ND',      // Notre Dame
    'KXNCAAWBGAME-26JAN01TEXMIZZ-TEX',  // Texas
  ];
  
  const fills = await kalshiFetch('/portfolio/fills?limit=500');
  
  for (const ticker of problemTickers) {
    console.log(`\n=== ${ticker} ===`);
    const tickerFills = (fills.fills || [])
      .filter(f => f.ticker === ticker)
      .sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
    
    let runningUnits = 0;
    let runningCost = 0;
    
    for (const fill of tickerFills) {
      const time = new Date(fill.created_time).toLocaleString();
      if (fill.action === 'buy') {
        runningUnits += fill.count;
        runningCost += fill.count * fill.price;
        console.log(`${time}: BUY ${fill.count} @ ${fill.price}¢ = $${(fill.count * fill.price / 100).toFixed(2)} | Running: ${runningUnits} units, $${(runningCost/100).toFixed(2)}`);
      } else {
        runningUnits -= fill.count;
        const soldValue = fill.count * fill.price;
        console.log(`${time}: SELL ${fill.count} @ ${fill.price}¢ = $${(soldValue / 100).toFixed(2)} | Remaining: ${runningUnits} units`);
      }
    }
    
    console.log(`\nFinal: ${runningUnits} units, avg cost $${runningUnits > 0 ? (runningCost/100/tickerFills.filter(f=>f.action==='buy').reduce((s,f)=>s+f.count,0)*runningUnits).toFixed(2) : 0}`);
  }
  
  // Also check total buys per hour to see if rebalance/monitor is stacking
  console.log('\n\n=== All Fills Grouped by Hour (Last 48h) ===');
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const recentFills = (fills.fills || []).filter(f => new Date(f.created_time) > twoDaysAgo && f.action === 'buy');
  
  const byHour = {};
  for (const fill of recentFills) {
    const hour = new Date(fill.created_time).toISOString().slice(0, 13) + ':00';
    if (!byHour[hour]) byHour[hour] = { count: 0, cost: 0, fills: [] };
    byHour[hour].count += fill.count;
    byHour[hour].cost += fill.count * fill.price;
    byHour[hour].fills.push(fill);
  }
  
  for (const [hour, data] of Object.entries(byHour).sort()) {
    console.log(`${hour}: ${data.fills.length} fills, ${data.count} units, $${(data.cost/100).toFixed(2)} spent`);
  }
}

main().catch(console.error);

