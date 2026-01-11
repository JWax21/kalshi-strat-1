import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Check if config is present
    const configCheck = {
      hasApiKey: !!KALSHI_CONFIG.apiKey,
      apiKeyLength: KALSHI_CONFIG.apiKey?.length || 0,
      hasPrivateKey: !!KALSHI_CONFIG.privateKey,
      privateKeyLength: KALSHI_CONFIG.privateKey?.length || 0,
      privateKeyStart: KALSHI_CONFIG.privateKey?.substring(0, 50) || 'MISSING',
      baseUrl: KALSHI_CONFIG.baseUrl,
    };

    if (!KALSHI_CONFIG.apiKey || !KALSHI_CONFIG.privateKey) {
      return NextResponse.json({
        success: false,
        error: 'Missing Kalshi API credentials',
        configCheck,
      });
    }

    // Try to make the API call
    const timestampMs = Date.now().toString();
    const method = 'GET';
    const endpoint = '/portfolio/balance';
    const fullPath = `/trade-api/v2${endpoint}`;

    const message = `${timestampMs}${method}${fullPath}`;
    
    let signature: string;
    try {
      const privateKey = crypto.createPrivateKey(KALSHI_CONFIG.privateKey);
      signature = crypto.sign('sha256', Buffer.from(message), {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      }).toString('base64');
    } catch (signError: any) {
      return NextResponse.json({
        success: false,
        error: 'Failed to sign request',
        signError: signError.message,
        configCheck,
      });
    }

    const fullUrl = `${KALSHI_CONFIG.baseUrl}${endpoint}`;
    
    const response = await fetch(fullUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'KALSHI-ACCESS-KEY': KALSHI_CONFIG.apiKey,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestampMs,
      },
    });

    const responseText = await response.text();
    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      responseJson = null;
    }

    return NextResponse.json({
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      responseJson,
      responseText: responseJson ? undefined : responseText,
      configCheck,
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message,
      stack: error.stack,
    }, { status: 500 });
  }
}

