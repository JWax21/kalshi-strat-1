import { NextResponse } from 'next/server';
import { KALSHI_CONFIG } from '@/lib/kalshi-config';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const hasApiKey = !!KALSHI_CONFIG.apiKey;
    const hasPrivateKey = !!KALSHI_CONFIG.privateKey;
    const privateKeyLength = KALSHI_CONFIG.privateKey?.length || 0;
    
    let privateKeyValid = false;
    let privateKeyError = '';
    
    try {
      if (KALSHI_CONFIG.privateKey) {
        crypto.createPrivateKey(KALSHI_CONFIG.privateKey);
        privateKeyValid = true;
      }
    } catch (e) {
      privateKeyError = e instanceof Error ? e.message : 'Unknown error';
    }

    // Try a simple Kalshi API call
    let balanceFetch = { success: false, error: '', balance: 0 };
    try {
      const timestampMs = Date.now().toString();
      const method = 'GET';
      const fullPath = '/trade-api/v2/portfolio/balance';

      const message = `${timestampMs}${method}${fullPath}`;
      const privateKey = crypto.createPrivateKey(KALSHI_CONFIG.privateKey);
      const signature = crypto.sign('sha256', Buffer.from(message), {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      }).toString('base64');

      const response = await fetch(`${KALSHI_CONFIG.baseUrl}/portfolio/balance`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'KALSHI-ACCESS-KEY': KALSHI_CONFIG.apiKey,
          'KALSHI-ACCESS-SIGNATURE': signature,
          'KALSHI-ACCESS-TIMESTAMP': timestampMs,
        },
      });

      if (response.ok) {
        const data = await response.json();
        balanceFetch = { success: true, error: '', balance: data.balance || 0 };
      } else {
        balanceFetch = { success: false, error: `HTTP ${response.status}`, balance: 0 };
      }
    } catch (e) {
      balanceFetch = { success: false, error: e instanceof Error ? e.message : 'Unknown', balance: 0 };
    }

    return NextResponse.json({
      config: {
        hasApiKey,
        apiKeyPreview: KALSHI_CONFIG.apiKey?.substring(0, 10) + '...',
        hasPrivateKey,
        privateKeyLength,
        privateKeyValid,
        privateKeyError,
      },
      balanceFetch,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }, { status: 500 });
  }
}

