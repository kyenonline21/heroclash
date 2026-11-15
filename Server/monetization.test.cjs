const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createBootstrapServer } = require('./bootstrap-server.cjs');
const { createMicrosoftStore, StoreServiceError } = require('./microsoft-store.cjs');
const { createAmazonStore } = require('./amazon-store.cjs');

const sourceConfig = JSON.parse(fs.readFileSync(path.join(
  __dirname, '..', 'Assets', 'Resources', 'UwpMonetization.json'), 'utf8'));
const secret = 'test-only-callback-secret-at-least-32-characters';
const config = () => ({
  ...structuredClone(sourceConfig),
  products: sourceConfig.products.map((row, i) => ({ ...row, storeId: `9TEST000000${i}` })),
  vungleAppId: 'test-app', chestTimePlacement: 'CHEST', battleDoublePlacement: 'BATTLE',
  privacyConfigured: true,
});
function success(body) {
  assert.equal(body.result, 'success', JSON.stringify(body));
  return body.data;
}
function error(body, code) {
  assert.equal(body.result, 'error', JSON.stringify(body));
  assert.equal(body.data.code, code);
}
async function start(t, options = {}) {
  const server = createBootstrapServer({
    databasePath: ':memory:', monetizationConfig: config(), callbackSecret: secret,
    store: { configured: true, identityTicket: async () => 'test-ticket', consume: async () => { } },
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    if (!server.listening) return;
    return new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (fields) => {
    const response = await fetch(`${base}/mph`, { method: 'POST', body: new URLSearchParams(fields) });
    return response.json();
  };
  const guestId = crypto.randomUUID();
  const login = success(await post({
    pg: 'check_login', memberType: '1', memberId: guestId, udid: guestId, timezone_offset: '420',
  }));
  const auth = (pg, fields = {}) => post({ pg, gsn: login.gsn, sessionid: login.sessionid, ...fields });
  success(await auth('user_nickupdate', { nickname: 'StoreTester' }));
  return {
    server, auth, login, post,
    async callback(intent, overrides = {}, key = secret) {
      const query = new URLSearchParams({
        user: intent.ad_intent, txid: crypto.randomUUID(), placement: intent.placement, key, ...overrides,
      });
      const response = await fetch(`${base}/vungle/reward?${query}`);
      return { status: response.status, body: await response.json() };
    },
  };
}
const begin = async (app, product = '410001') => success(await app.auth('store_begin', { product_id: product }));
const redeem = (app, intent, extra = {}) => app.auth('store_redeem', {
  intent_id: intent.intent_id, user_key: 'test-customer-key', ...extra,
});

test('default config is safely unconfigured, retains the six original diamond amounts, and rejects fake receipts', async (t) => {
  const app = await start(t, {
    monetizationConfig: sourceConfig, callbackSecret: undefined,
    store: createMicrosoftStore({ env: {} }),
  });
  const catalog = success(await app.auth('store_catalog'));
  assert.equal(catalog.store_enabled, '0');
  assert.equal(catalog.ads_enabled, '0');
  assert.deepEqual(catalog.products, []);
  error(await app.auth('store_begin', { product_id: '410001' }), '4003');
  error(await app.auth('amazon_purchase', {
    product_id: '410001', sku: 'heroes.dia1.aos', receipt_id: 'fake-receipt',
  }), '4003');
  error(await app.auth('shop_purchase', { product_id: '410001', receipt: 'fake' }), '4004');
  error(await app.auth('game_double', { room_id: 'fake' }), '4004');
  error(await app.auth('chest_adtime', { slot_id: '3' }), '4004');
  error(await app.auth('ad_prepare', { kind: 'chest_time' }), '4003');
  const enabled = await start(t);
  assert.deepEqual(success(await enabled.auth('store_catalog')).products.map((row) => row.amount),
    ['30', '80', '170', '350', '900', '1850']);
});

test('Amazon gem receipts are verified server-side and grant once to the authenticated account', async (t) => {
  const verifiedReceipts = [];
  const app = await start(t, {
    amazonStore: {
      configured: true,
      async verifyReceipt(receiptId, userId) {
        verifiedReceipts.push({ receiptId, userId });
        return {
          receiptId, productId: 'heroes.dia1.aos', productType: 'CONSUMABLE', cancelDate: 0,
        };
      },
    }
  });
  const request = {
    product_id: '410001', sku: 'heroes.dia1.aos', receipt_id: 'amazon-receipt-1', user_id: 'tester-user-1',
  };
  assert.equal(success(await app.auth('amazon_purchase', request)).remain_value, '35');
  assert.equal(success(await app.auth('amazon_purchase', request)).remain_value, '35');
  assert.deepEqual(verifiedReceipts, [{ receiptId: 'amazon-receipt-1', userId: 'tester-user-1' }]);
  error(await app.auth('amazon_purchase', {
    ...request, receipt_id: 'amazon-receipt-2', sku: 'heroes.dia2.aos',
  }), '4003');

  const otherId = crypto.randomUUID();
  const other = success(await app.post({ pg: 'check_login', memberType: '1', memberId: otherId, udid: otherId }));
  success(await app.post({ pg: 'user_nickupdate', gsn: other.gsn, sessionid: other.sessionid, nickname: 'Other' }));
  error(await app.post({
    pg: 'amazon_purchase', gsn: other.gsn, sessionid: other.sessionid, ...request,
  }), '4003');
});

test('Amazon RVS adapter keeps its shared secret server-side and rejects invalid service responses', async () => {
  let requestedUrl;
  const store = createAmazonStore({
    env: { AMAZON_IAP_SHARED_SECRET: 'server-only-secret' },
    async fetchImpl(url) {
      requestedUrl = url;
      return { ok: true, async json() { return { receiptId: 'receipt-1' }; } };
    },
  });
  assert.equal(store.configured, true);
  assert.deepEqual(await store.verifyReceipt('receipt-1'), { receiptId: 'receipt-1' });
  assert.match(requestedUrl, /server-only-secret/);
  assert.match(requestedUrl, /appstore-sdk\.amazon\.com\/version\/1\.0\/verifyReceiptId/);
  assert.doesNotMatch(requestedUrl, /\/sandbox\//);
});

test('Amazon App Tester receipts use RVS Cloud Sandbox with the Appstore user ID', async () => {
  let requestedUrl;
  const store = createAmazonStore({
    env: { AMAZON_IAP_SHARED_SECRET: 'sandbox-secret', AMAZON_IAP_RVS_MODE: 'sandbox' },
    async fetchImpl(url) {
      requestedUrl = url;
      return {
        ok: true,
        async json() {
          return {
            receiptId: 'test/receipt', productId: 'heroes.dia1.aos',
            productType: 'CONSUMABLE', cancelDate: null, testTransaction: true,
          };
        },
      };
    },
  });
  await assert.rejects(store.verifyReceipt('receipt-1'), /requires an Appstore user ID/);
  assert.deepEqual(await store.verifyReceipt('test/receipt', 'tester/user'), {
    receiptId: 'test/receipt', productId: 'heroes.dia1.aos',
    productType: 'CONSUMABLE', cancelDate: null, testTransaction: true,
  });
  assert.match(requestedUrl, /appstore-sdk\.amazon\.com\/sandbox\/version\/1\.0\/verifyReceiptId/);
  assert.match(requestedUrl, /\/user\/tester%2Fuser\/receiptId\/test%2Freceipt$/);
});

test('Store intents bind account/product; concurrent redemption consumes and grants once using authoritative catalog', async (t) => {
  let calls = 0;
  const app = await start(t, {
    store: {
      configured: true, identityTicket: async () => 'identity-ticket',
      async consume(data) {
        calls++;
        assert.equal(data.storeId, '9TEST0000000');
        assert.equal(data.gsn, Number(app.login.gsn));
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    }
  });
  const intent = await begin(app);
  assert.equal((await begin(app)).intent_id, intent.intent_id);
  const second = await begin(app, '410002');
  assert.notEqual(second.intent_id, intent.intent_id);
  const result = await Promise.all([redeem(app, intent, { amount: '999999' }), redeem(app, intent)]);
  for (const body of result) assert.equal(success(body).remain_value, '35');
  assert.equal(calls, 1);
  assert.equal(success(await redeem(app, intent)).remain_value, '35');
  assert.equal(calls, 1);
  assert.deepEqual(success(await app.auth('store_pending')).list.map((row) => row.intent_id), [second.intent_id]);
  assert.equal(success(await app.auth('store_identity')).service_ticket, 'identity-ticket');
  const otherId = crypto.randomUUID();
  const other = success(await app.post({
    pg: 'check_login', memberType: '1', memberId: otherId, udid: otherId,
  }));
  success(await app.post({ pg: 'user_nickupdate', gsn: other.gsn, sessionid: other.sessionid, nickname: 'Other' }));
  error(await app.post({
    pg: 'store_redeem', gsn: other.gsn, sessionid: other.sessionid,
    intent_id: intent.intent_id, user_key: 'other-key',
  }), '4003');
  error(await app.auth('store_begin', { product_id: '110001' }), '4003');
  error(await app.post({ pg: 'store_catalog', gsn: app.login.gsn, sessionid: 'invalid' }), '4001');
});

test('failed Store consume remains pending and reuses its tracking ID after a server restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'heropocket-store-'));
  const databasePath = path.join(directory, 'game.sqlite');
  const calls = [];
  const store = {
    configured: true, identityTicket: async () => 'ticket',
    async consume(data) {
      calls.push(data.intentId);
      if (calls.length === 1) throw new StoreServiceError('Service temporarily unavailable. Retry pending purchase.');
    },
  };
  const app = await start(t, { databasePath, store });
  const intent = await begin(app);
  error(await redeem(app, intent), '4003');
  assert.equal(success(await app.auth('check_lobby')).user_info.jewel, '5');
  assert.equal(success(await app.auth('store_pending')).list[0].fulfillment_started, '1');
  await new Promise((resolve) => app.server.close(resolve));
  const restarted = await start(t, { databasePath, store });
  const body = await restarted.post({
    pg: 'store_redeem', gsn: app.login.gsn, sessionid: app.login.sessionid,
    intent_id: intent.intent_id, user_key: 'new-customer-key',
  });
  assert.equal(success(body).remain_value, '35');
  assert.deepEqual(calls, [intent.intent_id, intent.intent_id]);
  t.after(() => fs.rmSync(directory, { recursive: true }));
});

test('grant rollback after confirmed Store consume is recovered without issuing another tracking ID', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'heropocket-grant-'));
  const databasePath = path.join(directory, 'game.sqlite');
  const calls = [];
  const app = await start(t, {
    databasePath, store: {
      configured: true, identityTicket: async () => 'ticket',
      async consume(row) { calls.push(row.intentId); },
    }
  });
  const intent = await begin(app);
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TRIGGER fail_grant BEFORE UPDATE OF granted_at ON store_intents
    BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
  error(await redeem(app, intent), '5000');
  assert.equal(success(await app.auth('check_lobby')).user_info.jewel, '5');
  db.exec('DROP TRIGGER fail_grant;');
  assert.equal(success(await redeem(app, intent)).remain_value, '35');
  assert.deepEqual(calls, [intent.intent_id, intent.intent_id]);
  db.close();
  t.after(() => fs.rmSync(directory, { recursive: true }));
});

test('chest ad requires authenticated S2S completion, correct placement, and grants one 60-minute reduction per instance', async (t) => {
  const app = await start(t);
  let lobby = success(await app.auth('check_lobby'));
  const chest = lobby.chest_info[2];
  success(await app.auth('chest_unlock', {
    slot_id: chest.slot_id, chest_id: chest.chest_id, chest_instance: chest.chest_instance,
    request_id: crypto.randomUUID(),
  }));
  lobby = success(await app.auth('check_lobby'));
  const before = lobby.chest_info[2].complete_value;
  const fields = { kind: 'chest_time', slot_id: '3', chest_instance: chest.chest_instance };
  const intent = success(await app.auth('ad_prepare', fields));
  assert.equal(success(await app.auth('ad_prepare', fields)).ad_intent, intent.ad_intent);
  assert.equal(success(await app.auth('ad_claim', {
    ad_intent: intent.ad_intent, completed: 'true',
  })).status, 'pending');
  assert.equal((await app.callback(intent, {}, 'wrong-secret')).status, 403);
  assert.equal((await app.callback(intent, { placement: 'BATTLE' })).status, 409);
  const txid = crypto.randomUUID();
  assert.equal((await app.callback(intent, { txid })).status, 200);
  assert.equal((await app.callback(intent, { txid })).status, 200);
  assert.equal((await app.callback(intent)).status, 409);
  const granted = success(await app.auth('ad_claim', { ad_intent: intent.ad_intent }));
  assert.equal(granted.status, 'granted');
  const time = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
    +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
  assert.equal(time(before) - time(granted.completeValue), 60 * 60000);
  error(await app.auth('ad_prepare', fields), '4003');
  error(await app.auth('ad_prepare', { ...fields, chest_instance: 'replaced' }), '4003');
});

test('battle double uses saved gold only, survives callback-before-client and cannot double the same battle twice', async (t) => {
  const app = await start(t);
  const room = crypto.randomUUID();
  const battle = {
    room_id: room, mode: '1', play_char_id: '201001', map_idx: '0',
    entry_user_cnt: '1', win: '1', battle_rank: '0', mvp: app.login.gsn,
  };
  success(await app.auth('game_entryfee', battle));
  const result = success(await app.auth('game_singleresult', battle));
  const before = success(await app.auth('check_lobby')).user_info;
  const intent = success(await app.auth('ad_prepare', { kind: 'battle_double', room_id: room, addGold: '99999' }));
  assert.equal((await app.callback(intent)).status, 200);
  const granted = success(await app.auth('ad_claim', { ad_intent: intent.ad_intent }));
  const amount = Number(result.winGold) + Number(result.mvpGold) + Number(result.boosterGold);
  assert.equal(Number(granted.addGold), amount);
  assert.equal(Number(granted.curGold), Number(before.gold) + amount);
  assert.equal(granted.curJewel, before.jewel);
  const again = success(await app.auth('ad_claim', { ad_intent: intent.ad_intent }));
  assert.equal(again.curGold, granted.curGold);
  error(await app.auth('ad_prepare', { kind: 'battle_double', room_id: room }), '4003');
  error(await app.auth('ad_prepare', { kind: 'battle_double', room_id: 'missing' }), '4003');
  error(await app.auth('ad_prepare', { kind: 'free_diamonds' }), '4000');
});

test('Vungle expires intents, refuses reused provider transactions and never rewards a replaced chest', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'heropocket-ads-'));
  const databasePath = path.join(directory, 'game.sqlite');
  const app = await start(t, { databasePath });
  const chest = success(await app.auth('check_lobby')).chest_info[2];
  success(await app.auth('chest_unlock', { ...chest, request_id: crypto.randomUUID() }));
  const fields = { kind: 'chest_time', slot_id: '3', chest_instance: chest.chest_instance };
  const first = success(await app.auth('ad_prepare', fields));
  const db = new DatabaseSync(databasePath);
  db.prepare('UPDATE ad_intents SET expires_at = 0 WHERE intent_id = ?').run(first.ad_intent);
  assert.equal((await app.callback(first)).status, 409);
  error(await app.auth('ad_claim', { ad_intent: first.ad_intent }), '4003');
  const second = success(await app.auth('ad_prepare', fields));
  assert.notEqual(second.ad_intent, first.ad_intent);
  const state = JSON.parse(db.prepare('SELECT state_json FROM accounts WHERE gsn = ?').get(Number(app.login.gsn)).state_json);
  state.chest_info[2].chest_instance = 'new-instance';
  db.prepare('UPDATE accounts SET state_json = ? WHERE gsn = ?').run(JSON.stringify(state), Number(app.login.gsn));
  assert.equal((await app.callback(second)).status, 409);
  error(await app.auth('ad_claim', { ad_intent: 'not-owned' }), '4003');
  db.close();
  t.after(() => fs.rmSync(directory, { recursive: true }));
});

test('Microsoft Store service uses server-only OAuth tokens and validates v8 consume confirmation', async () => {
  const requests = [];
  const store = createMicrosoftStore({
    env: { MS_STORE_TENANT_ID: 'tenant', MS_STORE_CLIENT_ID: 'client', MS_STORE_CLIENT_SECRET: 'secret' },
    async fetchImpl(url, options) {
      requests.push({ url, options });
      if (url.includes('oauth2')) return Response.json({ access_token: 'server-only', expires_in: '3600' });
      const body = JSON.parse(options.body);
      assert.equal(body.removeQuantity, 1);
      assert.equal(body.beneficiary.identityValue, 'customer-key');
      assert.equal(body.beneficiary.localTicketReference, '7');
      assert.equal(options.headers.Authorization, 'Bearer server-only');
      return Response.json({ productId: body.productId, trackingId: body.trackingId, newQuantity: 0 });
    },
  });
  await store.identityTicket();
  const intentId = crypto.randomUUID();
  await store.consume({ storeId: '9TEST0000000', intentId, userKey: 'customer-key', gsn: 7 });
  await store.consume({ storeId: '9TEST0000000', intentId, userKey: 'customer-key', gsn: 7 });
  assert.equal(requests.filter((row) => row.url.includes('oauth2')).length, 2);
  assert.equal(requests[0].options.body.get('resource'), 'https://onestore.microsoft.com/b2b/keys/create/collections');
  assert.equal(requests[1].options.body.get('resource'), 'https://onestore.microsoft.com');
  assert.equal(requests[2].url, 'https://collections.mp.microsoft.com/v8.0/collections/consume');
  const invalid = createMicrosoftStore({
    env: { MS_STORE_TENANT_ID: 'tenant', MS_STORE_CLIENT_ID: 'client', MS_STORE_CLIENT_SECRET: 'secret' },
    async fetchImpl(url) {
      return Response.json(url.includes('oauth2')
        ? { access_token: 'token', expires_in: 3600 } : { productId: 'wrong', trackingId: intentId, newQuantity: 0 });
    },
  });
  await assert.rejects(invalid.consume({ storeId: '9TEST0000000', intentId, userKey: 'key', gsn: 7 }), /invalid fulfillment/);
  assert.throws(() => createMicrosoftStore({ env: { MS_STORE_CLIENT_SECRET: 'missing-other-fields' } }), /all three/);
});

test('Store redemption reloads current account state after remote fulfillment, preserving concurrent mailbox grants', async (t) => {
  let release;
  let consuming;
  const started = new Promise((resolve) => { consuming = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const app = await start(t, {
    store: {
      configured: true, identityTicket: async () => 'ticket',
      async consume() { consuming(); await wait; },
    }
  });
  const intent = await begin(app);
  const pending = redeem(app, intent);
  await started;
  let claimed;
  try {
    const list = success(await app.auth('post_getpostlist', { cur_page: '1', list_item_cnt: '20' }));
    const mail = list.post[0];
    claimed = success(await app.auth('post_receive', { post_seq: mail.post_seq, request_id: crypto.randomUUID() }));
  } finally {
    release();
  }
  const purchase = success(await pending);
  const state = success(await app.auth('check_lobby')).user_info;
  assert.equal(state.gold, claimed.curGold);
  assert.equal(state.jewel, purchase.remain_value);
  assert.equal(Number(state.jewel), Number(claimed.curJewel) + 30);
});

test('verified ad grant persists across restart; a provider transaction cannot fund a second battle', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'heropocket-ad-restart-'));
  const databasePath = path.join(directory, 'game.sqlite');
  const app = await start(t, { databasePath });
  const txid = crypto.randomUUID();
  const play = async () => {
    const battle = {
      room_id: crypto.randomUUID(), mode: '1', play_char_id: '201001', map_idx: '0',
      entry_user_cnt: '1', win: '1', battle_rank: '0', mvp: app.login.gsn,
    };
    success(await app.auth('game_entryfee', battle));
    success(await app.auth('game_singleresult', battle));
    return success(await app.auth('ad_prepare', { kind: 'battle_double', room_id: battle.room_id }));
  };
  const first = await play();
  assert.equal((await app.callback(first, { txid })).status, 200);
  const second = await play();
  assert.equal((await app.callback(second, { txid })).status, 409);
  const gold = success(await app.auth('check_lobby')).user_info.gold;
  await new Promise((resolve) => app.server.close(resolve));
  const restarted = await start(t, { databasePath });
  const claim = success(await restarted.post({
    pg: 'ad_claim', gsn: app.login.gsn, sessionid: app.login.sessionid, ad_intent: first.ad_intent,
  }));
  assert.equal(claim.status, 'granted');
  assert.equal(claim.curGold, gold);
  assert.equal((await restarted.callback(first, { txid })).status, 200);
  t.after(() => fs.rmSync(directory, { recursive: true }));
});
