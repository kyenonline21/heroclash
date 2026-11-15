const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createBootstrapServer } = require('./bootstrap-server.cjs');

const project = path.join(__dirname, '..');
const table = (name) => JSON.parse(fs.readFileSync(path.join(
  project, 'Assets', 'Resources', 'jsonres', `JSON${name}Table.json`,
), 'utf8'));

async function start(databasePath = ':memory:') {
  const server = createBootstrapServer({ databasePath });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    async post(fields, multipart = false) {
      let body = new URLSearchParams(fields);
      if (multipart) {
        body = new FormData();
        for (const [key, value] of Object.entries(fields)) {
          body.append(key, value);
        }
      }
      const response = await fetch(`${baseUrl}/mph`, { method: 'POST', body });
      assert.equal(response.status, 200);
      return response.json();
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

function guest(identity = crypto.randomUUID(), extra = {}) {
  return {
    pg: 'check_login', memberType: '1', memberId: identity, udid: identity,
    gsn: '', timezone_offset: '420', ...extra,
  };
}

function authenticated(login, pg, extra = {}) {
  return { pg, gsn: login.data.gsn, sessionid: login.data.sessionid, ...extra };
}

function success(response) {
  assert.equal(response.result, 'success', JSON.stringify(response));
  return response.data;
}

function error(response, code) {
  assert.equal(response.result, 'error');
  assert.equal(response.data.code, code);
  assert.match(response.data.code, /^\d+$/, 'SystemMsg.net_error must be able to int.Parse(code)');
  assert.ok(response.data.message.length > 0);
}

test('guest -> tutorial nickname -> exact lobby and legacy string-encoded heroes', async (t) => {
  const app = await start();
  t.after(() => app.close());
  const identity = guest();
  const login = await app.post(identity, true);
  success(login);
  assert.equal(login.data.result, '2');
  assert.match(login.data.gsn, /^\d+$/);
  assert.match(login.data.sessionid, /^[a-f0-9]{64}$/);
  const pending = await app.post({ ...identity, gsn: login.data.gsn });
  assert.equal(success(pending).gsn, login.data.gsn);
  assert.equal(pending.data.result, '2', 'Unfinished tutorial must resume on next login');

  const before = success(await app.post(authenticated(login, 'check_lobby')));
  assert.equal(before.tutorial_completed, '0', 'Lobby must expose the server tutorial gate for client recovery');
  error(await app.post(authenticated(login, 'game_entryfee', battleFields(1))), '4003');
  assert.equal(before.user_info.gold, '0');
  assert.equal(before.chest_info[2].chest_id, '0');
  const nickname = 'AnhH\u00f9ng';
  assert.deepEqual(success(await app.post(
    authenticated(login, 'user_nickupdate', { nickname }), true,
  )), { nick: nickname });
  const lobby = success(await app.post(authenticated(login, 'check_lobby')));
  assert.equal(lobby.tutorial_completed, '1');
  const user = lobby.user_info;
  const common = table('Common')[0];
  const userSource = fs.readFileSync(path.join(
    project, 'Assets', 'Scripts', 'Assembly-CSharp', 'NetUserInfo.cs',
  ), 'utf8');
  const requiredKeys = [...userSource.matchAll(/dictionary\["([^"]+)"\]/g)].map((match) => match[1]);
  assert.deepEqual(Object.keys(user).sort(), requiredKeys.sort());
  assert.equal(user.nickname, nickname);
  for (const key of requiredKeys.filter((key) => key !== 'nickname')) {
    assert.match(user[key], /^-?\d+$/, key);
  }
  assert.equal(user.gold, String(common.TutoReward_Gold));
  assert.equal(user.jewel, String(common.TutoReward_Jewel));
  assert.equal(user.level, '1');
  assert.equal(user.exp, '0');
  assert.equal(user.league_flag, '0');
  assert.ok(table('League').some((row) => String(row.LeagueID) === user.grade));
  assert.deepEqual(lobby.purchase, []);
  assert.deepEqual(lobby.chest_info.map((chest) => chest.slot_id), ['1', '2', '3', '4', '5', '6']);
  for (const chest of lobby.chest_info) {
    if (chest.chest_id !== '0') {
      assert.ok(table('Chest').some((row) => String(row.ChestID) === chest.chest_id));
    }
    assert.match(chest.complete_value, chest.complete_type === '1' ? /^\d{14}$/ : /^\d+$/);
  }
  assert.equal(lobby.chest_info[0].complete_type, '1');
  assert.equal(lobby.chest_info[1].complete_type, '2');
  assert.equal(lobby.chest_info[2].complete_type, '0');
  assert.equal(lobby.chest_info[2].chest_id, '304001');
  assert.deepEqual(lobby.battle_mode.map((mode) => mode.modeId),
    table('BattleMode').map((row) => String(row.ModeID)));
  const now = new Date().toISOString().slice(0, 19).replace(/[-T:]/g, '');
  for (const mode of lobby.battle_mode) {
    assert.equal(mode.bonusGold, '0');
    assert.match(mode.init_time, /^\d{14}$/);
    assert.ok(mode.init_time > now, 'Expired reset times would make the lobby refresh forever');
  }
  const heroes = success(await app.post(authenticated(login, 'character_getlist', { char_id: '0' })));
  const parsed = heroes.characterList.map((value) => {
    assert.equal(typeof value, 'string', 'NetHeroInfo reads JSONObject.str');
    return JSON.parse(value);
  });
  assert.deepEqual(parsed.map((hero) => hero.char_id),
    [String(common.TutoReward_Char_1), String(common.TutoReward_Char_2)]);
  assert.ok(parsed.some((hero) => hero.char_id === user.rep_hero));
  const heroSource = fs.readFileSync(path.join(
    project, 'Assets', 'Scripts', 'Assembly-CSharp', 'NetHeroInfo.cs',
  ), 'utf8');
  const heroKeys = [...heroSource.matchAll(/dictionary\["([^"]+)"\]/g)].map((match) => match[1]);
  for (const hero of parsed) {
    assert.deepEqual(Object.keys(hero).sort(), [...heroKeys].sort());
    for (const value of Object.values(hero)) {
      assert.match(value, /^\d+$/);
    }
  }
  const filtered = success(await app.post(authenticated(
    login, 'character_getlist', { char_id: user.rep_hero },
  )));
  assert.equal(filtered.characterList.length, 1);
  const returning = success(await app.post({ ...identity, gsn: login.data.gsn }));
  assert.equal(returning.result, '1');
  assert.equal(returning.gsn, login.data.gsn);
});

test('account, session, tutorial rewards and unlock timer persist across a server restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-pocket-api-'));
  const databasePath = path.join(directory, 'game.sqlite');
  let app;
  t.after(async () => {
    if (app) {
      await app.close();
    }
    fs.rmSync(directory, { recursive: true });
  });
  app = await start(databasePath);
  const identity = guest();
  const login = await app.post(identity);
  success(login);
  success(await app.post(authenticated(login, 'user_nickupdate', { nickname: 'TestHero' })));
  const chest = success(await app.post(authenticated(login, 'check_lobby'))).chest_info[2];
  const fields = authenticated(login, 'chest_unlock', {
    slot_id: '3', chest_id: '304001', chest_instance: chest.chest_instance, request_id: crypto.randomUUID(),
  });
  const unlocked = success(await app.post(fields));
  assert.match(unlocked.completeValue, /^\d{14}$/);
  const duration = table('Chest').find((row) => row.ChestID === 304001).OpenTime;
  const parts = unlocked.completeValue.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  const unlockedAt = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]),
    Number(parts[4]), Number(parts[5]), Number(parts[6]));
  assert.ok(Math.abs(unlockedAt - (Date.now() + duration * 60000)) < 2000,
    'Tutorial chest must use its table duration rather than an instant test unlock');
  assert.deepEqual(success(await app.post(fields)), unlocked, 'Retry must not reset the timer');
  const before = success(await app.post(authenticated(login, 'check_lobby')));
  await app.close();
  app = undefined;
  app = await start(databasePath);
  const after = success(await app.post(authenticated(login, 'check_lobby')));
  assert.deepEqual(after, before, 'Saved session and all state survive reopening SQLite');
  assert.deepEqual(success(await app.post(fields)), unlocked);
  success(await app.post(authenticated(login, 'user_nickupdate', { nickname: 'TestHero' })));
  assert.deepEqual(success(await app.post(authenticated(login, 'check_lobby'))), before,
    'Repeated tutorial completion must not grant gold, jewels or chests again');
  error(await app.post(authenticated(login, 'user_nickupdate', { nickname: 'AnotherName' })), '4003');
  const relogin = success(await app.post({ ...identity, gsn: login.data.gsn }));
  assert.equal(relogin.gsn, login.data.gsn);
  assert.equal(relogin.result, '1');
  const db = new DatabaseSync(databasePath);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 1);
    const hash = crypto.createHash('sha256').update(login.data.sessionid).digest('hex');
    assert.ok(db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(hash),
      'Only the session token hash is stored');
    const state = JSON.parse(db.prepare('SELECT state_json FROM accounts').get().state_json);
    state.battle_mode.forEach((mode) => {
      mode.init_time = '20000101000000';
      mode.bonusGold = '10';
    });
    db.prepare('UPDATE accounts SET state_json = ?').run(JSON.stringify(state));
    const refreshed = success(await app.post(authenticated(login, 'check_lobby')));
    assert.ok(refreshed.battle_mode.every((mode) => mode.init_time > '20000101000000' && mode.bonusGold === '0'));
    db.prepare('UPDATE sessions SET expires_at = 0').run();
    error(await app.post(authenticated(login, 'check_lobby')), '4001');
  } finally {
    db.close();
  }
});

test('tutorial completion rolls back its rewards if the database update fails', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-pocket-transaction-'));
  const databasePath = path.join(directory, 'game.sqlite');
  const app = await start(databasePath);
  const db = new DatabaseSync(databasePath);
  t.after(async () => {
    db.close();
    await app.close();
    fs.rmSync(directory, { recursive: true });
  });
  const login = await app.post(guest());
  success(login);
  const before = success(await app.post(authenticated(login, 'check_lobby')));
  db.exec(`CREATE TRIGGER reject_completion BEFORE UPDATE OF tutorial_completed ON accounts
    BEGIN SELECT RAISE(ABORT, 'Test-only simulated database failure'); END`);
  const failed = await fetch(`${app.baseUrl}/mph`, {
    method: 'POST',
    body: new URLSearchParams(authenticated(login, 'user_nickupdate', { nickname: 'AtomicHero' })),
  });
  assert.equal(failed.status, 500);
  error(await failed.json(), '5000');
  assert.deepEqual(success(await app.post(authenticated(login, 'check_lobby'))), before,
    'No nickname, gold, jewels or chest may be partially committed');
  assert.equal(db.prepare('SELECT tutorial_completed FROM accounts').get().tutorial_completed, 0);
  db.exec('DROP TRIGGER reject_completion');
  success(await app.post(authenticated(login, 'user_nickupdate', { nickname: 'AtomicHero' })));
  const after = success(await app.post(authenticated(login, 'check_lobby')));
  assert.equal(after.user_info.gold, String(table('Common')[0].TutoReward_Gold));
});

test('invalid identities, mismatched sessions and unimplemented APIs do not return fake success', async (t) => {
  const app = await start();
  t.after(() => app.close());
  const firstGuest = guest();
  const first = await app.post(firstGuest);
  const second = await app.post(guest());
  success(first);
  success(second);
  error(await app.post(guest(undefined, { gsn: first.data.gsn })), '4001');
  error(await app.post(guest(undefined, { memberType: '3' })), '4003');
  error(await app.post(guest(undefined, { memberId: 'different-from-udid' })), '4000');
  const legacy = success(await app.post(guest(undefined, { gsn: '999999999' })));
  assert.notEqual(legacy.gsn, '999999999');
  error(await app.post(authenticated(first, 'check_lobby', { gsn: second.data.gsn })), '4001');
  error(await app.post({ pg: 'check_lobby', gsn: first.data.gsn }), '4000');
  error(await app.post(authenticated(first, 'check_lobby', { sessionid: 'invalid' })), '4001');
  error(await app.post(authenticated(first, 'character_getlist', { char_id: '999999' })), '4004');
  error(await app.post(authenticated(first, 'user_nickupdate', { nickname: 'TooLongNickname' })), '4000');
  error(await app.post(authenticated(first, 'user_nickupdate', { nickname: ' ' })), '4000');
  error(await app.post(authenticated(first, 'chest_unlock', { slot_id: '3', chest_id: '304001' })), '4003');
  for (const pg of ['shop_repurchase', 'membership_switching', 'chest_double', 'chest_adtime', 'game_double']) {
    error(await app.post(authenticated(first, pg)), '4004');
  }
  const before = success(await app.post(authenticated(first, 'check_lobby')));
  success(await app.post(authenticated(second, 'user_nickupdate', { nickname: 'SecondHero' })));
  assert.deepEqual(success(await app.post(authenticated(first, 'check_lobby'))), before);
});

test('HTTP form validation and private database routes', async (t) => {
  const app = await start();
  t.after(() => app.close());
  for (const requestPath of ['/mph', '/data/game.sqlite']) {
    const response = await fetch(`${app.baseUrl}${requestPath}`);
    assert.equal(response.status, requestPath === '/mph' ? 405 : 404);
  }
  const cases = [
    { headers: { 'Content-Type': 'application/json' }, body: '{}', status: 415 },
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'pg=check_login&pg=check_lobby', status: 400 },
    { headers: { 'Content-Type': 'multipart/form-data' }, body: 'not-a-form', status: 400 },
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x'.repeat(65537), status: 413 },
  ];
  for (const { headers, body, status } of cases) {
    const response = await fetch(`${app.baseUrl}/mph`, { method: 'POST', headers, body });
    assert.equal(response.status, status);
    error(await response.json(), '4000');
  }
  const fields = new FormData();
  fields.append('pg', 'check_login');
  fields.append('file', new Blob(['not-supported']), 'file.txt');
  const response = await fetch(`${app.baseUrl}/mph`, { method: 'POST', body: fields });
  assert.equal(response.status, 400);
  error(await response.json(), '4000');
});

async function battleGuest(app) {
  const login = await app.post(guest());
  success(login);
  success(await app.post(authenticated(login, 'user_nickupdate', { nickname: 'BattleHero' })));
  return login;
}

function battleFields(mode = 1, overrides = {}) {
  return {
    room_id: crypto.randomUUID(), mode: String(mode), play_char_id: '201001', map_idx: '0',
    entry_user_cnt: '1', win: '1', battle_rank: mode === 3 ? '1' : '0', mvp: '0',
    ...overrides,
  };
}

async function play(app, login, fields) {
  success(await app.post(authenticated(login, 'game_entryfee', fields)));
  return success(await app.post(authenticated(login, 'game_singleresult', fields)));
}

async function progressionFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-pocket-progression-'));
  const databasePath = path.join(directory, 'game.sqlite');
  let app = await start(databasePath);
  const login = await battleGuest(app);
  const db = new DatabaseSync(databasePath);
  t.after(async () => {
    db.close();
    await app.close();
    fs.rmSync(directory, { recursive: true });
  });
  const read = () => JSON.parse(db.prepare('SELECT state_json FROM accounts WHERE gsn = ?')
    .get(Number(login.data.gsn)).state_json);
  return {
    login, db, read,
    async post(pg, fields = {}) {
      return app.post(authenticated(login, pg, fields));
    },
    async restart() {
      await app.close();
      app = await start(databasePath);
    },
    async raw(fields) {
      return fetch(`${app.baseUrl}/mph`, {
        method: 'POST', body: new URLSearchParams(authenticated(login, fields.pg, fields)),
      });
    },
    edit(action) {
      const state = read();
      action(state);
      db.prepare('UPDATE accounts SET state_json = ? WHERE gsn = ?')
        .run(JSON.stringify(state), Number(login.data.gsn));
    },
    chest(slot, extra = {}) {
      const chest = read().chest_info[slot - 1];
      return {
        slot_id: chest.slot_id, chest_id: chest.chest_id, chest_instance: chest.chest_instance,
        nowYN: 'N', request_id: crypto.randomUUID(), ...extra,
      };
    },
  };
}

function mailFields(post, extra = {}) {
  return { post_seq: post.post_seq, request_id: crypto.randomUUID(), ...extra };
}

async function inbox(f, extra = {}) {
  return success(await f.post('post_getpostlist', { cur_page: '1', list_item_cnt: '100', ...extra }));
}

function seedMail(f, items = [], overrides = {}) {
  const row = {
    gsn: Number(f.login.data.gsn), title: 'Server notice', contents: 'Mailbox test',
    sent: Date.now(), expires: Date.now() + 7 * 86400000, ...overrides,
  };
  const inserted = f.db.prepare(`INSERT INTO mailbox
    (gsn, delivery_key, title, contents, sent_at, expires_at, attachments_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.gsn, crypto.randomUUID(), row.title, row.contents,
    row.sent, row.expires, JSON.stringify(items));
  return { post_seq: String(inserted.lastInsertRowid) };
}

test('mailbox sends one English welcome after tutorial, uses exact legacy DTO and survives restart/read', async (t) => {
  const f = await progressionFixture(t);
  const before = f.read();
  const list = await inbox(f);
  assert.equal(list.total_cnt, '1');
  assert.equal(list.post_cnt, '1');
  assert.equal(list.post.length, 1);
  const mail = list.post[0];
  assert.deepEqual(Object.keys(mail).sort(), [
    'post_seq', 'locale_id', 'title', 'contents', 'send_date', 'expire_date', 'state', 'attachlist',
  ].sort());
  assert.equal(mail.locale_id, '0');
  assert.equal(mail.title, 'Welcome to Hero Pocket!');
  assert.equal(mail.contents, 'Welcome to Hero Pocket! Thank you for joining us. Please claim your gift within 7 days.');
  assert.equal(mail.state, '0');
  assert.deepEqual(mail.attachlist, [
    { item_type: '5', item_id: '0', item_cnt: '100' },
    { item_type: '3', item_id: '304001', item_cnt: '1' },
  ]);
  assert.match(mail.send_date, /^\d{14}$/);
  assert.match(mail.expire_date, /^\d{14}$/);
  const stored = f.db.prepare('SELECT * FROM mailbox').get();
  assert.equal(stored.expires_at - stored.sent_at, 7 * 86400000);
  assert.deepEqual(f.read(), before, 'Delivery/list do not grant currency, cards or quest progress');
  assert.equal(success(await f.post('check_lobby')).user_info.post_cnt, '1');
  const read = mailFields(mail);
  assert.deepEqual(success(await f.post('post_read', read)), { state: '1', post_cnt: '1' });
  assert.deepEqual(success(await f.post('post_read', read)), { state: '1', post_cnt: '1' });
  success(await f.post('post_read', mailFields(mail)));
  assert.equal((await inbox(f)).post[0].state, '1');
  assert.equal((await inbox(f)).post_cnt, '1', 'Read mail with gifts remains actionable and counted');
  await f.restart();
  assert.equal((await inbox(f)).post[0].state, '1');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mailbox').get().n, 1);
  assert.equal(f.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'mailbox'").get().seq, 1,
    'Repeated welcome checks must not consume new sequence IDs');
});

test('welcome claim grants 100 gold plus original chest jewel roll without slots or double rewards', async (t) => {
  const f = await progressionFixture(t);
  const mail = (await inbox(f)).post[0];
  const fields = mailFields(mail);
  error(await f.post('post_postdelete', mailFields(mail)), '4003');
  const before = f.read();
  const chest = table('Chest').find((row) => row.ChestID === 304001);
  t.mock.method(crypto, 'randomInt', (min, max) => max === undefined ? 0 : max - 1);
  const received = success(await f.post('post_receive', { ...fields, item_cnt: '999999', gold: '999999' }));
  assert.equal(received.post_cnt, '0');
  assert.equal(received.curGold, String(Number(before.user_info.gold) + 100 + chest.Gold_Max));
  assert.equal(received.curJewel, String(Number(before.user_info.jewel) + chest.Jewel_Max));
  const gift = received.receiveList.find((row) => row.item_type === '5');
  const box = received.receiveList.find((row) => row.item_type === '3');
  assert.equal(gift.item_cnt, '100', 'Client cannot choose reward amount');
  assert.equal(gift.item_curCnt, received.curGold);
  assert.equal(box.item_id, '304001');
  assert.equal(box.item_chest.gold, String(chest.Gold_Max));
  assert.equal(box.item_chest.curGold, received.curGold);
  assert.equal(box.item_chest.jewel, String(chest.Jewel_Max));
  assert.equal(box.item_chest.curJewel, received.curJewel);
  assert.deepEqual(box.item_chest.card.map((row) => ({ id: row.id, count: row.count })),
    [{ id: '201001', count: String(chest.CommonCard_Max) }]);
  assert.deepEqual(f.read().heroes.map((hero) => hero.char_id), before.heroes.map((hero) => hero.char_id),
    'Welcome chest cannot unlock any hero or roll Rare cards');
  assert.deepEqual(f.read().chest_info, before.chest_info, 'Full tutorial chest slot does not block mailbox rewards');
  assert.equal(f.read().progress.totals[1000], 1);
  const after = f.read();
  assert.deepEqual(success(await f.post('post_receive', fields)), received);
  error(await f.post('post_receive', mailFields(mail)), '4003');
  error(await f.post('post_receive', { ...fields, post_seq: '99999' }), '4003');
  assert.deepEqual(f.read(), after);
  assert.deepEqual((await inbox(f)).post, []);
  assert.equal(success(await f.post('check_lobby')).user_info.post_cnt, '0');
  await f.restart();
  assert.deepEqual(success(await f.post('post_receive', fields)), received);
  assert.deepEqual(f.read(), after);
  assert.equal((await inbox(f)).total_cnt, '0');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mailbox').get().n, 1, 'Claimed delivery key remains a tombstone');
});

test('welcome chest uses original jewel probability instead of a fixed five-jewel bonus and preserves old receipts', async (t) => {
  const f = await progressionFixture(t);
  f.edit((state) => { state.user_info.jewel = '67'; });
  const mail = (await inbox(f)).post[0];
  const fields = mailFields(mail);
  t.mock.method(crypto, 'randomInt', (min, max) => max === undefined ? (min === 10000 ? 200 : 0) : min);
  const response = success(await f.post('post_receive', fields));
  assert.equal(response.curJewel, '67');
  assert.equal(response.receiveList.find((item) => item.item_type === '3').item_chest.jewel, '0');
  assert.equal(f.read().user_info.jewel, '67');
  const historical = structuredClone(response);
  historical.curJewel = '67';
  const chest = historical.receiveList.find((item) => item.item_type === '3').item_chest;
  chest.jewel = '0';
  chest.curJewel = '67';
  f.db.prepare('UPDATE mutations SET response_json = ? WHERE request_id = ? AND gsn = ?')
    .run(JSON.stringify(historical), fields.request_id, Number(f.login.data.gsn));
  f.edit((state) => { state.user_info.jewel = '67'; });
  await f.restart();
  const before = f.read();
  assert.deepEqual(success(await f.post('post_receive', fields)), historical);
  error(await f.post('post_receive', mailFields(mail)), '4003');
  assert.deepEqual(f.read(), before, 'Already claimed welcome mail is not reopened or topped up');
});

test('welcome chest renormalizes weights to owned Common heroes and never rolls other rarities even when owned', async (t) => {
  let roll = 0;
  t.mock.method(crypto, 'randomInt', (min, max) => {
    if (max !== undefined) return max - 1;
    return min === 10000 ? 0 : roll;
  });
  for (const [value, expected] of [[0, '201002'], [2999, '201002'], [3000, '201006'], [3799, '201006']]) {
    roll = 0;
    const f = await progressionFixture(t);
    f.edit((state) => {
      const starter = state.heroes[0];
      state.heroes = [state.heroes[1], ...['201006', '201004'].map((id) => ({ ...starter, char_id: id }))];
    });
    const before = f.read();
    roll = value;
    const mail = (await inbox(f)).post[0];
    const result = success(await f.post('post_receive', mailFields(mail)));
    const cards = result.receiveList.find((item) => item.item_type === '3').item_chest.card;
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, expected);
    assert.equal(cards[0].count, '5');
    assert.deepEqual(f.read().heroes.map((hero) => hero.char_id), before.heroes.map((hero) => hero.char_id));
    assert.equal(f.read().heroes.find((hero) => hero.char_id === '201004').stone, '0',
      'Even an already-owned Rare hero cannot receive welcome chest cards');
  }
});

test('mailbox notice reading/deletion is persistent and gifts cannot be deleted or received from a notice', async (t) => {
  const f = await progressionFixture(t);
  const notice = seedMail(f);
  const readFields = mailFields(notice);
  const read = success(await f.post('post_read', readFields));
  assert.equal(read.state, '1');
  assert.equal(read.post_cnt, '2');
  error(await f.post('post_receive', mailFields(notice)), '4003');
  const remove = mailFields(notice);
  const response = success(await f.post('post_postdelete', remove));
  assert.deepEqual(response, { post_cnt: '1' });
  assert.deepEqual(success(await f.post('post_postdelete', remove)), response);
  error(await f.post('post_postdelete', mailFields(notice)), '4003');
  error(await f.post('post_read', mailFields(notice)), '4003');
  error(await f.post('post_read', { ...remove }), '4003', 'Request ID is also scoped by API');
  assert.deepEqual(success(await f.post('post_read', readFields)), read, 'Historical read replay does not resurrect deleted mail');
  await f.restart();
  assert.deepEqual(success(await f.post('post_postdelete', remove)), response);
  assert.equal((await inbox(f)).total_cnt, '1');
});

test('mailbox expiry uses exact seven-day boundary, blocks every action and never resends welcome', async (t) => {
  const f = await progressionFixture(t);
  const mail = (await inbox(f)).post[0];
  const stored = f.db.prepare('SELECT * FROM mailbox').get();
  t.mock.timers.enable({ apis: ['Date'], now: stored.expires_at - 1 });
  f.db.prepare('UPDATE sessions SET expires_at = ?').run(stored.expires_at + 30 * 86400000);
  assert.equal((await inbox(f)).total_cnt, '1');
  assert.equal(success(await f.post('check_lobby')).user_info.post_cnt, '1');
  t.mock.timers.setTime(stored.expires_at);
  assert.deepEqual(await inbox(f), { total_cnt: '0', post_cnt: '0', post: [] });
  const before = f.read();
  for (const pg of ['post_read', 'post_receive', 'post_postdelete']) {
    error(await f.post(pg, mailFields(mail)), '4003');
  }
  assert.deepEqual(f.read(), before);
  assert.equal(success(await f.post('check_lobby')).user_info.post_cnt, '0');
  await f.restart();
  assert.equal((await inbox(f)).total_cnt, '0');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mailbox').get().n, 1);
  assert.equal(f.read().progress.totals[1000] || 0, 0);
});

test('mailbox paginates newest first, counts all live mail and rejects malformed or unauthorized operations', async (t) => {
  const f = await progressionFixture(t);
  const ids = Array.from({ length: 105 }, () => seedMail(f).post_seq).reverse();
  seedMail(f, [], { expires: Date.now() - 1 });
  const page = await inbox(f);
  assert.equal(page.total_cnt, '106');
  assert.equal(page.post_cnt, '106');
  assert.equal(page.post.length, 100);
  assert.deepEqual(page.post.map((row) => row.post_seq), ids.slice(0, 100));
  const second = await inbox(f, { cur_page: '2' });
  assert.equal(second.post.length, 6);
  assert.deepEqual(second.post.slice(0, 5).map((row) => row.post_seq), ids.slice(100));
  assert.deepEqual((await inbox(f, { cur_page: '3' })).post, []);
  for (const fields of [{ cur_page: '0' }, { list_item_cnt: '101' }, { list_item_cnt: '-1' }, { cur_page: '1.5' }]) {
    error(await f.post('post_getpostlist', { cur_page: '1', list_item_cnt: '100', ...fields }), '4000');
  }
  error(await f.post('post_getpostlist', { cur_page: '1', list_item_cnt: '100', sessionid: 'invalid' }), '4001');
  const other = success(await (await f.raw(guest())).json());
  const identity = { gsn: other.gsn, sessionid: other.sessionid };
  for (const pg of ['post_getpostlist', 'post_read', 'post_receive', 'post_postdelete']) {
    error(await f.post(pg, { ...identity, ...mailFields({ post_seq: ids[0] }), cur_page: '1', list_item_cnt: '100' }), '4003');
  }
  success(await f.post('user_nickupdate', { ...identity, nickname: 'MailOther' }));
  for (const pg of ['post_read', 'post_receive', 'post_postdelete']) {
    error(await f.post(pg, { ...identity, ...mailFields({ post_seq: ids[0] }) }), '4003');
    error(await f.post(pg, { post_seq: '0', request_id: crypto.randomUUID() }), '4000');
    error(await f.post(pg, { post_seq: ids[0] }), '4000');
  }
  const otherInbox = success(await f.post('post_getpostlist', { ...identity, cur_page: '1', list_item_cnt: '100' }));
  assert.equal(otherInbox.total_cnt, '1');
  assert.notEqual(otherInbox.post[0].post_seq, ids[0]);
});

test('mailbox grants gold/cards/chest with final authoritative counts regardless of attachment order', async (t) => {
  const f = await progressionFixture(t);
  t.mock.method(crypto, 'randomInt', (min, max) => max === undefined ? 0 : min);
  const items = [
    { item_type: '3', item_id: '304001', item_cnt: '1' },
    { item_type: '2', item_id: '201004', item_cnt: '7' },
    { item_type: '5', item_id: '0', item_cnt: '123' },
  ];
  const mail = seedMail(f, items);
  const response = success(await f.post('post_receive', mailFields(mail)));
  const hero = f.read().heroes.find((row) => row.char_id === '201004');
  assert.equal(hero.char_lv, '1');
  assert.equal(hero.health_lv, '0');
  assert.equal(hero.stone, '8', 'Seven direct rare cards plus one card from the chest');
  assert.equal(response.receiveList[1].item_curCnt, '8');
  assert.equal(response.receiveList[0].item_chest.card.find((row) => row.id === '201004').curCount, '8');
  assert.equal(response.curGold, '248', '100 starter + 123 direct + 25 chest');
  assert.equal(response.receiveList[2].item_curCnt, response.curGold);
  assert.equal(response.receiveList[0].item_chest.curGold, response.curGold);
  assert.equal(response.post_cnt, '1', 'Unclaimed welcome remains');
  assert.equal(f.read().progress.totals[1000], 1);
});

test('mailbox receipt or claim database errors roll back mail, currency/cards, quest counters and receipts', async (t) => {
  const f = await progressionFixture(t);
  const mail = (await inbox(f)).post[0];
  const fields = mailFields(mail);
  const before = f.read();
  for (const [name, sql] of [
    ['reject_mail_claim', `BEFORE UPDATE OF claimed_at ON mailbox`],
    ['reject_mail_receipt', `BEFORE UPDATE OF response_json ON mutations`],
  ]) {
    f.db.exec(`CREATE TRIGGER ${name} ${sql} BEGIN SELECT RAISE(ABORT, 'Test-only mailbox failure'); END`);
    const response = await f.raw({ pg: 'post_receive', ...fields });
    assert.equal(response.status, 500);
    error(await response.json(), '5000');
    assert.deepEqual(f.read(), before);
    const row = f.db.prepare('SELECT * FROM mailbox').get();
    assert.equal(row.claimed_at, null);
    assert.equal(row.read_at, null);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mutations WHERE request_id = ?').get(fields.request_id).n, 0);
    f.db.exec(`DROP TRIGGER ${name}`);
  }
  success(await f.post('post_receive', fields));
  assert.equal(f.read().progress.totals[1000], 1);
});

test('mailbox upgrade gives an existing tutorial-complete account one welcome without resetting state or resending after expiry', async (t) => {
  const f = await progressionFixture(t);
  f.db.exec('DROP TABLE mailbox');
  const before = f.read();
  await f.restart();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mailbox').get().n, 0);
  assert.equal((await inbox(f)).total_cnt, '1');
  assert.deepEqual(f.read(), before, 'Lazy delivery does not touch balances or progress');
  const expiry = f.db.prepare('SELECT expires_at FROM mailbox').get().expires_at;
  await f.restart();
  assert.equal((await inbox(f)).total_cnt, '1');
  assert.equal(f.db.prepare('SELECT expires_at FROM mailbox').get().expires_at, expiry);
});

test('concurrent mailbox claims return one saved reward and an expired receipt can only replay, never grant again', async (t) => {
  const f = await progressionFixture(t);
  const mail = (await inbox(f)).post[0];
  const fields = mailFields(mail);
  const results = await Promise.all([1, 2, 3].map(() => f.post('post_receive', fields)));
  const received = success(results[0]);
  results.forEach((result) => assert.deepEqual(success(result), received));
  assert.equal(f.read().progress.totals[1000], 1);
  const after = f.read();
  const expiry = f.db.prepare('SELECT expires_at FROM mailbox').get().expires_at;
  t.mock.timers.enable({ apis: ['Date'], now: expiry });
  f.db.prepare('UPDATE sessions SET expires_at = ?').run(expiry + 86400000);
  assert.deepEqual(success(await f.post('post_receive', fields)), received);
  error(await f.post('post_receive', mailFields(mail)), '4003');
  assert.deepEqual(f.read(), after);
});

test('mailbox read and notice deletion roll back if their final receipt cannot commit', async (t) => {
  const f = await progressionFixture(t);
  const notice = seedMail(f);
  const before = f.read();
  f.db.exec(`CREATE TRIGGER reject_mail_read_delete BEFORE UPDATE OF response_json ON mutations
    BEGIN SELECT RAISE(ABORT, 'Test-only mail action failure'); END`);
  const fields = mailFields(notice);
  for (const pg of ['post_read', 'post_postdelete']) {
    const response = await f.raw({ pg, ...fields });
    assert.equal(response.status, 500);
    error(await response.json(), '5000');
    const stored = f.db.prepare('SELECT read_at, deleted_at FROM mailbox WHERE post_seq = ?').get(Number(notice.post_seq));
    assert.equal(stored.read_at, null);
    assert.equal(stored.deleted_at, null);
    assert.deepEqual(f.read(), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mutations WHERE request_id = ?').get(fields.request_id).n, 0);
  }
  f.db.exec('DROP TRIGGER reject_mail_read_delete');
  success(await f.post('post_read', fields));
  success(await f.post('post_postdelete', mailFields(notice)));
});

test('unsupported or malformed stored mailbox attachments fail explicitly without granting any gifts', async (t) => {
  const f = await progressionFixture(t);
  for (const items of [
    [null],
    [{ item_type: '5', item_id: '0', item_cnt: 100 }],
    [{ item_type: '6', item_id: '0', item_cnt: '5' }],
    [{ item_type: '2', item_id: '999999', item_cnt: '5' }],
    [{ item_type: '5', item_id: '0', item_cnt: '-1' }],
    [{ item_type: '3', item_id: '304001', item_cnt: '2' }],
    [{ item_type: '3', item_id: '304001', item_cnt: '1' },
      { item_type: '3', item_id: '304002', item_cnt: '1' }],
  ]) {
    const mail = seedMail(f, items);
    const before = f.read();
    const response = await f.raw({ pg: 'post_receive', ...mailFields(mail) });
    assert.equal(response.status, 500);
    error(await response.json(), '5000');
    assert.deepEqual(f.read(), before);
    assert.equal(f.db.prepare('SELECT claimed_at FROM mailbox WHERE post_seq = ?').get(Number(mail.post_seq)).claimed_at, null);
  }
});

test('welcome delivery failure rolls back tutorial gifts and completion so a safe retry sends exactly once', async (t) => {
  const f = await progressionFixture(t);
  const pending = success(await (await f.raw(guest())).json());
  const identity = { gsn: pending.gsn, sessionid: pending.sessionid, nickname: 'MailRetry' };
  const before = f.db.prepare('SELECT * FROM accounts WHERE gsn = ?').get(Number(pending.gsn));
  f.db.exec(`CREATE TRIGGER reject_welcome BEFORE INSERT ON mailbox
    BEGIN SELECT RAISE(ABORT, 'Test-only welcome failure'); END`);
  const response = await f.raw({ pg: 'user_nickupdate', ...identity });
  assert.equal(response.status, 500);
  error(await response.json(), '5000');
  assert.deepEqual(f.db.prepare('SELECT * FROM accounts WHERE gsn = ?').get(Number(pending.gsn)), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mailbox WHERE gsn = ?').get(Number(pending.gsn)).n, 0);
  f.db.exec('DROP TRIGGER reject_welcome');
  success(await f.post('user_nickupdate', identity));
  success(await f.post('user_nickupdate', identity));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mailbox WHERE gsn = ?').get(Number(pending.gsn)).n, 1);
  assert.equal(success(await f.post('check_lobby', identity)).user_info.gold, '100');
});

test('ranking returns exact client DTOs, deterministic ties, top 100 and a personal rank outside the list', async (t) => {
  const f = await progressionFixture(t);
  const fresh = success(await f.post('ranking_list'));
  assert.deepEqual(fresh, {
    my_icon: '201001', my_nickname: 'BattleHero', my_rank: '1', my_score: '0',
    rank: [{ rank: '1', gsn: f.login.data.gsn, icon: '201001', nickname: 'BattleHero', score: '0' }],
  });
  const pending = success(await (await f.raw(guest())).json());
  const pendingIdentity = { gsn: pending.gsn, sessionid: pending.sessionid };
  const pendingRank = success(await f.post('ranking_list', pendingIdentity));
  assert.equal(pendingRank.my_rank, '0');
  assert.equal(pendingRank.rank.length, 1, 'Unfinished tutorials are not ranked');
  const state = f.read();
  const insert = f.db.prepare('INSERT INTO accounts (member_id, tutorial_completed, state_json) VALUES (?, 1, ?)');
  for (let i = 0; i < 102; i++) {
    const score = i < 2 ? 1000 : 200 - i;
    const other = structuredClone(state);
    other.user_info.nickname = `Rank${i}`;
    other.user_info.rep_hero = '201002';
    other.user_info.trophy_sum = String(score);
    other.heroes[0].trophy = String(score);
    insert.run(`rank-fixture-${i}`, JSON.stringify(other));
  }
  const ranked = success(await f.post('ranking_list'));
  assert.equal(ranked.rank.length, 100);
  assert.equal(ranked.my_rank, '103');
  assert.equal(ranked.my_score, '0');
  assert.deepEqual(ranked.rank.slice(0, 2).map((row) => row.nickname), ['Rank0', 'Rank1']);
  assert.deepEqual(ranked.rank.slice(0, 2).map((row) => row.rank), ['1', '2']);
  assert.equal(ranked.rank[99].rank, '100');
  assert.ok(!ranked.rank.some((row) => row.gsn === f.login.data.gsn));
  for (const row of ranked.rank) {
    assert.deepEqual(Object.keys(row).sort(), ['gsn', 'icon', 'nickname', 'rank', 'score']);
    for (const key of ['gsn', 'icon', 'rank', 'score']) {
      assert.match(row[key], /^\d+$/);
    }
  }
  await f.restart();
  assert.deepEqual(success(await f.post('ranking_list')), ranked);
  error(await f.post('ranking_list', { sessionid: 'bad-session' }), '4001');
  error(await f.post('ranking_weekly', { ...pendingIdentity, sessionid: f.login.data.sessionid }), '4001');
});

test('weekly ranking counts only positive actual trophy deltas once and persists without backfilling totals', async (t) => {
  const f = await progressionFixture(t);
  f.edit((state) => {
    state.heroes[0].trophy = '100';
    state.user_info.trophy_sum = '100';
    state.user_info.trophy_max = '100';
  });
  assert.equal(success(await f.post('ranking_list')).my_score, '100');
  assert.equal(success(await f.post('ranking_weekly')).my_score, '0', 'Do not backfill previous battles');
  const win = battleFields(1);
  success(await f.post('game_entryfee', win));
  success(await f.post('game_singleresult', win));
  assert.equal(success(await f.post('ranking_weekly')).my_score, '5');
  assert.equal(success(await f.post('ranking_list')).my_score, '105');
  success(await f.post('game_singleresult', win));
  assert.equal(success(await f.post('ranking_weekly')).my_score, '5');
  const lose = battleFields(1, { win: '2' });
  success(await f.post('game_entryfee', lose));
  success(await f.post('game_singleresult', lose));
  assert.equal(success(await f.post('ranking_weekly')).my_score, '5');
  assert.equal(success(await f.post('ranking_list')).my_score, '102');
  const draw = battleFields(1, { win: '3' });
  success(await f.post('game_entryfee', draw));
  success(await f.post('game_singleresult', draw));
  const gain = table('IngameReward').find((row) => row.IngameModeID === 1 && row.IngameResult === 3).GetTrophy;
  const expected = String(5 + Math.max(0, gain));
  assert.equal(success(await f.post('ranking_weekly')).my_score, expected);
  const other = success(await (await f.raw(guest())).json());
  const identity = { gsn: other.gsn, sessionid: other.sessionid };
  success(await f.post('user_nickupdate', { ...identity, nickname: 'OtherRank' }));
  const otherWin = battleFields(2);
  success(await f.post('game_entryfee', { ...otherWin, ...identity }));
  success(await f.post('game_singleresult', { ...otherWin, ...identity }));
  const weekly = success(await f.post('ranking_weekly'));
  assert.equal(weekly.rank.length, 2);
  assert.equal(weekly.rank[0].gsn, f.login.data.gsn, 'Stable GSN tie break');
  assert.equal(success(await f.post('ranking_weekly', identity)).my_score, '5');
  await f.restart();
  assert.deepEqual(success(await f.post('ranking_weekly')), weekly);
  f.edit((state) => { state.user_info.jewel = '5'; });
  const royale = battleFields(3);
  success(await f.post('game_entryfee', royale));
  const royaleResult = success(await f.post('game_singleresult', royale));
  assert.equal(success(await f.post('ranking_weekly')).my_score,
    String(Number(expected) + Math.max(0, Number(royaleResult.trophy))),
    'Battle Royale uses its actual trophy gain too');
});

test('weekly boundary is Monday 00:00 UTC+7, delayed results belong to completion week and replays do not migrate', async (t) => {
  const f = await progressionFixture(t);
  const boundary = Date.parse('2030-01-06T17:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: boundary - 1 });
  f.db.prepare('UPDATE sessions SET expires_at = ?').run(boundary + 30 * 86400000);
  const first = battleFields(1);
  success(await f.post('game_entryfee', first));
  success(await f.post('game_singleresult', first));
  const before = success(await f.post('ranking_weekly'));
  assert.equal(before.next_ranking, '20300106170000');
  assert.equal(before.my_score, '5');
  const delayed = battleFields(1);
  success(await f.post('game_entryfee', delayed));
  t.mock.timers.setTime(boundary);
  const after = success(await f.post('ranking_weekly'));
  assert.equal(after.next_ranking, '20300113170000');
  assert.equal(after.my_score, '0');
  assert.equal(after.rank[0].score, '0');
  assert.equal(success(await f.post('ranking_list')).my_score, '5', 'Weekly reset never resets hero trophies');
  success(await f.post('game_singleresult', first));
  assert.equal(success(await f.post('ranking_weekly')).my_score, '0');
  success(await f.post('game_singleresult', delayed));
  assert.equal(success(await f.post('ranking_weekly')).my_score, '5');
  const rows = f.db.prepare('SELECT score FROM weekly_scores ORDER BY week_start').all();
  assert.deepEqual(rows.map((row) => row.score), [5, 5]);
  t.mock.timers.setTime(Date.parse('2030-01-13T17:00:00Z'));
  assert.equal(success(await f.post('ranking_weekly')).next_ranking, '20300120170000');
  assert.equal(success(await f.post('ranking_weekly')).my_score, '0');
});

test('weekly score rolls back atomically when battle result storage fails', async (t) => {
  const f = await progressionFixture(t);
  const fields = battleFields(1);
  success(await f.post('game_entryfee', fields));
  const before = f.read();
  f.db.exec(`CREATE TRIGGER reject_ranking_result BEFORE UPDATE OF result_json ON battles
    BEGIN SELECT RAISE(ABORT, 'Test-only ranking rollback'); END`);
  const response = await f.raw({ pg: 'game_singleresult', ...fields });
  assert.equal(response.status, 500);
  error(await response.json(), '5000');
  assert.deepEqual(f.read(), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM weekly_scores').get().total, 0);
  f.db.exec('DROP TRIGGER reject_ranking_result');
  success(await f.post('game_singleresult', fields));
  assert.equal(success(await f.post('ranking_weekly')).my_score, '5');
});

test('shop initializes five released unique offers with exact string DTOs and survives restart', async (t) => {
  const f = await progressionFixture(t);
  const info = success(await f.post('shop_getshopinfo'));
  assert.equal(info.booster_gold_max, '0');
  assert.equal(info.booster_gold, '0');
  assert.equal(info.curGold, '100');
  assert.equal(info.curJewel, '5');
  const shop = info.shop_info;
  assert.equal(shop.shop_day, new Date().toISOString().slice(0, 10));
  assert.match(shop.shop_instance, /^[a-f0-9-]{36}$/);
  assert.match(shop.next_refresh, /^\d{8}000000$/);
  assert.equal(shop.next_free, '20000101000000');
  assert.equal(shop.items.length, 5);
  assert.equal(new Set(shop.items.map((row) => row.product_id)).size, 5);
  const products = table('Shop');
  const heroes = table('Character');
  const tiers = shop.items.map((row) => {
    assert.equal(row.bought, '0');
    const product = products.find((product) => String(product.ProductID) === row.product_id);
    assert.equal(product.IsActive, 1);
    assert.equal(product.Category, 2);
    const hero = heroes.find((hero) => hero.CharacterID === product.ItemID);
    assert.equal(hero.Type, 0);
    assert.equal(hero.ViewType, 1);
    return hero.Tier;
  });
  assert.ok(tiers.filter((tier) => tier === 1).length >= 2);
  assert.deepEqual(success(await f.post('shop_getshopinfo')), info, 'Reopening must not reroll');
  await f.restart();
  assert.deepEqual(success(await f.post('shop_getshopinfo')), info);
  error(await f.post('shop_getshopinfo', { sessionid: 'bad-session' }), '4001');
  const pending = success(await (await f.raw(guest())).json());
  for (const pg of ['shop_getshopinfo', 'shop_buyitem', 'shop_freechest']) {
    error(await f.post(pg, { gsn: pending.gsn, sessionid: pending.sessionid }), '4003');
  }
});

test('gold purchases follow all table prices including 500001, never trust submitted prices, and replay once', async (t) => {
  const f = await progressionFixture(t);
  const shop = success(await f.post('shop_getshopinfo')).shop_info;
  for (const product of table('Shop').filter((row) => row.IsActive === 1 && row.Category === 5 && row.StoreType === 0)) {
    f.edit((state) => { state.user_info.jewel = String(product.Price); });
    const before = f.read();
    const fields = {
      product_id: String(product.ProductID), shop_instance: shop.shop_instance,
      request_id: crypto.randomUUID(), price: '0', item_count: '999999', MoneyType: '3',
    };
    const result = success(await f.post('shop_buyitem', fields));
    assert.equal(result.remain_value, '0');
    assert.equal(result.curJewel, '0');
    assert.equal(result.curGold, String(Number(before.user_info.gold) + product.ItemCount));
    assert.equal(result.item_count, String(product.ItemCount));
    assert.deepEqual(f.read().heroes, before.heroes);
    const after = f.read();
    assert.deepEqual(success(await f.post('shop_buyitem', fields)), result);
    assert.deepEqual(f.read(), after);
    await f.restart();
    assert.deepEqual(success(await f.post('shop_buyitem', fields)), result);
    error(await f.post('shop_buyitem', { ...fields, product_id: '600001' }), '4003');
    error(await f.post('shop_buyitem', { ...fields, request_id: crypto.randomUUID() }), '4003');
  }
  for (const id of ['110001', '400001', '200005', '999999']) {
    error(await f.post('shop_buyitem', {
      product_id: id, shop_instance: shop.shop_instance, request_id: crypto.randomUUID(),
    }), '4003');
  }
  error(await f.post('shop_buyitem', { product_id: '500001', request_id: crypto.randomUUID() }), '4000');
  error(await f.post('shop_buyitem', {
    product_id: 'invalid', shop_instance: shop.shop_instance, request_id: crypto.randomUUID(),
  }), '4000');
});

test('daily cards can only be bought once from the current server offers and create new heroes at level one', async (t) => {
  const f = await progressionFixture(t);
  const shop = success(await f.post('shop_getshopinfo')).shop_info;
  const product = table('Shop').find((row) => shop.items.some((item) => item.product_id === String(row.ProductID))
    && !f.read().heroes.some((hero) => hero.char_id === String(row.ItemID)));
  assert.ok(product);
  const fields = {
    product_id: String(product.ProductID), shop_instance: shop.shop_instance, request_id: crypto.randomUUID(),
  };
  const before = f.read();
  error(await f.post('shop_buyitem', fields), '4003');
  assert.deepEqual(f.read(), before, 'Failed purchase must not mark sold out');
  f.edit((state) => { state.user_info.gold = String(product.Price); });
  const result = success(await f.post('shop_buyitem', fields));
  assert.equal(result.curGold, '0');
  assert.equal(result.remain_value, '0');
  assert.equal(result.curJewel, '5');
  assert.equal(result.curCount, String(product.ItemCount));
  assert.equal(result.item_id, String(product.ItemID));
  const hero = f.read().heroes.find((row) => row.char_id === result.item_id);
  assert.equal(hero.char_lv, '1');
  assert.equal(hero.stone, result.curCount);
  assert.deepEqual([hero.health_lv, hero.primary_lv, hero.super_lv], ['0', '0', '0']);
  assert.equal(result.shop_info.items.find((row) => row.product_id === fields.product_id).bought, '1');
  assert.deepEqual(success(await f.post('shop_buyitem', fields)), result);
  error(await f.post('shop_buyitem', { ...fields, request_id: crypto.randomUUID() }), '4003');
  const unavailable = table('Shop').find((row) => row.Category === 2 && row.IsActive === 1
    && !shop.items.some((item) => item.product_id === String(row.ProductID)));
  error(await f.post('shop_buyitem', {
    ...fields, product_id: String(unavailable.ProductID), request_id: crypto.randomUUID(),
  }), '4003');
});

test('shop chests grant immediate table rewards without consuming slots and receipts prevent rerolls', async (t) => {
  const f = await progressionFixture(t);
  const shop = success(await f.post('shop_getshopinfo')).shop_info;
  t.mock.method(crypto, 'randomInt', (min, max) => max === undefined ? 0 : max - 1);
  for (const product of table('Shop').filter((row) => row.IsActive === 1 && row.Category === 3 && row.StoreType === 0)) {
    f.edit((state) => { state.user_info.jewel = String(product.Price); });
    const before = f.read();
    const chest = table('Chest').find((row) => row.ChestID === product.ItemID);
    const fields = {
      product_id: String(product.ProductID), shop_instance: shop.shop_instance, request_id: crypto.randomUUID(),
    };
    const result = success(await f.post('shop_buyitem', fields));
    assert.equal(result.gold, String(chest.Gold_Max));
    assert.equal(result.curGold, String(Number(before.user_info.gold) + chest.Gold_Max));
    assert.equal(result.curJewel, '0');
    assert.equal(result.remain_value, '0');
    const prefixes = ['CommonCard', 'RareCard', 'EpicCard', 'LegendCard'];
    assert.deepEqual(result.card.map((row) => row.count),
      prefixes.filter((prefix) => chest[`${prefix}_Rate`] > 0 && chest[`${prefix}_Max`] > 0)
        .map((prefix) => String(chest[`${prefix}_Max`])));
    for (const card of result.card) {
      assert.equal(typeof card.cSeq, 'string');
      assert.equal(f.read().heroes.find((row) => row.char_id === card.id).stone, card.curCount);
    }
    assert.deepEqual(f.read().chest_info, before.chest_info);
    const after = f.read();
    assert.deepEqual(success(await f.post('shop_buyitem', fields)), result);
    assert.deepEqual(f.read(), after);
    error(await f.post('shop_buyitem', { ...fields, request_id: crypto.randomUUID() }), '4003');
  }
});

test('daily gift is once per UTC day, paid refresh changes offers not free eligibility and stale requests fail', async (t) => {
  const f = await progressionFixture(t);
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const shop = success(await f.post('shop_getshopinfo')).shop_info;
  f.edit((state) => { state.user_info.jewel = '100'; });
  const free = { shop_day: shop.shop_day, request_id: crypto.randomUUID() };
  const gift = success(await f.post('shop_freechest', free));
  assert.equal(gift.curJewel, '100', 'Free chest must preserve all jewels');
  assert.equal(gift.shop_info.next_free, shop.next_refresh);
  assert.ok(Number(gift.gold) >= 15 && Number(gift.gold) <= 30);
  assert.deepEqual(success(await f.post('shop_freechest', free)), gift);
  error(await f.post('shop_freechest', { ...free, request_id: crypto.randomUUID() }), '4003');
  const refresh = {
    product_id: '600001', shop_instance: shop.shop_instance, request_id: crypto.randomUUID(),
  };
  const reset = success(await f.post('shop_buyitem', refresh));
  assert.equal(reset.curJewel, '80');
  assert.notEqual(reset.shop_info.shop_instance, shop.shop_instance);
  assert.equal(reset.shop_info.shop_day, shop.shop_day);
  assert.equal(reset.shop_info.next_refresh, shop.next_refresh);
  assert.equal(reset.shop_info.next_free, shop.next_refresh);
  assert.ok(reset.shop_info.items.every((row) => row.bought === '0'));
  assert.deepEqual(success(await f.post('shop_buyitem', refresh)), reset);
  error(await f.post('shop_buyitem', { ...refresh, request_id: crypto.randomUUID() }), '4003');
  error(await f.post('shop_freechest', { ...free, request_id: crypto.randomUUID() }), '4003');
  await f.restart();
  assert.deepEqual(success(await f.post('shop_getshopinfo')).shop_info, reset.shop_info);
  const nextMidnight = Date.parse(`${shop.shop_day}T00:00:00Z`) + 86400000;
  t.mock.timers.setTime(nextMidnight - 1);
  assert.equal(success(await f.post('shop_getshopinfo')).shop_info.shop_day, shop.shop_day);
  t.mock.timers.setTime(nextMidnight);
  const newDay = success(await f.post('shop_getshopinfo')).shop_info;
  assert.notEqual(newDay.shop_day, shop.shop_day);
  assert.notEqual(newDay.shop_instance, reset.shop_info.shop_instance);
  assert.equal(newDay.next_free, '20000101000000');
  assert.deepEqual(success(await f.post('shop_freechest', free)), gift, 'Old receipt must not consume the new day gift');
  assert.equal(success(await f.post('shop_getshopinfo')).shop_info.next_free, '20000101000000');
  error(await f.post('shop_freechest', { ...free, request_id: crypto.randomUUID() }), '4003');
  error(await f.post('shop_buyitem', {
    product_id: '500001', shop_instance: reset.shop_info.shop_instance, request_id: crypto.randomUUID(),
  }), '4003');
  success(await f.post('shop_freechest', { shop_day: newDay.shop_day, request_id: crypto.randomUUID() }));
  error(await f.post('shop_freechest', { shop_day: newDay.shop_day, request_id: crypto.randomUUID() }), '4003');
});

test('shop offers, purchases and free gifts are account-scoped with atomic receipt rollback', async (t) => {
  const f = await progressionFixture(t);
  const shop = success(await f.post('shop_getshopinfo')).shop_info;
  f.edit((state) => { state.user_info.gold = '10000'; state.user_info.jewel = '1000'; });
  const other = success(await (await f.raw(guest())).json());
  const identity = { gsn: other.gsn, sessionid: other.sessionid };
  success(await f.post('user_nickupdate', { ...identity, nickname: 'OtherShop' }));
  success(await f.post('shop_getshopinfo', identity));
  const fields = {
    product_id: '500001', shop_instance: shop.shop_instance, request_id: crypto.randomUUID(),
  };
  error(await f.post('shop_buyitem', { ...fields, ...identity }), '4003');
  const before = f.read();
  f.db.exec(`CREATE TRIGGER reject_shop_receipt BEFORE UPDATE OF response_json ON mutations
    BEGIN SELECT RAISE(ABORT, 'Test-only shop transaction failure'); END`);
  const requests = [
    { pg: 'shop_buyitem', ...fields },
    { pg: 'shop_buyitem', ...fields, product_id: shop.items[0].product_id, request_id: crypto.randomUUID() },
    { pg: 'shop_buyitem', ...fields, product_id: '300001', request_id: crypto.randomUUID() },
    { pg: 'shop_buyitem', ...fields, product_id: '600001', request_id: crypto.randomUUID() },
    { pg: 'shop_freechest', shop_day: shop.shop_day, request_id: crypto.randomUUID() },
  ];
  for (const request of requests) {
    const response = await f.raw(request);
    assert.equal(response.status, 500);
    error(await response.json(), '5000');
    assert.deepEqual(f.read(), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM mutations').get().total, 0);
  }
  f.db.exec('DROP TRIGGER reject_shop_receipt');
  success(await f.post('shop_buyitem', fields));
  assert.deepEqual(success(await f.post('shop_getshopinfo', identity)).curGold, '100');
});

test('daily shop rarity cutoffs match the existing 50/10/20 percent UI rules without duplicate heroes', async (t) => {
  const f = await progressionFixture(t);
  let rates;
  t.mock.method(crypto, 'randomInt', (max) => max === 100 ? rates.shift() : max - 1);
  const products = table('Shop');
  const heroes = table('Character');
  for (const [rolls, expected] of [
    [[0, 0, 0], [1, 1, 2, 3, 4]],
    [[49, 9, 19], [1, 1, 2, 3, 4]],
    [[50, 10, 20], [1, 1, 1, 2, 3]],
    [[99, 99, 99], [1, 1, 1, 2, 3]],
  ]) {
    rates = [...rolls];
    f.edit((state) => { delete state.shop; });
    const shop = success(await f.post('shop_getshopinfo')).shop_info;
    const selected = shop.items.map((row) => products.find((product) => String(product.ProductID) === row.product_id));
    assert.equal(new Set(selected.map((product) => product.ItemID)).size, 5);
    assert.deepEqual(selected.map((product) => heroes.find((hero) => hero.CharacterID === product.ItemID).Tier), expected);
    assert.equal(rates.length, 0);
  }
});

test('paid refresh makes sold daily products eligible again but cannot be replayed to reset their next purchase', async (t) => {
  const f = await progressionFixture(t);
  t.mock.method(crypto, 'randomInt', () => 0);
  const shop = success(await f.post('shop_getshopinfo')).shop_info;
  f.edit((state) => { state.user_info.gold = '10000'; state.user_info.jewel = '100'; });
  const productId = shop.items[0].product_id;
  const buy = {
    product_id: productId, shop_instance: shop.shop_instance, request_id: crypto.randomUUID(),
  };
  const first = success(await f.post('shop_buyitem', buy));
  const refresh = {
    product_id: '600001', shop_instance: shop.shop_instance, request_id: crypto.randomUUID(),
  };
  const reroll = success(await f.post('shop_buyitem', refresh));
  const newBuy = { ...buy, shop_instance: reroll.shop_info.shop_instance, request_id: crypto.randomUUID() };
  const second = success(await f.post('shop_buyitem', newBuy));
  assert.equal(Number(second.curCount), Number(first.curCount) * 2);
  assert.equal(second.curJewel, '80');
  const stateAfter = f.read();
  assert.deepEqual(success(await f.post('shop_buyitem', refresh)), reroll);
  assert.deepEqual(success(await f.post('shop_buyitem', buy)), first);
  assert.deepEqual(f.read(), stateAfter);
  error(await f.post('shop_buyitem', { ...newBuy, request_id: crypto.randomUUID() }), '4003');
  f.edit((state) => { state.user_info.jewel = '19'; });
  error(await f.post('shop_buyitem', {
    product_id: '600001', shop_instance: reroll.shop_info.shop_instance, request_id: crypto.randomUUID(),
  }), '4003');
  assert.equal(f.read().shop.instance, reroll.shop_info.shop_instance);
});

test('quest/achievement list DTOs match active tables, notifications and exact UTC deadline', async (t) => {
  const f = await progressionFixture(t);
  const daily = success(await f.post('quest_daily'));
  const achievements = success(await f.post('achievement_list'));
  const active = table('Quest').filter((row) => row.Active === 1);
  assert.deepEqual(daily.list.map((row) => row.id),
    active.filter((row) => row.Category === 1).map((row) => String(row.QuestID)));
  assert.equal(daily.list.length, 6);
  assert.equal(achievements.list.length, 16);
  assert.equal(daily.quest_day, new Date().toISOString().slice(0, 10));
  assert.match(daily.next_reset, /^\d{8}000000$/);
  assert.equal(daily.quest_cnt, '1');
  assert.equal(daily.achievement_cnt, '1');
  assert.deepEqual(daily.list[0], { id: '10100001', progressCnt: '1', status: '1' });
  assert.deepEqual(achievements.list[0], { id: '20100001', progressCnt: '1', status: '1', step: '1' });
  for (const row of [...daily.list, ...achievements.list]) {
    for (const value of Object.values(row)) {
      assert.match(value, /^\d+$/);
    }
  }
  assert.ok(!achievements.list.some((row) => ['20500001', '20800001'].includes(row.id)));
  const lobby = success(await f.post('check_lobby'));
  assert.equal(lobby.user_info.quest_cnt, daily.quest_cnt);
  assert.equal(lobby.user_info.achievement_cnt, daily.achievement_cnt);
  await f.restart();
  assert.deepEqual(success(await f.post('quest_daily')), daily);
  assert.deepEqual(success(await f.post('achievement_list')), achievements);
  error(await f.post('quest_daily', { sessionid: 'bad-session' }), '4001');
  const pending = success(await (await f.raw(guest())).json());
  for (const pg of ['quest_daily', 'achievement_list', 'quest_complete', 'achievement_complete']) {
    error(await f.post(pg, { gsn: pending.gsn, sessionid: pending.sessionid }), '4003');
  }
});

test('reward tables restore original objective, tutorial, chest, level-up and clan jewels', () => {
  const rewards = table('QuestReward');
  assert.equal(rewards.filter((row) => row.ItemType === 6).length, 103);
  for (const [id, amount] of [
    [10100001, 1], [10200001, 30], [10300001, 30], [10400001, 15],
    [11000001, 30], [11200001, 9],
    [20100001, 5], [20100002, 10], [20100007, 50], [20910005, 250],
  ]) {
    assert.equal(rewards.find((row) => row.QuestRewardID === id).ItemCount, amount, `Reward ${id}`);
  }
  assert.equal(table('Common')[0].TutoReward_Jewel, 5);
  assert.equal(table('Common')[0].TutoReward_Gold, 100);
  assert.equal(table('Chest').filter((row) => row.GetJewelRate > 0).length, 34);
  for (const [id, min, max, rate] of [
    [301001, 1, 2, 500], [302001, 1, 2, 1000], [304001, 1, 1, 200],
    [304002, 1, 2, 100], [304003, 1, 3, 50], [311001, 70, 70, 10000],
    [311002, 160, 160, 10000], [311003, 500, 500, 10000],
  ]) {
    const chest = table('Chest').find((row) => row.ChestID === id);
    assert.deepEqual([chest.Jewel_Min, chest.Jewel_Max, chest.GetJewelRate], [min, max, rate]);
  }
  for (const level of table('UserLevel')) {
    for (const n of [1, 2]) {
      assert.equal(level[`LevelUpReward${n}Type`], n === 1 ? 6 : 0);
      assert.equal(level[`LevelUpReward${n}Count`], n === 1 ? 2 : 0);
    }
  }
  assert.equal(table('ClanAttendReward').find((row) => row.RewardItemType === 6).RewardItemCount, 1);
  const br = table('BattleMode').find((row) => row.ModeID === 3);
  assert.equal(br.EntryFeeType, 6);
  assert.equal(br.EntryFee, 1);
  assert.deepEqual(table('IngameReward').filter((row) => row.IngameModeID === 3)
    .map((row) => row.GetEntryFee), [2, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  const iapJewels = table('Shop').filter((row) => row.ItemType === 6 && row.IsActive === 1);
  assert.equal(iapJewels.length, 12);
  assert.ok(iapJewels.every((row) => row.MoneyType === 1 && [1, 2].includes(row.StoreType)
    && row.ItemCount > 0 && row.ShopProductID.startsWith('heroes.dia')));
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'bootstrap-config.json'), 'utf8'));
  assert.equal(config.tabledata.QuestRewardTable, 3);
  assert.equal(config.tabledata.ChestTable, 4);
  for (const name of ['CommonTable', 'UserLevelTable', 'ClanAttendRewardTable']) {
    assert.equal(config.tabledata[name], 3);
  }
});

test('existing jewels and claimed progress survive reward changes; new quest claims grant original jewels', async (t) => {
  const f = await progressionFixture(t);
  f.edit((state) => {
    state.user_info.jewel = '67';
    state.progress.achievements[20100001] = 1;
  });
  const original = f.read();
  await f.restart();
  assert.deepEqual(f.read(), original, 'A restart must not migrate balances or reset objective claims');
  const daily = success(await f.post('quest_daily'));
  const result = success(await f.post('quest_complete', {
    id: '10100001', quest_day: daily.quest_day, request_id: crypto.randomUUID(),
  }));
  assert.equal(result.curMoneyType, '6');
  assert.equal(result.curGold, '100');
  assert.equal(result.curJewel, '68');
  assert.equal(f.read().progress.achievements[20100001], 1);
  error(await f.post('achievement_complete', {
    id: '20100001', expected_step: '1', request_id: crypto.randomUUID(),
  }), '4003');
});

test('legacy jewel reward receipts replay unchanged without issuing a second or converted reward', async (t) => {
  const f = await progressionFixture(t);
  const daily = success(await f.post('quest_daily'));
  const fields = { id: '10100001', quest_day: daily.quest_day, request_id: crypto.randomUUID() };
  const historical = { curMoneyType: '6', curMoney: '68', curGold: '100', curJewel: '68', status: '2' };
  f.edit((state) => {
    state.user_info.jewel = '68';
    state.progress.claimed.push(10100001);
    state.progress.daily[1200] = 1;
    state.progress.totals[1200] = 1;
  });
  f.db.prepare(`INSERT INTO mutations (gsn, request_id, pg, fingerprint, response_json)
    VALUES (?, ?, 'quest_complete', ?, ?)`).run(Number(f.login.data.gsn), fields.request_id,
    JSON.stringify([['id', fields.id], ['quest_day', fields.quest_day]]), JSON.stringify(historical));
  const before = f.read();
  await f.restart();
  assert.deepEqual(success(await f.post('quest_complete', fields)), historical);
  assert.deepEqual(f.read(), before);
  error(await f.post('quest_complete', { ...fields, request_id: crypto.randomUUID() }), '4003');
  assert.deepEqual(f.read(), before, 'A gold reward must not be granted again for a historical jewel claim');
});

test('daily login rewards grant table money once, reject invalid/stale claims and replay after restart', async (t) => {
  const f = await progressionFixture(t);
  const daily = success(await f.post('quest_daily'));
  const fields = { id: '10100001', quest_day: daily.quest_day, request_id: crypto.randomUUID() };
  error(await f.post('quest_complete', { ...fields, id: '10200001' }), '4003');
  error(await f.post('quest_complete', { ...fields, id: '10500001' }), '4004');
  error(await f.post('quest_complete', { ...fields, quest_day: '2000-01-01' }), '4003');
  error(await f.post('quest_complete', { ...fields, request_id: '' }), '4000');
  const result = success(await f.post('quest_complete', fields));
  const row = table('QuestReward').find((row) => row.QuestRewardID === 10100001);
  assert.equal(result.curMoneyType, String(row.ItemType));
  assert.equal(result.curGold, '100');
  assert.equal(result.curJewel, String(5 + row.ItemCount));
  assert.equal(result.curMoney, result.curJewel);
  assert.equal(result.status, '2');
  assert.equal(result.quests.find((row) => row.id === '11200001').progressCnt, '1');
  assert.equal(result.quest_cnt, '0');
  const state = f.read();
  assert.deepEqual(success(await f.post('quest_complete', fields)), result);
  assert.deepEqual(f.read(), state);
  error(await f.post('quest_complete', { ...fields, request_id: crypto.randomUUID() }), '4003');
  error(await f.post('quest_complete', { ...fields, id: '11200001' }), '4003');
  await f.restart();
  assert.deepEqual(success(await f.post('quest_complete', fields)), result);
  assert.deepEqual(f.read(), state);
});

test('battle events count wins, MVP, first kill, gems, turrets, potions and kills once including defeats', async (t) => {
  const f = await progressionFixture(t);
  const first = battleFields(1, {
    total_kill: '10', get_potion: '10', get_jam: '12', turret_kill: '0',
    first_kill: f.login.data.gsn, mvp: f.login.data.gsn,
  });
  success(await f.post('game_entryfee', first));
  success(await f.post('game_singleresult', first));
  const counts = f.read().progress;
  for (const [type, amount] of [[200, 1], [210, 12], [600, 10], [610, 10], [620, 1], [630, 1]]) {
    assert.equal(counts.totals[type], amount);
  }
  success(await f.post('game_singleresult', first));
  assert.deepEqual(f.read().progress, counts);
  error(await f.post('game_singleresult', { ...first, total_kill: '11' }), '4003');
  error(await f.post('game_singleresult', { ...first, get_potion: '-1' }), '4000');
  error(await f.post('game_singleresult', { ...first, get_jam: '100001' }), '4000');
  error(await f.post('game_singleresult', { ...first, turret_kill: '1' }), '4000');
  const defense = battleFields(2, { win: '2', total_kill: '2', get_potion: '3', turret_kill: '1', get_jam: '0' });
  success(await f.post('game_entryfee', defense));
  success(await f.post('game_singleresult', defense));
  assert.equal(f.read().progress.totals[310], 1, 'Individual turret kill counts even in a defeat');
  assert.equal(f.read().progress.totals[610], 12);
  assert.equal(f.read().progress.totals[300] || 0, 0);
  f.edit((state) => { state.user_info.jewel = '5'; });
  const br = battleFields(3);
  success(await f.post('game_entryfee', br));
  success(await f.post('game_singleresult', br));
  assert.equal(f.read().progress.totals[400], 1);
  const brLoss = battleFields(3, { battle_rank: '2' });
  success(await f.post('game_entryfee', brLoss));
  success(await f.post('game_singleresult', brLoss));
  assert.equal(f.read().progress.totals[400], 1);
  const list = success(await f.post('achievement_list')).list;
  for (const id of ['20210001', '20310001', '20600001', '20610001']) {
    assert.equal(list.find((row) => row.id === id).status, '1');
  }
});

test('all five daily objectives unlock the daily completion reward without claim replay inflation', async (t) => {
  const f = await progressionFixture(t);
  f.edit((state) => { state.user_info.jewel = '5'; });
  for (const mode of [1, 1, 1, 2, 2, 2, 3]) {
    const fields = battleFields(mode);
    success(await f.post('game_entryfee', fields));
    success(await f.post('game_singleresult', fields));
  }
  f.edit((state) => { state.user_info.jewel = '1000'; });
  const shop = success(await f.post('shop_getshopinfo')).shop_info;
  for (let i = 0; i < 3; i++) {
    success(await f.post('shop_buyitem', {
      product_id: '300001', shop_instance: shop.shop_instance, request_id: crypto.randomUUID(),
    }));
  }
  const daily = success(await f.post('quest_daily'));
  assert.equal(daily.quest_cnt, '5');
  const meta = daily.list.find((row) => row.id === '11200001');
  assert.equal(meta.status, '0');
  for (const quest of daily.list.filter((row) => row.id !== meta.id)) {
    const fields = { id: quest.id, quest_day: daily.quest_day, request_id: crypto.randomUUID() };
    success(await f.post('quest_complete', fields));
    success(await f.post('quest_complete', fields));
  }
  const ready = success(await f.post('quest_daily'));
  assert.equal(ready.list.find((row) => row.id === meta.id).progressCnt, '5');
  assert.equal(ready.list.find((row) => row.id === meta.id).status, '1');
  assert.equal(ready.quest_cnt, '1');
  const reward = success(await f.post('quest_complete', {
    id: meta.id, quest_day: daily.quest_day, request_id: crypto.randomUUID(),
  }));
  assert.equal(reward.quest_cnt, '0');
  assert.ok(reward.quests.every((row) => row.status === '2'));
  assert.equal(reward.quests.find((row) => row.id === meta.id).progressCnt, '6');
});

test('achievement steps award each threshold exactly once and retain the final step after completion', async (t) => {
  const f = await progressionFixture(t);
  f.edit((state) => { state.progress.totals[610] = 3000; });
  const steps = table('Quest').filter((row) => row.Active === 1 && row.QuestID === 20610001);
  let lastFields;
  let lastResult;
  for (const quest of steps) {
    const before = f.read();
    const fields = {
      id: String(quest.QuestID), expected_step: String(quest.QuestStep), request_id: crypto.randomUUID(),
    };
    const result = success(await f.post('achievement_complete', fields));
    const reward = table('QuestReward').find((row) => row.QuestRewardID === quest.QuestRewardID);
    const currency = reward.ItemType === 5 ? 'gold' : 'jewel';
    assert.equal(Number(f.read().user_info[currency]) - Number(before.user_info[currency]), reward.ItemCount);
    assert.equal(result.curStep, String(Math.min(quest.QuestStep + 1, steps.at(-1).QuestStep)));
    assert.equal(result.status, quest === steps.at(-1) ? '2' : '1');
    assert.equal(result.progressCnt, '3000');
    const after = f.read();
    assert.deepEqual(success(await f.post('achievement_complete', fields)), result);
    assert.deepEqual(f.read(), after);
    error(await f.post('achievement_complete', { ...fields, request_id: crypto.randomUUID() }), '4003');
    lastFields = fields;
    lastResult = result;
  }
  await f.restart();
  assert.deepEqual(success(await f.post('achievement_complete', lastFields)), lastResult);
  assert.equal(success(await f.post('achievement_list')).list.find((row) => row.id === '20610001').status, '2');
});

test('chest, currency spend, upgrade and roster achievements track their actual successful server actions', async (t) => {
  const f = await progressionFixture(t);
  f.edit((state) => {
    state.user_info.gold = '10000';
    state.user_info.jewel = '1000';
    state.heroes[0].stone = '100';
    state.heroes[0].trophy = '100';
    state.user_info.trophy_sum = '100';
  });
  const before = structuredClone(f.read().progress);
  const upgrade = { char_id: '201001', skill_type: '0', expected_level: '0', request_id: crypto.randomUUID() };
  success(await f.post('character_upgradeskill', upgrade));
  assert.equal(f.read().progress.totals[710], before.totals[710] + 1);
  assert.equal(f.read().progress.totals[900], 10);
  success(await f.post('character_upgradeskill', upgrade));
  assert.equal(f.read().progress.totals[900], 10);
  const shop = success(await f.post('shop_getshopinfo')).shop_info;
  const product = table('Shop').find((row) => shop.items.some((item) => item.product_id === String(row.ProductID))
    && !f.read().heroes.some((hero) => hero.char_id === String(row.ItemID)));
  success(await f.post('shop_buyitem', {
    product_id: String(product.ProductID), shop_instance: shop.shop_instance, request_id: crypto.randomUUID(),
  }));
  assert.equal(f.read().progress.totals[900], 10 + product.Price);
  success(await f.post('shop_buyitem', {
    product_id: '500001', shop_instance: shop.shop_instance, request_id: crypto.randomUUID(),
  }));
  success(await f.post('shop_buyitem', {
    product_id: '300001', shop_instance: shop.shop_instance, request_id: crypto.randomUUID(),
  }));
  success(await f.post('shop_freechest', { shop_day: shop.shop_day, request_id: crypto.randomUUID() }));
  const chest = f.chest(3, { nowYN: 'Y' });
  success(await f.post('chest_open', chest));
  assert.equal(f.read().progress.totals[1000], 3);
  assert.equal(f.read().progress.totals[910], 108, '20 gold pack + 70 chest + 18 instant unlock');
  const br = battleFields(3);
  success(await f.post('game_entryfee', br));
  assert.equal(f.read().progress.totals[910], 109);
  const list = success(await f.post('achievement_list')).list;
  for (const id of ['20700001', '20710001', '20720001', '20900001', '20910001']) {
    assert.equal(list.find((row) => row.id === id).status, '1');
  }
  const state = f.read();
  error(await f.post('chest_open', { ...chest, request_id: crypto.randomUUID() }), '4003');
  assert.deepEqual(f.read(), state);
});

test('UTC midnight resets daily objectives but keeps lifetime progress and login streak resets after a missed day', async (t) => {
  const f = await progressionFixture(t);
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  f.db.prepare('UPDATE sessions SET expires_at = ?').run(now + 10 * 86400000);
  const daily = success(await f.post('quest_daily'));
  const claim = { id: '10100001', quest_day: daily.quest_day, request_id: crypto.randomUUID() };
  const first = success(await f.post('quest_complete', claim));
  const win = battleFields(1);
  success(await f.post('game_entryfee', win));
  success(await f.post('game_singleresult', win));
  const midnight = Date.parse(`${daily.quest_day}T00:00:00Z`) + 86400000;
  t.mock.timers.setTime(midnight - 1);
  assert.equal(success(await f.post('quest_daily')).quest_day, daily.quest_day);
  t.mock.timers.setTime(midnight);
  const next = success(await f.post('quest_daily'));
  assert.notEqual(next.quest_day, daily.quest_day);
  assert.equal(next.list.find((row) => row.id === '10100001').status, '1');
  assert.equal(next.list.find((row) => row.id === '10200001').progressCnt, '0');
  assert.equal(next.list.find((row) => row.id === '11200001').progressCnt, '0');
  assert.equal(f.read().progress.totals[200], 1);
  assert.equal(f.read().progress.streak, 2);
  assert.deepEqual(success(await f.post('quest_complete', claim)), first);
  assert.equal(success(await f.post('quest_daily')).list[0].status, '1');
  error(await f.post('quest_complete', { ...claim, request_id: crypto.randomUUID() }), '4003');
  success(await f.post('game_singleresult', win));
  assert.equal(success(await f.post('quest_daily')).list.find((row) => row.id === '10200001').progressCnt, '0');
  assert.equal(f.read().progress.streak, 2, 'Repeated calls within a day do not grow streak');
  t.mock.timers.setTime(midnight + 2 * 86400000);
  assert.equal(success(await f.post('achievement_list')).list.find((row) => row.id === '20100001').progressCnt, '1');
  assert.equal(f.read().progress.streak, 1);
  await f.restart();
  assert.equal(success(await f.post('achievement_list')).list.find((row) => row.id === '20100001').progressCnt, '1');
});

test('quest reward receipts and battle statistics roll back atomically and are isolated between accounts', async (t) => {
  const f = await progressionFixture(t);
  const daily = success(await f.post('quest_daily'));
  const fields = { id: '10100001', quest_day: daily.quest_day, request_id: crypto.randomUUID() };
  const before = f.read();
  f.db.exec(`CREATE TRIGGER reject_quest_claim BEFORE UPDATE OF response_json ON mutations
    BEGIN SELECT RAISE(ABORT, 'Test-only quest reward failure'); END`);
  const response = await f.raw({ pg: 'quest_complete', ...fields });
  assert.equal(response.status, 500);
  error(await response.json(), '5000');
  assert.deepEqual(f.read(), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM mutations').get().total, 0);
  const failedAchievement = await f.raw({
    pg: 'achievement_complete', id: '20100001', expected_step: '1', request_id: crypto.randomUUID(),
  });
  assert.equal(failedAchievement.status, 500);
  error(await failedAchievement.json(), '5000');
  assert.deepEqual(f.read(), before);
  f.db.exec('DROP TRIGGER reject_quest_claim');
  success(await f.post('quest_complete', fields));
  const other = success(await (await f.raw(guest())).json());
  const identity = { gsn: other.gsn, sessionid: other.sessionid };
  success(await f.post('user_nickupdate', { ...identity, nickname: 'OtherQuest' }));
  const otherList = success(await f.post('quest_daily', identity));
  assert.equal(otherList.list[0].status, '1');
  success(await f.post('quest_complete', { ...fields, ...identity }));
  const battle = battleFields(1, { total_kill: '10', get_potion: '5', get_jam: '15' });
  success(await f.post('game_entryfee', battle));
  const state = f.read();
  f.db.exec(`CREATE TRIGGER reject_progress_battle BEFORE UPDATE OF result_json ON battles
    BEGIN SELECT RAISE(ABORT, 'Test-only progress failure'); END`);
  const failed = await f.raw({ pg: 'game_singleresult', ...battle });
  assert.equal(failed.status, 500);
  error(await failed.json(), '5000');
  assert.deepEqual(f.read(), state);
  f.db.exec('DROP TRIGGER reject_progress_battle');
  success(await f.post('game_singleresult', battle));
  assert.equal(f.read().progress.totals[610], 10);
  assert.equal(success(await f.post('achievement_list', identity)).list.find((row) => row.id === '20610001').progressCnt, '0');
});

test('every active achievement chain uses actual reward tables and remains completed at its final valid step', async (t) => {
  const f = await progressionFixture(t);
  const active = table('Quest').filter((row) => row.Active === 1 && row.Category === 2);
  f.edit((state) => {
    state.progress.streak = 7;
    for (const quest of active) {
      state.progress.totals[quest.QuestType] = Math.max(state.progress.totals[quest.QuestType] || 0, quest.QuestCount);
    }
    state.heroes = table('Character').filter((row) => row.Type === 0 && row.ViewType === 1 && row.Tier <= 4)
      .map((hero) => ({
        char_id: String(hero.CharacterID), char_lv: '1', skin_id: '0', trophy: '100',
        stone: '0', health_lv: '0', primary_lv: '0', super_lv: '0',
      }));
  });
  for (const id of [...new Set(active.map((row) => row.QuestID))]) {
    const steps = active.filter((row) => row.QuestID === id).sort((a, b) => a.QuestStep - b.QuestStep);
    for (const step of steps) {
      const before = f.read().user_info;
      const result = success(await f.post('achievement_complete', {
        id: String(id), expected_step: String(step.QuestStep), request_id: crypto.randomUUID(),
      }));
      const rewards = table('QuestReward').filter((row) => row.QuestRewardID === step.QuestRewardID);
      assert.equal(Number(result.curGold) - Number(before.gold),
        rewards.filter((row) => row.ItemType === 5).reduce((sum, row) => sum + row.ItemCount, 0));
      assert.equal(Number(result.curJewel) - Number(before.jewel),
        rewards.filter((row) => row.ItemType === 6).reduce((sum, row) => sum + row.ItemCount, 0));
    }
    const last = success(await f.post('achievement_list')).list.find((row) => row.id === String(id));
    assert.equal(last.status, '2');
    assert.equal(last.step, String(steps.at(-1).QuestStep));
  }
  assert.equal(success(await f.post('achievement_list')).achievement_cnt, '0');
});

test('legacy accounts migrate known roster/skill state but not invented past events; legacy battle replays grant nothing', async (t) => {
  const f = await progressionFixture(t);
  const battle = battleFields(1, { total_kill: '10', get_potion: '5' });
  success(await f.post('game_entryfee', battle));
  success(await f.post('game_singleresult', battle));
  const stored = f.db.prepare('SELECT result_request FROM battles WHERE room_id = ?').get(battle.room_id);
  const normalized = JSON.parse(stored.result_request);
  delete normalized.stats;
  f.db.prepare('UPDATE battles SET result_request = ? WHERE room_id = ?')
    .run(JSON.stringify(normalized), battle.room_id);
  f.edit((state) => {
    delete state.progress;
    state.heroes[0].health_lv = '2';
    state.heroes[0].primary_lv = '1';
    state.heroes[0].char_lv = '4';
  });
  const before = f.read();
  await f.restart();
  const list = success(await f.post('achievement_list'));
  assert.equal(list.list.find((row) => row.id === '20710001').progressCnt, '3');
  assert.equal(list.list.find((row) => row.id === '20610001').progressCnt, '0');
  assert.equal(list.list.find((row) => row.id === '20200001').progressCnt, '0');
  assert.deepEqual(f.read().heroes, before.heroes);
  const migrated = f.read();
  success(await f.post('game_singleresult', battle));
  assert.deepEqual(f.read(), migrated, 'Old receipt returns without backfilling progress');
});

function leagueClock(t, f) {
  const end = Date.parse('2030-01-06T17:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: end - 60000 });
  f.db.prepare('UPDATE sessions SET expires_at = ?').run(end + 90 * 86400000);
  return { end, start: end - 7 * 86400000 };
}

function seedLeagueMembers(f, week, leagueId, scores) {
  const ids = [];
  const template = f.read();
  for (const [index, score] of scores.entries()) {
    const state = structuredClone(template);
    state.user_info.grade = String(leagueId);
    state.user_info.nickname = `League${leagueId}-${index}`;
    const inserted = f.db.prepare('INSERT INTO accounts (member_id, tutorial_completed, state_json) VALUES (?, 1, ?)')
      .run(crypto.randomUUID(), JSON.stringify(state));
    const gsn = Number(inserted.lastInsertRowid);
    f.db.prepare('INSERT INTO weekly_scores (week_start, gsn, score) VALUES (?, ?, ?)').run(week, gsn, score);
    f.db.prepare('INSERT INTO league_members (week_start, gsn, league_id) VALUES (?, ?, ?)').run(week, gsn, leagueId);
    ids.push(gsn);
  }
  return ids;
}

test('league list only enrolls finished battles, uses weekly gains, stable ties and exact thresholds', async (t) => {
  const f = await progressionFixture(t);
  leagueClock(t, f);
  const empty = success(await f.post('league_list'));
  assert.equal(empty.league_id, '103');
  assert.deepEqual(empty.rank, []);
  assert.equal(empty.next_league, '20300106170000');
  error(await f.post('league_weekly'), '4003');
  const fields = battleFields(1);
  success(await f.post('game_entryfee', fields));
  assert.deepEqual(success(await f.post('league_list')).rank, [], 'Entry or an abandoned match is not participation');
  success(await f.post('game_singleresult', fields));
  const list = success(await f.post('league_list'));
  assert.equal(list.pRank, '1', 'Positive-score singleton may promote');
  assert.equal(list.dRank, '0', 'Bottom league cannot demote');
  assert.deepEqual(list.rank, [{
    rank: '1', gsn: f.login.data.gsn, icon: '201001', nickname: 'BattleHero', score: '5',
  }]);
  success(await f.post('game_singleresult', fields));
  assert.deepEqual(success(await f.post('league_list')), list);
  error(await f.post('league_list', { sessionid: 'invalid' }), '4001');
});

test('all leagues settle promotion/keep/demotion ratios once and choose rewards from old league and global ranks', async (t) => {
  const f = await progressionFixture(t);
  const { start, end } = leagueClock(t, f);
  const groups = table('League').map((league) => ({
    league, ids: seedLeagueMembers(f, start, league.LeagueID, [10, 10, 8, 7, 6, 5, 4, 3, 2, 1]),
  }));
  const offlineProgress = JSON.parse(f.db.prepare('SELECT state_json FROM accounts WHERE gsn = ?')
    .get(groups[0].ids[0]).state_json).progress;
  t.mock.timers.setTime(end);
  success(await f.post('check_lobby'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM league_periods').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM league_results').get().n, 170);
  for (const { league, ids } of groups) {
    const promote = league.PromoteLeagueID === league.LeagueID ? 0 : Math.floor(10 * league.PromoteRank / 10000);
    const keep = Math.max(promote, Math.floor(10 * league.DemoteRank / 10000));
    for (const [index, id] of ids.entries()) {
      const stored = f.db.prepare('SELECT data_json FROM league_results WHERE gsn = ?').get(id);
      const data = JSON.parse(stored.data_json);
      const expectedLeague = index < promote ? league.PromoteLeagueID
        : index >= keep ? league.DemoteLeagueID : league.LeagueID;
      assert.equal(data.league_id, String(league.LeagueID));
      assert.equal(data.new_league_id, String(expectedLeague));
      assert.equal(data.my_rank, String(index + 1));
      assert.equal(data.pRank, String(promote));
      assert.equal(data.dRank, league.DemoteLeagueID === league.LeagueID ? '0' : String(keep));
      assert.deepEqual(data.rank.map((row) => Number(row.gsn)), ids, 'GSN ascending breaks score ties');
      const account = JSON.parse(f.db.prepare('SELECT state_json FROM accounts WHERE gsn = ?').get(id).state_json);
      assert.equal(account.user_info.grade, String(expectedLeague));
      assert.equal(account.user_info.league_flag, '1');
      assert.deepEqual(account.progress, offlineProgress, 'Offline settlement must not create login/streak activity');
      const rewards = f.db.prepare('SELECT kind, chest_id FROM season_rewards WHERE gsn = ? ORDER BY kind').all(id);
      const prize = table('LeagueReward').find((row) => row.LeagueID === league.LeagueID
        && row.MinRank <= index + 1 && (row.MaxRank === 0 || row.MaxRank >= index + 1));
      assert.equal(rewards[0].kind, 'league');
      assert.equal(rewards[0].chest_id, prize.RewardChestID);
      assert.equal(rewards.length, Number(data.global_rank) <= 50 ? 2 : 1);
      if (rewards.length === 2) {
        const weekly = table('WeeklyRankingReward').find((row) => row.MinRank <= Number(data.global_rank)
          && row.MaxRank >= Number(data.global_rank));
        assert.equal(rewards[1].kind, 'weekly');
        assert.equal(rewards[1].chest_id, weekly.ChestID);
      }
    }
  }
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM season_rewards').get().n;
  assert.equal(before, 220, '170 league rewards plus 50 global ranking rewards');
  success(await f.post('check_lobby'));
  await f.restart();
  success(await f.post('check_lobby'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM season_rewards').get().n, before);
  assert.equal(f.read().user_info.grade, '103', 'Nonparticipant never promotes or demotes');
  assert.equal(f.read().user_info.league_flag, '0');
});

test('week boundary snapshots old scores, late results enroll in new league and no-play weeks do not generate rewards', async (t) => {
  const f = await progressionFixture(t);
  const { end } = leagueClock(t, f);
  const first = battleFields(1);
  success(await f.post('game_entryfee', first));
  success(await f.post('game_singleresult', first));
  const late = battleFields(1);
  success(await f.post('game_entryfee', late));
  t.mock.timers.setTime(end - 1);
  assert.equal(success(await f.post('check_lobby')).user_info.grade, '103');
  t.mock.timers.setTime(end);
  const lobby = success(await f.post('check_lobby'));
  assert.equal(lobby.user_info.grade, '102');
  assert.equal(lobby.user_info.league_flag, '1');
  const season = success(await f.post('league_weekly'));
  assert.equal(season.league_id, '103');
  assert.equal(season.new_league_id, '102');
  assert.equal(season.my_score, '5');
  assert.equal(season.rewards.length, 2);
  success(await f.post('game_singleresult', first));
  assert.deepEqual(success(await f.post('league_list')).rank, [], 'Old replay must not enroll new week');
  success(await f.post('game_singleresult', late));
  assert.equal(success(await f.post('league_list')).rank[0].score, '5');
  assert.equal(success(await f.post('league_list')).league_id, '102');
  assert.deepEqual(success(await f.post('league_weekly')), season, 'Old season immutable after later battles');
  t.mock.timers.setTime(end + 3 * 7 * 86400000);
  assert.equal(success(await f.post('check_lobby')).user_info.grade, '101');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM league_results WHERE gsn = ?').get(Number(f.login.data.gsn)).n, 2);
  assert.deepEqual(success(await f.post('league_weekly')), season, 'Oldest unacknowledged season remains first');
});

test('one request uses one season cutoff even if the clock crosses Monday between score and enrollment writes', async (t) => {
  const f = await progressionFixture(t);
  const { start, end } = leagueClock(t, f);
  const fields = battleFields(1);
  success(await f.post('game_entryfee', fields));
  const clock = t.mock.method(Date, 'now', () => f.db.prepare('SELECT COUNT(*) AS n FROM weekly_scores').get().n ? end : end - 1);
  try {
    success(await f.post('game_singleresult', fields));
    assert.equal(f.db.prepare('SELECT week_start FROM weekly_scores').get().week_start, start);
    assert.equal(f.db.prepare('SELECT week_start FROM league_members').get().week_start, start);
    const season = success(await f.post('league_weekly'));
    assert.equal(season.my_score, '5');
    assert.equal(season.new_league_id, '102');
  } finally {
    clock.mock.restore();
  }
});

test('league rewards roll exact chest tables once, remain pending across restart and ack requires every prize', async (t) => {
  const f = await progressionFixture(t);
  const { end } = leagueClock(t, f);
  const win = battleFields(1);
  success(await f.post('game_entryfee', win));
  success(await f.post('game_singleresult', win));
  t.mock.timers.setTime(end);
  const season = success(await f.post('league_weekly'));
  const ack = { season_id: season.season_id, request_id: crypto.randomUUID() };
  error(await f.post('league_ack', ack), '4003');
  error(await f.post('league_rewardclaim', { reward_id: 'missing', request_id: crypto.randomUUID() }), '4003');
  t.mock.method(crypto, 'randomInt', (min, max) => max === undefined ? 0 : max - 1);
  const slots = f.read().chest_info;
  for (const reward of season.rewards) {
    const before = f.read();
    const fields = { reward_id: reward.reward_id, request_id: crypto.randomUUID() };
    const chest = table('Chest').find((row) => String(row.ChestID) === reward.chest_id);
    const result = success(await f.post('league_rewardclaim', fields));
    assert.equal(result.chest_id, reward.chest_id);
    assert.equal(result.gold, String(chest.Gold_Max));
    assert.equal(Number(result.curGold), Number(before.user_info.gold) + chest.Gold_Max);
    assert.equal(result.curJewel, before.user_info.jewel);
    assert.deepEqual(f.read().chest_info, slots);
    const groups = ['CommonCard', 'RareCard', 'EpicCard', 'LegendCard']
      .filter((prefix) => chest[`${prefix}_Rate`] > 0 && chest[`${prefix}_Max`] > 0);
    assert.deepEqual(result.card.map((row) => row.count), groups.map((prefix) => String(chest[`${prefix}_Max`])));
    const after = f.read();
    assert.deepEqual(success(await f.post('league_rewardclaim', fields)), result);
    assert.deepEqual(f.read(), after);
    error(await f.post('league_rewardclaim', { ...fields, request_id: crypto.randomUUID() }), '4003');
    error(await f.post('league_rewardclaim', { ...fields, reward_id: 'changed' }), '4003');
    await f.restart();
    assert.deepEqual(success(await f.post('league_rewardclaim', fields)), result);
    assert.deepEqual(f.read(), after);
  }
  assert.deepEqual(success(await f.post('league_weekly')).rewards, []);
  const response = success(await f.post('league_ack', ack));
  assert.deepEqual(response, { league_id: '102', league_flag: '0' });
  assert.deepEqual(success(await f.post('league_ack', ack)), response);
  error(await f.post('league_ack', { ...ack, request_id: crypto.randomUUID() }), '4003');
  error(await f.post('league_weekly'), '4003');
  assert.equal(success(await f.post('check_lobby')).user_info.league_flag, '0');
  assert.equal(f.read().progress.totals[1000], 2, 'Actual season reward opens count as opened chests');
});

test('league settlement, claim and ack database errors roll back all grades, reward receipts and grants', async (t) => {
  const f = await progressionFixture(t);
  const { start, end } = leagueClock(t, f);
  const win = battleFields(1);
  success(await f.post('game_entryfee', win));
  success(await f.post('game_singleresult', win));
  seedLeagueMembers(f, start, 103, [1]);
  const before = f.read();
  f.db.exec(`CREATE TRIGGER reject_league_period BEFORE INSERT ON league_periods
    BEGIN SELECT RAISE(ABORT, 'Test-only settlement failure'); END`);
  t.mock.timers.setTime(end);
  const failed = await f.raw({ pg: 'check_lobby' });
  assert.equal(failed.status, 500);
  error(await failed.json(), '5000');
  assert.deepEqual(f.read(), before);
  for (const tableName of ['league_results', 'season_rewards', 'league_periods']) {
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${tableName}`).get().n, 0);
  }
  f.db.exec('DROP TRIGGER reject_league_period');
  const season = success(await f.post('league_weekly'));
  const state = f.read();
  const fields = { reward_id: season.rewards[0].reward_id, request_id: crypto.randomUUID() };
  f.db.exec(`CREATE TRIGGER reject_league_receipt BEFORE UPDATE OF response_json ON mutations
    BEGIN SELECT RAISE(ABORT, 'Test-only season receipt failure'); END`);
  const rejected = await f.raw({ pg: 'league_rewardclaim', ...fields });
  assert.equal(rejected.status, 500);
  error(await rejected.json(), '5000');
  assert.deepEqual(f.read(), state);
  assert.equal(f.db.prepare('SELECT response_json FROM season_rewards WHERE reward_id = ?')
    .get(fields.reward_id).response_json, null);
  f.db.exec('DROP TRIGGER reject_league_receipt');
  for (const reward of season.rewards) {
    success(await f.post('league_rewardclaim', { reward_id: reward.reward_id, request_id: crypto.randomUUID() }));
  }
  f.db.exec(`CREATE TRIGGER reject_league_ack BEFORE UPDATE OF acknowledged ON league_results
    BEGIN SELECT RAISE(ABORT, 'Test-only ack failure'); END`);
  const ack = { season_id: season.season_id, request_id: crypto.randomUUID() };
  const ackResponse = await f.raw({ pg: 'league_ack', ...ack });
  assert.equal(ackResponse.status, 500);
  error(await ackResponse.json(), '5000');
  assert.equal(f.db.prepare('SELECT acknowledged FROM league_results WHERE gsn = ?')
    .get(Number(f.login.data.gsn)).acknowledged, 0);
  assert.equal(f.read().user_info.league_flag, '1');
  f.db.exec('DROP TRIGGER reject_league_ack');
  success(await f.post('league_ack', ack));
});

test('zero-point participants still receive league rewards, inactive accounts do not, and ownership is enforced', async (t) => {
  const f = await progressionFixture(t);
  const { end } = leagueClock(t, f);
  const lose = battleFields(1, { win: '2' });
  success(await f.post('game_entryfee', lose));
  success(await f.post('game_singleresult', lose));
  assert.equal(success(await f.post('league_list')).pRank, '0', 'Zero-point singleton does not use promotion exception');
  const other = success(await (await f.raw(guest())).json());
  const identity = { gsn: other.gsn, sessionid: other.sessionid };
  success(await f.post('user_nickupdate', { ...identity, nickname: 'Inactive' }));
  t.mock.timers.setTime(end);
  const season = success(await f.post('league_weekly'));
  assert.equal(season.new_league_id, '103');
  assert.equal(season.rewards.length, 2);
  error(await f.post('league_weekly', identity), '4003');
  error(await f.post('league_rewardclaim', {
    ...identity, reward_id: season.rewards[0].reward_id, request_id: crypto.randomUUID(),
  }), '4003');
  error(await f.post('league_ack', { ...identity, season_id: season.season_id, request_id: crypto.randomUUID() }), '4003');
  assert.equal(success(await f.post('check_lobby', identity)).user_info.grade, '103');
  const pending = success(await (await f.raw(guest())).json());
  for (const pg of ['league_list', 'league_weekly', 'league_rewardclaim', 'league_ack']) {
    error(await f.post(pg, { gsn: pending.gsn, sessionid: pending.sessionid }), '4003');
  }
});

test('small league groups honor floor cutoffs and the top ceiling including a zero-score singleton', async (t) => {
  const f = await progressionFixture(t);
  const { start, end } = leagueClock(t, f);
  const top = seedLeagueMembers(f, start, 701, [5]);
  const zero = seedLeagueMembers(f, start, 102, [0]);
  const small = seedLeagueMembers(f, start, 101, [5, 4, 3]);
  t.mock.timers.setTime(end);
  success(await f.post('check_lobby'));
  const result = (id) => JSON.parse(f.db.prepare('SELECT data_json FROM league_results WHERE gsn = ?').get(id).data_json);
  assert.equal(result(top[0]).new_league_id, '601', 'Highest singleton cannot promote; safe count floors to zero');
  assert.equal(result(top[0]).pRank, '0');
  assert.equal(result(zero[0]).new_league_id, '103', 'Zero singleton demotes in higher leagues');
  assert.equal(result(zero[0]).dRank, '0');
  assert.deepEqual(small.map((id) => result(id).new_league_id), ['101', '101', '102']);
  assert.equal(result(small[0]).pRank, '0', 'floor(3 * 0.3) is zero, no rounding up');
  assert.equal(result(small[0]).dRank, '2');
});

test('all league/global reward chests expose exact approved card and currency ranges through claims', async (t) => {
  const f = await progressionFixture(t);
  const { start } = leagueClock(t, f);
  const ids = [...new Set([
    ...table('LeagueReward').map((row) => row.RewardChestID),
    ...table('WeeklyRankingReward').map((row) => row.ChestID),
  ])];
  const fixtures = table('Chest').filter((row) => ids.includes(row.ChestID));
  assert.equal(fixtures.length, 72);
  for (const [id, min, max] of [[307131, 40, 45], [307132, 39, 44], [307133, 39, 44], [307134, 38, 43]]) {
    const chest = fixtures.find((row) => row.ChestID === id);
    assert.equal(chest.RareCard_Min, min);
    assert.equal(chest.RareCard_Max, max);
  }
  let maximum = false;
  t.mock.method(crypto, 'randomInt', (min, max) => max === undefined ? 0 : maximum ? max - 1 : min);
  for (const [index, chest] of fixtures.entries()) {
    for (const useMax of [false, true]) {
      maximum = useMax;
      const rewardId = crypto.randomUUID();
      f.db.prepare(`INSERT INTO season_rewards (reward_id, week_start, gsn, kind, chest_id)
        VALUES (?, ?, ?, 'league', ?)`)
        .run(rewardId, start - (index * 2 + Number(useMax)) * 7 * 86400000, Number(f.login.data.gsn), chest.ChestID);
      const reward = success(await f.post('league_rewardclaim', { reward_id: rewardId, request_id: crypto.randomUUID() }));
      const suffix = useMax ? 'Max' : 'Min';
      assert.equal(reward.gold, String(chest.GetGoldRate > 0 ? chest[`Gold_${suffix}`] : 0));
      assert.equal(reward.jewel, String(chest.GetJewelRate > 0 ? chest[`Jewel_${suffix}`] : 0));
      const rarities = ['CommonCard', 'RareCard', 'EpicCard', 'LegendCard'];
      const expected = rarities.map((prefix, tier) => ({
        tier: tier + 1, count: chest[`${prefix}_Rate`] > 0 ? chest[`${prefix}_${suffix}`] : 0,
      })).filter((row) => row.count > 0);
      assert.equal(reward.card.length, expected.length);
      reward.card.forEach((card, cardIndex) => {
        const hero = table('Character').find((row) => String(row.CharacterID) === card.id);
        assert.equal(hero.Tier, expected[cardIndex].tier);
        assert.equal(hero.Type, 0);
        assert.equal(hero.ViewType, 1);
        assert.equal(card.count, String(expected[cardIndex].count));
      });
    }
  }
  assert.equal(f.read().progress.totals[1000], 144);
});

test('multiple pending seasons acknowledge oldest first without changing the current grade to a historical grade', async (t) => {
  const f = await progressionFixture(t);
  const { end } = leagueClock(t, f);
  const firstBattle = battleFields(1);
  success(await f.post('game_entryfee', firstBattle));
  success(await f.post('game_singleresult', firstBattle));
  t.mock.timers.setTime(end);
  const first = success(await f.post('league_weekly'));
  const secondBattle = battleFields(1);
  success(await f.post('game_entryfee', secondBattle));
  success(await f.post('game_singleresult', secondBattle));
  t.mock.timers.setTime(end + 7 * 86400000);
  success(await f.post('check_lobby'));
  await f.restart();
  assert.deepEqual(success(await f.post('league_weekly')), first);
  for (const [index, expectedGrade] of ['102', '101'].entries()) {
    const pending = success(await f.post('league_weekly'));
    assert.equal(pending.new_league_id, expectedGrade);
    for (const reward of pending.rewards) {
      success(await f.post('league_rewardclaim', { reward_id: reward.reward_id, request_id: crypto.randomUUID() }));
    }
    const ack = success(await f.post('league_ack', { season_id: pending.season_id, request_id: crypto.randomUUID() }));
    assert.deepEqual(ack, { league_id: '101', league_flag: index === 0 ? '1' : '0' });
  }
  error(await f.post('league_weekly'), '4003');
});

test('upgrade migration enrolls only current-week completed scores without fabricating old seasons', async (t) => {
  const f = await progressionFixture(t);
  const { start, end } = leagueClock(t, f);
  const battle = battleFields(1);
  success(await f.post('game_entryfee', battle));
  success(await f.post('game_singleresult', battle));
  f.db.exec('DELETE FROM league_members');
  f.db.prepare('INSERT INTO weekly_scores (week_start, gsn, score) VALUES (?, ?, ?)')
    .run(start - 7 * 86400000, Number(f.login.data.gsn), 50);
  await f.restart();
  const members = f.db.prepare('SELECT * FROM league_members').all();
  assert.deepEqual(members.map((row) => ({ ...row })), [{
    week_start: start, gsn: Number(f.login.data.gsn), league_id: 103,
  }]);
  t.mock.timers.setTime(end);
  const result = success(await f.post('league_weekly'));
  assert.equal(result.my_score, '5');
  assert.equal(result.new_league_id, '102');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM league_results').get().n, 1);
});

test('chests validate ownership/readiness, enforce one timer and charge exact instant-open cost', async (t) => {
  const f = await progressionFixture(t);
  const locked = f.chest(3);
  error(await f.post('chest_open', locked), '4003');
  error(await f.post('chest_open', { ...locked, nowYN: 'Y' }), '4003');
  error(await f.post('chest_open', { ...locked, nowYN: 'invalid' }), '4000');
  error(await f.post('chest_open', { ...locked, request_id: '' }), '4000');
  error(await f.post('chest_open', { ...locked, chest_id: '304002' }), '4003');
  error(await f.post('chest_open', { ...locked, slot_id: '4' }), '4003');
  error(await f.post('chest_open', { ...locked, chest_instance: crypto.randomUUID() }), '4003');
  error(await f.post('chest_open', f.chest(1)), '4003');
  error(await f.post('chest_open', f.chest(2)), '4003');
  const unlock = success(await f.post('chest_unlock', locked));
  const expires = new Date(`${unlock.completeValue.slice(0, 4)}-${unlock.completeValue.slice(4, 6)}-${unlock.completeValue.slice(6, 8)}T${unlock.completeValue.slice(8, 10)}:${unlock.completeValue.slice(10, 12)}:${unlock.completeValue.slice(12)}Z`);
  assert.ok(Math.abs(expires - Date.now() - 180 * 60000) < 2000);
  assert.deepEqual(success(await f.post('chest_unlock', locked)), unlock);
  assert.deepEqual(success(await f.post('chest_unlock', f.chest(3))), unlock);
  f.edit((state) => {
    state.chest_info[3] = {
      ...state.chest_info[3], chest_id: '304002', complete_type: '0', complete_value: '0',
    };
  });
  error(await f.post('chest_unlock', f.chest(4)), '4003');
  error(await f.post('chest_unlock', f.chest(1)), '4000');
  error(await f.post('chest_open', { ...locked, request_id: crypto.randomUUID() }), '4003');

  t.mock.method(crypto, 'randomInt', (min) => min === 10000 ? 0 : min);
  f.edit((state) => {
    state.user_info.jewel = '100';
    state.chest_info[2].complete_value = '20000101000000';
  });
  const expired = success(await f.post('chest_open', f.chest(3)));
  assert.equal(expired.curJewel, '101', 'Expired chest grants its rolled jewel without charging jewels');
  assert.equal(expired.chest_id, '0');
  assert.deepEqual(expired.chest_info, f.read().chest_info[2]);
  const paid = success(await f.post('chest_open', f.chest(4, { nowYN: 'Y' })));
  assert.equal(Number(expired.curJewel) + Number(paid.jewel) - Number(paid.curJewel), 48);
  f.edit((state) => {
    state.chest_info[3] = {
      ...state.chest_info[3], chest_id: '304001', complete_type: '1',
      complete_value: new Date(Date.now() + 25 * 60000).toISOString().slice(0, 19).replace(/[-T:]/g, ''),
      chest_instance: crypto.randomUUID(),
    };
  });
  const before = Number(f.read().user_info.jewel);
  const running = success(await f.post('chest_open', f.chest(4, { nowYN: 'Y' })));
  assert.equal(before + Number(running.jewel) - Number(running.curJewel), 3);
});

test('weighted card bundles grant released heroes, exact strings, and durable receipt replays', async (t) => {
  const f = await progressionFixture(t);
  t.mock.method(crypto, 'randomInt', (min) => min === 10000 ? 0 : min);
  f.edit((state) => { state.user_info.jewel = '100'; });
  const fields = f.chest(3, { nowYN: 'Y' });
  const result = success(await f.post('chest_open', fields));
  assert.equal(result.gold, '25');
  assert.equal(result.jewel, '1');
  assert.equal(result.curGold, '125');
  assert.equal(result.curJewel, '83', '100 - 18 instant cost + 1 rolled jewel');
  assert.equal(result.card.length, 2, 'One hero bundle per successful rarity, not one hero per card');
  assert.deepEqual(result.card.map(({ id, count, curCount }) => ({ id, count, curCount })), [
    { id: '201001', count: '3', curCount: '3' }, { id: '201004', count: '1', curCount: '1' },
  ]);
  for (const value of [result.gold, result.jewel, result.curGold, result.curJewel, result.gSeq, result.jSeq]) {
    assert.match(value, /^\d+$/);
  }
  const added = f.read().heroes.find((hero) => hero.char_id === '201004');
  assert.deepEqual(added, {
    char_id: '201004', char_lv: '1', skin_id: '0', trophy: '0',
    stone: '1', health_lv: '0', primary_lv: '0', super_lv: '0',
  });
  const after = f.read();
  assert.deepEqual(success(await f.post('chest_open', fields)), result);
  assert.deepEqual(f.read(), after);
  error(await f.post('chest_open', { ...fields, nowYN: 'N' }), '4003');
  error(await f.post('chest_unlock', fields), '4003');
  error(await f.post('chest_open', { ...fields, request_id: crypto.randomUUID() }), '4003');
  await f.restart();
  assert.deepEqual(success(await f.post('chest_open', fields)), result);
  assert.deepEqual(f.read(), after);
  f.edit((state) => {
    state.chest_info[2] = {
      ...state.chest_info[2], chest_id: '304001', complete_type: '0',
      chest_instance: crypto.randomUUID(),
    };
  });
  const reused = f.read();
  assert.deepEqual(success(await f.post('chest_open', fields)), result);
  assert.deepEqual(f.read(), reused, 'Retrying an old receipt must not consume a later chest in the same slot');
  error(await f.post('chest_open', { ...fields, request_id: crypto.randomUUID() }), '4003');
  const second = success(await f.post('chest_open', f.chest(3, { nowYN: 'Y' })));
  assert.equal(second.card[0].curCount, '6');
});

test('free/play chest renewal, empty drops, max rolls and uniform fallback exclude unavailable heroes', async (t) => {
  const f = await progressionFixture(t);
  f.edit((state) => { state.chest_info[0].complete_value = '20000101000000'; });
  const miss = t.mock.method(crypto, 'randomInt', (max) => max - 1);
  const empty = success(await f.post('chest_open', f.chest(1)));
  assert.deepEqual(empty.card, []);
  assert.equal(empty.gold, '0');
  assert.equal(empty.jewel, '0');
  assert.equal(empty.curGold, '100');
  assert.equal(empty.curJewel, '5');
  assert.equal(empty.chest_id, '301001');
  assert.equal(empty.chest_info.complete_type, '1');
  assert.ok(empty.chest_info.complete_value > new Date(Date.now() + 359 * 60000)
    .toISOString().slice(0, 19).replace(/[-T:]/g, ''));
  error(await f.post('chest_open', f.chest(1)), '4003');
  error(await f.post('chest_open', { ...f.chest(1), nowYN: 'Y' }), '4003');
  miss.mock.restore();
  f.edit((state) => { state.chest_info[1].complete_value = '10'; });
  t.mock.method(crypto, 'randomInt', (min, max) => max === undefined ? 0 : max - 1);
  const playChest = success(await f.post('chest_open', f.chest(2)));
  assert.equal(playChest.chest_id, '302001');
  assert.equal(playChest.chest_info.complete_type, '2');
  assert.equal(playChest.chest_info.complete_value, '0');
  assert.deepEqual(playChest.card.map((card) => card.count), ['3', '2']);
  assert.equal(playChest.gold, '25');
  assert.equal(playChest.jewel, '2');
  error(await f.post('chest_open', f.chest(2)), '4003');
  const heroes = table('Character').filter((row) => row.Type === 0 && row.ViewType === 1);
  for (const card of playChest.card) {
    assert.ok(heroes.some((hero) => String(hero.CharacterID) === card.id));
  }
  f.edit((state) => {
    state.chest_info[3] = {
      ...state.chest_info[3], chest_id: '304003', complete_type: '1',
      complete_value: '20000101000000',
    };
  });
  const legendary = success(await f.post('chest_open', f.chest(4)));
  assert.ok(legendary.card.some((card) => heroes.some((hero) => hero.Tier === 4
    && String(hero.CharacterID) === card.id)), 'Missing chest weights must support released legendary heroes');
});

test('hero upgrades use all tier/skill/level costs, reject stale/invalid requests, and replay after restart', async (t) => {
  const f = await progressionFixture(t);
  const fields = {
    char_id: '201001', skill_type: '0', expected_level: '0', request_id: crypto.randomUUID(),
  };
  error(await f.post('character_upgradeskill', fields), '4003', 'Starter hero has no cards');
  error(await f.post('character_upgradeskill', { ...fields, char_id: '204003' }), '4004');
  for (const invalid of [{ skill_type: '3' }, { expected_level: '8' }, { request_id: '' }]) {
    error(await f.post('character_upgradeskill', { ...fields, ...invalid }), '4000');
  }
  f.edit((state) => {
    state.user_info.gold = '9';
    state.heroes[0].stone = '2';
  });
  error(await f.post('character_upgradeskill', fields), '4003', 'Insufficient gold');
  f.edit((state) => { state.user_info.gold = '100'; });
  const first = success(await f.post('character_upgradeskill', fields));
  assert.deepEqual(first, {
    char_id: '201001', skill_type: '0', skill_value: '1',
    char_lv: '2', remain_value: '90', remain_stone: '0',
  });
  const stateAfter = f.read();
  assert.deepEqual(success(await f.post('character_upgradeskill', fields)), first);
  assert.deepEqual(f.read(), stateAfter);
  error(await f.post('character_upgradeskill', { ...fields, request_id: crypto.randomUUID() }), '4003');
  error(await f.post('character_upgradeskill', { ...fields, skill_type: '1' }), '4003');
  await f.restart();
  assert.deepEqual(success(await f.post('character_upgradeskill', fields)), first);

  const heroes = table('Character').filter((row) => row.Type === 0 && row.ViewType === 1);
  const costs = table('CharacterUpgrade');
  for (let tier = 1; tier <= 4; tier++) {
    const id = String(heroes.find((hero) => hero.Tier === tier).CharacterID);
    f.edit((state) => {
      state.user_info.gold = '1000000';
      state.heroes = [{
        ...state.heroes[0], char_id: id, char_lv: '1', stone: '100000',
        health_lv: '0', primary_lv: '0', super_lv: '0',
      }];
    });
    for (let skill = 0; skill <= 2; skill++) {
      for (let level = 0; level < 7; level++) {
        const before = f.read();
        const result = success(await f.post('character_upgradeskill', {
          char_id: id, skill_type: String(skill), expected_level: String(level), request_id: crypto.randomUUID(),
        }));
        const settings = costs.find((row) => row.Tier === tier && row.Level === level + 1);
        assert.equal(result.skill_value, String(level + 1));
        assert.equal(result.char_lv, String(1 + skill * 7 + level + 1));
        assert.equal(Number(before.user_info.gold) - Number(result.remain_value), settings.Upgrade_Gold);
        assert.equal(Number(before.heroes[0].stone) - Number(result.remain_stone), settings.Upgrade_HeroStone);
        for (const [i, key] of ['health_lv', 'primary_lv', 'super_lv'].entries()) {
          if (i !== skill) {
            assert.equal(f.read().heroes[0][key], before.heroes[0][key], 'Do not change other skills');
          }
        }
      }
      error(await f.post('character_upgradeskill', {
        char_id: id, skill_type: String(skill), expected_level: '7', request_id: crypto.randomUUID(),
      }), '4003');
    }
    assert.equal(f.read().heroes[0].char_lv, '22');
  }
});

test('chest and hero mutations roll back with receipts on a storage failure', async (t) => {
  const f = await progressionFixture(t);
  f.edit((state) => {
    state.user_info.jewel = '100';
    state.heroes[0].stone = '10';
  });
  const requests = [
    { pg: 'chest_unlock', ...f.chest(3) },
    { pg: 'chest_open', ...f.chest(3, { nowYN: 'Y' }) },
    {
      pg: 'character_upgradeskill', char_id: '201001', skill_type: '0', expected_level: '0',
      request_id: crypto.randomUUID(),
    },
  ];
  const before = f.read();
  f.db.exec(`CREATE TRIGGER reject_mutation BEFORE UPDATE OF response_json ON mutations
    BEGIN SELECT RAISE(ABORT, 'Test-only mutation receipt failure'); END`);
  for (const fields of requests) {
    const response = await f.raw(fields);
    assert.equal(response.status, 500);
    error(await response.json(), '5000');
    assert.deepEqual(f.read(), before, 'All debits, drops, timers and upgrades must roll back with the receipt');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM mutations').get().total, 0);
  }
  f.db.exec('DROP TRIGGER reject_mutation');
  for (const fields of requests) {
    success(await f.post(fields.pg, fields));
  }
});

test('instant pricing at exact ten-minute boundaries, expiry and stale instances is server-authoritative', async (t) => {
  const f = await progressionFixture(t);
  const now = Math.floor(Date.now() / 60000) * 60000;
  t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.method(crypto, 'randomInt', (min, max) => max === undefined ? min - 1 : min);
  for (const [minutes, cost] of [[30, 4], [20, 3], [10, 2], [1, 1], [0, 0], [-1, 0]]) {
    f.edit((state) => {
      state.user_info.jewel = '100';
      state.chest_info[2] = {
        ...state.chest_info[2], chest_id: '304001', complete_type: '1',
        complete_value: new Date(now + minutes * 60000).toISOString().slice(0, 19).replace(/[-T:]/g, ''),
        chest_instance: crypto.randomUUID(),
      };
    });
    const result = success(await f.post('chest_open', f.chest(3, { nowYN: 'Y', cost: '0' })));
    assert.equal(100 + Number(result.jewel) - Number(result.curJewel), cost, `${minutes} minutes`);
  }
});

test('explicit hero weights honor every cumulative boundary and missing weights are uniformly indexed', async (t) => {
  const f = await progressionFixture(t);
  const common = [
    [0, '201001'], [2999, '201001'], [3000, '201002'], [5999, '201002'],
    [6000, '201003'], [8699, '201003'], [8700, '201006'], [9499, '201006'],
    [9500, '201007'], [9999, '201007'],
  ];
  const rare = [
    [0, '201004'], [599, '201004'], [600, '202001'], [2899, '202001'],
    [2900, '202005'], [8499, '202005'], [8500, '202006'], [9999, '202006'],
  ];
  let calls;
  let index;
  const weighted = t.mock.method(crypto, 'randomInt', (min, max) => {
    if (max !== undefined) {
      return min;
    }
    const call = calls++;
    return call === 3 ? common[index][0] : call === 5 ? rare[index % rare.length][0] : 0;
  });
  for (index = 0; index < common.length; index++) {
    calls = 0;
    f.edit((state) => {
      state.user_info.jewel = '100';
      state.chest_info[2] = {
        ...state.chest_info[2], chest_id: '304001', complete_type: '0', chest_instance: crypto.randomUUID(),
      };
    });
    const result = success(await f.post('chest_open', f.chest(3, { nowYN: 'Y' })));
    assert.deepEqual(result.card.map((row) => row.id), [common[index][1], rare[index % rare.length][1]]);
  }
  weighted.mock.restore();
  const pools = [1, 2, 3, 4].map((tier) => table('Character')
    .filter((row) => row.Type === 0 && row.ViewType === 1 && row.Tier === tier));
  const uniform = t.mock.method(crypto, 'randomInt', (min, max) => {
    if (max !== undefined) {
      return max - 1;
    }
    return min === 10000 ? 0 : index % min;
  });
  for (index = 0; index < 5; index++) {
    f.edit((state) => {
      state.chest_info[3] = {
        ...state.chest_info[3], chest_id: '304003', complete_type: '1',
        complete_value: '20000101000000', chest_instance: crypto.randomUUID(),
      };
    });
    const result = success(await f.post('chest_open', f.chest(4)));
    assert.deepEqual(result.card.map((row) => row.id), pools.map((pool) => String(pool[index % pool.length].CharacterID)));
  }
  uniform.mock.restore();
});

test('drop rates have exact /10000 cutoffs; receipts and chest instances are account-scoped', async (t) => {
  const f = await progressionFixture(t);
  let roll;
  t.mock.method(crypto, 'randomInt', (min, max) => max === undefined ? (min === 10000 ? roll : 0) : max - 1);
  for (const [value, gold, jewel, cards] of [
    [99, '30', '2', 1], [100, '30', '2', 0],
    [499, '30', '2', 0], [500, '30', '0', 0],
    [9499, '30', '0', 0], [9500, '0', '0', 0],
  ]) {
    roll = value;
    f.edit((state) => { state.chest_info[0].complete_value = '20000101000000'; });
    const result = success(await f.post('chest_open', f.chest(1)));
    assert.equal(result.gold, gold);
    assert.equal(result.jewel, jewel);
    assert.equal(result.card.length, cards);
  }
  const firstRequest = f.chest(3);
  success(await f.post('chest_unlock', firstRequest));
  const other = success(await (await f.raw(guest())).json());
  const identity = { gsn: other.gsn, sessionid: other.sessionid };
  success(await f.post('user_nickupdate', { ...identity, nickname: 'OtherHero' }));
  error(await f.post('chest_unlock', { ...firstRequest, ...identity }), '4003');
  const otherLobby = success(await f.post('check_lobby', identity));
  success(await f.post('chest_unlock', {
    ...firstRequest, ...identity, chest_instance: otherLobby.chest_info[2].chest_instance,
  }));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM mutations WHERE request_id = ?')
    .get(firstRequest.request_id).total, 2, 'The same request ID belongs to separate accounts independently');
});

test('pre-chest-system account state gains stable slot identities without losing existing progress', async (t) => {
  const f = await progressionFixture(t);
  f.edit((state) => {
    for (const chest of state.chest_info) {
      delete chest.chest_instance;
    }
    state.user_info.gold = '345';
    state.user_info.jewel = '67';
    state.heroes[0].stone = '89';
    state.chest_info[2].complete_type = '1';
    state.chest_info[2].complete_value = '20990101000000';
  });
  const legacy = f.read();
  await f.restart();
  const migrated = success(await f.post('check_lobby'));
  assert.deepEqual(migrated.user_info, legacy.user_info);
  assert.deepEqual(f.read().heroes, legacy.heroes);
  assert.equal(migrated.chest_info[2].complete_value, legacy.chest_info[2].complete_value);
  for (const chest of migrated.chest_info) {
    assert.match(chest.chest_instance, /^[a-f0-9-]{36}$/);
  }
  assert.deepEqual(success(await f.post('check_lobby')).chest_info, migrated.chest_info);
  await f.restart();
  assert.deepEqual(success(await f.post('check_lobby')).chest_info, migrated.chest_info);
});

test('bot victories, loss, draw, level rewards and combined gold cap persist exact amounts', async (t) => {
  const app = await start();
  t.after(() => app.close());
  const login = await battleGuest(app);
  const initial = success(await app.post(authenticated(login, 'check_lobby')));
  const firstFields = battleFields(1, { mvp: login.data.gsn, winGold: '999999', accExp: '999999' });
  const first = await play(app, login, firstFields);
  assert.deepEqual(Object.keys(first).sort(), [
    'result', 'accExp', 'trophy', 'winGold', 'mvpGold', 'boosterGold',
    'chestReceive', 'chestGrade', 'entryFeeType', 'entryFee',
  ].sort());
  for (const value of Object.values(first)) {
    assert.equal(typeof value, 'string');
    assert.match(value, /^-?\d+$/);
  }
  assert.equal(first.accExp, '8');
  assert.equal(first.trophy, '5');
  assert.equal(first.winGold, '6');
  assert.equal(first.mvpGold, '5');
  assert.equal(first.boosterGold, '0');
  assert.equal(first.entryFee, '0');
  assert.equal(first.chestReceive, '1');
  assert.ok(['2', '3'].includes(first.chestGrade));
  const afterFirst = success(await app.post(authenticated(login, 'check_lobby')));
  assert.equal(Number(afterFirst.user_info.gold), Number(initial.user_info.gold) + 11);
  assert.equal(afterFirst.user_info.trophy_sum, '5');
  assert.equal(afterFirst.user_info.trophy_max, '5');
  assert.equal(afterFirst.user_info.win_sum, '1');
  assert.equal(afterFirst.chest_info[1].complete_value, '1');
  assert.equal(afterFirst.chest_info[3].complete_type, '0');
  const saved = JSON.stringify(afterFirst);
  const retries = await Promise.all([1, 2, 3].map(() => app.post(authenticated(
    login, 'game_singleresult', firstFields,
  ))));
  retries.forEach((response) => assert.deepEqual(success(response), first));
  assert.equal(JSON.stringify(success(await app.post(authenticated(login, 'check_lobby')))), saved);
  error(await app.post(authenticated(login, 'game_singleresult', { ...firstFields, win: '2' })), '4003');

  const second = await play(app, login, battleFields(1, { win: '2' }));
  assert.equal(second.accExp, '11');
  assert.equal(second.trophy, '-3');
  assert.equal(second.chestReceive, '0');
  const afterSecond = success(await app.post(authenticated(login, 'check_lobby')));
  assert.equal(afterSecond.user_info.level, '2');
  assert.equal(afterSecond.user_info.jewel, '7', 'Level 2 grants 2 jewels once');
  assert.equal(afterSecond.user_info.trophy_sum, '2');
  assert.equal(afterSecond.user_info.trophy_max, '5');
  const draw = await play(app, login, battleFields(2, { win: '3' }));
  assert.equal(draw.accExp, '16');
  assert.equal(draw.trophy, '0');
  assert.equal(draw.winGold, '4');
  assert.equal(draw.chestReceive, '0');
  const floor = await play(app, login, battleFields(2, { win: '2' }));
  assert.equal(floor.trophy, '-2', 'Loss cannot reduce a hero below zero trophies');
  assert.equal(success(await app.post(authenticated(login, 'check_lobby'))).user_info.trophy_sum, '0');

  let modeOneTotal = 13; // 11 for victory + 2 for loss above.
  for (let i = 0; i < 5; i++) {
    const result = await play(app, login, battleFields(1, { mvp: login.data.gsn }));
    const remaining = Math.max(0, 50 - modeOneTotal);
    assert.equal(Number(result.winGold), Math.min(6, remaining));
    assert.equal(Number(result.mvpGold), Math.min(5, Math.max(0, remaining - 6)));
    modeOneTotal += Number(result.winGold) + Number(result.mvpGold);
  }
  assert.equal(modeOneTotal, 50);
  const capped = await play(app, login, battleFields(1, { mvp: login.data.gsn }));
  assert.equal(capped.winGold, '0');
  assert.equal(capped.mvpGold, '0');
  assert.equal(capped.trophy, '5');
  assert.equal(capped.chestReceive, '-1', 'Full reward slots report rejected chest explicitly');
  assert.ok(Number(capped.chestGrade) >= 2);
  const cappedLobby = success(await app.post(authenticated(login, 'check_lobby')));
  assert.equal(cappedLobby.battle_mode[0].bonusGold, '50');
  assert.equal(cappedLobby.chest_info[1].complete_value, '10', 'Play chest counter stops at its requirement');
});

test('all Battle Royale ranks use table rewards and debit entry fees only once', async (t) => {
  for (let rank = 1; rank <= 8; rank++) {
    const f = await progressionFixture(t);
    f.edit((state) => { state.user_info.jewel = '5'; });
    const fields = battleFields(3, { battle_rank: String(rank), win: '0' });
    const entry = success(await f.post('game_entryfee', fields));
    assert.equal(entry.curMoneyType, '6');
    assert.equal(entry.curMoney, '4');
    assert.deepEqual(success(await f.post('game_entryfee', fields)), entry);
    const before = success(await f.post('check_lobby'));
    assert.equal(before.user_info.jewel, '4');
    const reward = table('IngameReward').find((row) => row.IngameModeID === 3 && row.IngameResult === rank);
    const result = success(await f.post('game_singleresult', fields));
    assert.equal(result.accExp, String(reward.GetExp));
    assert.equal(result.trophy, String(Math.max(0, reward.GetTrophy)));
    assert.equal(result.winGold, String(reward.GetBonusGold));
    assert.equal(result.mvpGold, '0');
    assert.equal(result.entryFee, String(reward.GetEntryFee));
    assert.equal(result.entryFeeType, '6');
    if (rank <= 2) {
      assert.equal(result.chestReceive, '1');
    } else if (rank > 3) {
      assert.equal(result.chestReceive, '0');
    }
    const after = success(await f.post('check_lobby'));
    assert.equal(after.user_info.jewel, String(4 + reward.GetEntryFee));
    assert.equal(after.user_info.gold, String(100 + reward.GetBonusGold));
    assert.equal(after.user_info.win_sum, rank === 1 ? '1' : '0');
    assert.deepEqual(success(await f.post('game_singleresult', fields)), result);
    error(await f.post('game_entryfee', fields), '4003');
  }
  const broke = await progressionFixture(t);
  broke.edit((state) => { state.user_info.jewel = '0'; });
  error(await broke.post('game_entryfee', battleFields(3)), '4003');
  broke.edit((state) => { state.user_info.jewel = '5'; });
  for (let i = 0; i < 5; i++) {
    success(await broke.post('game_entryfee', battleFields(3)));
  }
  error(await broke.post('game_entryfee', battleFields(3)), '4003');
  assert.equal(success(await broke.post('check_lobby')).user_info.jewel, '0');
});

test('battle result rejects unregistered, altered, unowned and multiplayer claims', async (t) => {
  const app = await start();
  t.after(() => app.close());
  const login = await battleGuest(app);
  const other = await battleGuest(app);
  const fields = battleFields();
  const before = success(await app.post(authenticated(login, 'check_lobby')));
  error(await app.post(authenticated(login, 'game_singleresult', fields)), '4003');
  error(await app.post(authenticated(login, 'game_entryfee', { ...fields, play_char_id: '999999' })), '4004');
  for (const extra of [{ mode: '4' }, { mode: 'NaN' }, { map_idx: '3' }, { map_idx: '-1' }]) {
    error(await app.post(authenticated(login, 'game_entryfee', { ...fields, ...extra })), '4000');
  }
  success(await app.post(authenticated(login, 'game_entryfee', fields)));
  error(await app.post(authenticated(login, 'game_entryfee', { ...fields, mode: '2' })), '4003');
  for (const extra of [{ win: '0' }, { win: '4' }, { battle_rank: '1' }, { entry_user_cnt: '2' }]) {
    error(await app.post(authenticated(login, 'game_singleresult', { ...fields, ...extra })), '4000');
  }
  for (const extra of [{ mode: '2' }, { map_idx: '1' }, { play_char_id: '201002' }]) {
    error(await app.post(authenticated(login, 'game_singleresult', { ...fields, ...extra })), '4003');
  }
  error(await app.post(authenticated(other, 'game_singleresult', fields)), '4003');
  assert.deepEqual(success(await app.post(authenticated(login, 'check_lobby'))), before);
  const unfinished = await app.post(guest());
  error(await app.post(authenticated(unfinished, 'game_entryfee', battleFields())), '4003');
});

test('chest probability cutoffs follow the exact table weights', async (t) => {
  const app = await start();
  t.after(() => app.close());
  let roll = 0;
  t.mock.method(crypto, 'randomInt', (maximum) => {
    assert.equal(maximum, 10000);
    return roll;
  });
  for (const mode of [1, 2]) {
    for (const value of [0, 8999, 9000, 9999]) {
      const login = await battleGuest(app);
      roll = value;
      const result = await play(app, login, battleFields(mode));
      assert.equal(result.chestReceive, '1');
      assert.equal(result.chestGrade, value < 9000 ? '2' : '3');
      const lobby = success(await app.post(authenticated(login, 'check_lobby')));
      assert.equal(lobby.chest_info[3].chest_id, value < 9000 ? '304001' : '304002');
    }
    for (const win of ['2', '3']) {
      const login = await battleGuest(app);
      roll = 0;
      const result = await play(app, login, battleFields(mode, { win }));
      const row = table('IngameReward').find((reward) => reward.IngameModeID === mode
        && reward.IngameResult === Number(win));
      assert.equal(result.accExp, String(row.GetExp));
      assert.equal(result.winGold, String(row.GetBonusGold));
      assert.equal(result.chestReceive, '0');
      assert.equal(result.chestGrade, '0');
    }
  }
  for (const value of [9499, 9500]) {
    const f = await progressionFixture(t);
    f.edit((state) => { state.user_info.jewel = '5'; });
    roll = value;
    const fields = battleFields(3);
    success(await f.post('game_entryfee', fields));
    const result = success(await f.post('game_singleresult', fields));
    assert.equal(result.chestGrade, value < 9500 ? '2' : '3');
  }
  for (const value of [4999, 5000]) {
    const f = await progressionFixture(t);
    f.edit((state) => { state.user_info.jewel = '5'; });
    roll = value;
    const fields = battleFields(3, { battle_rank: '3' });
    success(await f.post('game_entryfee', fields));
    const result = success(await f.post('game_singleresult', fields));
    assert.equal(result.chestReceive, value < 5000 ? '1' : '0');
    assert.equal(result.chestGrade, value < 5000 ? '2' : '0');
  }
});

test('battle entry and results are atomic and replay-safe across SQLite reopen', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-pocket-battles-'));
  const databasePath = path.join(directory, 'game.sqlite');
  let app = await start(databasePath);
  const db = new DatabaseSync(databasePath);
  t.after(async () => {
    db.close();
    await app.close();
    fs.rmSync(directory, { recursive: true });
  });
  const login = await battleGuest(app);
  const funded = JSON.parse(db.prepare('SELECT state_json FROM accounts WHERE gsn = ?').get(Number(login.data.gsn)).state_json);
  funded.user_info.jewel = '5';
  db.prepare('UPDATE accounts SET state_json = ? WHERE gsn = ?').run(JSON.stringify(funded), Number(login.data.gsn));
  const fields = battleFields(3);
  const before = success(await app.post(authenticated(login, 'check_lobby')));
  db.exec(`CREATE TRIGGER reject_battle_entry BEFORE INSERT ON battles
    BEGIN SELECT RAISE(ABORT, 'Test-only entry failure'); END`);
  async function expectDatabaseFailure(pg) {
    const response = await fetch(`${app.baseUrl}/mph`, {
      method: 'POST', body: new URLSearchParams(authenticated(login, pg, fields)),
    });
    assert.equal(response.status, 500);
    error(await response.json(), '5000');
  }
  await expectDatabaseFailure('game_entryfee');
  assert.deepEqual(success(await app.post(authenticated(login, 'check_lobby'))), before);
  db.exec('DROP TRIGGER reject_battle_entry');
  const entry = success(await app.post(authenticated(login, 'game_entryfee', fields)));
  const afterEntry = success(await app.post(authenticated(login, 'check_lobby')));
  db.exec(`CREATE TRIGGER reject_battle_result BEFORE UPDATE OF result_json ON battles
    BEGIN SELECT RAISE(ABORT, 'Test-only result failure'); END`);
  await expectDatabaseFailure('game_singleresult');
  assert.deepEqual(success(await app.post(authenticated(login, 'check_lobby'))), afterEntry);
  assert.equal(db.prepare('SELECT result_json FROM battles').get().result_json, null);
  db.exec('DROP TRIGGER reject_battle_result');
  await app.close();
  app = await start(databasePath);
  assert.deepEqual(success(await app.post(authenticated(login, 'game_entryfee', fields))), entry);
  const result = success(await app.post(authenticated(login, 'game_singleresult', fields)));
  const afterResult = success(await app.post(authenticated(login, 'check_lobby')));
  await app.close();
  app = await start(databasePath);
  assert.deepEqual(success(await app.post(authenticated(login, 'game_singleresult', fields))), result);
  assert.deepEqual(success(await app.post(authenticated(login, 'check_lobby'))), afterResult);

  const state = JSON.parse(db.prepare('SELECT state_json FROM accounts').get().state_json);
  state.user_info.exp = '49989';
  state.user_info.level = '99';
  state.battle_mode[0].bonusGold = '50';
  state.battle_mode[0].init_time = '20000101000000';
  db.prepare('UPDATE accounts SET state_json = ?').run(JSON.stringify(state));
  const maxed = await play(app, login, battleFields(1));
  assert.equal(maxed.accExp, '49990');
  assert.equal(maxed.winGold, '6', 'Expired mode budget refreshes even without a lobby request');
  const atMax = success(await app.post(authenticated(login, 'check_lobby')));
  assert.equal(atMax.user_info.level, '100');
  assert.equal(Number(atMax.user_info.jewel), Number(afterResult.user_info.jewel) + 2, 'Reaching maximum level grants 2 jewels once');
  await play(app, login, battleFields(1));
  const stillMax = success(await app.post(authenticated(login, 'check_lobby')));
  assert.equal(stillMax.user_info.exp, '49990');
  assert.equal(stillMax.user_info.jewel, atMax.user_info.jewel, 'Max-level reward cannot be granted twice');
});
