import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import crypto from "crypto";
import { KALSHI_CONFIG } from "@/lib/kalshi-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function getMarketResult(ticker: string): Promise<{
  settled: boolean;
  result: "yes" | "no" | null;
  status: string;
}> {
  try {
    const timestampMs = Date.now().toString();
    const method = "GET";
    const endpoint = `/markets/${ticker}`;
    const fullPath = `/trade-api/v2${endpoint}`;

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
      return { settled: false, result: null, status: "error" };
    }

    const data = await response.json();
    const market = data.market;

    if (market.result === "yes" || market.result === "no") {
      return { settled: true, result: market.result, status: market.status };
    }

    return { settled: false, result: null, status: market.status };
  } catch (error) {
    return { settled: false, result: null, status: "error" };
  }
}

export async function POST() {
  try {
    // Get all undecided orders
    const { data: orders, error: selectError } = await supabase
      .from("orders")
      .select("id, ticker, side, result_status")
      .eq("result_status", "undecided")
      .eq("placement_status", "confirmed");

    if (selectError) {
      return NextResponse.json({ success: false, error: selectError });
    }

    if (!orders || orders.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No undecided orders to update",
      });
    }

    const results = {
      checked: orders.length,
      updated: 0,
      won: 0,
      lost: 0,
      still_pending: 0,
      errors: [] as string[],
    };

    for (const order of orders) {
      const marketResult = await getMarketResult(order.ticker);

      if (!marketResult.settled || !marketResult.result) {
        results.still_pending++;
        continue;
      }

      const won = order.side.toLowerCase() === marketResult.result;
      const resultStatus = won ? "won" : "lost";
      const settlementStatus = won ? "pending" : "closed";

      // Use .select() to force the update to return data (and confirm it worked)
      const { data: updateData, error: updateError } = await supabase
        .from("orders")
        .update({
          result_status: resultStatus,
          result_status_at: new Date().toISOString(),
          settlement_status: settlementStatus,
          settlement_status_at: won ? null : new Date().toISOString(),
        })
        .eq("id", order.id)
        .select("id, result_status");

      if (updateError) {
        results.errors.push(`${order.ticker}: ${updateError.message}`);
      } else if (updateData && updateData.length > 0) {
        results.updated++;
        if (won) results.won++;
        else results.lost++;
      } else {
        results.errors.push(`${order.ticker}: No rows updated`);
      }

      // Rate limit
      await new Promise((r) => setTimeout(r, 100));
    }

    return NextResponse.json({
      success: true,
      results,
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: String(error),
    });
  }
}

