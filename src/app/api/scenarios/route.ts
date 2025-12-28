import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import crypto from "crypto";
import { KALSHI_CONFIG } from "@/lib/kalshi-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Helper to make authenticated Kalshi API calls
async function kalshiFetch(endpoint: string): Promise<any> {
  const timestampMs = Date.now().toString();
  const method = "GET";
  const pathWithoutQuery = endpoint.split("?")[0];
  const fullPath = `/trade-api/v2${pathWithoutQuery}`;

  const message = `${timestampMs}${method}${fullPath}`;
  const privateKey = crypto.createPrivateKey(KALSHI_CONFIG.privateKey);
  const signature = crypto
    .sign("sha256", Buffer.from(message), {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");

  const response = await fetch(`${KALSHI_CONFIG.baseUrl}${endpoint}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "KALSHI-ACCESS-KEY": KALSHI_CONFIG.apiKey,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    },
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

// Fetch min AND max price for an order from candlestick data
// Returns { minPrice, maxPrice } for the user's side
async function getPriceRangeForOrder(
  order: any
): Promise<{ minPrice: number | null; maxPrice: number | null }> {
  try {
    const seriesTicker = order.event_ticker?.split("-")[0] || "";
    const marketTicker = order.ticker;
    const userSide = order.side;

    if (!seriesTicker || !marketTicker)
      return { minPrice: null, maxPrice: null };

    // Get FULL time range for the market (not just from placement)
    // We need the high to determine if we would have triggered at a given threshold
    const closeTime = order.market_close_time
      ? Math.floor(new Date(order.market_close_time).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    // Start from 48 hours before close to capture full price range
    const startTs = closeTime - 48 * 60 * 60;
    const endTs = closeTime;

    const url = `/series/${seriesTicker}/markets/${marketTicker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=60`;
    const response = await kalshiFetch(url);

    if (!response?.candlesticks || response.candlesticks.length === 0) {
      return { minPrice: null, maxPrice: null };
    }

    // Calculate min and max price for user's side
    let minPrice = 100;
    let maxPrice = 0;

    for (const c of response.candlesticks) {
      const yesLow = c.price?.low ?? c.yes_bid?.low ?? 100;
      const yesHigh = c.price?.high ?? c.yes_bid?.high ?? 0;

      // User's min/max depends on their side
      if (userSide === "YES") {
        if (yesLow > 0 && yesLow < minPrice) minPrice = yesLow;
        if (yesHigh > maxPrice) maxPrice = yesHigh;
      } else {
        // For NO side, min = 100 - yesHigh, max = 100 - yesLow
        const noLow = yesHigh > 0 ? 100 - yesHigh : 100;
        const noHigh = yesLow > 0 ? 100 - yesLow : 0;
        if (noLow > 0 && noLow < minPrice) minPrice = noLow;
        if (noHigh > maxPrice) maxPrice = noHigh;
      }
    }

    return {
      minPrice: minPrice < 100 ? minPrice : null,
      maxPrice: maxPrice > 0 ? maxPrice : null,
    };
  } catch (e) {
    return { minPrice: null, maxPrice: null };
  }
}

interface EventBreakdown {
  event_ticker: string;
  event_title: string;
  side: string;
  entry_price: number;
  would_bet: boolean;
  actual_result: "won" | "lost";
  min_price: number | null;
  would_stop: boolean;
  simulated_result: "won" | "stopped" | "lost";
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
  losses: number; // True losses (entry < SL)
  winsStoppedOut: number; // Wins that would have been sold due to stop-loss dip
  lossesSaved: number; // Losses saved by stop-loss
  winRate: number;
  totalCost: number;
  totalPayout: number;
  stopLossRecovery: number;
  missedWinProfit: number; // Profit missed from stopped-out wins
  pnl: number;
  roi: number;
  breakdown: EventBreakdown[];
}

// Helper function to calculate scenario for a given threshold and stop-loss
// KEY LOGIC: We would have triggered a buy if the HIGH price reached the threshold
function calculateScenario(
  threshold: number,
  stopLossValue: number,
  orders: any[],
  orderPriceRanges: Map<
    string,
    { minPrice: number | null; maxPrice: number | null }
  >
): ScenarioResult {
  // Group ALL orders by event_ticker first
  const eventResults: Record<
    string,
    { hasWon: boolean; hasLost: boolean; orders: typeof orders }
  > = {};
  for (const order of orders) {
    if (!eventResults[order.event_ticker]) {
      eventResults[order.event_ticker] = {
        hasWon: false,
        hasLost: false,
        orders: [],
      };
    }
    eventResults[order.event_ticker].orders.push(order);
    if (order.result_status === "won") {
      eventResults[order.event_ticker].hasWon = true;
    } else if (order.result_status === "lost") {
      eventResults[order.event_ticker].hasLost = true;
    }
  }

  let wins = 0;
  let losses = 0;
  let winsStoppedOut = 0;
  let lossesSaved = 0;
  let totalCost = 0;
  let totalPayout = 0;
  let stopLossRecovery = 0;
  let missedWinProfit = 0;
  const breakdown: EventBreakdown[] = [];
  let eligibleOrderCount = 0;

  for (const [eventTicker, result] of Object.entries(eventResults)) {
    const eventOrders = result.orders;

    // Get the max price for this event (across all orders)
    // This determines if we would have triggered at the threshold
    let eventMaxPrice = 0;
    let eventMinPrice = 100;
    let hasRealPriceData = false;
    
    for (const order of eventOrders) {
      const range = orderPriceRanges.get(order.id);
      if (range?.maxPrice && range.maxPrice > eventMaxPrice) {
        eventMaxPrice = range.maxPrice;
        hasRealPriceData = true;
      }
      if (range?.minPrice && range.minPrice < eventMinPrice) {
        eventMinPrice = range.minPrice;
      }
      
      // FALLBACK: If no candlestick data, use actual entry price as max
      // This ensures we don't skip orders just because API didn't return data
      if (!hasRealPriceData) {
        const entryPrice = order.executed_price_cents || order.price_cents || 0;
        if (entryPrice > eventMaxPrice) {
          eventMaxPrice = entryPrice;
        }
      }
    }
    
    // If no price data at all, use entry price as max (fallback)
    if (eventMaxPrice === 0) {
      for (const order of eventOrders) {
        const entryPrice = order.executed_price_cents || order.price_cents || 0;
        if (entryPrice > eventMaxPrice) eventMaxPrice = entryPrice;
      }
    }

    // CRITICAL: Would we have triggered at this threshold?
    // We buy when price reaches our threshold
    const wouldTrigger = eventMaxPrice >= threshold;

    if (!wouldTrigger) {
      // Price never reached our threshold, we wouldn't have bet
      continue;
    }

    // We would have bet! Calculate simulated P&L
    eligibleOrderCount += eventOrders.length;

    // Simulated entry price = threshold (we buy when price hits our threshold)
    const simulatedEntryPrice = threshold;

    // Calculate simulated cost (at threshold price, not actual entry)
    // Use same units as actual orders
    const totalUnits = eventOrders.reduce(
      (sum: number, o: any) => sum + (o.units || 0),
      0
    );
    const simulatedCost = (simulatedEntryPrice / 100) * totalUnits * 100; // Cost in cents

    // Would we hit stop-loss?
    const wouldHitStopLoss =
      eventMinPrice < stopLossValue && simulatedEntryPrice > stopLossValue;

    if (result.hasWon) {
      // Actual result was a win
      const actualPayout = totalUnits * 100; // $1 per unit on win

      if (wouldHitStopLoss) {
        // Win that would have been stopped out
        winsStoppedOut++;
        const stopLossReturn = (stopLossValue / 100) * totalUnits * 100;
        totalCost += simulatedCost;
        totalPayout += stopLossReturn;
        missedWinProfit +=
          actualPayout - simulatedCost - (stopLossReturn - simulatedCost);

        breakdown.push({
          event_ticker: eventTicker,
          event_title: eventOrders[0]?.event_title || eventTicker,
          side: eventOrders[0]?.side || "YES",
          entry_price: simulatedEntryPrice,
          would_bet: true,
          actual_result: "won",
          min_price: eventMinPrice < 100 ? eventMinPrice : null,
          would_stop: true,
          simulated_result: "stopped",
          cost: Math.round(simulatedCost),
          actual_payout: actualPayout,
          simulated_payout: Math.round(stopLossReturn),
          actual_pnl: actualPayout - simulatedCost,
          simulated_pnl: Math.round(stopLossReturn - simulatedCost),
          market_close_time: eventOrders[0]?.market_close_time || null,
        });
      } else {
        // Win that held through
        wins++;
        totalCost += simulatedCost;
        totalPayout += actualPayout;

        breakdown.push({
          event_ticker: eventTicker,
          event_title: eventOrders[0]?.event_title || eventTicker,
          side: eventOrders[0]?.side || "YES",
          entry_price: simulatedEntryPrice,
          would_bet: true,
          actual_result: "won",
          min_price: eventMinPrice < 100 ? eventMinPrice : null,
          would_stop: false,
          simulated_result: "won",
          cost: Math.round(simulatedCost),
          actual_payout: actualPayout,
          simulated_payout: actualPayout,
          actual_pnl: actualPayout - simulatedCost,
          simulated_pnl: actualPayout - simulatedCost,
          market_close_time: eventOrders[0]?.market_close_time || null,
        });
      }
    } else if (result.hasLost) {
      // Actual result was a loss (price went to 0)

      if (stopLossValue > 0 && simulatedEntryPrice > stopLossValue) {
        // Loss that would be saved by stop-loss
        lossesSaved++;
        const stopLossReturn = (stopLossValue / 100) * totalUnits * 100;
        stopLossRecovery += stopLossReturn;
        totalCost += simulatedCost;
        totalPayout += stopLossReturn;

        breakdown.push({
          event_ticker: eventTicker,
          event_title: eventOrders[0]?.event_title || eventTicker,
          side: eventOrders[0]?.side || "YES",
          entry_price: simulatedEntryPrice,
          would_bet: true,
          actual_result: "lost",
          min_price: 0,
          would_stop: true,
          simulated_result: "stopped",
          cost: Math.round(simulatedCost),
          actual_payout: 0,
          simulated_payout: Math.round(stopLossReturn),
          actual_pnl: -simulatedCost,
          simulated_pnl: Math.round(stopLossReturn - simulatedCost),
          market_close_time: eventOrders[0]?.market_close_time || null,
        });
      } else {
        // True loss (no stop-loss or entry below SL)
        losses++;
        totalCost += simulatedCost;

        breakdown.push({
          event_ticker: eventTicker,
          event_title: eventOrders[0]?.event_title || eventTicker,
          side: eventOrders[0]?.side || "YES",
          entry_price: simulatedEntryPrice,
          would_bet: true,
          actual_result: "lost",
          min_price: 0,
          would_stop: false,
          simulated_result: "lost",
          cost: Math.round(simulatedCost),
          actual_payout: 0,
          simulated_payout: 0,
          actual_pnl: -simulatedCost,
          simulated_pnl: -simulatedCost,
          market_close_time: eventOrders[0]?.market_close_time || null,
        });
      }
    }
  }

  const totalEvents = wins + losses + winsStoppedOut + lossesSaved;
  const effectiveWinRate = totalEvents > 0 ? (wins / totalEvents) * 100 : 0;
  const pnl = totalPayout - totalCost;
  const roi = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

  breakdown.sort((a, b) => {
    if (!a.market_close_time && !b.market_close_time) return 0;
    if (!a.market_close_time) return 1;
    if (!b.market_close_time) return -1;
    return (
      new Date(b.market_close_time).getTime() -
      new Date(a.market_close_time).getTime()
    );
  });

  return {
    threshold,
    stopLoss: stopLossValue,
    totalBets: eligibleOrderCount,
    totalEvents,
    wins,
    losses,
    winsStoppedOut,
    lossesSaved,
    winRate: Math.round(effectiveWinRate * 10) / 10,
    totalCost: Math.round(totalCost),
    totalPayout: Math.round(totalPayout),
    stopLossRecovery: Math.round(stopLossRecovery),
    missedWinProfit: Math.round(missedWinProfit),
    pnl: Math.round(pnl),
    roi: Math.round(roi * 10) / 10,
    breakdown,
  };
}

// Helper function to calculate scenario WITHOUT stop-loss
// Uses same max-price triggering logic
function calculateScenarioNoStopLoss(
  threshold: number,
  orders: any[],
  orderPriceRanges: Map<
    string,
    { minPrice: number | null; maxPrice: number | null }
  >
): ScenarioResult {
  // Group ALL orders by event_ticker
  const eventResults: Record<
    string,
    { hasWon: boolean; hasLost: boolean; orders: typeof orders }
  > = {};
  for (const order of orders) {
    if (!eventResults[order.event_ticker]) {
      eventResults[order.event_ticker] = {
        hasWon: false,
        hasLost: false,
        orders: [],
      };
    }
    eventResults[order.event_ticker].orders.push(order);
    if (order.result_status === "won")
      eventResults[order.event_ticker].hasWon = true;
    else if (order.result_status === "lost")
      eventResults[order.event_ticker].hasLost = true;
  }

  let wins = 0,
    losses = 0,
    totalCost = 0,
    totalPayout = 0;
  let eligibleOrderCount = 0;
  const breakdown: EventBreakdown[] = [];

  for (const [eventTicker, result] of Object.entries(eventResults)) {
    const eventOrders = result.orders;

    // Get max price for this event
    let eventMaxPrice = 0;
    let hasRealPriceData = false;
    
    for (const order of eventOrders) {
      const range = orderPriceRanges.get(order.id);
      if (range?.maxPrice && range.maxPrice > eventMaxPrice) {
        eventMaxPrice = range.maxPrice;
        hasRealPriceData = true;
      }
      
      // FALLBACK: If no candlestick data, use actual entry price as max
      if (!hasRealPriceData) {
        const entryPrice = order.executed_price_cents || order.price_cents || 0;
        if (entryPrice > eventMaxPrice) {
          eventMaxPrice = entryPrice;
        }
      }
    }
    
    // If no price data at all, use entry price as max
    if (eventMaxPrice === 0) {
      for (const order of eventOrders) {
        const entryPrice = order.executed_price_cents || order.price_cents || 0;
        if (entryPrice > eventMaxPrice) eventMaxPrice = entryPrice;
      }
    }

    // Would we have triggered at this threshold?
    const wouldTrigger = eventMaxPrice >= threshold;
    if (!wouldTrigger) continue;

    eligibleOrderCount += eventOrders.length;
    const simulatedEntryPrice = threshold;
    const totalUnits = eventOrders.reduce(
      (sum: number, o: any) => sum + (o.units || 0),
      0
    );
    const simulatedCost = (simulatedEntryPrice / 100) * totalUnits * 100;

    if (result.hasWon) {
      wins++;
      const actualPayout = totalUnits * 100;
      totalCost += simulatedCost;
      totalPayout += actualPayout;
      breakdown.push({
        event_ticker: eventTicker,
        event_title: eventOrders[0]?.event_title || eventTicker,
        side: eventOrders[0]?.side || "YES",
        entry_price: simulatedEntryPrice,
        would_bet: true,
        actual_result: "won",
        min_price: null,
        would_stop: false,
        simulated_result: "won",
        cost: Math.round(simulatedCost),
        actual_payout: actualPayout,
        simulated_payout: actualPayout,
        actual_pnl: actualPayout - simulatedCost,
        simulated_pnl: actualPayout - simulatedCost,
        market_close_time: eventOrders[0]?.market_close_time || null,
      });
    } else if (result.hasLost) {
      losses++;
      totalCost += simulatedCost;
      breakdown.push({
        event_ticker: eventTicker,
        event_title: eventOrders[0]?.event_title || eventTicker,
        side: eventOrders[0]?.side || "YES",
        entry_price: simulatedEntryPrice,
        would_bet: true,
        actual_result: "lost",
        min_price: 0,
        would_stop: false,
        simulated_result: "lost",
        cost: Math.round(simulatedCost),
        actual_payout: 0,
        simulated_payout: 0,
        actual_pnl: -simulatedCost,
        simulated_pnl: -simulatedCost,
        market_close_time: eventOrders[0]?.market_close_time || null,
      });
    }
  }

  const totalEvents = wins + losses;
  const winRate = totalEvents > 0 ? (wins / totalEvents) * 100 : 0;
  const pnl = totalPayout - totalCost;
  const roi = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

  return {
    threshold,
    stopLoss: null,
    totalBets: eligibleOrderCount,
    totalEvents,
    wins,
    losses,
    winsStoppedOut: 0,
    lossesSaved: 0,
    winRate: Math.round(winRate * 10) / 10,
    totalCost: Math.round(totalCost),
    totalPayout: Math.round(totalPayout),
    stopLossRecovery: 0,
    missedWinProfit: 0,
    pnl: Math.round(pnl),
    roi: Math.round(roi * 10) / 10,
    breakdown,
  };
}

// GET - Analyze different threshold scenarios
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get("days") || "90");
    const stopLossValuesParam =
      searchParams.get("stopLosses") || "50,55,60,65,70,75";
    const stopLossValues = stopLossValuesParam
      .split(",")
      .map((v) => parseInt(v.trim()));

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Get all confirmed orders with results
    const { data: orders, error } = await supabase
      .from("orders")
      .select("*")
      .eq("placement_status", "confirmed")
      .in("result_status", ["won", "lost"])
      .gte("created_at", startDate.toISOString())
      .order("created_at", { ascending: false });

    if (error) throw error;

    if (!orders || orders.length === 0) {
      return NextResponse.json({
        success: true,
        scenarios: [],
        summary: { total_orders: 0 },
      });
    }

    // Fetch min AND max prices for ALL orders
    // - maxPrice: determines if we would have triggered at a given threshold
    // - minPrice: determines if we would have hit stop-loss
    const orderPriceRanges = new Map<
      string,
      { minPrice: number | null; maxPrice: number | null }
    >();

    console.log(
      `[Scenarios] Fetching price ranges for ${orders.length} orders...`
    );

    // Fetch in batches to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < orders.length; i += batchSize) {
      const batch = orders.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (order) => {
          const priceRange = await getPriceRangeForOrder(order);
          return { id: order.id, ...priceRange };
        })
      );

      for (const result of results) {
        orderPriceRanges.set(result.id, {
          minPrice: result.minPrice,
          maxPrice: result.maxPrice,
        });
      }

      // Rate limit between batches
      if (i + batchSize < orders.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const ordersWithMaxPrice = [...orderPriceRanges.values()].filter((v) => v.maxPrice !== null).length;
    const ordersWithMinPrice = [...orderPriceRanges.values()].filter((v) => v.minPrice !== null).length;
    console.log(
      `[Scenarios] Fetched price ranges. Orders: ${orders.length}, With maxPrice: ${ordersWithMaxPrice}, With minPrice: ${ordersWithMinPrice}`
    );
    
    // Debug: log sample of price ranges
    const sampleRanges = [...orderPriceRanges.entries()].slice(0, 3);
    console.log(`[Scenarios] Sample price ranges:`, sampleRanges.map(([id, r]) => ({ id: id.slice(0, 8), ...r })));

    // Analyze scenarios for thresholds 85-95 across all stop-loss values
    const thresholds = [85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95];

    // Create matrix: threshold x stopLoss -> P&L
    // Also store all scenario details for breakdown display
    const matrix: Record<number, Record<number, number>> = {};
    const allScenarios: Record<string, ScenarioResult> = {}; // key: "threshold-stopLoss"
    const scenarios: ScenarioResult[] = []; // For backward compat (75¢ SL)
    const scenariosWithoutStopLoss: ScenarioResult[] = [];

    // Calculate for each threshold
    for (const threshold of thresholds) {
      matrix[threshold] = {};

      // Calculate with each stop-loss value
      for (const sl of stopLossValues) {
        const result = calculateScenario(
          threshold,
          sl,
          orders,
          orderPriceRanges
        );
        matrix[threshold][sl] = result.pnl;
        allScenarios[`${threshold}-${sl}`] = result;

        // Store detailed scenarios for the last stop-loss value (for backward compat)
        if (sl === stopLossValues[stopLossValues.length - 1]) {
          scenarios.push(result);
        }
      }

      // Also calculate without stop-loss for comparison
      const noSLResult = calculateScenarioNoStopLoss(
        threshold,
        orders,
        orderPriceRanges
      );
      scenariosWithoutStopLoss.push(noSLResult);
      allScenarios[`${threshold}-0`] = noSLResult;
      matrix[threshold][0] = noSLResult.pnl; // 0 = no stop-loss
    }

    // Find optimal combination
    let optimalThreshold = 85;
    let optimalStopLoss = 75;
    let maxPnl = Number.NEGATIVE_INFINITY;

    for (const threshold of thresholds) {
      for (const sl of stopLossValues) {
        if (matrix[threshold][sl] > maxPnl) {
          maxPnl = matrix[threshold][sl];
          optimalThreshold = threshold;
          optimalStopLoss = sl;
        }
      }
    }

    return NextResponse.json({
      success: true,
      scenarios,
      scenariosWithoutStopLoss,
      allScenarios,
      matrix,
      stopLossValues,
      thresholds,
      optimal: {
        threshold: optimalThreshold,
        stopLoss: optimalStopLoss,
        pnl: maxPnl,
      },
      summary: {
        total_orders: orders.length,
        days_analyzed: days,
      },
    });
  } catch (error) {
    console.error("Error analyzing scenarios:", error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
