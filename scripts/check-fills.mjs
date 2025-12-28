import crypto from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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

async function kalshiFetch(endpoint) {
  const timestampMs = Date.now().toString();
  const method = 'GET';
  const fullPath = '/trade-api/v2' + endpoint.split('?')[0];
  const message = timestampMs + method + fullPath;
  const privateKey = crypto.createPrivateKey(KALSHI_PRIVATE_KEY);
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');

  const response = await fetch('https://api.elections.kalshi.com/trade-api/v2' + endpoint, {
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

const data = await kalshiFetch('/portfolio/fills?limit=10');
console.log('Sample fills from Kalshi:');
data.fills.forEach(f => {
  console.log(JSON.stringify({
    ticker: f.ticker,
    count: f.count,
    price: f.price,
    side: f.side,
  }));
});

