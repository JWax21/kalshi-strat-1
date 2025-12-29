import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  'https://lnycekbczyhxjlxoooqn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI'
);

const KALSHI_CONFIG = {
  apiKey: 'a5da15ab-e94e-4cfb-adc5-ce352805c7c5',
  privateKey: `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAn+7HFLfJqLZ9FhWjBT+DSMJCnFMbrZ/15a3LxiTGMj3CLrrg
eGPH7HhPYxe0IfYCDTSYuSKOQE2FIdhiuDyqHc8XNNEhdTFGcoWxbwcJdxcJ7bNo
G5OmVFp/gj2+RxHOl0J2xpIaUn0paeVJiFKZVyxDWLDYhpAyGOWpYH4mPO/Jqjka
L2v8p3n8UmfJlmRvIuAJQJNlIiDt2bEqNqd6oH/VqGPLPT7FaeMtYi0jyYlxyofy
iFU+Olc0kfALzB/SNEBZ32RbbPzY95+Tcgc7HHKYvDXlvJlIzwgGO9z+b0VSORGO
ksZ+qFNlPYuLLYWnAx4g8qhEFuAdNPj5sUHfKQIDAQABAoIBADBSYcOdHwOd+wyT
BNs3eI2N+q/M9HNfJP1gg6gXQJj3D2VCV9NQ+RD8Cw/gF2RVWrST+25GAI30IgiP
MtR3pdtvg2gBnMs6rImEbmXD5tX5Ypm0hrAUZC2lH3oZG0DUHDsF6H+14/E7dLtP
/YKzXLWjHW3THkzMF00sRGz7UxRV0urpTdDcM+p2VD/0cwT7MiE5y5hDzXtbT8xI
M4w68SrRrN05csEt7WvUvZj9JOEn7FyatPXLueL2cHvNMGqIcWFEt6CwgDyoKpvP
fCAZxYUeA3JXu42BOK99oIvjrvNfdIo46k/BZzb/nwP7Blwr/KIUZ/5tqPGYD8Fp
LvT3njECgYEA0yBfO0rqRk4ypPg62YGzwEz8jYHy62b6O7++gGrvcxhRNJvvvjfd
u1UEhYDbfP2JKUyMCmO4e9w2dxUCzFxIxTnTC0Nx0DnMD1XiDAHzFDKmCdz/aEwN
GMTV1RBK3NXGLT5JDK5P90jCluWCaJh/JIKKmkHhTOAhGpP6KNDRcvkCgYEAwngo
AkpPFb/lw6nBLRGC3u+TsazQj4DdI4s6hgRHJMjPjYXSn9fj0sMfrCq1wUPkfVMq
pkkJLuaJJgsh3QxH66LccXv/bhh/cJVk1CYhSQwwxWxd5NUyDfpGp0P87V4hLO5h
Uk/zSJxhH4lLfKIxhfJh5V2qPDgWz7RxE9cxCeECgYBglhx17vVRUX1W8I8tFhSn
+KRRqPn6Uqk8tAI+urtabDJnEMJSj9LNMQIbKz8e2XeFjE1Y1qEtQWZ+bGEjnJkC
4N/O5i1V/9+V2SCaiFO9bj4roOmQmL0V2K7dP/Hb40llBXyZIiQQc/1k4EXqLqzQ
Wma2CBW9M//zPOrQS0NzkQKBgC6Ug2Y6mM1pq7CfvaJ1lnN94rpvXRcMxFurkzKq
sPvVPBYjJvtG2mR5xqZFoJCgxKA8wPq05qCyodr3rsOt2a3bWS1KpDBq+S69JDGS
4i6ETBnKXQpQh+7SJJdkJ1FqddpqkiN8fHNjXJt5PGbU6dCDWvT7rrfC5Z/n3u0c
kqphAoGBAMBqBqBtxk0tNgqJNrcTBPNn81IGemGm8opQBH8G+a6UBJhBVdaKIGy6
pD/wrEs0Auv0lx/lEy0I8c0r3dZJuSmHy3Ax3C6hMXuQJMNUqpL5khCpjSEjwbcs
SdUIbO5c6LbGQH0c/1TlThMPJP6gD8+o75vx6mVnLYMHqqEvL8wh
-----END RSA PRIVATE KEY-----`
};

async function kalshiFetch(endpoint) {
  const timestampMs = Date.now().toString();
  const method = 'GET';
  const pathWithoutQuery = endpoint.split('?')[0];
  const fullPath = '/trade-api/v2' + pathWithoutQuery;
  const message = timestampMs + method + fullPath;
  const privateKey = crypto.createPrivateKey(KALSHI_CONFIG.privateKey);
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');

  const response = await fetch('https://api.elections.kalshi.com/trade-api/v2' + endpoint, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': KALSHI_CONFIG.apiKey,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    },
  });
  return response.json();
}

// Fetch all settlements from Kalshi
console.log('Fetching settlements from Kalshi...');
let allSettlements = [];
let cursor = null;

do {
  const url = cursor 
    ? `/portfolio/settlements?limit=200&cursor=${cursor}`
    : '/portfolio/settlements?limit=200';
  const data = await kalshiFetch(url);
  if (data.settlements) {
    allSettlements = allSettlements.concat(data.settlements);
  }
  cursor = data.cursor;
} while (cursor);

console.log('Total settlements from Kalshi:', allSettlements.length);

// Get all orders from DB
const { data: orders } = await supabase
  .from('orders')
  .select('id, ticker, side, result_status, executed_cost_cents, actual_payout_cents, fee_cents')
  .eq('placement_status', 'confirmed')
  .in('result_status', ['won', 'lost']);

console.log('Orders to patch:', orders.length);

// Create a map of settlements by ticker
const settlementsByTicker = {};
allSettlements.forEach(s => {
  settlementsByTicker[s.ticker] = s;
});

// Patch each order
let patchedCount = 0;
for (const order of orders) {
  const settlement = settlementsByTicker[order.ticker];
  if (!settlement) {
    console.log('No settlement found for:', order.ticker);
    continue;
  }

  // Determine which side the order was on
  const isYesSide = order.side === 'YES' || order.side === 'yes';
  
  // Get cost from settlement
  const actualCost = isYesSide ? settlement.yes_total_cost : settlement.no_total_cost;
  const units = isYesSide ? settlement.yes_count : settlement.no_count;
  
  // Get payout: revenue is the total payout (includes original cost back for wins)
  // For a win: revenue = units * 100 (you get $1 per unit)
  // For a loss: revenue = 0
  const actualPayout = settlement.revenue || 0;
  
  // Fee is in dollars as a string, convert to cents
  const feeCents = Math.round(parseFloat(settlement.fee_cost || '0') * 100);
  
  // Calculate P&L for verification
  const pnl = actualPayout - actualCost - feeCents;
  
  // Only update if values differ
  if (order.executed_cost_cents !== actualCost || 
      order.actual_payout_cents !== actualPayout ||
      order.fee_cents !== feeCents) {
    
    console.log(`Patching ${order.ticker}: cost ${order.executed_cost_cents} -> ${actualCost}, payout ${order.actual_payout_cents} -> ${actualPayout}, fee ${order.fee_cents} -> ${feeCents}, P&L: ${pnl / 100}`);
    
    const { error } = await supabase
      .from('orders')
      .update({
        executed_cost_cents: actualCost,
        cost_cents: actualCost,
        actual_payout_cents: actualPayout,
        fee_cents: feeCents,
      })
      .eq('id', order.id);
    
    if (error) {
      console.log('Error updating:', error.message);
    } else {
      patchedCount++;
    }
  }
}

console.log(`\nPatched ${patchedCount} orders`);

// Calculate total P&L
const { data: updatedOrders } = await supabase
  .from('orders')
  .select('result_status, executed_cost_cents, actual_payout_cents, fee_cents')
  .eq('placement_status', 'confirmed')
  .in('result_status', ['won', 'lost']);

let totalPnl = 0;
updatedOrders.forEach(o => {
  const payout = o.actual_payout_cents || 0;
  const cost = o.executed_cost_cents || 0;
  const fee = o.fee_cents || 0;
  totalPnl += payout - cost - fee;
});

console.log(`\nTotal P&L: $${(totalPnl / 100).toFixed(2)}`);

