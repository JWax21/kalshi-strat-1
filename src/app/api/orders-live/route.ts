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
    throw new Error(`Kalshi API error: ${response.status}`);
  }

  return response.json();
}

// GET - Fetch all batches and orders with stats
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get("days") || "30");

    // Get batches from the last N days
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data: batches, error: batchesError } = await supabase
      .from("order_batches")
      .select("*")
      .gte("batch_date", startDate.toISOString().split("T")[0])
      .order("batch_date", { ascending: false });

    if (batchesError) throw batchesError;

    // Get all orders for these batches
    const batchIds = (batches || []).map((b) => b.id);

    let orders: any[] = [];
    if (batchIds.length > 0) {
      const { data: ordersData, error: ordersError } = await supabase
        .from("orders")
        .select("*")
        .in("batch_id", batchIds)
        .order("open_interest", { ascending: false });

      if (ordersError) throw ordersError;
      orders = ordersData || [];
    }

    // Fetch current prices for active positions from Kalshi
    const activeOrders = orders.filter(
      (o) =>
        o.placement_status === "confirmed" && o.result_status === "undecided"
    );
    const currentPrices: Record<string, number> = {};

    // Batch fetch market data for active positions (limit to avoid rate limits)
    const uniqueTickers = [...new Set(activeOrders.map((o) => o.ticker))];
    for (const ticker of uniqueTickers.slice(0, 20)) {
      // Limit to 20 to avoid rate limits
      try {
        const marketData = await kalshiFetch(`/markets/${ticker}`);
        if (marketData?.market) {
          // Get current price based on the order's side
          // Kalshi returns prices in cents already (0-100)
          const yesPrice =
            Math.round(
              (marketData.market.yes_bid + marketData.market.yes_ask) / 2
            ) || 0;
          const noPrice =
            Math.round(
              (marketData.market.no_bid + marketData.market.no_ask) / 2
            ) || 0;
          currentPrices[ticker] = { yes: yesPrice, no: noPrice } as any;
        }
      } catch (e) {
        // Skip if market not found
      }
    }

    // Enrich orders with current prices
    orders = orders.map((order) => {
      const priceData = currentPrices[order.ticker] as any;
      if (priceData) {
        const currentPrice =
          order.side === "YES" ? priceData.yes : priceData.no;
        return { ...order, current_price_cents: currentPrice };
      }
      return { ...order, current_price_cents: null };
    });

    // Group orders by batch
    const ordersByBatch: Record<string, any[]> = {};
    orders.forEach((order) => {
      if (!ordersByBatch[order.batch_id]) {
        ordersByBatch[order.batch_id] = [];
      }
      ordersByBatch[order.batch_id].push(order);
    });

    // Calculate aggregate stats
    const allOrders = orders;

    // Placement status breakdown
    const pendingPlacement = allOrders.filter(
      (o) => o.placement_status === "pending"
    );
    const placedOrders = allOrders.filter(
      (o) => o.placement_status === "placed"
    );
    const confirmedOrders = allOrders.filter(
      (o) => o.placement_status === "confirmed"
    );

    // Result status breakdown (only from confirmed orders)
    const undecidedOrders = confirmedOrders.filter(
      (o) => o.result_status === "undecided"
    );
    const wonOrders = confirmedOrders.filter((o) => o.result_status === "won");
    const lostOrders = confirmedOrders.filter(
      (o) => o.result_status === "lost"
    );

    // Settlement status breakdown (only from orders with result = won or lost)
    const decidedOrdersForSettlement = allOrders.filter(
      (o) => o.result_status === "won" || o.result_status === "lost"
    );
    const pendingSettlement = decidedOrdersForSettlement.filter(
      (o) => o.settlement_status === "pending"
    );
    const closedOrders = decidedOrdersForSettlement.filter(
      (o) => o.settlement_status === "settled" && o.result_status === "lost"
    );
    const successOrders = decidedOrdersForSettlement.filter(
      (o) => o.settlement_status === "settled" && o.result_status === "won"
    );

    const decidedOrders = [...wonOrders, ...lostOrders];

    // ===== PLACEMENT-BASED FINANCIALS =====
    // Estimated cost = limit price * units for placed + confirmed orders
    const placementEstimatedCost = [...placedOrders, ...confirmedOrders].reduce(
      (sum, o) => sum + (o.cost_cents || 0),
      0
    );
    // Actual cost = what we actually paid (only confirmed orders with executed_cost_cents)
    const placementActualCost = confirmedOrders.reduce(
      (sum, o) => sum + (o.executed_cost_cents || 0),
      0
    );
    // Total projected payout = if all confirmed orders win
    const placementProjectedPayout = confirmedOrders.reduce(
      (sum, o) => sum + (o.potential_payout_cents || 0),
      0
    );

    // ===== RESULT-BASED FINANCIALS =====
    // Undecided exposure = cost of orders still waiting for results (cash at risk)
    const resultUndecidedExposure = undecidedOrders.reduce(
      (sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0),
      0
    );
    // Estimated won = payout from orders marked "won" (may not be settled yet)
    const resultEstimatedWon = wonOrders.reduce(
      (sum, o) =>
        sum + (o.actual_payout_cents || o.potential_payout_cents || 0),
      0
    );
    // Cost of won orders
    const resultWonCost = wonOrders.reduce(
      (sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0),
      0
    );
    // Fees on won orders
    const resultWonFees = wonOrders.reduce(
      (sum, o) => sum + (o.fee_cents || 0),
      0
    );
    // Estimated lost = cost of orders marked "lost"
    const resultEstimatedLost = lostOrders.reduce(
      (sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0),
      0
    );
    // Fees on lost orders
    const resultLostFees = lostOrders.reduce(
      (sum, o) => sum + (o.fee_cents || 0),
      0
    );
    // Estimated P&L = (payout - cost - fees) for wins - (cost + fees) for losses
    const resultEstimatedPnl =
      resultEstimatedWon -
      resultWonCost -
      resultWonFees -
      resultEstimatedLost -
      resultLostFees;

    // ===== SETTLEMENT-BASED FINANCIALS (ACTUALS) =====
    // Projected payout = from won orders still pending settlement
    const settlementProjectedPayout = wonOrders
      .filter((o) => o.settlement_status === "pending")
      .reduce((sum, o) => sum + (o.potential_payout_cents || 0), 0);
    // Actual payout = from orders with settlement_status = 'settled' and result = 'won' (cash received)
    // For won orders: payout is $1 per contract = 100 cents
    const settlementActualPayout = successOrders.reduce(
      (sum, o) =>
        sum + (o.actual_payout_cents || o.potential_payout_cents || 0),
      0
    );
    // Actual cost of won orders that were settled
    const settlementWonCost = successOrders.reduce(
      (sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0),
      0
    );
    // Total fees paid on settled trades
    const settlementFeesPaid = successOrders.reduce(
      (sum, o) => sum + (o.fee_cents || 0),
      0
    );
    // Actual lost = from orders with settlement_status = 'settled' and result = 'lost'
    const settlementActualLost = closedOrders.reduce(
      (sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0),
      0
    );
    // Net P&L = (payout - cost - fees) for won orders - lost amount
    // Profit = payout received - cost paid - fees paid - losses
    const settlementNetProfit =
      settlementActualPayout -
      settlementWonCost -
      settlementFeesPaid -
      settlementActualLost;

    const winRate =
      decidedOrders.length > 0
        ? ((wonOrders.length / decidedOrders.length) * 100).toFixed(1)
        : "0.0";

    // ===== FETCH BALANCE FROM KALSHI =====
    let balance = { balance: 0, portfolio_value: 0 };
    try {
      balance = await kalshiFetch("/portfolio/balance");
    } catch (e) {
      console.error("Error fetching balance:", e);
    }

    // ===== TODAY'S STATS =====
    const today = new Date().toISOString().split("T")[0];
    const todayBatch = (batches || []).find((b) => b.batch_date === today);
    const todayOrders = todayBatch ? ordersByBatch[todayBatch.id] || [] : [];

    const todayConfirmed = todayOrders.filter(
      (o) => o.placement_status === "confirmed"
    );
    const todayWon = todayConfirmed.filter((o) => o.result_status === "won");
    const todayLost = todayConfirmed.filter((o) => o.result_status === "lost");
    // Payout received for today's won orders
    const todayPayout = todayWon.reduce(
      (sum, o) =>
        sum + (o.actual_payout_cents || o.potential_payout_cents || 0),
      0
    );
    // Fees paid on today's settled orders
    const todayFees = [...todayWon, ...todayLost].reduce(
      (sum, o) => sum + (o.fee_cents || 0),
      0
    );
    // Cost paid for today's won orders (not losses - those are separate)
    const todayWonCost = todayWon.reduce(
      (sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0),
      0
    );
    // Lost amount
    const todayLostCost = todayLost.reduce(
      (sum, o) => sum + (o.executed_cost_cents || o.cost_cents || 0),
      0
    );
    // Profit = Payout - Fees - Cost of Won Trades - Losses
    const todayProfit = todayPayout - todayFees - todayWonCost - todayLostCost;

    // Enrich batches with their orders
    const enrichedBatches = (batches || []).map((batch) => ({
      ...batch,
      orders: ordersByBatch[batch.id] || [],
    }));

    // CRITICAL: Total portfolio = cash + positions value (Kalshi returns these separately)
    const totalPortfolioCents =
      (balance.balance || 0) + (balance.portfolio_value || 0);

    return NextResponse.json({
      success: true,
      batches: enrichedBatches,
      stats: {
        // Account info from Kalshi
        balance_cents: balance.balance,
        portfolio_value_cents: totalPortfolioCents, // Total portfolio = cash + positions
        total_exposure_cents: balance.portfolio_value, // positions value = market exposure

        // Today's stats
        today: {
          date: today,
          orders: todayOrders.length,
          confirmed: todayConfirmed.length,
          won: todayWon.length,
          lost: todayLost.length,
          payout_cents: todayPayout,
          fees_cents: todayFees,
          cost_cents: todayWonCost,
          lost_cents: todayLostCost,
          profit_cents: todayProfit,
        },

        total_batches: (batches || []).length,
        total_orders: allOrders.length,
        confirmed_orders: confirmedOrders.length,
        won_orders: wonOrders.length,
        lost_orders: lostOrders.length,
        pending_orders: undecidedOrders.length,
        win_rate: winRate,
        // Legacy fields for backward compatibility
        total_cost_cents: placementActualCost,
        total_payout_cents: settlementActualPayout,
        total_fees_cents: settlementFeesPaid,
        net_pnl_cents: settlementNetProfit,
        roi_percent:
          placementActualCost > 0
            ? ((settlementNetProfit / placementActualCost) * 100).toFixed(2)
            : "0.00",
        // Status breakdowns
        placement_breakdown: {
          pending: pendingPlacement.length,
          placed: placedOrders.length,
          confirmed: confirmedOrders.length,
        },
        result_breakdown: {
          undecided: undecidedOrders.length,
          won: wonOrders.length,
          lost: lostOrders.length,
        },
        settlement_breakdown: {
          pending: pendingSettlement.length,
          closed: closedOrders.length,
          success: successOrders.length,
        },
        // Financials by stage
        placement_financials: {
          estimated_cost_cents: placementEstimatedCost,
          actual_cost_cents: placementActualCost,
          projected_payout_cents: placementProjectedPayout,
        },
        result_financials: {
          undecided_exposure_cents: resultUndecidedExposure,
          estimated_won_cents: resultEstimatedWon,
          estimated_lost_cents: resultEstimatedLost,
          estimated_pnl_cents: resultEstimatedPnl,
        },
        settlement_financials: {
          projected_payout_cents: settlementProjectedPayout,
          actual_payout_cents: settlementActualPayout,
          won_cost_cents: settlementWonCost,
          fees_paid_cents: settlementFeesPaid,
          actual_lost_cents: settlementActualLost,
          net_profit_cents: settlementNetProfit,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

// PATCH - Update settings (unit size, pause status)
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const { batch_id, unit_size_cents, is_paused } = body;

    if (!batch_id) {
      return NextResponse.json(
        { success: false, error: "batch_id required" },
        { status: 400 }
      );
    }

    const updates: any = {};
    if (unit_size_cents !== undefined)
      updates.unit_size_cents = unit_size_cents;
    if (is_paused !== undefined) updates.is_paused = is_paused;

    const { error } = await supabase
      .from("order_batches")
      .update(updates)
      .eq("id", batch_id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating batch:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
