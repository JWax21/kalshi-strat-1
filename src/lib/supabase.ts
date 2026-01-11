import { createClient } from '@supabase/supabase-js';

// =============================================
// DATABASE CONFIGURATION
// =============================================
// Default: Original favorites database
// Set SUPABASE_UNDERDOG_URL and SUPABASE_UNDERDOG_KEY to use the underdog fund database
// =============================================

// Original favorites database (legacy)
const FAVORITES_DB_URL = 'https://lnycekbczyhxjlxoooqn.supabase.co';
const FAVORITES_DB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI';

// Underdog fund database (new strategy)
// Set these environment variables when you create the new Supabase project:
// - SUPABASE_UNDERDOG_URL: The URL of the new Supabase project
// - SUPABASE_UNDERDOG_KEY: The service role key of the new Supabase project
const UNDERDOG_DB_URL = process.env.SUPABASE_UNDERDOG_URL;
const UNDERDOG_DB_KEY = process.env.SUPABASE_UNDERDOG_KEY;

// Select which database to use
// If UNDERDOG env vars are set, use underdog database; otherwise use favorites
const useUnderdogDb = UNDERDOG_DB_URL && UNDERDOG_DB_KEY;

const supabaseUrl = useUnderdogDb ? UNDERDOG_DB_URL : FAVORITES_DB_URL;
const supabaseServiceKey = useUnderdogDb 
  ? UNDERDOG_DB_KEY 
  : (process.env.SUPABASE_SERVICE_KEY || FAVORITES_DB_KEY);

// Log which database is being used (only on first import)
if (typeof window === 'undefined') {
  console.log(`[Supabase] Using ${useUnderdogDb ? 'UNDERDOG FUND' : 'FAVORITES (legacy)'} database`);
}

// Use service role for server-side operations
export const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Export database info for debugging
export const databaseInfo = {
  isUnderdogFund: useUnderdogDb,
  projectUrl: supabaseUrl,
};

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

