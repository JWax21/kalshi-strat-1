import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Direct fix for executed_cost_cents - bypasses all complex logic
export async function POST() {
  try {
    // Get ALL confirmed orders
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .eq('placement_status', 'confirmed');

    if (error) throw error;

    const results = {
      total_checked: orders?.length || 0,
      fixed: 0,
      already_correct: 0,
      errors: [] as string[],
      details: [] as any[],
    };

    for (const order of orders || []) {
      const units = order.units || 1;
      const pricePerUnit = order.price_cents || 0;
      const expectedCost = pricePerUnit * units;
      const currentCost = order.executed_cost_cents || 0;

      const detail = {
        ticker: order.ticker,
        units,
        price_cents: pricePerUnit,
        expected_cost: expectedCost,
        current_cost: currentCost,
        action: 'none',
      };

      // Check if cost needs fixing (allow 1 cent tolerance)
      if (Math.abs(currentCost - expectedCost) > 1) {
        // Fix it!
        const { error: updateError } = await supabase
          .from('orders')
          .update({
            executed_cost_cents: expectedCost,
            executed_price_cents: pricePerUnit,
          })
          .eq('id', order.id);

        if (updateError) {
          results.errors.push(`${order.ticker}: ${updateError.message}`);
          detail.action = 'error';
        } else {
          results.fixed++;
          detail.action = 'fixed';
        }
      } else {
        results.already_correct++;
        detail.action = 'correct';
      }

      results.details.push(detail);
    }

    return NextResponse.json({
      success: true,
      message: `Fixed ${results.fixed} orders, ${results.already_correct} were already correct`,
      ...results,
    });
  } catch (error) {
    console.error('Error fixing costs:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// GET to see what would be fixed without making changes
export async function GET() {
  try {
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, ticker, units, price_cents, executed_cost_cents, executed_price_cents, placement_status')
      .eq('placement_status', 'confirmed');

    if (error) throw error;

    const analysis = (orders || []).map(order => {
      const units = order.units || 1;
      const pricePerUnit = order.price_cents || 0;
      const expectedCost = pricePerUnit * units;
      const currentCost = order.executed_cost_cents || 0;
      const needsFix = Math.abs(currentCost - expectedCost) > 1;

      return {
        ticker: order.ticker,
        units,
        price_cents: pricePerUnit,
        expected_cost_cents: expectedCost,
        current_cost_cents: currentCost,
        needs_fix: needsFix,
        difference: currentCost - expectedCost,
      };
    });

    const needsFix = analysis.filter(a => a.needs_fix);
    const correct = analysis.filter(a => !a.needs_fix);

    return NextResponse.json({
      success: true,
      summary: {
        total: analysis.length,
        needs_fix: needsFix.length,
        correct: correct.length,
      },
      needs_fix: needsFix,
      correct: correct.slice(0, 5), // Just show first 5 correct ones
    });
  } catch (error) {
    console.error('Error analyzing costs:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

