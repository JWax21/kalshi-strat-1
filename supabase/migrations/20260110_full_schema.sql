-- Full schema for KALSHI_UNDERDOG_FUND database
-- Run this in a new Supabase project to create all required tables

-- =============================================
-- ORDER_BATCHES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS order_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_date DATE NOT NULL,
  unit_size_cents INTEGER NOT NULL DEFAULT 100,
  total_orders INTEGER NOT NULL DEFAULT 0,
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  total_potential_payout_cents INTEGER NOT NULL DEFAULT 0,
  is_paused BOOLEAN NOT NULL DEFAULT FALSE,
  prepared_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for batch lookups by date
CREATE INDEX IF NOT EXISTS idx_order_batches_date ON order_batches(batch_date);

COMMENT ON TABLE order_batches IS 'Groups of orders prepared for a specific date';

-- =============================================
-- ORDERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID REFERENCES order_batches(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  event_ticker TEXT NOT NULL,
  title TEXT,
  side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  price_cents INTEGER NOT NULL,
  units INTEGER NOT NULL DEFAULT 1,
  cost_cents INTEGER NOT NULL,
  potential_payout_cents INTEGER NOT NULL,
  potential_profit_cents INTEGER,
  open_interest INTEGER,
  volume_24h INTEGER,
  market_close_time TIMESTAMPTZ,
  
  -- Placement tracking
  placement_status TEXT NOT NULL DEFAULT 'pending' CHECK (placement_status IN ('pending', 'placed', 'confirmed', 'cancelled', 'queue', 'failed')),
  placement_status_at TIMESTAMPTZ,
  kalshi_order_id TEXT,
  
  -- Execution tracking
  executed_price_cents INTEGER,
  executed_cost_cents INTEGER,
  
  -- Result tracking
  result_status TEXT NOT NULL DEFAULT 'undecided' CHECK (result_status IN ('undecided', 'won', 'lost')),
  result_status_at TIMESTAMPTZ,
  
  -- Settlement tracking
  settlement_status TEXT NOT NULL DEFAULT 'pending' CHECK (settlement_status IN ('pending', 'settled')),
  settled_at TIMESTAMPTZ,
  pnl_cents INTEGER,
  
  -- Cancellation tracking
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_orders_batch_id ON orders(batch_id);
CREATE INDEX IF NOT EXISTS idx_orders_ticker ON orders(ticker);
CREATE INDEX IF NOT EXISTS idx_orders_event_ticker ON orders(event_ticker);
CREATE INDEX IF NOT EXISTS idx_orders_placement_status ON orders(placement_status);
CREATE INDEX IF NOT EXISTS idx_orders_result_status ON orders(result_status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_kalshi_order_id ON orders(kalshi_order_id) WHERE kalshi_order_id IS NOT NULL;

COMMENT ON TABLE orders IS 'Individual orders placed on Kalshi markets';

-- =============================================
-- ILLIQUID_MARKETS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS illiquid_markets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL UNIQUE,
  event_ticker TEXT,
  title TEXT,
  reason TEXT,
  original_order_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_illiquid_markets_ticker ON illiquid_markets(ticker);

COMMENT ON TABLE illiquid_markets IS 'Blacklisted markets that failed to fill';

-- =============================================
-- ODDS_HISTORY TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS odds_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL,
  event_ticker TEXT NOT NULL,
  title TEXT,
  side TEXT NOT NULL CHECK (side IN ('yes', 'no')),
  yes_price_cents INTEGER NOT NULL,
  our_side_odds_cents INTEGER NOT NULL,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  drop_alert BOOLEAN NOT NULL DEFAULT FALSE,
  drop_percent NUMERIC(5,1),
  data_quality TEXT NOT NULL DEFAULT 'high' CHECK (data_quality IN ('high', 'medium', 'low', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_odds_history_ticker_logged ON odds_history(ticker, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_odds_history_logged_at ON odds_history(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_odds_history_drop_alert ON odds_history(drop_alert) WHERE drop_alert = TRUE;

COMMENT ON TABLE odds_history IS 'Tracks position odds every minute for drop detection';

-- =============================================
-- DAILY_SNAPSHOTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS daily_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL UNIQUE,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  positions_cents INTEGER NOT NULL DEFAULT 0,
  portfolio_cents INTEGER NOT NULL DEFAULT 0,
  deployed_cents INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  pnl_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date ON daily_snapshots(snapshot_date DESC);

COMMENT ON TABLE daily_snapshots IS 'Daily portfolio snapshots captured at 11:55pm ET';

-- =============================================
-- SIMULATION TABLES (Optional)
-- =============================================
CREATE TABLE IF NOT EXISTS simulation_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL,
  total_markets INTEGER NOT NULL DEFAULT 0,
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS simulation_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID REFERENCES simulation_snapshots(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  event_ticker TEXT NOT NULL,
  title TEXT,
  side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  price_cents INTEGER NOT NULL,
  units INTEGER NOT NULL DEFAULT 1,
  cost_cents INTEGER NOT NULL,
  potential_profit_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost')),
  pnl_cents INTEGER,
  market_close_time TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_simulation_orders_snapshot ON simulation_orders(snapshot_id);

-- =============================================
-- UPDATED_AT TRIGGER FUNCTION
-- =============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to tables with updated_at
DROP TRIGGER IF EXISTS update_order_batches_updated_at ON order_batches;
CREATE TRIGGER update_order_batches_updated_at
    BEFORE UPDATE ON order_batches
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
CREATE TRIGGER update_orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- ROW LEVEL SECURITY (Optional - enable if needed)
-- =============================================
-- ALTER TABLE order_batches ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE illiquid_markets ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE odds_history ENABLE ROW LEVEL SECURITY;

