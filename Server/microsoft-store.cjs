class StoreServiceError extends Error {}

function createMicrosoftStore({ env = process.env, fetchImpl = fetch } = {}) {
  const tenant = env.MS_STORE_TENANT_ID;
  const client = env.MS_STORE_CLIENT_ID;
  const secret = env.MS_STORE_CLIENT_SECRET;
  const configured = Boolean(tenant && client && secret);
  if ([tenant, client, secret].some(Boolean) && !configured) {
    throw new Error('Set all three MS_STORE_TENANT_ID, MS_STORE_CLIENT_ID and MS_STORE_CLIENT_SECRET variables.');
  }
  if (configured && !/^[a-zA-Z0-9.-]+$/.test(tenant)) {
    throw new Error('MS_STORE_TENANT_ID must be a tenant GUID or domain.');
  }
  const tokens = new Map();

  async function token(resource) {
    if (!configured) {
      throw new StoreServiceError('Microsoft Store server credentials are not configured.');
    }
    const cached = tokens.get(resource);
    if (cached && cached.expires > Date.now() + 120000) {
      return cached.value;
    }
    const response = await fetchImpl(`https://login.microsoftonline.com/${tenant}/oauth2/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: client, client_secret: secret, resource,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      throw new StoreServiceError(`Microsoft Store authentication failed (HTTP ${response.status}). Check server credentials.`);
    }
    const data = await response.json();
    if (typeof data.access_token !== 'string' || !data.access_token
        || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 120) {
      throw new StoreServiceError('Microsoft Store returned an invalid service token.');
    }
    tokens.set(resource, { value: data.access_token, expires: Date.now() + Number(data.expires_in) * 1000 });
    return data.access_token;
  }

  return {
    configured,
    identityTicket: () => token('https://onestore.microsoft.com/b2b/keys/create/collections'),
    async consume({ storeId, intentId, userKey, gsn }) {
      const accessToken = await token('https://onestore.microsoft.com');
      const response = await fetchImpl('https://collections.mp.microsoft.com/v8.0/collections/consume', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          beneficiary: { identityType: 'b2b', identityValue: userKey, localTicketReference: String(gsn) },
          productId: storeId, trackingId: intentId, removeQuantity: 1,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        throw new StoreServiceError(`Microsoft Store could not fulfill this pack (HTTP ${response.status}). Retry the pending purchase; do not buy again.`);
      }
      const data = await response.json();
      if (data.productId !== storeId || data.trackingId?.toLowerCase() !== intentId.toLowerCase()
          || !Number.isSafeInteger(data.newQuantity) || data.newQuantity < 0) {
        throw new StoreServiceError('Microsoft Store returned an invalid fulfillment confirmation. Purchase remains pending.');
      }
    },
  };
}

module.exports = { createMicrosoftStore, StoreServiceError };
