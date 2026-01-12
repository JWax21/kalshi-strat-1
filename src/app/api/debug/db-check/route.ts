import { NextResponse } from "next/server";
import { supabase, databaseInfo } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Check which database we're connected to
    const envCheck = {
      SUPABASE_UNDERDOG_URL: process.env.SUPABASE_UNDERDOG_URL ? 
        process.env.SUPABASE_UNDERDOG_URL.substring(0, 50) + "..." : "NOT SET",
      SUPABASE_UNDERDOG_KEY: process.env.SUPABASE_UNDERDOG_KEY ? 
        process.env.SUPABASE_UNDERDOG_KEY.substring(0, 20) + "..." : "NOT SET",
    };

    // Try to count orders to verify connection
    const { count, error } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true });

    return NextResponse.json({
      success: true,
      database: databaseInfo,
      envCheck,
      orderCount: count,
      error: error?.message,
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: String(error),
    });
  }
}

