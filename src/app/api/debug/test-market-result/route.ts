import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import crypto from "crypto";
import { KALSHI_CONFIG } from "@/lib/kalshi-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getMarketResult(ticker: string): Promise<any> {
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
      return { error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    return {
      ticker,
      status: data.market?.status,
      result: data.market?.result,
      close_time: data.market?.close_time,
      title: data.market?.title,
      raw: data.market,
    };
  } catch (error) {
    return { ticker, error: String(error) };
  }
}

export async function GET() {
  try {
    // Get a few undecided orders
    const { data: orders, error } = await supabase
      .from("orders")
      .select("ticker, title, side")
      .eq("result_status", "undecided")
      .limit(5);

    if (error) throw error;

    const results = [];
    for (const order of orders || []) {
      const marketResult = await getMarketResult(order.ticker);
      results.push({
        ...order,
        marketResult,
        wouldWin:
          marketResult.result &&
          order.side.toLowerCase() === marketResult.result,
      });
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

