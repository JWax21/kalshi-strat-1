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

const supabase = createClient(
  'https://lnycekbczyhxjlxoooqn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI'
);

// Get game date from ticker
const getGameDateFromTicker = (ticker) => {
  const match = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (match) {
    const monthMap = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
    return '20' + match[1] + '-' + monthMap[match[2]] + '-' + match[3];
  }
  return null;
};

async function main() {
  console.log('=== SIMULATING /api/records ===\n');
  
  const startDateStr = '2025-12-24';
  
  // Get all confirmed orders
  const { data: allOrders } = await supabase
    .from('orders')
    .select('*')
    .eq('placement_status', 'confirmed');
    
  console.log('Total confirmed orders:', allOrders?.length || 0);
  
  // Group by game date
  const ordersByDate = {};
  
  allOrders?.forEach(order => {
    const gameDate = getGameDateFromTicker(order.ticker);
    if (gameDate && gameDate >= startDateStr) {
      if (!ordersByDate[gameDate]) ordersByDate[gameDate] = [];
      ordersByDate[gameDate].push(order);
    }
  });
  
  console.log('\nRecords that would be returned:');
  
  Object.keys(ordersByDate).sort().forEach(date => {
    const dayOrders = ordersByDate[date];
    const won = dayOrders.filter(o => o.result_status === 'won').length;
    const lost = dayOrders.filter(o => o.result_status === 'lost').length;
    const pending = dayOrders.filter(o => o.result_status === 'undecided').length;
    const totalCost = dayOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
    
    console.log(`  ${date}: W=${won} L=${lost} P=${pending} | Cost=$${(totalCost/100).toFixed(2)}`);
  });
  
  // Now simulate what the UI does - match orders by placement_status_at date
  console.log('\n=== WHAT UI DOES (matches by placement_status_at) ===\n');
  
  const getDateFromTimestampET = (isoTimestamp) => {
    return new Date(isoTimestamp).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  };
  
  const ordersByPlacementDate = {};
  allOrders?.forEach(order => {
    if (!order.placement_status_at) return;
    const placedDate = getDateFromTimestampET(order.placement_status_at);
    if (!ordersByPlacementDate[placedDate]) ordersByPlacementDate[placedDate] = [];
    ordersByPlacementDate[placedDate].push(order);
  });
  
  console.log('Orders grouped by placement_status_at date:');
  Object.keys(ordersByPlacementDate).sort().forEach(date => {
    const dayOrders = ordersByPlacementDate[date];
    const totalCost = dayOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
    console.log(`  ${date}: ${dayOrders.length} orders | Cost=$${(totalCost/100).toFixed(2)}`);
  });
  
  // Check mismatches
  console.log('\n=== CHECKING MISMATCHES ===');
  console.log('Records use game date (from ticker)');
  console.log('UI deployed uses placement_status_at date');
  
  const gameDates = Object.keys(ordersByDate);
  const placeDates = Object.keys(ordersByPlacementDate);
  
  // For each record date, check if placement dates match
  for (const recordDate of gameDates) {
    const ordersForGameDate = ordersByDate[recordDate] || [];
    const ordersMatchingPlacement = allOrders?.filter(o => {
      if (!o.placement_status_at) return false;
      return getDateFromTimestampET(o.placement_status_at) === recordDate;
    }) || [];
    
    const gameTotal = ordersForGameDate.reduce((sum, o) => sum + (o.executed_cost_cents || 0), 0);
    const placeTotal = ordersMatchingPlacement.reduce((sum, o) => sum + (o.executed_cost_cents || 0), 0);
    
    if (Math.abs(gameTotal - placeTotal) > 100) {
      console.log(`  ${recordDate}: Game=$${(gameTotal/100).toFixed(2)}, Place=$${(placeTotal/100).toFixed(2)} ← MISMATCH`);
    } else {
      console.log(`  ${recordDate}: Game=$${(gameTotal/100).toFixed(2)}, Place=$${(placeTotal/100).toFixed(2)} ✓`);
    }
  }
}

main().catch(console.error);

