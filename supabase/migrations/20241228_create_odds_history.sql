-- Create odds_history table to track position odds over time
-- Used for detecting rapid price drops and triggering alerts

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
  drop_percent NUMERIC(5,1), -- Percentage drop from 10 min ago (e.g., 12.5)
  data_quality TEXT NOT NULL DEFAULT 'high' CHECK (data_quality IN ('high', 'medium', 'low', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient queries
CREATE INDEX IF NOT EXISTS idx_odds_history_ticker_logged ON odds_history(ticker, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_odds_history_logged_at ON odds_history(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_odds_history_drop_alert ON odds_history(drop_alert) WHERE drop_alert = TRUE;

-- Add comment
COMMENT ON TABLE odds_history IS 'Tracks position odds every minute for drop detection. Auto-cleaned after 7 days.';

