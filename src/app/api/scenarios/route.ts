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

// Fetch min price for an order from candlestick data
async function getMinPriceForOrder(order: any): Promise<number | null> {
  try {
    const seriesTicker = order.event_ticker?.split('-')[0] || '';
    const marketTicker = order.ticker;
    const userSide = order.side;
    
    if (!seriesTicker || !marketTicker) return null;
    
    // Get time range from placement to market close
    const placementTime = order.placement_status_at 
      ? Math.floor(new Date(order.placement_status_at).getTime() / 1000)
      : null;
    const closeTime = order.market_close_time 
      ? Math.floor(new Date(order.market_close_time).getTime() / 1000)
      : Math.floor(Date.now() / 1000);
    
    const startTs = placementTime || closeTime - (48 * 60 * 60);
    const endTs = closeTime;
    
    const url = `/series/${seriesTicker}/markets/${marketTicker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=60`;
    const response = await kalshiFetch(url);
    
    if (!response?.candlesticks || response.candlesticks.length === 0) {
      return null;
    }
    
    // Calculate min price for user's side
    let minPrice = 100;
    for (const c of response.candlesticks) {
      const yesLow = c.price?.low ?? c.yes_bid?.low ?? 100;
      const yesHigh = c.price?.high ?? c.yes_bid?.high ?? 0;
      
      // User's min depends on their side
      const userMin = userSide === 'YES' ? yesLow : (yesHigh > 0 ? 100 - yesHigh : 100);
      if (userMin > 0 && userMin < minPrice) {
        minPrice = userMin;
      }
    }
    
    return minPrice < 100 ? minPrice : null;
  } catch (e) {
    return null;
  }
}

interface EventBreakdown {
  event_ticker: string;
  event_title: string;
  side: string;
  entry_price: number;
  would_bet: boolean;
  actual_result: 'won' | 'lost';
  min_price: number | null;
  would_stop: boolean;
  simulated_result: 'won' | 'stopped' | 'lost';
  cost: number;
  actual_payout: number;
  simulated_payout: number;
  actual_pnl: number;
  simulated_pnl: number;
  market_close_time: string | null;
}

interface ScenarioResult {
  threshold: number;
  stopLoss: number | null;
  totalBets: number;
  totalEvents: number;
  wins: number;
  losses: number;
  winsStoppedOut: number; // Wins that would have been sold due to stop-loss dip
  winRate: number;
  totalCost: number;
  totalPayout: number;
  stopLossRecovery: number;
  missedWinProfit: number; // Profit missed from stopped-out wins
  pnl: number;
  roi: number;
  breakdown: EventBreakdown[];
}

// GET - Analyze different threshold scenarios
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '90');
    const stopLossValue = parseInt(searchParams.get('stopLoss') || '75');

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Get all confirmed orders with results
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .eq('placement_status', 'confirmed')
      .in('result_status', ['won', 'lost'])
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!orders || orders.length === 0) {
      return NextResponse.json({
        success: true,
        scenarios: [],
        summary: { total_orders: 0 },
      });
    }

    // Fetch min prices for winning orders (we need to know if they dipped below stop-loss)
    // Only fetch for won orders since we already know lost orders went to 0
    const winningOrders = orders.filter(o => o.result_status === 'won');
    const orderMinPrices = new Map<string, number | null>();
    
    console.log(`[Scenarios] Fetching min prices for ${winningOrders.length} winning orders...`);
    
    // Fetch in batches to avoid rate limits (max 10 concurrent)
    const batchSize = 5;
    for (let i = 0; i < winningOrders.length; i += batchSize) {
      const batch = winningOrders.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (order) => {
          const minPrice = await getMinPriceForOrder(order);
          return { id: order.id, minPrice };
        })
      );
      
      for (const result of results) {
        orderMinPrices.set(result.id, result.minPrice);
      }
      
      // Rate limit between batches
      if (i + batchSize < winningOrders.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    
    console.log(`[Scenarios] Fetched min prices. Orders with data: ${[...orderMinPrices.values()].filter(v => v !== null).length}`);

    // Analyze scenarios for thresholds 85-95
    const thresholds = [85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95];
    const scenarios: ScenarioResult[] = [];

    for (const threshold of thresholds) {
      // Filter orders that would have been placed at this threshold
      // An order would be placed if entry_price >= threshold
      const eligibleOrders = orders.filter(o => {
        const entryPrice = o.executed_price_cents || o.price_cents || 0;
        return entryPrice >= threshold;
      });

      // Group by event_ticker to count unique events
      const eventResults: Record<string, { 
        hasWon: boolean; 
        hasLost: boolean;
        orders: typeof orders;
      }> = {};

      for (const order of eligibleOrders) {
        if (!eventResults[order.event_ticker]) {
          eventResults[order.event_ticker] = { hasWon: false, hasLost: false, orders: [] };
        }
        eventResults[order.event_ticker].orders.push(order);
        if (order.result_status === 'won') {
          eventResults[order.event_ticker].hasWon = true;
        } else if (order.result_status === 'lost') {
          eventResults[order.event_ticker].hasLost = true;
        }
      }

      // Calculate wins/losses by unique events
      let wins = 0;
      let losses = 0;
      let winsStoppedOut = 0; // Wins we would have sold due to stop-loss
      let totalCost = 0;
      let totalPayout = 0;
      let stopLossRecovery = 0;
      let missedWinProfit = 0; // Profit we would have missed from stopped-out wins
      const breakdown: EventBreakdown[] = [];

      for (const [eventTicker, result] of Object.entries(eventResults)) {
        const eventOrders = result.orders;
        const eventCost = eventOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
        const eventPayout = eventOrders
          .filter(o => o.result_status === 'won')
          .reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);

        if (result.hasWon) {
          // For wins, check if any order's min price was below stop-loss (using cached data)
          // We look up min prices that were pre-fetched
          
          const avgEntryPrice = eventOrders.reduce((sum, o) => sum + (o.executed_price_cents || o.price_cents || 0), 0) / eventOrders.length;
          
          // Check if any order in this event has a min price below stop-loss
          // Use the orderMinPrices map populated earlier
          let wouldDip = false;
          for (const order of eventOrders) {
            const minPrice = orderMinPrices.get(order.id);
            if (minPrice !== undefined && minPrice !== null && minPrice < stopLossValue) {
              wouldDip = true;
              break;
            }
          }
          
          if (wouldDip && avgEntryPrice > stopLossValue) {
            // This win would have been stopped out!
            winsStoppedOut++;
            
            // We would have sold at stop-loss price, getting back stopLoss * units per dollar
            // Original payout = units * 100 (win pays $1 per contract)
            // With stop-loss, we'd get stopLoss * units instead
            let eventSimulatedPayout = 0;
            for (const order of eventOrders) {
              const units = order.units || 0;
              const originalPayout = order.actual_payout_cents || order.potential_payout_cents || 0;
              const costPaid = order.executed_cost_cents || order.cost_cents || 0;
              const stopLossReturn = (stopLossValue / 100) * units * 100; // Selling at 75¢
              
              // We get back stopLossReturn instead of full payout
              totalPayout += stopLossReturn;
              totalCost += costPaid;
              eventSimulatedPayout += stopLossReturn;
              
              // Missed profit = what we would have made minus what we actually got
              const actualProfit = originalPayout - costPaid;
              const stopLossProfit = stopLossReturn - costPaid;
              missedWinProfit += (actualProfit - stopLossProfit);
            }
            
            // Get min price for this event
            let eventMinPrice: number | null = null;
            for (const order of eventOrders) {
              const minPrice = orderMinPrices.get(order.id);
              if (minPrice !== null && minPrice !== undefined) {
                if (eventMinPrice === null || minPrice < eventMinPrice) {
                  eventMinPrice = minPrice;
                }
              }
            }
            
            // Add breakdown entry for stopped-out win
            breakdown.push({
              event_ticker: eventTicker,
              event_title: eventOrders[0]?.event_title || eventTicker,
              side: eventOrders[0]?.side || 'YES',
              entry_price: Math.round(avgEntryPrice),
              would_bet: true,
              actual_result: 'won',
              min_price: eventMinPrice,
              would_stop: true,
              simulated_result: 'stopped',
              cost: eventCost,
              actual_payout: eventPayout,
              simulated_payout: Math.round(eventSimulatedPayout),
              actual_pnl: eventPayout - eventCost,
              simulated_pnl: Math.round(eventSimulatedPayout) - eventCost,
              market_close_time: eventOrders[0]?.market_close_time || null,
            });
          } else {
            // This win held through - we get full payout
            wins++;
            totalCost += eventCost;
            totalPayout += eventPayout;
            
            // Add breakdown entry for win
            breakdown.push({
              event_ticker: eventTicker,
              event_title: eventOrders[0]?.event_title || eventTicker,
              side: eventOrders[0]?.side || 'YES',
              entry_price: Math.round(avgEntryPrice),
              would_bet: true,
              actual_result: 'won',
              min_price: null, // Not relevant for wins that held
              would_stop: false,
              simulated_result: 'won',
              cost: eventCost,
              actual_payout: eventPayout,
              simulated_payout: eventPayout,
              actual_pnl: eventPayout - eventCost,
              simulated_pnl: eventPayout - eventCost,
              market_close_time: eventOrders[0]?.market_close_time || null,
            });
          }
        } else if (result.hasLost) {
          losses++;
          
          // For losses, calculate stop-loss recovery
          // The price definitely dropped through stop-loss on the way to 0
          
          const avgEntryPrice = eventOrders.reduce((sum, o) => sum + (o.executed_price_cents || o.price_cents || 0), 0) / eventOrders.length;
          let eventSimulatedPayout = 0;
          let wouldStopLoss = false;
          
          for (const order of eventOrders) {
            const entryPrice = order.executed_price_cents || order.price_cents || 0;
            const units = order.units || 0;
            
            if (entryPrice > stopLossValue) {
              // We exit at stop-loss instead of riding to 0
              // Original loss = cost paid (got 0 back)
              // With stop-loss, we sell at stopLossValue, getting back stopLoss * units
              const costPaid = order.executed_cost_cents || order.cost_cents || 0;
              const stopLossReturn = (stopLossValue / 100) * units * 100;
              
              stopLossRecovery += stopLossReturn; // What we got back
              totalCost += costPaid;
              totalPayout += stopLossReturn;
              eventSimulatedPayout += stopLossReturn;
              wouldStopLoss = true;
            } else {
              // Entry was below stop-loss, so stop-loss wouldn't trigger
              totalCost += order.executed_cost_cents || order.cost_cents || 0;
              // No payout - we lost
            }
          }
          
          // Add breakdown entry for loss
          breakdown.push({
            event_ticker: eventTicker,
            event_title: eventOrders[0]?.event_title || eventTicker,
            side: eventOrders[0]?.side || 'YES',
            entry_price: Math.round(avgEntryPrice),
            would_bet: true,
            actual_result: 'lost',
            min_price: 0, // It went to 0
            would_stop: wouldStopLoss,
            simulated_result: 'lost',
            cost: eventCost,
            actual_payout: 0,
            simulated_payout: Math.round(eventSimulatedPayout),
            actual_pnl: -eventCost,
            simulated_pnl: Math.round(eventSimulatedPayout) - eventCost,
            market_close_time: eventOrders[0]?.market_close_time || null,
          });
        }
      }

      const totalEvents = wins + losses + winsStoppedOut;
      const effectiveWinRate = totalEvents > 0 ? (wins / totalEvents) * 100 : 0;
      const pnl = totalPayout - totalCost;
      const roi = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

      // Sort breakdown by market close time (most recent first)
      breakdown.sort((a, b) => {
        if (!a.market_close_time && !b.market_close_time) return 0;
        if (!a.market_close_time) return 1;
        if (!b.market_close_time) return -1;
        return new Date(b.market_close_time).getTime() - new Date(a.market_close_time).getTime();
      });

      scenarios.push({
        threshold,
        stopLoss: stopLossValue,
        totalBets: eligibleOrders.length,
        totalEvents,
        wins,
        losses,
        winsStoppedOut,
        winRate: Math.round(effectiveWinRate * 10) / 10,
        totalCost: Math.round(totalCost),
        totalPayout: Math.round(totalPayout),
        stopLossRecovery: Math.round(stopLossRecovery),
        missedWinProfit: Math.round(missedWinProfit),
        pnl: Math.round(pnl),
        roi: Math.round(roi * 10) / 10,
        breakdown,
      });
    }

    // Also calculate scenario WITHOUT stop-loss for comparison
    const scenariosWithoutStopLoss: ScenarioResult[] = [];
    
    for (const threshold of thresholds) {
      const eligibleOrders = orders.filter(o => {
        const entryPrice = o.executed_price_cents || o.price_cents || 0;
        return entryPrice >= threshold;
      });

      const eventResults: Record<string, { hasWon: boolean; hasLost: boolean; orders: typeof orders }> = {};

      for (const order of eligibleOrders) {
        if (!eventResults[order.event_ticker]) {
          eventResults[order.event_ticker] = { hasWon: false, hasLost: false, orders: [] };
        }
        eventResults[order.event_ticker].orders.push(order);
        if (order.result_status === 'won') {
          eventResults[order.event_ticker].hasWon = true;
        } else if (order.result_status === 'lost') {
          eventResults[order.event_ticker].hasLost = true;
        }
      }

      let wins = 0;
      let losses = 0;
      let totalCost = 0;
      let totalPayout = 0;
      const breakdownNoSL: EventBreakdown[] = [];

      for (const [eventTicker, result] of Object.entries(eventResults)) {
        const eventOrders = result.orders;
        const eventCost = eventOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
        const eventPayout = eventOrders
          .filter(o => o.result_status === 'won')
          .reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);
        const avgEntryPrice = eventOrders.reduce((sum, o) => sum + (o.executed_price_cents || o.price_cents || 0), 0) / eventOrders.length;

        if (result.hasWon) {
          wins++;
          totalCost += eventCost;
          totalPayout += eventPayout;
          
          breakdownNoSL.push({
            event_ticker: eventTicker,
            event_title: eventOrders[0]?.event_title || eventTicker,
            side: eventOrders[0]?.side || 'YES',
            entry_price: Math.round(avgEntryPrice),
            would_bet: true,
            actual_result: 'won',
            min_price: null,
            would_stop: false,
            simulated_result: 'won',
            cost: eventCost,
            actual_payout: eventPayout,
            simulated_payout: eventPayout,
            actual_pnl: eventPayout - eventCost,
            simulated_pnl: eventPayout - eventCost,
            market_close_time: eventOrders[0]?.market_close_time || null,
          });
        } else if (result.hasLost) {
          losses++;
          totalCost += eventCost;
          
          breakdownNoSL.push({
            event_ticker: eventTicker,
            event_title: eventOrders[0]?.event_title || eventTicker,
            side: eventOrders[0]?.side || 'YES',
            entry_price: Math.round(avgEntryPrice),
            would_bet: true,
            actual_result: 'lost',
            min_price: 0,
            would_stop: false,
            simulated_result: 'lost',
            cost: eventCost,
            actual_payout: 0,
            simulated_payout: 0,
            actual_pnl: -eventCost,
            simulated_pnl: -eventCost,
            market_close_time: eventOrders[0]?.market_close_time || null,
          });
        }
      }
      
      // Sort breakdown by market close time (most recent first)
      breakdownNoSL.sort((a, b) => {
        if (!a.market_close_time && !b.market_close_time) return 0;
        if (!a.market_close_time) return 1;
        if (!b.market_close_time) return -1;
        return new Date(b.market_close_time).getTime() - new Date(a.market_close_time).getTime();
      });

      const totalEvents = wins + losses;
      const winRate = totalEvents > 0 ? (wins / totalEvents) * 100 : 0;
      const pnl = totalPayout - totalCost;
      const roi = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

      scenariosWithoutStopLoss.push({
        threshold,
        stopLoss: null,
        totalBets: eligibleOrders.length,
        totalEvents,
        wins,
        losses,
        winsStoppedOut: 0,
        winRate: Math.round(winRate * 10) / 10,
        totalCost: Math.round(totalCost),
        totalPayout: Math.round(totalPayout),
        stopLossRecovery: 0,
        missedWinProfit: 0,
        pnl: Math.round(pnl),
        roi: Math.round(roi * 10) / 10,
        breakdown: breakdownNoSL,
      });
    }

    return NextResponse.json({
      success: true,
      scenarios,
      scenariosWithoutStopLoss,
      summary: {
        total_orders: orders.length,
        days_analyzed: days,
        stop_loss_value: stopLossValue,
      },
    });
  } catch (error) {
    console.error('Error analyzing scenarios:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

