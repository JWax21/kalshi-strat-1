import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Clear the illiquid markets blacklist so we can retry those markets
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { ticker, clearAll } = body;

    if (clearAll) {
      // Clear all blacklisted markets
      const { data: deleted, error } = await supabase
        .from('illiquid_markets')
        .delete()
        .neq('ticker', ''); // Delete all

      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        message: 'Cleared all blacklisted markets',
      });
    } else if (ticker) {
      // Clear specific ticker
      const { error } = await supabase
        .from('illiquid_markets')
        .delete()
        .eq('ticker', ticker);

      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        message: `Cleared blacklist entry for ${ticker}`,
      });
    } else {
      return NextResponse.json({ 
        success: false, 
        error: 'Provide ticker or clearAll: true' 
      }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// GET - Show all blacklisted markets
export async function GET() {
  try {
    const { data: blacklisted, error } = await supabase
      .from('illiquid_markets')
      .select('*')
      .order('flagged_at', { ascending: false });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      count: blacklisted?.length || 0,
      markets: blacklisted || [],
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

