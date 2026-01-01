import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  return response.json();
}

async function main() {
  const ticker = 'KXNCAAFGAME-25DEC31NEBUTAH-UTAH';
  
  console.log('=== DEBUGGING UTAH POSITION ===\n');
  
  // Get all fills for Utah
  const fillsData = await kalshiFetch('/portfolio/fills?limit=1000');
  const utahFills = (fillsData.fills || []).filter(f => f.ticker === ticker);
  
  console.log(`Found ${utahFills.length} fills for Utah:\n`);
  
  let totalBought = 0;
  let totalBuyCost = 0;
  let totalSold = 0;
  let totalSellProceeds = 0;
  
  for (const fill of utahFills) {
    const units = fill.count || 0;
    const price = fill.side === 'yes' ? fill.yes_price : fill.no_price;
    const cost = units * price;
    const time = new Date(fill.created_time).toLocaleString();
    
    console.log(`${fill.action.toUpperCase()} ${units}u @ ${price}¢ = $${(cost/100).toFixed(2)} | ${fill.side} | ${time}`);
    
    if (fill.action === 'buy') {
      totalBought += units;
      totalBuyCost += cost;
    } else {
      totalSold += units;
      totalSellProceeds += cost;
    }
  }
  
  const netUnits = totalBought - totalSold;
  const avgBuyPrice = totalBought > 0 ? totalBuyCost / totalBought : 0;
  const remainingCost = Math.round(netUnits * avgBuyPrice);
  
  console.log('\n=== SUMMARY ===');
  console.log('Total bought:', totalBought, 'units for $' + (totalBuyCost/100).toFixed(2));
  console.log('Total sold:', totalSold, 'units for $' + (totalSellProceeds/100).toFixed(2));
  console.log('Net units:', netUnits);
  console.log('Avg buy price:', avgBuyPrice.toFixed(2) + '¢');
  console.log('Remaining cost (units × avg price):', '$' + (remainingCost/100).toFixed(2));
  console.log('Realized P&L from sells:', '$' + ((totalSellProceeds - (totalSold * avgBuyPrice))/100).toFixed(2));
}

main().catch(console.error);

