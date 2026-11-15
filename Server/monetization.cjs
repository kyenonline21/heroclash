const crypto = require('node:crypto');
const { StoreServiceError } = require('./microsoft-store.cjs');

function createMonetization({
  db, config, store, amazonStore, callbackSecret, tables, transaction, required, integer, ApiError, utcTime, parseUtcTime,
}) {
  if (!Array.isArray(config.products) || typeof config.privacyConfigured !== 'boolean'
    || !Number.isSafeInteger(tables.get('CommonTable')[0].AdChestTimeCut)
    || tables.get('CommonTable')[0].AdChestTimeCut <= 0) {
    throw new Error('Invalid UWP catalog, privacy configuration or chest ad reduction.');
  }
  const catalog = config.products.map((product) => {
    const row = tables.get('ShopTable').find((item) => item.ProductID === product.shopId);
    if (!row || row.Category !== 4 || row.ItemType !== 6 || row.StoreType !== 1 || row.IsActive !== 1
      || !Number.isSafeInteger(row.ItemCount) || row.ItemCount <= 0
      || !/^heropocket\.diamonds\d+$/.test(product.offerToken)
      || (product.storeId !== '' && !/^[A-Z0-9]{12}$/.test(product.storeId))) {
      throw new Error(`Invalid UWP product mapping: ${product.shopId}`);
    }
    return { ...product, amount: row.ItemCount };
  });
  for (const key of ['shopId', 'offerToken', 'storeId']) {
    const values = catalog.map((item) => item[key]).filter((value) => value !== '');
    if (new Set(values).size !== values.length) {
      throw new Error(`Duplicate UWP product ${key}.`);
    }
  }
  if (callbackSecret && callbackSecret.length < 32) {
    throw new Error('VUNGLE_CALLBACK_SECRET must contain at least 32 characters.');
  }
  const adsConfigured = Boolean(callbackSecret && config.privacyConfigured && config.vungleAppId
    && config.chestTimePlacement && config.battleDoublePlacement);
  if (config.chestTimePlacement && config.chestTimePlacement === config.battleDoublePlacement) {
    throw new Error('Use separate Vungle placements for chest time reduction and battle rewards.');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS amazon_receipts (
      receipt_id TEXT PRIMARY KEY,
      gsn INTEGER NOT NULL REFERENCES accounts(gsn),
      shop_id INTEGER NOT NULL,
      granted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS store_intents (
      intent_id TEXT PRIMARY KEY,
      gsn INTEGER NOT NULL REFERENCES accounts(gsn),
      shop_id INTEGER NOT NULL,
      store_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      fulfillment_started INTEGER NOT NULL DEFAULT 0,
      granted_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS store_pending_product
      ON store_intents(gsn, shop_id) WHERE granted_at IS NULL;
    CREATE TABLE IF NOT EXISTS ad_intents (
      intent_id TEXT PRIMARY KEY,
      gsn INTEGER NOT NULL REFERENCES accounts(gsn),
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      placement TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      provider_transaction TEXT UNIQUE,
      response_json TEXT,
      UNIQUE (gsn, kind, target)
    );
  `);
  const inFlight = new Map();
  const loadState = (gsn) => JSON.parse(db.prepare('SELECT state_json FROM accounts WHERE gsn = ?').get(gsn).state_json);
  const saveState = (gsn, state) => db.prepare('UPDATE accounts SET state_json = ? WHERE gsn = ?')
    .run(JSON.stringify(state), gsn);
  const storeReady = () => {
    if (!store.configured) {
      throw new ApiError(4003, 'Microsoft Store is not configured on this server. No payment was started.');
    }
  };
  const adInfo = (row) => ({
    ad_intent: row.intent_id, placement: row.placement,
    status: row.response_json ? 'granted' : 'pending',
  });
  const storeInfo = (row) => ({
    intent_id: row.intent_id, product_id: String(row.shop_id), store_id: row.store_id,
    fulfillment_started: row.fulfillment_started ? '1' : '0',
  });

  async function handle(fields, account, now) {
    const pg = fields.pg;
    if (!account.tutorial_completed) {
      throw new ApiError(4003, 'Complete the tutorial before purchasing or using rewarded ads.');
    }
    if (pg === 'store_catalog') {
      return {
        store_enabled: store.configured ? '1' : '0',
        ads_enabled: adsConfigured ? '1' : '0',
        products: catalog.filter((item) => item.storeId).map((item) => ({
          product_id: String(item.shopId), store_id: item.storeId, amount: String(item.amount),
        })),
      };
    }
    if (pg === 'store_pending') {
      return {
        list: db.prepare('SELECT * FROM store_intents WHERE gsn = ? AND granted_at IS NULL ORDER BY created_at')
          .all(account.gsn).map(storeInfo)
      };
    }
    if (pg === 'store_identity') {
      storeReady();
      return { service_ticket: await store.identityTicket(), publisher_user_id: String(account.gsn) };
    }
    if (pg === 'store_begin') {
      storeReady();
      const id = integer(fields, 'product_id', 1, 2147483647);
      const product = catalog.find((item) => item.shopId === id && item.storeId);
      if (!product) {
        throw new ApiError(4003, 'This Microsoft Store product has not been configured.');
      }
      return transaction(() => {
        let row = db.prepare('SELECT * FROM store_intents WHERE gsn = ? AND shop_id = ? AND granted_at IS NULL')
          .get(account.gsn, id);
        if (!row) {
          row = {
            intent_id: crypto.randomUUID(), gsn: account.gsn, shop_id: id,
            store_id: product.storeId, amount: product.amount, created_at: now,
          };
          db.prepare(`INSERT INTO store_intents (intent_id, gsn, shop_id, store_id, amount, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`).run(row.intent_id, row.gsn, id, row.store_id, row.amount, now);
        }
        return storeInfo(row);
      });
    }
    if (pg === 'store_redeem') {
      storeReady();
      const id = required(fields, 'intent_id');
      const row = db.prepare('SELECT * FROM store_intents WHERE intent_id = ? AND gsn = ?').get(id, account.gsn);
      if (!row) {
        throw new ApiError(4003, 'Purchase intent does not belong to this account.');
      }
      const userKey = required(fields, 'user_key', 16000);
      if (!row.granted_at) {
        if (!inFlight.has(id)) {
          db.prepare('UPDATE store_intents SET fulfillment_started = 1 WHERE intent_id = ?').run(id);
          const work = (async () => {
            // Commit the durable tracking ID before the remote call; always reuse it after a crash.
            await store.consume({ storeId: row.store_id, intentId: id, userKey, gsn: account.gsn });
            transaction(() => {
              const current = db.prepare('SELECT granted_at FROM store_intents WHERE intent_id = ?').get(id);
              if (current.granted_at !== null) {
                return;
              }
              const state = loadState(account.gsn);
              state.user_info.jewel = String(Number(state.user_info.jewel) + row.amount);
              saveState(account.gsn, state);
              db.prepare('UPDATE store_intents SET granted_at = ? WHERE intent_id = ?').run(Date.now(), id);
            });
          })();
          inFlight.set(id, work);
        }
        const work = inFlight.get(id);
        try {
          await work;
        } finally {
          if (inFlight.get(id) === work) {
            inFlight.delete(id);
          }
        }
      }
      return { ...storeInfo(row), remain_value: loadState(account.gsn).user_info.jewel };
    }
    if (pg === 'amazon_purchase') {
      if (!amazonStore?.configured) {
        throw new ApiError(4003, 'Amazon receipt verification is not configured. No purchase was fulfilled.');
      }
      const receiptId = required(fields, 'receipt_id', 256);
      const shopId = integer(fields, 'product_id', 1, 2147483647);
      const product = tables.get('ShopTable').find((item) => item.ProductID === shopId
        && item.Category === 4 && item.ItemType === 6 && item.StoreType === 1 && item.IsActive === 1
        && Number.isSafeInteger(item.ItemCount) && item.ItemCount > 0);
      if (!product || required(fields, 'sku', 128) !== product.ShopProductID) {
        throw new ApiError(4003, 'This Amazon product is not available.');
      }
      const previous = db.prepare('SELECT * FROM amazon_receipts WHERE receipt_id = ?').get(receiptId);
      if (previous) {
        if (previous.gsn !== account.gsn || previous.shop_id !== shopId) {
          throw new ApiError(4003, 'This Amazon receipt has already been used.');
        }
        return { product_id: String(shopId), remain_value: loadState(account.gsn).user_info.jewel };
      }
      let verified;
      try {
        verified = await amazonStore.verifyReceipt(receiptId, fields.user_id);
      } catch (error) {
        if (error instanceof StoreServiceError) {
          throw new ApiError(4003, error.message);
        }
        throw error;
      }
      if (verified?.receiptId !== receiptId || verified.productId !== product.ShopProductID
        || verified.productType !== 'CONSUMABLE'
        || (verified.cancelDate !== undefined && verified.cancelDate !== null && Number(verified.cancelDate) !== 0)) {
        throw new ApiError(4003, 'Amazon receipt does not match an active purchase for this product.');
      }
      return transaction(() => {
        const duplicate = db.prepare('SELECT * FROM amazon_receipts WHERE receipt_id = ?').get(receiptId);
        if (duplicate) {
          if (duplicate.gsn !== account.gsn || duplicate.shop_id !== shopId) {
            throw new ApiError(4003, 'This Amazon receipt has already been used.');
          }
          return { product_id: String(shopId), remain_value: loadState(account.gsn).user_info.jewel };
        }
        const state = loadState(account.gsn);
        state.user_info.jewel = String(Number(state.user_info.jewel) + product.ItemCount);
        saveState(account.gsn, state);
        db.prepare('INSERT INTO amazon_receipts (receipt_id, gsn, shop_id, granted_at) VALUES (?, ?, ?, ?)')
          .run(receiptId, account.gsn, shopId, now);
        return { product_id: String(shopId), remain_value: state.user_info.jewel };
      });
    }
    if (pg === 'ad_prepare') {
      if (!adsConfigured) {
        throw new ApiError(4003, 'Vungle rewarded ads and server callbacks are not configured.');
      }
      const kind = required(fields, 'kind');
      const state = loadState(account.gsn);
      let target;
      let payload;
      let placement;
      if (kind === 'battle_double') {
        target = required(fields, 'room_id');
        const battle = db.prepare('SELECT * FROM battles WHERE gsn = ? AND room_id = ?').get(account.gsn, target);
        if (!battle?.result_json || battle.created_at < now - 86400000) {
          throw new ApiError(4003, 'No recent completed battle is available for this reward.');
        }
        const result = JSON.parse(battle.result_json);
        payload = { amount: Number(result.winGold) + Number(result.mvpGold) + Number(result.boosterGold) };
        if (!Number.isSafeInteger(payload.amount) || payload.amount <= 0) {
          throw new ApiError(4003, 'This battle has no gold to double.');
        }
        placement = config.battleDoublePlacement;
      } else if (kind === 'chest_time') {
        target = required(fields, 'chest_instance');
        const slot = integer(fields, 'slot_id', 3, 6);
        const chest = state.chest_info.find((item) => item.slot_id === String(slot) && item.chest_instance === target);
        if (!chest || chest.complete_type !== '1' || parseUtcTime(chest.complete_value) <= now) {
          throw new ApiError(4003, 'This chest is no longer counting down.');
        }
        payload = { slot, minutes: tables.get('CommonTable')[0].AdChestTimeCut };
        placement = config.chestTimePlacement;
      } else {
        throw new ApiError(4000, 'Unsupported rewarded placement.');
      }
      return transaction(() => {
        let row = db.prepare('SELECT * FROM ad_intents WHERE gsn = ? AND kind = ? AND target = ?')
          .get(account.gsn, kind, target);
        if (row?.response_json) {
          throw new ApiError(4003, 'This reward has already been granted.');
        }
        if (row && row.expires_at <= now) {
          db.prepare('DELETE FROM ad_intents WHERE intent_id = ?').run(row.intent_id);
          row = undefined;
        }
        if (!row) {
          row = { intent_id: crypto.randomUUID(), placement };
          db.prepare(`INSERT INTO ad_intents (intent_id, gsn, kind, target, payload_json, placement, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.intent_id, account.gsn, kind, target,
            JSON.stringify(payload), placement, now + 15 * 60000);
        }
        return adInfo(row);
      });
    }
    if (pg === 'ad_claim') {
      const id = required(fields, 'ad_intent');
      const row = db.prepare('SELECT * FROM ad_intents WHERE intent_id = ? AND gsn = ?').get(id, account.gsn);
      if (!row) {
        throw new ApiError(4003, 'Reward intent does not belong to this account.');
      }
      if (!row.response_json && row.expires_at <= now) {
        throw new ApiError(4003, 'Rewarded ad expired without a verified completion.');
      }
      const state = loadState(account.gsn);
      return {
        ...adInfo(row), ...(row.response_json ? JSON.parse(row.response_json) : {}),
        curGold: state.user_info.gold, curJewel: state.user_info.jewel,
        chest_info: state.chest_info,
      };
    }
    throw new ApiError(4004, 'Unsupported monetization operation.');
  }

  function callback(url) {
    if (!adsConfigured) {
      throw new ApiError(4003, 'Vungle server callback is disabled.', 503);
    }
    const supplied = Buffer.from(url.searchParams.get('key') || '');
    const expected = Buffer.from(callbackSecret);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      throw new ApiError(4001, 'Invalid callback credentials.', 403);
    }
    const id = url.searchParams.get('user');
    const tx = url.searchParams.get('txid');
    const placement = url.searchParams.get('placement');
    if (!id || id.length > 128 || !tx || tx.length > 128 || !placement) {
      throw new ApiError(4000, 'Callback requires user, txid and placement.', 400);
    }
    return transaction(() => {
      const row = db.prepare('SELECT * FROM ad_intents WHERE intent_id = ?').get(id);
      if (!row) {
        throw new ApiError(4003, 'Unknown reward intent.', 404);
      }
      if (row.placement !== placement) {
        throw new ApiError(4003, 'Callback placement does not match the reward intent.', 409);
      }
      if (row.response_json) {
        if (row.provider_transaction !== tx) {
          throw new ApiError(4003, 'Reward already completed by another transaction.', 409);
        }
        return { accepted: true };
      }
      if (row.expires_at <= Date.now()
        || db.prepare('SELECT 1 FROM ad_intents WHERE provider_transaction = ?').get(tx)) {
        throw new ApiError(4003, 'Expired or duplicate rewarded transaction.', 409);
      }
      const state = loadState(row.gsn);
      const payload = JSON.parse(row.payload_json);
      let response;
      if (row.kind === 'battle_double') {
        state.user_info.gold = String(Number(state.user_info.gold) + payload.amount);
        response = { result: '1', addGold: String(payload.amount) };
      } else {
        const chest = state.chest_info.find((item) => item.slot_id === String(payload.slot)
          && item.chest_instance === row.target && item.complete_type === '1');
        if (!chest) {
          throw new ApiError(4003, 'The advertised chest has been replaced or opened.', 409);
        }
        chest.complete_value = utcTime(new Date(Math.max(Date.now(),
          parseUtcTime(chest.complete_value) - payload.minutes * 60000)));
        response = { completeValue: chest.complete_value, slot_id: chest.slot_id };
      }
      saveState(row.gsn, state);
      db.prepare('UPDATE ad_intents SET provider_transaction = ?, response_json = ? WHERE intent_id = ?')
        .run(tx, JSON.stringify(response), id);
      return { accepted: true };
    });
  }
  return {
    async handle(fields, account, now) {
      try {
        return await handle(fields, account, now);
      } catch (error) {
        if (error instanceof StoreServiceError) {
          throw new ApiError(4003, error.message);
        }
        throw error;
      }
    },
    callback,
  };
}

module.exports = { createMonetization };
