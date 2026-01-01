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
  console.log('Fetching Kalshi data...\n');
  
  // Get balance first
  const balance = await kalshiFetch('/portfolio/balance');
  const portfolioValue = balance.portfolio_value || 0;
  const threePercentCap = Math.floor(portfolioValue * 0.03);
  console.log('=== Current Balance ===');
  console.log(`Portfolio: $${(portfolioValue / 100).toFixed(2)}`);
  console.log(`3% Cap should be: $${(threePercentCap / 100).toFixed(2)}`);
  console.log(`Available cash: $${(balance.balance / 100).toFixed(2)}`);
  
  // Get current positions
  console.log('\n=== Current Positions (High Cost) ===');
  const positions = await kalshiFetch('/portfolio/positions');
  const highCostPositions = (positions.market_positions || [])
    .filter(p => (p.total_traded * p.position) / 100 > 300) // Cost > $300
    .sort((a, b) => b.total_traded * b.position - a.total_traded * a.position);
  
  for (const p of highCostPositions) {
    const cost = p.market_exposure;
    const payout = p.position * 100; // $1 per contract
    const profit = payout - cost;
    const overCapBy = cost - threePercentCap;
    console.log(`\n${p.ticker}:`);
    console.log(`  Units: ${p.position} @ avg ${p.total_traded}¢`);
    console.log(`  Cost: $${(cost / 100).toFixed(2)}`);
    console.log(`  Over 3% cap by: $${(overCapBy / 100).toFixed(2)} (${overCapBy > 0 ? '⚠️ VIOLATION' : '✅ OK'})`);
  }
  
  // Get fills
  console.log('\n\n=== Today\'s Fills (Last 24h) ===');
  const fills = await kalshiFetch('/portfolio/fills?limit=200');
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentFills = (fills.fills || []).filter(f => new Date(f.created_time) > oneDayAgo);
  
  // Group by ticker
  const byTicker = {};
  for (const fill of recentFills) {
    if (!byTicker[fill.ticker]) byTicker[fill.ticker] = { buys: [], sells: [] };
    if (fill.action === 'buy') {
      byTicker[fill.ticker].buys.push(fill);
    } else {
      byTicker[fill.ticker].sells.push(fill);
    }
  }
  
  for (const [ticker, data] of Object.entries(byTicker)) {
    const totalBuys = data.buys.reduce((sum, f) => sum + f.count, 0);
    const totalBuyCost = data.buys.reduce((sum, f) => sum + f.count * f.price, 0);
    if (totalBuyCost > 30000) { // Only show if cost > $300
      console.log(`\n${ticker}:`);
      console.log(`  Buy orders: ${data.buys.length}, Total units: ${totalBuys}, Cost: $${(totalBuyCost / 100).toFixed(2)}`);
      if (totalBuyCost > threePercentCap) {
        console.log(`  ⚠️ EXCEEDS 3% CAP of $${(threePercentCap / 100).toFixed(2)} by $${((totalBuyCost - threePercentCap) / 100).toFixed(2)}`);
      }
      console.log('  Fill breakdown:');
      for (const f of data.buys.sort((a, b) => new Date(a.created_time) - new Date(b.created_time))) {
        const time = new Date(f.created_time).toLocaleTimeString();
        console.log(`    ${time}: ${f.count} units @ ${f.price}¢ = $${(f.count * f.price / 100).toFixed(2)} (order: ${f.order_id?.slice(0, 8)}...)`);
      }
    }
  }
  
  // Check which routes placed orders
  console.log('\n\n=== Order IDs for Investigation ===');
  const orderIds = new Set();
  for (const fill of recentFills) {
    if (fill.action === 'buy') {
      orderIds.add(fill.order_id);
    }
  }
  console.log(`Unique order IDs in last 24h: ${orderIds.size}`);
}

main().catch(console.error);
