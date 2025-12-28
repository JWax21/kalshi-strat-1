import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import crypto from 'crypto';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Helper to make authenticated Kalshi API calls
async function kalshiFetch(endpoint: string): Promise<any> {
  const timestampMs = Date.now().toString();
  const method = 'GET';
  const pathWithoutQuery = endpoint.split('?')[0];
  const fullPath = `/trade-api/v2${pathWithoutQuery}`;

  const message = `${timestampMs}${method}${fullPath}`;
  const privateKey = crypto.createPrivateKey(KALSHI_CONFIG.privateKey);
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');

  const response = await fetch(`${KALSHI_CONFIG.baseUrl}${endpoint}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': KALSHI_CONFIG.apiKey,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    },
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

interface PriceHistoryPoint {
  timestamp: string;
  yes_price: number;
  no_price: number;
}

interface OrderAnalysis {
  id: string;
  ticker: string;
  title: string;
  side: string;
  units: number;
  entry_price_cents: number;
  cost_cents: number;
  result_status: 'won' | 'lost';
  price_history: PriceHistoryPoint[];
  min_price_after_entry: number | null;
  max_price_after_entry: number | null;
  would_trigger_at: Record<number, boolean>; // stopLoss -> would trigger
  recovery_at: Record<number, number>; // stopLoss -> recovery amount in cents
}

// GET - Fetch historical data for What If analysis
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '90');

    // Get all settled orders
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data: settledOrders, error } = await supabase
      .from('orders')
      .select('*, order_batches(batch_date)')
      .in('result_status', ['won', 'lost'])
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!settledOrders || settledOrders.length === 0) {
      return NextResponse.json({
        success: true,
        orders: [],
        summary: {
          total_orders: 0,
          won: 0,
          lost: 0,
        },
      });
    }

    // Analyze each order - fetch price history where available
    const analyzedOrders: OrderAnalysis[] = [];
    const stopLossLevels = [30, 40, 50, 60, 70, 75, 80, 85];

    for (const order of settledOrders.slice(0, 50)) { // Limit to 50 to avoid rate limits
      const entryPrice = order.executed_price_cents || order.price_cents;
      const side = order.side;
      
      // Try to get price history from Kalshi
      // Note: This endpoint may vary - trying candlesticks/history endpoints
      let priceHistory: PriceHistoryPoint[] = [];
      let minPriceAfterEntry: number | null = null;
      let maxPriceAfterEntry: number | null = null;

      try {
        // Try to get market candlestick data
        const historyResponse = await kalshiFetch(
          `/markets/${order.ticker}/candlesticks?period_interval=1440` // Daily candles
        );
        
        if (historyResponse?.candlesticks) {
          priceHistory = historyResponse.candlesticks.map((c: any) => ({
            timestamp: c.end_period_ts,
            yes_price: c.yes_price?.close || c.close_price || 0,
            no_price: 100 - (c.yes_price?.close || c.close_price || 0),
          }));
        }
        
        await new Promise(r => setTimeout(r, 100)); // Rate limit
      } catch (e) {
        // Price history not available for this market
      }

      // Calculate min/max price after entry based on our side
      if (priceHistory.length > 0) {
        const prices = priceHistory.map(p => side === 'YES' ? p.yes_price : p.no_price);
        minPriceAfterEntry = Math.min(...prices);
        maxPriceAfterEntry = Math.max(...prices);
      }

      // Determine if each stop-loss level would trigger
      const wouldTriggerAt: Record<number, boolean> = {};
      const recoveryAt: Record<number, number> = {};

      for (const stopLoss of stopLossLevels) {
        if (order.result_status === 'lost') {
          // For losses: we know price went to 0, so any stop-loss above 0 would trigger
          // The question is: would it have triggered before going to 0?
          // If we have price history, check if it ever dipped below stop-loss
          // If no history, assume it would trigger if stopLoss < entryPrice
          
          if (priceHistory.length > 0 && minPriceAfterEntry !== null) {
            // Price did drop - check if it went below stop-loss
            wouldTriggerAt[stopLoss] = minPriceAfterEntry <= stopLoss;
          } else {
            // No history - assume linear decline, would trigger if stopLoss < entryPrice
            wouldTriggerAt[stopLoss] = stopLoss < entryPrice;
          }
          
          // Recovery = stopLoss * units (if triggered)
          recoveryAt[stopLoss] = wouldTriggerAt[stopLoss] ? stopLoss * order.units : 0;
        } else {
          // For wins: price went to 100, but may have dipped below stop-loss first
          if (priceHistory.length > 0 && minPriceAfterEntry !== null) {
            wouldTriggerAt[stopLoss] = minPriceAfterEntry <= stopLoss;
          } else {
            // No history - estimate based on volatility
            // Closer stop-loss to entry = more likely to trigger
            const gap = entryPrice - stopLoss;
            if (gap <= 5) wouldTriggerAt[stopLoss] = true; // Very likely
            else if (gap <= 10) wouldTriggerAt[stopLoss] = Math.random() < 0.5;
            else if (gap <= 15) wouldTriggerAt[stopLoss] = Math.random() < 0.3;
            else wouldTriggerAt[stopLoss] = Math.random() < 0.1;
          }
          
          // For wins that would trigger, recovery = stopLoss * units (missed full payout)
          // For wins that wouldn't trigger, recovery = 0 (kept full payout)
          recoveryAt[stopLoss] = wouldTriggerAt[stopLoss] ? stopLoss * order.units : 0;
        }
      }

      analyzedOrders.push({
        id: order.id,
        ticker: order.ticker,
        title: order.title,
        side: order.side,
        units: order.units,
        entry_price_cents: entryPrice,
        cost_cents: order.executed_cost_cents || order.cost_cents,
        result_status: order.result_status,
        price_history: priceHistory,
        min_price_after_entry: minPriceAfterEntry,
        max_price_after_entry: maxPriceAfterEntry,
        would_trigger_at: wouldTriggerAt,
        recovery_at: recoveryAt,
      });
    }

    // Calculate summary for each stop-loss level
    const wonOrders = analyzedOrders.filter(o => o.result_status === 'won');
    const lostOrders = analyzedOrders.filter(o => o.result_status === 'lost');

    const actualWonPayout = wonOrders.reduce((sum, o) => sum + (o.units * 100), 0); // Full payout
    const actualWonCost = wonOrders.reduce((sum, o) => sum + o.cost_cents, 0);
    const actualLostCost = lostOrders.reduce((sum, o) => sum + o.cost_cents, 0);
    const actualPnL = actualWonPayout - actualWonCost - actualLostCost;

    const stopLossResults: Record<number, {
      lossesTriggered: number;
      winsTriggered: number;
      lossRecovery: number;
      missedWinProfit: number;
      simulatedPnL: number;
      improvement: number;
    }> = {};

    for (const stopLoss of stopLossLevels) {
      const lossesTriggered = lostOrders.filter(o => o.would_trigger_at[stopLoss]).length;
      const winsTriggered = wonOrders.filter(o => o.would_trigger_at[stopLoss]).length;
      
      // Loss recovery = sum of stopLoss * units for triggered losses
      const lossRecovery = lostOrders
        .filter(o => o.would_trigger_at[stopLoss])
        .reduce((sum, o) => sum + (stopLoss * o.units), 0);
      
      // Missed win profit = sum of (100 - stopLoss) * units for triggered wins
      const missedWinProfit = wonOrders
        .filter(o => o.would_trigger_at[stopLoss])
        .reduce((sum, o) => sum + ((100 - stopLoss) * o.units), 0);
      
      // Simulated P&L:
      // = Actual won payout - missed profit from early exits
      // + Recovery from stopped-out losses
      // - Actual costs
      const simulatedPnL = actualWonPayout - missedWinProfit + lossRecovery - actualWonCost - actualLostCost;
      
      stopLossResults[stopLoss] = {
        lossesTriggered,
        winsTriggered,
        lossRecovery,
        missedWinProfit,
        simulatedPnL,
        improvement: simulatedPnL - actualPnL,
      };
    }

    // Find optimal stop-loss
    const optimalStopLoss = Object.entries(stopLossResults)
      .sort((a, b) => b[1].simulatedPnL - a[1].simulatedPnL)[0];

    return NextResponse.json({
      success: true,
      orders: analyzedOrders,
      summary: {
        total_orders: analyzedOrders.length,
        won: wonOrders.length,
        lost: lostOrders.length,
        actual_pnl_cents: actualPnL,
        stop_loss_results: stopLossResults,
        optimal_stop_loss: {
          price: parseInt(optimalStopLoss[0]),
          ...optimalStopLoss[1],
        },
        has_price_history: analyzedOrders.filter(o => o.price_history.length > 0).length,
      },
    });
  } catch (error) {
    console.error('Error in whatif analysis:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

