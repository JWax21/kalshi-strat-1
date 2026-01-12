import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Helper to convert UTC timestamp to ET date string
function getETDateFromTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// GET - List orders that need fixing (no batch_id or undecided status)
export async function GET() {
  try {
    const { data: ordersNeedingFix, error } = await supabase
      .from('orders')
      .select('id, ticker, event_ticker, title, side, placement_status_at, batch_id, result_status, cost_cents, units')
      .or('batch_id.is.null,result_status.eq.undecided')
      .order('placement_status_at', { ascending: false });

    if (error) throw error;

    // Also get all batches
    const { data: batches } = await supabase
      .from('order_batches')
      .select('id, batch_date')
      .order('batch_date', { ascending: false });

    return NextResponse.json({
      orders_needing_fix: ordersNeedingFix?.map(o => ({
        ...o,
        suggested_batch_date: o.placement_status_at ? getETDateFromTimestamp(o.placement_status_at) : null,
      })),
      available_batches: batches,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST - Fix specific orders
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { fixes } = body;

    // fixes should be an array like:
    // [{ order_id: "xxx", batch_date: "2025-12-24", result_status: "won", actual_payout_cents: 38900 }]

    if (!fixes || !Array.isArray(fixes)) {
      return NextResponse.json({ 
        error: 'Please provide fixes array', 
        example: {
          fixes: [
            { order_id: "uuid", batch_date: "2025-12-24", result_status: "won" },
            { order_id: "uuid2", batch_date: "2025-12-25", result_status: "lost" }
          ]
        }
      }, { status: 400 });
    }

    const results: any[] = [];

    for (const fix of fixes) {
      const { order_id, batch_date, result_status, actual_payout_cents, ticker, side, title } = fix;

      if (!order_id) {
        results.push({ error: 'order_id is required', fix });
        continue;
      }

      const updateData: any = {};

      // Direct field updates
      if (ticker) updateData.ticker = ticker;
      if (side) updateData.side = side.toUpperCase();
      if (title) updateData.title = title;

      // If batch_date provided, find or create the batch
      if (batch_date) {
        let { data: batch } = await supabase
          .from('order_batches')
          .select('id')
          .eq('batch_date', batch_date)
          .single();

        if (!batch) {
          const { data: newBatch, error: batchError } = await supabase
            .from('order_batches')
            .insert({
              batch_date: batch_date,
              unit_size_cents: 100,
              total_orders: 0,
              total_cost_cents: 0,
              total_potential_payout_cents: 0,
              is_paused: false,
            })
            .select('id')
            .single();

          if (batchError) {
            results.push({ error: `Failed to create batch: ${batchError.message}`, fix });
            continue;
          }
          batch = newBatch;
        }

        if (batch) {
          updateData.batch_id = batch.id;
        }
      }

      // Update result status if provided
      if (result_status) {
        updateData.result_status = result_status;
        updateData.result_status_at = new Date().toISOString();
        
        if (result_status === 'won' || result_status === 'lost') {
          updateData.settlement_status = 'success';
          updateData.settled_at = new Date().toISOString();
        }
      }

      // Update payout if provided
      if (actual_payout_cents !== undefined) {
        updateData.actual_payout_cents = actual_payout_cents;
      }

      // If won but no payout specified, calculate it
      if (result_status === 'won' && actual_payout_cents === undefined) {
        const { data: order } = await supabase
          .from('orders')
          .select('units')
          .eq('id', order_id)
          .single();
        
        if (order) {
          updateData.actual_payout_cents = order.units * 100; // $1 per unit won
        }
      }

      // If lost, payout is 0
      if (result_status === 'lost') {
        updateData.actual_payout_cents = 0;
      }

      if (Object.keys(updateData).length === 0) {
        results.push({ error: 'Nothing to update', fix });
        continue;
      }

      const { error: updateError } = await supabase
        .from('orders')
        .update(updateData)
        .eq('id', order_id);

      results.push({
        order_id,
        success: !updateError,
        updated: updateData,
        error: updateError?.message,
      });
    }

    return NextResponse.json({ results });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

