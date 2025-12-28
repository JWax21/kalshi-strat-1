import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ScenarioResult {
  threshold: number;
  stopLoss: number | null;
  totalBets: number;
  totalEvents: number;
  wins: number;
  losses: number;
  winRate: number;
  totalCost: number;
  totalPayout: number;
  stopLossRecovery: number;
  pnl: number;
  roi: number;
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
      let totalCost = 0;
      let totalPayout = 0;
      let stopLossRecovery = 0;

      for (const [eventTicker, result] of Object.entries(eventResults)) {
        const eventOrders = result.orders;
        const eventCost = eventOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
        const eventPayout = eventOrders
          .filter(o => o.result_status === 'won')
          .reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);

        if (result.hasWon) {
          wins++;
          totalCost += eventCost;
          totalPayout += eventPayout;
        } else if (result.hasLost) {
          losses++;
          
          // For losses, calculate stop-loss recovery
          // If we had a stop-loss at 75, and entry was at e.g. 92, we'd recover:
          // (entry - stopLoss) * units per order
          // This assumes the price dropped through the stop-loss level before going to 0
          
          for (const order of eventOrders) {
            const entryPrice = order.executed_price_cents || order.price_cents || 0;
            const units = order.units || 0;
            
            if (entryPrice > stopLossValue) {
              // Amount we would have saved by exiting at stop-loss instead of 0
              // Original loss = entry_price * units (we paid this, got 0)
              // With stop-loss, we exit at stopLossValue, so we get back: stopLossValue * units
              // Recovery = stopLossValue * units (what we'd get back)
              // But we still lost (entry - stopLoss) * units
              // Net loss with stop-loss = (entry - stopLoss) * units instead of entry * units
              // Recovery = entry * units - (entry - stopLoss) * units = stopLoss * units
              const originalLoss = order.executed_cost_cents || order.cost_cents || 0;
              const lossWithStopLoss = ((entryPrice - stopLossValue) / 100) * units;
              const recovery = originalLoss - lossWithStopLoss;
              stopLossRecovery += recovery;
              totalCost += lossWithStopLoss; // Reduced loss
            } else {
              // Entry was below stop-loss, so stop-loss wouldn't help
              totalCost += order.executed_cost_cents || order.cost_cents || 0;
            }
          }
        }
      }

      const totalEvents = wins + losses;
      const winRate = totalEvents > 0 ? (wins / totalEvents) * 100 : 0;
      const pnl = totalPayout - totalCost;
      const roi = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

      scenarios.push({
        threshold,
        stopLoss: stopLossValue,
        totalBets: eligibleOrders.length,
        totalEvents,
        wins,
        losses,
        winRate: Math.round(winRate * 10) / 10,
        totalCost: Math.round(totalCost),
        totalPayout: Math.round(totalPayout),
        stopLossRecovery: Math.round(stopLossRecovery),
        pnl: Math.round(pnl),
        roi: Math.round(roi * 10) / 10,
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

      for (const result of Object.values(eventResults)) {
        const eventOrders = result.orders;
        const eventCost = eventOrders.reduce((sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0), 0);
        const eventPayout = eventOrders
          .filter(o => o.result_status === 'won')
          .reduce((sum, o) => sum + (o.actual_payout_cents || o.potential_payout_cents || 0), 0);

        if (result.hasWon) {
          wins++;
          totalCost += eventCost;
          totalPayout += eventPayout;
        } else if (result.hasLost) {
          losses++;
          totalCost += eventCost;
        }
      }

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
        winRate: Math.round(winRate * 10) / 10,
        totalCost: Math.round(totalCost),
        totalPayout: Math.round(totalPayout),
        stopLossRecovery: 0,
        pnl: Math.round(pnl),
        roi: Math.round(roi * 10) / 10,
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

