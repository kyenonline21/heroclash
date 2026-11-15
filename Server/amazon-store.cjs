const { StoreServiceError } = require('./microsoft-store.cjs');

function createAmazonStore({ env = process.env, fetchImpl = fetch } = {}) {
    const sharedSecret = env.AMAZON_IAP_SHARED_SECRET;
    const rvsMode = env.AMAZON_IAP_RVS_MODE || 'production';
    if (!['production', 'sandbox'].includes(rvsMode)) {
        throw new Error('AMAZON_IAP_RVS_MODE must be production or sandbox.');
    }
    return {
        configured: Boolean(sharedSecret),
        async verifyReceipt(receiptId, userId) {
            if (!sharedSecret) {
                throw new StoreServiceError('Amazon IAP receipt verification is not configured.');
            }
            let url;
            if (rvsMode === 'sandbox') {
                if (!userId) {
                    throw new StoreServiceError('Amazon sandbox receipt verification requires an Appstore user ID.');
                }
                url = `https://appstore-sdk.amazon.com/sandbox/version/1.0/verifyReceiptId/developer/${encodeURIComponent(sharedSecret)}/user/${encodeURIComponent(userId)}/receiptId/${encodeURIComponent(receiptId)}`;
            } else {
                url = `https://appstore-sdk.amazon.com/version/1.0/verifyReceiptId/${encodeURIComponent(sharedSecret)}/${encodeURIComponent(receiptId)}`;
            }
            let response;
            try {
                response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
            } catch {
                throw new StoreServiceError('Amazon receipt verification is unavailable. Retry this purchase.');
            }
            if (!response.ok) {
                throw new StoreServiceError(`Amazon rejected the receipt (HTTP ${response.status}).`);
            }
            let receipt;
            try {
                receipt = await response.json();
            } catch {
                throw new StoreServiceError('Amazon returned an invalid receipt response.');
            }
            return receipt;
        },
    };
}

module.exports = { createAmazonStore };