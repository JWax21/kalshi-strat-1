import { NextResponse } from "next/server";
import { supabase, databaseInfo } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    // Get one undecided order
    const { data: orders, error: selectError } = await supabase
      .from("orders")
      .select("id, ticker, result_status")
      .eq("result_status", "undecided")
      .limit(1);

    if (selectError) {
      return NextResponse.json({
        success: false,
        step: "select",
        error: selectError,
      });
    }

    if (!orders || orders.length === 0) {
      return NextResponse.json({
        success: false,
        step: "select",
        error: "No undecided orders found",
      });
    }

    const order = orders[0];

    // Try to update it to 'lost'
    const { data: updateData, error: updateError } = await supabase
      .from("orders")
      .update({
        result_status: "lost",
        result_status_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .select();

    if (updateError) {
      return NextResponse.json({
        success: false,
        step: "update",
        orderId: order.id,
        error: updateError,
        databaseInfo,
      });
    }

    // Verify the update
    const { data: verifyData, error: verifyError } = await supabase
      .from("orders")
      .select("id, ticker, result_status, result_status_at")
      .eq("id", order.id)
      .single();

    return NextResponse.json({
      success: true,
      orderId: order.id,
      ticker: order.ticker,
      updateResult: updateData,
      verifyResult: verifyData,
      verifyError,
      databaseInfo,
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: String(error),
    });
  }
}

