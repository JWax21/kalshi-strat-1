import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Delete a batch and its orders
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { batch_id, batch_date } = body;

    if (!batch_id && !batch_date) {
      return NextResponse.json(
        { success: false, error: 'Must provide batch_id or batch_date' },
        { status: 400 }
      );
    }

    let targetBatchId = batch_id;

    // If batch_date provided, find the batch
    if (!targetBatchId && batch_date) {
      const { data: batch, error } = await supabase
        .from('order_batches')
        .select('id')
        .eq('batch_date', batch_date)
        .single();

      if (error || !batch) {
        return NextResponse.json(
          { success: false, error: `No batch found for ${batch_date}` },
          { status: 404 }
        );
      }
      targetBatchId = batch.id;
    }

    // Delete orders first (foreign key constraint)
    const { data: deletedOrders, error: ordersError } = await supabase
      .from('orders')
      .delete()
      .eq('batch_id', targetBatchId)
      .select('id');

    if (ordersError) throw ordersError;

    // Delete the batch
    const { error: batchError } = await supabase
      .from('order_batches')
      .delete()
      .eq('id', targetBatchId);

    if (batchError) throw batchError;

    return NextResponse.json({
      success: true,
      message: `Deleted batch ${targetBatchId} and ${deletedOrders?.length || 0} orders`,
      deleted_orders: deletedOrders?.length || 0,
    });
  } catch (error) {
    console.error('Error deleting batch:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

