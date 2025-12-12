import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lnycekbczyhxjlxoooqn.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI';

// Use service role for server-side operations
export const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Types for simulation tables
export interface SimulationSnapshot {
  id: string;
  snapshot_date: string;
  total_markets: number;
  total_cost_cents: number;
  created_at: string;
}

export interface SimulationOrder {
  id: string;
  snapshot_id: string;
  ticker: string;
  event_ticker: string;
  title: string;
  side: 'YES' | 'NO';
  price_cents: number;
  units: number;
  cost_cents: number;
  potential_profit_cents: number;
  status: 'pending' | 'won' | 'lost';
  pnl_cents: number | null;
  market_close_time: string;
  settled_at: string | null;
  created_at: string;
}

