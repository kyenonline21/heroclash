const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createMonetization } = require('./monetization.cjs');

class ApiError extends Error {
  constructor(code, message, status = 200) {
    super(message);
    this.code = String(code);
    this.status = status;
  }
}

function utcTime(date) {
  return date.toISOString().slice(0, 19).replace(/[-T:]/g, '');
}

function parseUtcTime(value) {
  if (!/^\d{14}$/.test(value)) {
    throw new Error(`Invalid saved UTC timestamp: ${value}`);
  }
  return Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)), Number(value.slice(8, 10)),
    Number(value.slice(10, 12)), Number(value.slice(12, 14)));
}

function rankingWeek(now) {
  const offset = 7 * 60 * 60 * 1000;
  const local = new Date(now + offset);
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()
    - (local.getUTCDay() + 6) % 7) - offset;
  return { start, end: start + 7 * 24 * 60 * 60 * 1000 };
}

function nextModeReset(mode, now) {
  const criteria = String(mode.CriteriaTime);
  const interval = mode.BonusGoldResetTerm * 60 * 60 * 1000;
  if (!/^\d{6}$/.test(criteria) || !Number.isSafeInteger(interval) || interval <= 0) {
    throw new Error(`Invalid reset settings for mode ${mode.ModeID}`);
  }
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    Number(criteria.slice(0, 2)), Number(criteria.slice(2, 4)), Number(criteria.slice(4, 6)));
  const periods = Math.floor((now.getTime() - start) / interval) + 1;
  return utcTime(new Date(start + periods * interval));
}

async function readForm(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 65536) {
      throw new ApiError(4000, 'Form exceeds the 64 KiB limit.', 413);
    }
    chunks.push(chunk);
  }
  const contentType = request.headers['content-type'] || '';
  if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)(;|$)/i.test(contentType)) {
    throw new ApiError(4000, 'Expected URL-encoded or multipart form fields.', 415);
  }
  let form;
  try {
    form = await new Request('http://localhost/mph', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: Buffer.concat(chunks),
    }).formData();
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    throw new ApiError(4000, 'Malformed form data.', 400);
  }
  const fields = Object.create(null);
  for (const [key, value] of form) {
    if (typeof value !== 'string' || Object.hasOwn(fields, key)) {
      throw new ApiError(4000, 'File uploads and duplicate fields are not supported.', 400);
    }
    fields[key] = value;
  }
  return fields;
}

function required(fields, key, maxLength = 128) {
  const value = fields[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new ApiError(4000, `Missing or invalid ${key}.`);
  }
  return value;
}

function integer(fields, key, min, max) {
  const value = required(fields, key);
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new ApiError(4000, `Invalid ${key}; expected an integer from ${min} to ${max}.`);
  }
  return number;
}

function createGameApi({ tables, databasePath, monetizationConfig, store, amazonStore, callbackSecret }) {
  const common = tables.get('CommonTable')[0];
  const characters = tables.get('CharacterTable');
  const modes = tables.get('BattleModeTable');
  const chests = tables.get('ChestTable');
  const characterRates = tables.get('ChestCharacterRateTable');
  const upgrades = tables.get('CharacterUpgradeTable');
  const quests = tables.get('QuestTable').filter((row) => row.Active === 1 && [1, 2].includes(row.Category));
  const questRewards = tables.get('QuestRewardTable');
  const progressTypes = new Set([100, 200, 300, 400, 1000, 1200, 210, 310, 600, 610, 620, 630, 700, 710, 720, 900, 910]);
  for (const quest of quests) {
    const rewards = questRewards.filter((row) => row.QuestRewardID === quest.QuestRewardID);
    if (!progressTypes.has(quest.QuestType) || !Number.isSafeInteger(quest.QuestCount) || quest.QuestCount < 1
      || rewards.length === 0 || rewards.some((row) => ![5, 6].includes(row.ItemType)
        || !Number.isSafeInteger(row.ItemCount) || row.ItemCount < 0)) {
      throw new Error(`Unsupported quest or reward: ${quest.QuestID}/${quest.QuestStep}`);
    }
  }
  const products = tables.get('ShopTable');
  const leagues = tables.get('LeagueTable');
  const leagueRewards = tables.get('LeagueRewardTable');
  const weeklyRewards = tables.get('WeeklyRankingRewardTable');
  for (const row of leagues) {
    if (![row.PromoteRank, row.DemoteRank].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 10000)
      || !leagues.some((target) => target.LeagueID === row.PromoteLeagueID)
      || !leagues.some((target) => target.LeagueID === row.DemoteLeagueID)) {
      throw new Error(`Invalid league thresholds or target: ${row.LeagueID}`);
    }
  }
  const shopProducts = products.filter((row) => row.IsActive === 1 && row.StoreType === 0
    && [2, 3, 5, 6].includes(row.Category));
  const cardGroups = ['CommonCard', 'RareCard', 'EpicCard', 'LegendCard'];
  const eligibleCharacters = characters.filter((row) => row.Type === 0 && row.ViewType === 1
    && row.Tier >= 1 && row.Tier <= 4);
  function cardPool(chestId, tier) {
    const specified = characterRates.filter((row) => row.ChestID === chestId);
    return eligibleCharacters.filter((row) => row.Tier === tier).map((hero) => ({
      id: hero.CharacterID,
      weight: specified.length === 0 ? 1 : specified
        .filter((row) => row.CharacterID === hero.CharacterID).reduce((sum, row) => sum + row.DropRate, 0),
    })).filter((row) => row.weight > 0);
  }
  for (const row of shopProducts) {
    if (!Number.isSafeInteger(row.Price) || row.Price < 0
      || !Number.isSafeInteger(row.ItemCount) || row.ItemCount < 0
      || row.MoneyType !== (row.Category === 2 ? 3 : 2)
      || row.ItemType !== ({ 2: 2, 3: 3, 5: 5, 6: 0 })[row.Category]
      || (row.Category !== 6 && row.ItemCount === 0)
      || (row.Category === 3 && (row.ItemCount !== 1 || !chests.some((chest) => chest.ChestID === row.ItemID)))) {
      throw new Error(`Unsupported shop product settings: ${row.ProductID}`);
    }
  }
  const dailyProducts = shopProducts.filter((row) => row.Category === 2
    && eligibleCharacters.some((hero) => hero.CharacterID === row.ItemID));
  for (let tier = 1; tier <= 4; tier++) {
    const count = dailyProducts.filter((row) => characters.find((hero) => hero.CharacterID === row.ItemID).Tier === tier).length;
    if (count < (tier === 1 ? 3 : tier === 2 ? 2 : 1)) {
      throw new Error(`Insufficient daily shop products for tier ${tier}`);
    }
  }
  for (const row of [...leagueRewards, ...weeklyRewards]) {
    if (!Number.isSafeInteger(row.MinRank) || row.MinRank < 1
      || !Number.isSafeInteger(row.MaxRank) || (row.MaxRank !== 0 && row.MaxRank < row.MinRank)
      || !chests.some((chest) => chest.ChestID === (row.RewardChestID ?? row.ChestID))) {
      throw new Error('Invalid league/weekly reward rank range or chest.');
    }
  }
  const rewardChestIds = new Set([303004, ...shopProducts.filter((row) => row.Category === 3).map((row) => row.ItemID),
    ...leagueRewards.map((row) => row.RewardChestID), ...weeklyRewards.map((row) => row.ChestID)]);
  if (!chests.some((row) => row.ChestID === 303004)) {
    throw new Error('Missing free shop chest 303004.');
  }
  for (const chest of chests.filter((row) => [1, 2, 4].includes(row.ChestType) || rewardChestIds.has(row.ChestID))) {
    const groups = [...cardGroups.map((name) => ({
      min: chest[`${name}_Min`], max: chest[`${name}_Max`], rate: chest[`${name}_Rate`],
    })), { min: chest.Gold_Min, max: chest.Gold_Max, rate: chest.GetGoldRate },
    { min: chest.Jewel_Min, max: chest.Jewel_Max, rate: chest.GetJewelRate }];
    if (!Number.isSafeInteger(chest.OpenTime) || chest.OpenTime < 0
      || groups.some(({ min, max, rate }) => !Number.isSafeInteger(min) || min < 0
        || !Number.isSafeInteger(max) || max < min || max >= 2147483647
        || !Number.isSafeInteger(rate) || rate < 0 || rate > 10000)) {
      throw new Error(`Invalid chest ranges or rates: ${chest.ChestID}`);
    }
    for (let tier = 1; tier <= 4; tier++) {
      const group = groups[tier - 1];
      if (group.rate > 0 && group.max > 0 && cardPool(chest.ChestID, tier).length === 0) {
        throw new Error(`No eligible hero weights for chest ${chest.ChestID}, tier ${tier}`);
      }
    }
  }
  for (const row of characterRates) {
    if (!Number.isSafeInteger(row.DropRate) || row.DropRate < 0) {
      throw new Error(`Invalid character drop weight at sequence ${row.Seq}`);
    }
  }
  const rewards = tables.get('IngameRewardTable');
  const levels = [...tables.get('UserLevelTable')].sort((a, b) => a.UserLevel - b.UserLevel);
  for (const row of rewards.filter((reward) => reward.IngameModeID <= 3)) {
    let totalRate = 0;
    for (let i = 1; i <= 3; i++) {
      const rate = row[`GetChestRate_${i}`];
      const chestId = row[`GetChestID_${i}`];
      if (!Number.isSafeInteger(rate) || rate < 0 || rate > 10000
        || (rate > 0 && !chests.some((chest) => chest.ChestID === chestId))) {
        throw new Error(`Invalid chest reward in row ${row.IngameRewardID}`);
      }
      totalRate += rate;
    }
    if (totalRate > 10000) {
      throw new Error(`Chest probabilities exceed 10000 in row ${row.IngameRewardID}`);
    }
  }
  for (const row of levels) {
    for (let i = 1; i <= 2; i++) {
      const type = row[`LevelUpReward${i}Type`];
      if (![0, 5, 6].includes(type)) {
        throw new Error(`Unsupported level-up reward type ${type} at level ${row.UserLevel}`);
      }
    }
  }
  const starterHeroes = [common.TutoReward_Char_1, common.TutoReward_Char_2];
  const league = [...tables.get('LeagueTable')].sort((a, b) => a.LeagueOrder - b.LeagueOrder)[0];
  const freeChest = chests.find((row) => row.ChestType === 1);
  const playChest = chests.find((row) => row.ChestType === 2);
  const tutorialChest = chests.find((row) => row.ChestType === 4 && row.ChestGrade === 2);
  if (!league || !freeChest || !playChest || !tutorialChest
    || starterHeroes.some((id) => !characters.some((row) => row.CharacterID === id && row.Type === 0))) {
    throw new Error('Tables do not contain the required tutorial heroes, league or chests.');
  }
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS accounts (
      gsn INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL UNIQUE,
      tutorial_completed INTEGER NOT NULL DEFAULT 0,
      state_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      gsn INTEGER NOT NULL REFERENCES accounts(gsn),
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS battles (
      gsn INTEGER NOT NULL REFERENCES accounts(gsn),
      room_id TEXT NOT NULL,
      entry_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      result_request TEXT,
      result_json TEXT,
      PRIMARY KEY (gsn, room_id)
    );
    CREATE TABLE IF NOT EXISTS mutations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      gsn INTEGER NOT NULL REFERENCES accounts(gsn),
      request_id TEXT NOT NULL,
      pg TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      response_json TEXT,
      UNIQUE (gsn, request_id)
    );
    CREATE TABLE IF NOT EXISTS weekly_scores (
      week_start INTEGER NOT NULL,
      gsn INTEGER NOT NULL REFERENCES accounts(gsn),
      score INTEGER NOT NULL CHECK (score >= 0),
      PRIMARY KEY (week_start, gsn)
    );
    CREATE TABLE IF NOT EXISTS league_members (
      week_start INTEGER NOT NULL,
      gsn INTEGER NOT NULL REFERENCES accounts(gsn),
      league_id INTEGER NOT NULL,
      PRIMARY KEY (week_start, gsn)
    );
    CREATE TABLE IF NOT EXISTS league_periods (
      week_start INTEGER PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS league_results (
      week_start INTEGER NOT NULL,
      gsn INTEGER NOT NULL REFERENCES accounts(gsn),
      data_json TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (week_start, gsn)
    );
    CREATE TABLE IF NOT EXISTS season_rewards (
      reward_id TEXT PRIMARY KEY,
      week_start INTEGER NOT NULL,
      gsn INTEGER NOT NULL REFERENCES accounts(gsn),
      kind TEXT NOT NULL,
      chest_id INTEGER NOT NULL,
      response_json TEXT,
      UNIQUE (week_start, gsn, kind)
    );
    CREATE TABLE IF NOT EXISTS mailbox (
      post_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      gsn INTEGER NOT NULL REFERENCES accounts(gsn),
      delivery_key TEXT NOT NULL,
      title TEXT NOT NULL,
      contents TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      attachments_json TEXT NOT NULL,
      read_at INTEGER,
      claimed_at INTEGER,
      deleted_at INTEGER,
      UNIQUE (gsn, delivery_key)
    );
    CREATE INDEX IF NOT EXISTS mailbox_owner ON mailbox (gsn, post_seq);
  `);
  // Current-week scores were only created on accepted battle results.
  db.prepare(`
    INSERT OR IGNORE INTO league_members (week_start, gsn, league_id)
    SELECT w.week_start, a.gsn, CAST(json_extract(a.state_json, '$.user_info.grade') AS INTEGER)
    FROM weekly_scores w JOIN accounts a ON a.gsn = w.gsn
    WHERE w.week_start = ? AND a.tutorial_completed = 1
  `).run(rankingWeek(Date.now()).start);

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function newState(now) {
    return {
      user_info: {
        nickname: 'Player',
        rep_hero: String(starterHeroes[0]),
        grade: String(league.LeagueID),
        level: '1',
        gold: '0',
        jewel: '0',
        exp: '0',
        post_cnt: '0',
        trophy_max: '0',
        trophy_sum: '0',
        win_sum: '0',
        achievement_cnt: '0',
        quest_cnt: '0',
        league_flag: '0',
      },
      heroes: starterHeroes.map((id) => ({
        char_id: String(id), char_lv: '1', skin_id: '0', trophy: '0',
        stone: '0', health_lv: '0', primary_lv: '0', super_lv: '0',
      })),
      chest_info: [
        {
          slot_id: '1', chest_id: String(freeChest.ChestID), complete_type: '1',
          complete_value: utcTime(new Date(now.getTime() + freeChest.OpenTime * 60000)),
          chest_instance: crypto.randomUUID(),
        },
        {
          slot_id: '2', chest_id: String(playChest.ChestID),
          complete_type: '2', complete_value: '0', chest_instance: crypto.randomUUID(),
        },
        ...[3, 4, 5, 6].map((id) => ({
          slot_id: String(id), chest_id: '0', complete_type: '0', complete_value: '0',
          chest_instance: crypto.randomUUID(),
        })),
      ],
      battle_mode: modes.map((mode) => ({
        modeId: String(mode.ModeID), bonusGold: '0', init_time: nextModeReset(mode, now),
      })),
      purchase: [],
    };
  }

  function saveState(gsn, state) {
    refreshProgress(state);
    updateProgressNotifications(state);
    state.user_info.post_cnt = String(mailCount(gsn));
    db.prepare('UPDATE accounts SET state_json = ? WHERE gsn = ?')
      .run(JSON.stringify(state), gsn);
  }

  function refreshProgress(state) {
    const day = new Date().toISOString().slice(0, 10);
    if (!state.progress) {
      state.progress = {
        day, daily: {}, totals: {
          710: state.heroes.reduce((sum, hero) => sum + Number(hero.health_lv)
            + Number(hero.primary_lv) + Number(hero.super_lv), 0),
        }, claimed: [], achievements: {}, last_login: '', streak: 0,
      };
    }
    const p = state.progress;
    if (p.day !== day) {
      p.day = day;
      p.daily = {};
      p.claimed = [];
    }
    if (p.last_login !== day) {
      const yesterday = new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      p.streak = p.last_login === yesterday ? p.streak + 1 : 1;
      p.last_login = day;
    }
    p.daily[100] = 1;
  }

  function addProgress(state, type, amount = 1) {
    refreshProgress(state);
    for (const counters of [state.progress.daily, state.progress.totals]) {
      counters[type] = Math.min(2147483647, (counters[type] || 0) + amount);
    }
  }

  function progressCount(state, quest) {
    const p = state.progress;
    if (quest.Category === 1) {
      return p.daily[quest.QuestType] || 0;
    }
    switch (quest.QuestType) {
      case 100: return p.streak;
      case 700: return state.heroes.length;
      case 720: return state.heroes.filter((hero) => Number(hero.trophy) >= 100).length;
      default: return p.totals[quest.QuestType] || 0;
    }
  }

  function questList(state, category) {
    const result = [];
    const ids = [...new Set(quests.filter((row) => row.Category === category).map((row) => row.QuestID))];
    for (const id of ids) {
      const steps = quests.filter((row) => row.Category === category && row.QuestID === id)
        .sort((a, b) => a.QuestStep - b.QuestStep);
      const claimedStep = state.progress.achievements[id] || 0;
      const row = category === 1 ? steps[0]
        : steps.find((step) => step.QuestStep > claimedStep) || steps.at(-1);
      const claimed = category === 1 ? state.progress.claimed.includes(id) : claimedStep >= row.QuestStep;
      const count = progressCount(state, row);
      result.push({
        id: String(id), progressCnt: String(count), status: claimed ? '2' : count >= row.QuestCount ? '1' : '0',
        ...(category === 2 ? { step: String(row.QuestStep) } : {}),
      });
    }
    return result;
  }

  function updateProgressNotifications(state) {
    state.user_info.quest_cnt = String(questList(state, 1).filter((row) => row.status === '1').length);
    state.user_info.achievement_cnt = String(questList(state, 2).filter((row) => row.status === '1').length);
  }

  function progressClaim(fields, account, state, category) {
    const id = integer(fields, 'id', 1, 2147483647);
    return mutation(fields, account, state, ['id', category === 1 ? 'quest_day' : 'expected_step'], () => {
      refreshProgress(state);
      const current = questList(state, category).find((row) => row.id === String(id));
      if (!current) {
        throw new ApiError(4004, 'Quest or achievement is inactive or does not exist.');
      }
      if ((category === 1 && fields.quest_day !== state.progress.day)
        || (category === 2 && fields.expected_step !== current.step)) {
        throw new ApiError(4003, 'Quest day or achievement step changed. Reopen the quest window.');
      }
      if (current.status !== '1') {
        throw new ApiError(4003, 'Objective is not complete or its reward was already claimed.');
      }
      const quest = quests.find((row) => row.QuestID === id && row.Category === category
        && (category === 1 || String(row.QuestStep) === current.step));
      const rewards = questRewards.filter((row) => row.QuestRewardID === quest.QuestRewardID);
      for (const reward of rewards) {
        const key = reward.ItemType === 5 ? 'gold' : 'jewel';
        state.user_info[key] = String(Number(state.user_info[key]) + reward.ItemCount);
      }
      if (category === 1) {
        state.progress.claimed.push(id);
        addProgress(state, 1200);
      } else {
        state.progress.achievements[id] = Number(current.step);
      }
      updateProgressNotifications(state);
      const next = questList(state, category).find((row) => row.id === String(id));
      return {
        curMoneyType: String(rewards[0].ItemType),
        curMoney: state.user_info[rewards[0].ItemType === 5 ? 'gold' : 'jewel'],
        curGold: state.user_info.gold, curJewel: state.user_info.jewel,
        status: next.status, curStep: next.step || '0', progressCnt: next.progressCnt,
        quest_cnt: state.user_info.quest_cnt, achievement_cnt: state.user_info.achievement_cnt,
        quests: questList(state, 1), achievements: questList(state, 2),
        quest_day: state.progress.day,
        next_reset: utcTime(new Date(Date.parse(`${state.progress.day}T00:00:00Z`) + 86400000)),
      };
    });
  }

  function mutation(fields, account, state, keys, action) {
    const requestId = required(fields, 'request_id');
    const fingerprint = JSON.stringify(keys.map((key) => [key, required(fields, key)]));
    return transaction(() => {
      const existing = db.prepare('SELECT * FROM mutations WHERE gsn = ? AND request_id = ?')
        .get(account.gsn, requestId);
      if (existing) {
        if (existing.pg !== fields.pg || existing.fingerprint !== fingerprint) {
          throw new ApiError(4003, 'Request ID has already been used with different parameters.');
        }
        return JSON.parse(existing.response_json);
      }
      const inserted = db.prepare('INSERT INTO mutations (gsn, request_id, pg, fingerprint) VALUES (?, ?, ?, ?)')
        .run(account.gsn, requestId, fields.pg, fingerprint);
      refreshProgress(state);
      const response = action(String(inserted.lastInsertRowid));
      saveState(account.gsn, state);
      db.prepare('UPDATE mutations SET response_json = ? WHERE seq = ?')
        .run(JSON.stringify(response), inserted.lastInsertRowid);
      return response;
    });
  }

  function mailCount(gsn, now = Date.now()) {
    return db.prepare(`SELECT COUNT(*) AS count FROM mailbox WHERE gsn = ?
      AND expires_at > ? AND deleted_at IS NULL AND claimed_at IS NULL`).get(gsn, now).count;
  }

  function deliverWelcome(gsn, now) {
    db.prepare(`INSERT INTO mailbox
      (gsn, delivery_key, title, contents, sent_at, expires_at, attachments_json)
      SELECT ?, 'welcome-v1', ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM mailbox WHERE gsn = ? AND delivery_key = 'welcome-v1')`)
      .run(gsn, 'Welcome to Hero Pocket!',
        'Welcome to Hero Pocket! Thank you for joining us. Please claim your gift within 7 days.',
        now, now + 7 * 86400000, JSON.stringify([
          { item_type: '5', item_id: '0', item_cnt: '100' },
          { item_type: '3', item_id: '304001', item_cnt: '1' },
        ]), gsn);
  }

  function mailAttachments(row) {
    const items = JSON.parse(row.attachments_json);
    if (!Array.isArray(items) || items.length > 3
      || items.some((item) => !item || typeof item.item_type !== 'string'
        || typeof item.item_id !== 'string' || typeof item.item_cnt !== 'string')
      || items.filter((item) => item.item_type === '3').length > 1
      || items.some((item) => !['2', '3', '5'].includes(item.item_type)
        || !/^\d+$/.test(item.item_cnt) || !Number.isSafeInteger(Number(item.item_cnt))
        || Number(item.item_cnt) < 1 || !/^\d+$/.test(item.item_id)
        || (item.item_type === '5' && item.item_id !== '0')
        || (item.item_type === '2' && (Number(item.item_cnt) > 2147483647
          || !eligibleCharacters.some((hero) => String(hero.CharacterID) === item.item_id)))
        || (item.item_type === '3' && (item.item_cnt !== '1'
          || !chests.some((chest) => String(chest.ChestID) === item.item_id
            && ([1, 2, 4].includes(chest.ChestType) || rewardChestIds.has(chest.ChestID))))))) {
      throw new Error(`Invalid mailbox attachments for post ${row.post_seq}`);
    }
    return items;
  }

  function ownedMail(fields, account, now) {
    const id = integer(fields, 'post_seq', 1, 2147483647);
    const row = db.prepare(`SELECT * FROM mailbox WHERE post_seq = ? AND gsn = ?
      AND expires_at > ? AND deleted_at IS NULL AND claimed_at IS NULL`).get(id, account.gsn, now);
    if (!row) {
      throw new ApiError(4003, 'Mail expired, was removed or is not owned by this account.');
    }
    return row;
  }

  function mailList(fields, account, now) {
    const page = integer(fields, 'cur_page', 1, 2147483647);
    const size = integer(fields, 'list_item_cnt', 1, 100);
    const total = String(mailCount(account.gsn, now));
    const rows = db.prepare(`SELECT * FROM mailbox WHERE gsn = ? AND expires_at > ?
      AND deleted_at IS NULL AND claimed_at IS NULL ORDER BY post_seq DESC LIMIT ? OFFSET ?`)
      .all(account.gsn, now, size, (page - 1) * size);
    return {
      total_cnt: total, post_cnt: total,
      post: rows.map((row) => ({
        post_seq: String(row.post_seq), locale_id: '0', title: row.title, contents: row.contents,
        send_date: utcTime(new Date(row.sent_at)), expire_date: utcTime(new Date(row.expires_at)),
        state: row.read_at === null ? '0' : '1', attachlist: mailAttachments(row),
      })),
    };
  }

  function mailMutation(fields, account, state, now) {
    return mutation(fields, account, state, ['post_seq'], (seq) => {
      const row = ownedMail(fields, account, now);
      const items = mailAttachments(row);
      if (fields.pg === 'post_read') {
        db.prepare('UPDATE mailbox SET read_at = COALESCE(read_at, ?) WHERE post_seq = ?').run(now, row.post_seq);
        return { state: '1', post_cnt: String(mailCount(account.gsn, now)) };
      }
      if (fields.pg === 'post_postdelete') {
        if (items.length > 0) {
          throw new ApiError(4003, 'Claim the attached gifts before deleting this mail.');
        }
        db.prepare('UPDATE mailbox SET deleted_at = ? WHERE post_seq = ?').run(now, row.post_seq);
        return { post_cnt: String(mailCount(account.gsn, now)) };
      }
      if (items.length === 0) {
        throw new ApiError(4003, 'This mail has no attached gifts.');
      }
      const received = items.map((item) => {
        if (item.item_type === '5') {
          state.user_info.gold = String(Number(state.user_info.gold) + Number(item.item_cnt));
        } else if (item.item_type === '2') {
          grantHeroCards(state, Number(item.item_id), Number(item.item_cnt));
        }
        return { ...item };
      });
      // Open the chest last so its balances/cards include every direct attachment.
      for (const item of received) {
        if (item.item_type === '3') {
          item.item_chest = chestRewards(state, chests.find((chest) => String(chest.ChestID) === item.item_id),
            seq, row.delivery_key === 'welcome-v1');
        }
      }
      for (const item of received) {
        if (item.item_type === '5') {
          item.item_curCnt = state.user_info.gold;
        } else if (item.item_type === '2') {
          item.item_curCnt = state.heroes.find((hero) => hero.char_id === item.item_id).stone;
        }
      }
      db.prepare('UPDATE mailbox SET claimed_at = ?, read_at = COALESCE(read_at, ?) WHERE post_seq = ?')
        .run(now, now, row.post_seq);
      updateProgressNotifications(state);
      return {
        receiveList: received, curGold: state.user_info.gold, curJewel: state.user_info.jewel,
        post_cnt: String(mailCount(account.gsn, now)),
        quest_cnt: state.user_info.quest_cnt, achievement_cnt: state.user_info.achievement_cnt,
      };
    });
  }

  function leagueThresholds(settings, count, score = 0) {
    let promote = Math.floor(count * settings.PromoteRank / 10000);
    if (count === 1 && score > 0 && settings.PromoteLeagueID !== settings.LeagueID) {
      promote = 1;
    }
    if (settings.PromoteLeagueID === settings.LeagueID) {
      promote = 0;
    }
    const keep = Math.max(promote, Math.floor(count * settings.DemoteRank / 10000));
    return {
      pRank: String(promote),
      // dRank is the last safe rank; positions strictly greater are demoted.
      dRank: settings.DemoteLeagueID === settings.LeagueID ? '0' : String(keep),
      keep,
    };
  }

  function rewardAtRank(rows, rank) {
    return rows.find((row) => row.MinRank <= rank && (row.MaxRank === 0 || rank <= row.MaxRank));
  }

  function settleLeagueWeeks(now) {
    const current = rankingWeek(now).start;
    const weeks = db.prepare(`
      SELECT DISTINCT m.week_start FROM league_members m
      WHERE m.week_start < ? AND NOT EXISTS (
        SELECT 1 FROM league_periods p WHERE p.week_start = m.week_start
      ) ORDER BY m.week_start
    `).all(current);
    for (const { week_start: week } of weeks) {
      transaction(() => {
        const accounts = db.prepare(`
          SELECT a.gsn, a.state_json, COALESCE(w.score, 0) AS score
          FROM accounts a LEFT JOIN weekly_scores w ON w.gsn = a.gsn AND w.week_start = ?
          WHERE a.tutorial_completed = 1 ORDER BY score DESC, a.gsn ASC
        `).all(week).map((row, index) => ({
          ...row, state: JSON.parse(row.state_json), globalRank: index + 1,
        }));
        const members = db.prepare('SELECT gsn, league_id FROM league_members WHERE week_start = ?').all(week);
        for (const leagueId of [...new Set(members.map((row) => row.league_id))]) {
          const settings = leagues.find((row) => row.LeagueID === leagueId);
          if (!settings) {
            throw new Error(`Unknown league in weekly membership: ${leagueId}`);
          }
          const groupIds = new Set(members.filter((row) => row.league_id === leagueId).map((row) => row.gsn));
          const group = accounts.filter((row) => groupIds.has(row.gsn));
          const thresholds = leagueThresholds(settings, group.length, group[0]?.score || 0);
          const rankList = group.map((row, index) => ({
            rank: String(index + 1), gsn: String(row.gsn), icon: row.state.user_info.rep_hero,
            nickname: row.state.user_info.nickname, score: String(row.score),
          }));
          for (const [index, row] of group.entries()) {
            const rank = index + 1;
            const newLeague = rank <= Number(thresholds.pRank) ? settings.PromoteLeagueID
              : rank > thresholds.keep ? settings.DemoteLeagueID : leagueId;
            const prize = rewardAtRank(leagueRewards.filter((reward) => reward.LeagueID === leagueId), rank);
            if (!prize) {
              throw new Error(`Missing reward for league ${leagueId}, rank ${rank}`);
            }
            const globalPrize = rewardAtRank(weeklyRewards, row.globalRank);
            for (const [kind, chestId] of [['league', prize.RewardChestID], ['weekly', globalPrize?.ChestID]]) {
              if (chestId) {
                db.prepare(`INSERT INTO season_rewards (reward_id, week_start, gsn, kind, chest_id)
                  VALUES (?, ?, ?, ?, ?)`).run(crypto.randomUUID(), week, row.gsn, kind, chestId);
              }
            }
            const data = {
              season_id: String(week), league_id: String(leagueId), new_league_id: String(newLeague),
              pRank: thresholds.pRank, dRank: thresholds.dRank, rank: rankList,
              my_rank: String(rank), my_score: String(row.score), global_rank: String(row.globalRank),
              week_end: utcTime(new Date(week + 7 * 86400000)),
            };
            db.prepare('INSERT INTO league_results (week_start, gsn, data_json) VALUES (?, ?, ?)')
              .run(week, row.gsn, JSON.stringify(data));
            row.state.user_info.grade = String(newLeague);
            row.state.user_info.league_flag = '1';
            // Settlement must not create login activity for an offline account.
            db.prepare('UPDATE accounts SET state_json = ? WHERE gsn = ?')
              .run(JSON.stringify(row.state), row.gsn);
          }
        }
        db.prepare('INSERT INTO league_periods (week_start) VALUES (?)').run(week);
      });
    }
  }

  function pendingSeason(gsn) {
    const row = db.prepare(`SELECT * FROM league_results WHERE gsn = ? AND acknowledged = 0
      ORDER BY week_start LIMIT 1`).get(gsn);
    if (!row) {
      throw new ApiError(4003, 'No pending league settlement.');
    }
    const rewards = db.prepare(`SELECT reward_id, kind, chest_id FROM season_rewards
      WHERE gsn = ? AND week_start = ? AND response_json IS NULL ORDER BY kind`)
      .all(gsn, row.week_start);
    return {
      ...JSON.parse(row.data_json),
      rewards: rewards.map((reward) => ({
        reward_id: reward.reward_id, kind: reward.kind, chest_id: String(reward.chest_id),
      })),
    };
  }

  function leagueList(account, state, now) {
    const week = rankingWeek(now);
    const settings = leagues.find((row) => String(row.LeagueID) === state.user_info.grade);
    const members = db.prepare(`
      SELECT a.gsn, a.state_json, COALESCE(w.score, 0) AS score
      FROM league_members m JOIN accounts a ON a.gsn = m.gsn
      LEFT JOIN weekly_scores w ON w.week_start = m.week_start AND w.gsn = m.gsn
      WHERE m.week_start = ? AND m.league_id = ? ORDER BY score DESC, a.gsn ASC
    `).all(week.start, settings.LeagueID);
    const thresholds = leagueThresholds(settings, members.length, members[0]?.score || 0);
    return {
      league_id: String(settings.LeagueID), next_league: utcTime(new Date(week.end)),
      pRank: thresholds.pRank, dRank: thresholds.dRank, league_flag: state.user_info.league_flag,
      rank: members.map((row, index) => {
        const user = JSON.parse(row.state_json).user_info;
        return {
          rank: String(index + 1), gsn: String(row.gsn), icon: user.rep_hero,
          nickname: user.nickname, score: String(row.score),
        };
      }),
    };
  }

  function leagueClaim(fields, account, state) {
    return mutation(fields, account, state, ['reward_id'], (seq) => {
      const reward = db.prepare('SELECT * FROM season_rewards WHERE reward_id = ? AND gsn = ?')
        .get(fields.reward_id, account.gsn);
      if (!reward || reward.response_json) {
        throw new ApiError(4003, 'Season reward does not exist, is not owned or was already claimed.');
      }
      const response = {
        reward_id: reward.reward_id, chest_id: String(reward.chest_id),
        ...chestRewards(state, chests.find((row) => row.ChestID === reward.chest_id), seq),
      };
      db.prepare('UPDATE season_rewards SET response_json = ? WHERE reward_id = ?')
        .run(JSON.stringify(response), reward.reward_id);
      return response;
    });
  }

  function leagueAck(fields, account, state) {
    return mutation(fields, account, state, ['season_id'], () => {
      const week = integer(fields, 'season_id', 0, Number.MAX_SAFE_INTEGER);
      const row = db.prepare('SELECT * FROM league_results WHERE week_start = ? AND gsn = ?')
        .get(week, account.gsn);
      if (!row || row.acknowledged || db.prepare(`SELECT 1 FROM season_rewards
        WHERE week_start = ? AND gsn = ? AND response_json IS NULL`).get(week, account.gsn)) {
        throw new ApiError(4003, 'Claim all season rewards before closing this settlement.');
      }
      db.prepare('UPDATE league_results SET acknowledged = 1 WHERE week_start = ? AND gsn = ?')
        .run(week, account.gsn);
      const pending = db.prepare('SELECT 1 FROM league_results WHERE gsn = ? AND acknowledged = 0').get(account.gsn);
      state.user_info.league_flag = pending ? '1' : '0';
      return { league_id: state.user_info.grade, league_flag: state.user_info.league_flag };
    });
  }

  function ownedChest(fields, state, minSlot = 1) {
    const slot = integer(fields, 'slot_id', minSlot, 6);
    const chestId = integer(fields, 'chest_id', 1, 2147483647);
    const instance = required(fields, 'chest_instance');
    const chest = state.chest_info.find((row) => row.slot_id === String(slot));
    if (!chest || chest.chest_id !== String(chestId) || chest.chest_instance !== instance) {
      throw new ApiError(4003, 'Chest slot changed. Refresh the lobby before trying again.');
    }
    const settings = chests.find((row) => row.ChestID === chestId);
    const expectedType = slot === 1 ? 1 : slot === 2 ? 2 : 4;
    if (!settings || settings.ChestType !== expectedType
      || !(slot === 1 ? ['1'] : slot === 2 ? ['2'] : ['0', '1']).includes(chest.complete_type)) {
      throw new ApiError(4003, 'Chest type or state is not supported in this slot.');
    }
    return chest;
  }

  function grantHeroCards(state, id, count) {
    let hero = state.heroes.find((row) => row.char_id === String(id));
    if (!hero) {
      hero = {
        char_id: String(id), char_lv: '1', skin_id: '0', trophy: '0',
        stone: '0', health_lv: '0', primary_lv: '0', super_lv: '0',
      };
      state.heroes.push(hero);
    }
    hero.stone = String(Number(hero.stone) + count);
    return hero;
  }

  function chestRewards(state, settings, seq, welcomeOnly = false) {
    addProgress(state, 1000);
    const rollAmount = (min, max, rate) => rate === 0 || max === 0
      || crypto.randomInt(10000) >= rate ? 0 : crypto.randomInt(min, max + 1);
    const gold = rollAmount(settings.Gold_Min, settings.Gold_Max, settings.GetGoldRate);
    const jewel = rollAmount(settings.Jewel_Min, settings.Jewel_Max, settings.GetJewelRate);
    const cards = [];
    for (let i = 0; i < (welcomeOnly ? 1 : cardGroups.length); i++) {
      const name = cardGroups[i];
      const count = rollAmount(settings[`${name}_Min`], settings[`${name}_Max`], settings[`${name}_Rate`]);
      if (count === 0) {
        continue;
      }
      const pool = cardPool(settings.ChestID, i + 1).filter((row) => !welcomeOnly
        || state.heroes.some((hero) => hero.char_id === String(row.id)));
      if (pool.length === 0) {
        throw new Error(`No eligible owned common hero for welcome chest ${settings.ChestID}`);
      }
      const totalWeight = pool.reduce((sum, row) => sum + row.weight, 0);
      let roll = crypto.randomInt(totalWeight);
      const picked = pool.find((row) => {
        roll -= row.weight;
        return roll < 0;
      });
      const hero = grantHeroCards(state, picked.id, count);
      cards.push({ id: hero.char_id, count: String(count), curCount: hero.stone, cSeq: seq });
    }
    state.user_info.gold = String(Number(state.user_info.gold) + gold);
    state.user_info.jewel = String(Number(state.user_info.jewel) + jewel);
    return {
      gold: String(gold), jewel: String(jewel), curGold: state.user_info.gold,
      curJewel: state.user_info.jewel, gSeq: seq, jSeq: seq, card: cards,
    };
  }

  function chestOpen(fields, account, state) {
    if (!['Y', 'N'].includes(required(fields, 'nowYN'))) {
      throw new ApiError(4000, 'nowYN must be Y or N.');
    }
    return mutation(fields, account, state,
      ['slot_id', 'chest_id', 'chest_instance', 'nowYN'], (seq) => {
        const chest = ownedChest(fields, state);
        const settings = chests.find((row) => String(row.ChestID) === chest.chest_id);
        const slot = Number(chest.slot_id);
        let cost = 0;
        const now = new Date();
        if (slot >= 3) {
          if (fields.nowYN === 'Y') {
            if (chest.complete_type === '0') {
              cost = Math.max(1, Math.floor(settings.OpenTime / 10));
            } else if (chest.complete_value > utcTime(now)) {
              cost = Math.floor((parseUtcTime(chest.complete_value) - now.getTime()) / 600000) + 1;
            }
          } else if (chest.complete_type !== '1' || chest.complete_value > utcTime(now)) {
            throw new ApiError(4003, 'Reward chest is still locked or its timer has not finished.');
          }
        } else if (slot === 1) {
          if (fields.nowYN !== 'N' || chest.complete_type !== '1' || chest.complete_value > utcTime(now)) {
            throw new ApiError(4003, 'Free chest cooldown has not finished; ad-based opens are not implemented.');
          }
        } else if (fields.nowYN !== 'N' || chest.complete_type !== '2'
          || Number(chest.complete_value) < settings.OpenTime) {
          throw new ApiError(4003, 'Play chest requires more completed battles.');
        }
        if (Number(state.user_info.jewel) < cost) {
          throw new ApiError(4003, 'Not enough jewels to open this chest immediately.');
        }
        state.user_info.jewel = String(Number(state.user_info.jewel) - cost);
        addProgress(state, 910, cost);
        const rewards = chestRewards(state, settings, seq);
        chest.chest_instance = crypto.randomUUID();
        chest.complete_value = '0';
        if (slot >= 3) {
          chest.chest_id = '0';
          chest.complete_type = '0';
        } else if (slot === 1) {
          chest.complete_value = utcTime(new Date(now.getTime() + settings.OpenTime * 60000));
        }
        return {
          slot_id: chest.slot_id, chest_id: chest.chest_id, ad: '0',
          ...rewards, chest_info: { ...chest },
        };
      });
  }

  function refreshShop(state) {
    const day = new Date().toISOString().slice(0, 10);
    if (state.shop && state.shop.day === day) {
      return;
    }
    state.shop = {
      day, next_refresh: utcTime(new Date(Date.parse(`${day}T00:00:00Z`) + 86400000)),
      free_claimed: false,
    };
    rollShop(state.shop);
  }

  function rollShop(shop) {
    const selected = [];
    const take = (tier) => {
      const pool = dailyProducts.filter((row) => !selected.includes(row)
        && characters.find((hero) => hero.CharacterID === row.ItemID).Tier === tier);
      selected.push(pool[crypto.randomInt(pool.length)]);
    };
    take(1);
    take(1);
    take(crypto.randomInt(100) < 50 ? 2 : 1);
    take(crypto.randomInt(100) < 10 ? 3 : 2);
    take(crypto.randomInt(100) < 20 ? 4 : 3);
    selected.sort((a, b) => characters.find((hero) => hero.CharacterID === a.ItemID).Tier
      - characters.find((hero) => hero.CharacterID === b.ItemID).Tier || a.CategoryOrder - b.CategoryOrder);
    shop.instance = crypto.randomUUID();
    shop.items = selected.map((row) => ({ product_id: String(row.ProductID), bought: '0' }));
  }

  function shopInfo(state) {
    return {
      shop_instance: state.shop.instance, shop_day: state.shop.day,
      next_refresh: state.shop.next_refresh,
      next_free: state.shop.free_claimed ? state.shop.next_refresh : '20000101000000',
      items: state.shop.items.map((row) => ({ ...row })),
    };
  }

  function shopBuy(fields, account, state) {
    const id = integer(fields, 'product_id', 1, 2147483647);
    return mutation(fields, account, state, ['product_id', 'shop_instance'], (seq) => {
      refreshShop(state);
      if (fields.shop_instance !== state.shop.instance) {
        throw new ApiError(4003, 'Shop changed. Reopen the shop before buying.');
      }
      const product = shopProducts.find((row) => row.ProductID === id);
      if (!product || (product.Category === 2 && !dailyProducts.includes(product))) {
        throw new ApiError(4003, 'This product is inactive or unavailable in the local shop.');
      }
      let item;
      if (product.Category === 2) {
        item = state.shop.items.find((row) => row.product_id === String(id));
        if (!item || item.bought !== '0') {
          throw new ApiError(4003, 'Daily product is not offered or has already been bought.');
        }
      }
      const currency = product.MoneyType === 3 ? 'gold' : 'jewel';
      if (Number(state.user_info[currency]) < product.Price) {
        throw new ApiError(4003, `Not enough ${currency} for this purchase.`);
      }
      state.user_info[currency] = String(Number(state.user_info[currency]) - product.Price);
      addProgress(state, currency === 'gold' ? 900 : 910, product.Price);
      let rewards = {};
      if (product.Category === 2) {
        const hero = grantHeroCards(state, product.ItemID, product.ItemCount);
        rewards.curCount = hero.stone;
        item.bought = '1';
      } else if (product.Category === 3) {
        rewards = chestRewards(state, chests.find((row) => row.ChestID === product.ItemID), seq);
      } else if (product.Category === 5) {
        state.user_info.gold = String(Number(state.user_info.gold) + product.ItemCount);
      } else {
        rollShop(state.shop);
      }
      return {
        product_id: String(id), item_id: String(product.ItemID), item_count: String(product.ItemCount),
        remain_value: state.user_info[currency], curGold: state.user_info.gold,
        curJewel: state.user_info.jewel, ...rewards, shop_info: shopInfo(state),
      };
    });
  }

  function shopFree(fields, account, state) {
    return mutation(fields, account, state, ['shop_day'], (seq) => {
      refreshShop(state);
      if (fields.shop_day !== state.shop.day || state.shop.free_claimed) {
        throw new ApiError(4003, 'Free shop chest already claimed or shop day changed. Reopen the shop.');
      }
      state.shop.free_claimed = true;
      return {
        ...chestRewards(state, chests.find((row) => row.ChestID === 303004), seq),
        shop_info: shopInfo(state),
      };
    });
  }

  function heroUpgrade(fields, account, state) {
    const id = integer(fields, 'char_id', 1, 2147483647);
    const type = integer(fields, 'skill_type', 0, 2);
    const expected = integer(fields, 'expected_level', 0, 7);
    return mutation(fields, account, state, ['char_id', 'skill_type', 'expected_level'], () => {
      const hero = state.heroes.find((row) => row.char_id === String(id));
      if (!hero) {
        throw new ApiError(4004, 'Character is not owned by this account.');
      }
      const key = ['health_lv', 'primary_lv', 'super_lv'][type];
      if (Number(hero[key]) !== expected) {
        throw new ApiError(4003, 'Skill level changed. Refresh the hero before upgrading again.');
      }
      const character = characters.find((row) => row.CharacterID === id);
      const settings = upgrades.find((row) => row.Tier === character.Tier && row.Level === expected + 1);
      if (!settings) {
        throw new ApiError(4003, 'This skill is already at its maximum level.');
      }
      if (Number(state.user_info.gold) < settings.Upgrade_Gold || Number(hero.stone) < settings.Upgrade_HeroStone) {
        throw new ApiError(4003, 'Not enough gold or hero cards for this upgrade.');
      }
      state.user_info.gold = String(Number(state.user_info.gold) - settings.Upgrade_Gold);
      addProgress(state, 900, settings.Upgrade_Gold);
      addProgress(state, 710);
      hero.stone = String(Number(hero.stone) - settings.Upgrade_HeroStone);
      hero[key] = String(expected + 1);
      hero.char_lv = String(1 + Number(hero.health_lv) + Number(hero.primary_lv) + Number(hero.super_lv));
      return {
        char_id: hero.char_id, skill_type: String(type), skill_value: hero[key],
        char_lv: hero.char_lv, remain_value: state.user_info.gold, remain_stone: hero.stone,
      };
    });
  }

  function refreshModes(state) {
    const now = new Date();
    const current = utcTime(now);
    let changed = false;
    for (const mode of state.battle_mode) {
      if (mode.init_time <= current) {
        const settings = modes.find((row) => String(row.ModeID) === mode.modeId);
        mode.init_time = nextModeReset(settings, now);
        mode.bonusGold = '0';
        changed = true;
      }
    }
    return changed;
  }

  function ranking(account, state, weekly, now) {
    const week = rankingWeek(now);
    const rows = db.prepare(`
      WITH ranked AS (
        SELECT a.gsn,
          json_extract(a.state_json, '$.user_info.rep_hero') AS icon,
          json_extract(a.state_json, '$.user_info.nickname') AS nickname,
          ${weekly ? 'COALESCE(w.score, 0)' : "CAST(json_extract(a.state_json, '$.user_info.trophy_sum') AS INTEGER)"} AS score
        FROM accounts a
        ${weekly ? 'LEFT JOIN weekly_scores w ON w.gsn = a.gsn AND w.week_start = ?' : ''}
        WHERE a.tutorial_completed = 1
      ), numbered AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY score DESC, gsn ASC) AS rank FROM ranked
      )
      SELECT * FROM numbered WHERE rank <= 100 OR gsn = ? ORDER BY rank
    `).all(...(weekly ? [week.start, account.gsn] : [account.gsn]));
    const mine = rows.find((row) => row.gsn === account.gsn);
    const response = {
      my_icon: state.user_info.rep_hero, my_nickname: state.user_info.nickname,
      my_rank: mine ? String(mine.rank) : '0', my_score: mine ? String(mine.score) : '0',
      rank: rows.filter((row) => row.rank <= 100).map((row) => ({
        rank: String(row.rank), gsn: String(row.gsn), icon: row.icon,
        nickname: row.nickname, score: String(row.score),
      })),
    };
    if (weekly) {
      response.next_ranking = utcTime(new Date(week.end));
    }
    return response;
  }

  function battleEntry(fields, account, state) {
    if (!account.tutorial_completed) {
      throw new ApiError(4003, 'Complete the tutorial nickname step before entering a battle.');
    }
    const roomId = required(fields, 'room_id');
    const modeId = integer(fields, 'mode', 1, 3);
    const heroId = integer(fields, 'play_char_id', 1, 2147483647);
    const mapIdx = integer(fields, 'map_idx', 0, 2);
    if (!state.heroes.some((hero) => hero.char_id === String(heroId))) {
      throw new ApiError(4004, 'Battle hero is not owned by this account.');
    }
    const settings = modes.find((row) => row.ModeID === modeId);
    const identity = { mode: modeId, hero: heroId, map: mapIdx };
    return transaction(() => {
      const previous = db.prepare('SELECT * FROM battles WHERE gsn = ? AND room_id = ?')
        .get(account.gsn, roomId);
      if (previous) {
        const entry = JSON.parse(previous.entry_json);
        if (JSON.stringify(entry.identity) !== JSON.stringify(identity) || previous.result_json) {
          throw new ApiError(4003, 'Battle ID is already used by a different or completed battle.');
        }
        return entry.response;
      }
      const moneyKey = settings.EntryFeeType === 5 ? 'gold' : 'jewel';
      if (settings.EntryFee > 0) {
        if (![5, 6].includes(settings.EntryFeeType)) {
          throw new Error(`Unsupported entry currency for mode ${modeId}`);
        }
        if (Number(state.user_info[moneyKey]) < settings.EntryFee) {
          throw new ApiError(4003, 'Not enough currency for this battle entry fee.');
        }
        state.user_info[moneyKey] = String(Number(state.user_info[moneyKey]) - settings.EntryFee);
        addProgress(state, moneyKey === 'gold' ? 900 : 910, settings.EntryFee);
      }
      const response = {
        result: '1', room_id: roomId, curMoneyType: String(settings.EntryFeeType),
        curMoney: settings.EntryFeeType === 0 ? '0' : state.user_info[moneyKey],
      };
      saveState(account.gsn, state);
      db.prepare('INSERT INTO battles (gsn, room_id, entry_json, created_at) VALUES (?, ?, ?, ?)')
        .run(account.gsn, roomId, JSON.stringify({ identity, response }), Date.now());
      return response;
    });
  }

  function battleResult(fields, account, state, now) {
    const roomId = required(fields, 'room_id');
    const modeId = integer(fields, 'mode', 1, 3);
    const heroId = integer(fields, 'play_char_id', 1, 2147483647);
    const mapIdx = integer(fields, 'map_idx', 0, 2);
    integer(fields, 'entry_user_cnt', 1, 1);
    const settings = modes.find((row) => row.ModeID === modeId);
    const win = integer(fields, 'win', modeId === 3 ? 0 : 1, 3);
    const rank = integer(fields, 'battle_rank', modeId === 3 ? 1 : 0,
      modeId === 3 ? settings.EntryMemberCount : 0);
    const mvp = required(fields, 'mvp');
    const outcome = modeId === 3 ? rank : win;
    const statKeys = ['total_kill', 'get_potion', 'get_jam', 'turret_kill'];
    const stats = Object.fromEntries(statKeys.map((key) => [key,
      fields[key] === undefined ? 0 : integer(fields, key, 0, 100000)]));
    stats.first_kill = fields.first_kill === String(account.gsn) ? 1 : 0;
    if ((modeId !== 1 && stats.get_jam > 0) || (modeId !== 2 && stats.turret_kill > 0)
      || stats.first_kill > stats.total_kill) {
      throw new ApiError(4000, 'Battle statistics do not match the mode or kill count.');
    }
    const identity = { modeId, heroId, mapIdx, win, rank, mvp };
    const normalized = JSON.stringify({ ...identity, stats });
    return transaction(() => {
      const battle = db.prepare('SELECT * FROM battles WHERE gsn = ? AND room_id = ?')
        .get(account.gsn, roomId);
      if (!battle) {
        throw new ApiError(4003, 'Battle entry is missing. Start a new battle from the lobby.');
      }
      const entry = JSON.parse(battle.entry_json);
      if (entry.identity.mode !== modeId || entry.identity.hero !== heroId || entry.identity.map !== mapIdx) {
        throw new ApiError(4003, 'Battle mode, hero or map does not match the registered entry.');
      }
      if (battle.result_json) {
        const previous = JSON.parse(battle.result_request);
        if (battle.result_request !== (previous.stats ? normalized : JSON.stringify(identity))) {
          throw new ApiError(4003, 'This battle already has a different result.');
        }
        return JSON.parse(battle.result_json);
      }
      const reward = rewards.find((row) => row.IngameModeID === modeId
        && row.IngameModeType === (modeId === 3 ? 2 : 1) && row.IngameResult === outcome);
      if (!reward) {
        throw new Error(`No reward table row for mode ${modeId}, outcome ${outcome}`);
      }
      const hero = state.heroes.find((row) => row.char_id === String(heroId));
      if (!hero) {
        throw new ApiError(4004, 'Battle hero is no longer owned.');
      }
      const user = state.user_info;
      refreshProgress(state);
      if ((modeId === 3 && rank === 1) || (modeId !== 3 && win === 1)) {
        addProgress(state, ({ 1: 200, 2: 300, 3: 400 })[modeId]);
      }
      for (const [type, count] of [[210, stats.get_jam], [310, stats.turret_kill],
      [600, stats.get_potion], [610, stats.total_kill], [620, stats.first_kill],
      [630, modeId !== 3 && mvp === String(account.gsn) ? 1 : 0]]) {
        addProgress(state, type, count);
      }
      refreshModes(state);
      const modeState = state.battle_mode.find((row) => row.modeId === String(modeId));
      const remaining = Math.max(0, settings.BonusGold - Number(modeState.bonusGold));
      const winGold = Math.min(remaining, reward.GetBonusGold);
      const mvpGold = mvp === String(account.gsn) && modeId !== 3
        ? Math.min(remaining - winGold, reward.GetMvpGold) : 0;
      modeState.bonusGold = String(Number(modeState.bonusGold) + winGold + mvpGold);
      user.gold = String(Number(user.gold) + winGold + mvpGold);

      const oldTrophy = Number(hero.trophy);
      hero.trophy = String(Math.max(0, oldTrophy + reward.GetTrophy));
      const weeklyGain = Math.max(0, Number(hero.trophy) - oldTrophy);
      db.prepare(`
        INSERT INTO weekly_scores (week_start, gsn, score) VALUES (?, ?, ?)
        ON CONFLICT (week_start, gsn) DO UPDATE SET score = score + excluded.score
      `).run(rankingWeek(now).start, account.gsn, weeklyGain);
      db.prepare(`INSERT OR IGNORE INTO league_members (week_start, gsn, league_id) VALUES (?, ?, ?)`)
        .run(rankingWeek(now).start, account.gsn, Number(user.grade));
      user.trophy_sum = String(state.heroes.reduce((sum, row) => sum + Number(row.trophy), 0));
      user.trophy_max = String(Math.max(Number(user.trophy_max), Number(user.trophy_sum)));
      if ((modeId === 3 && rank === 1) || (modeId !== 3 && win === 1)) {
        user.win_sum = String(Number(user.win_sum) + 1);
      }
      user.exp = String(Math.min(levels[levels.length - 1].AccumulateExp, Number(user.exp) + reward.GetExp));
      const oldLevel = Number(user.level);
      const newLevel = levels.filter((row) => row.AccumulateExp <= Number(user.exp)).at(-1).UserLevel;
      for (const level of levels.filter((row) => row.UserLevel > oldLevel && row.UserLevel <= newLevel)) {
        for (let i = 1; i <= 2; i++) {
          const type = level[`LevelUpReward${i}Type`];
          if (type !== 0) {
            const key = type === 5 ? 'gold' : 'jewel';
            user[key] = String(Number(user[key]) + level[`LevelUpReward${i}Count`]);
          }
        }
      }
      user.level = String(newLevel);
      if (reward.GetEntryFee > 0) {
        if (![5, 6].includes(settings.EntryFeeType)) {
          throw new Error(`Unsupported payout currency for mode ${modeId}`);
        }
        const key = settings.EntryFeeType === 5 ? 'gold' : 'jewel';
        user[key] = String(Number(user[key]) + reward.GetEntryFee);
      }

      let chestId = 0;
      const roll = crypto.randomInt(10000);
      let cumulative = 0;
      for (let i = 1; i <= 3; i++) {
        cumulative += reward[`GetChestRate_${i}`];
        if (roll < cumulative) {
          chestId = reward[`GetChestID_${i}`];
          break;
        }
      }
      let chestReceive = 0;
      if (chestId > 0) {
        const slot = state.chest_info.find((row) => Number(row.slot_id) >= 3 && row.chest_id === '0');
        chestReceive = slot ? 1 : -1;
        if (slot) {
          slot.chest_id = String(chestId);
          slot.chest_instance = crypto.randomUUID();
          slot.complete_type = '0';
          slot.complete_value = '0';
        }
      }
      const play = state.chest_info.find((row) => row.slot_id === '2');
      play.complete_value = String(Math.min(playChest.OpenTime, Number(play.complete_value) + 1));
      const response = {
        result: '1', accExp: user.exp, trophy: String(Number(hero.trophy) - oldTrophy),
        winGold: String(winGold), mvpGold: String(mvpGold), boosterGold: '0',
        chestReceive: String(chestReceive),
        chestGrade: chestId === 0 ? '0' : String(chests.find((row) => row.ChestID === chestId).ChestGrade),
        entryFeeType: String(settings.EntryFeeType), entryFee: String(reward.GetEntryFee),
      };
      saveState(account.gsn, state);
      db.prepare('UPDATE battles SET result_request = ?, result_json = ? WHERE gsn = ? AND room_id = ?')
        .run(normalized, JSON.stringify(response), account.gsn, roomId);
      return response;
    });
  }

  function login(fields) {
    const memberId = required(fields, 'memberId');
    const udid = required(fields, 'udid');
    if (required(fields, 'memberType') !== '1') {
      throw new ApiError(4003, 'Only local guest accounts are supported. Google/Apple login is not implemented.');
    }
    if (memberId !== udid) {
      throw new ApiError(4000, 'Guest memberId must equal udid.');
    }
    return transaction(() => {
      let account = db.prepare('SELECT * FROM accounts WHERE member_id = ?').get(memberId);
      if (fields.gsn && fields.gsn !== String(account?.gsn)) {
        const claimed = db.prepare('SELECT gsn FROM accounts WHERE CAST(gsn AS TEXT) = ?').get(fields.gsn);
        if (claimed) {
          throw new ApiError(4001, 'Account does not belong to this guest identity.');
        }
        // An unknown legacy GSN cannot restore old server data; use this guest identity.
      }
      const now = new Date();
      if (!account) {
        const inserted = db.prepare('INSERT INTO accounts (member_id, state_json) VALUES (?, ?)')
          .run(memberId, JSON.stringify(newState(now)));
        account = db.prepare('SELECT * FROM accounts WHERE gsn = ?').get(inserted.lastInsertRowid);
      }
      saveState(account.gsn, JSON.parse(account.state_json));
      const token = crypto.randomBytes(32).toString('hex');
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.getTime());
      db.prepare('INSERT INTO sessions (token_hash, gsn, expires_at) VALUES (?, ?, ?)')
        .run(hash, account.gsn, now.getTime() + 86400000);
      return {
        result: account.tutorial_completed ? '1' : '2',
        country: 'G9',
        gsn: String(account.gsn),
        sessionid: token,
      };
    });
  }

  function authenticatedAccount(fields) {
    const token = required(fields, 'sessionid');
    const gsn = required(fields, 'gsn');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const account = db.prepare(`
      SELECT a.* FROM accounts a JOIN sessions s ON s.gsn = a.gsn
      WHERE s.token_hash = ? AND s.expires_at > ? AND CAST(a.gsn AS TEXT) = ?
    `).get(hash, Date.now(), gsn);
    if (!account) {
      throw new ApiError(4001, 'Invalid, expired or mismatched session. Log in again.');
    }
    return account;
  }

  const monetization = createMonetization({
    db, config: monetizationConfig, store, amazonStore, callbackSecret, tables, transaction,
    required, integer, ApiError, utcTime, parseUtcTime,
  });

  function dispatch(fields) {
    const now = Date.now();
    const pg = required(fields, 'pg');
    if (pg !== 'check_login') {
      authenticatedAccount(fields);
    }
    settleLeagueWeeks(now);
    if (pg === 'check_login') {
      return login(fields);
    }
    const account = authenticatedAccount(fields);
    if (account.tutorial_completed) {
      deliverWelcome(account.gsn, now);
    }
    const state = JSON.parse(account.state_json);
    if (state.chest_info.some((chest) => !chest.chest_instance)) {
      for (const chest of state.chest_info) {
        if (!chest.chest_instance) {
          chest.chest_instance = crypto.randomUUID();
        }
      }
      saveState(account.gsn, state);
    }
    switch (pg) {
      case 'store_catalog':
      case 'store_pending':
      case 'store_identity':
      case 'store_begin':
      case 'store_redeem':
      case 'amazon_purchase':
      case 'ad_prepare':
      case 'ad_claim':
        return monetization.handle(fields, account, now);
      case 'post_getpostlist':
      case 'post_read':
      case 'post_receive':
      case 'post_postdelete':
        if (!account.tutorial_completed) {
          throw new ApiError(4003, 'Complete the tutorial before using the mailbox.');
        }
        return pg === 'post_getpostlist' ? mailList(fields, account, now)
          : mailMutation(fields, account, state, now);
      case 'league_list':
      case 'league_weekly':
      case 'league_rewardclaim':
      case 'league_ack':
        if (!account.tutorial_completed) {
          throw new ApiError(4003, 'Complete the tutorial before using leagues.');
        }
        if (pg === 'league_list') {
          return leagueList(account, state, now);
        }
        if (pg === 'league_weekly') {
          return pendingSeason(account.gsn);
        }
        return pg === 'league_rewardclaim' ? leagueClaim(fields, account, state) : leagueAck(fields, account, state);
      case 'quest_daily':
      case 'achievement_list':
      case 'quest_complete':
      case 'achievement_complete':
        if (!account.tutorial_completed) {
          throw new ApiError(4003, 'Complete the tutorial before using quests and achievements.');
        }
        if (pg === 'quest_complete' || pg === 'achievement_complete') {
          return progressClaim(fields, account, state, pg === 'quest_complete' ? 1 : 2);
        }
        return transaction(() => {
          saveState(account.gsn, state);
          return {
            list: questList(state, pg === 'quest_daily' ? 1 : 2),
            quest_day: state.progress.day,
            next_reset: utcTime(new Date(Date.parse(`${state.progress.day}T00:00:00Z`) + 86400000)),
            quest_cnt: state.user_info.quest_cnt, achievement_cnt: state.user_info.achievement_cnt,
          };
        });
      case 'shop_getshopinfo':
        if (!account.tutorial_completed) {
          throw new ApiError(4003, 'Complete the tutorial before using the shop.');
        }
        return transaction(() => {
          refreshShop(state);
          saveState(account.gsn, state);
          return {
            booster_gold_max: '0', booster_gold: '0', shop_info: shopInfo(state),
            curGold: state.user_info.gold, curJewel: state.user_info.jewel,
          };
        });
      case 'shop_buyitem':
      case 'shop_freechest':
        if (!account.tutorial_completed) {
          throw new ApiError(4003, 'Complete the tutorial before using the shop.');
        }
        return pg === 'shop_buyitem' ? shopBuy(fields, account, state) : shopFree(fields, account, state);
      case 'ranking_list':
        return ranking(account, state, false, now);
      case 'ranking_weekly':
        return ranking(account, state, true, now);
      case 'chest_open':
        return chestOpen(fields, account, state);
      case 'character_upgradeskill':
        return heroUpgrade(fields, account, state);
      case 'game_entryfee':
        return battleEntry(fields, account, state);
      case 'game_singleresult':
        return battleResult(fields, account, state, now);
      case 'check_lobby': {
        refreshModes(state);
        saveState(account.gsn, state);
        return {
          user_info: state.user_info, chest_info: state.chest_info,
          battle_mode: state.battle_mode, purchase: state.purchase,
          tutorial_completed: account.tutorial_completed ? '1' : '0',
        };
      }
      case 'character_getlist': {
        const id = required(fields, 'char_id');
        const heroes = id === '0' ? state.heroes : state.heroes.filter((hero) => hero.char_id === id);
        if (heroes.length === 0) {
          throw new ApiError(4004, 'Character is not owned by this account.');
        }
        // NetHeroInfo.set_data reads .str rather than a nested JSON object.
        return { characterList: heroes.map((hero) => JSON.stringify(hero)) };
      }
      case 'user_nickupdate': {
        const nickname = required(fields, 'nickname', 12);
        if (nickname.trim() !== nickname || /[\u0000-\u001f\u007f]/.test(nickname)) {
          throw new ApiError(4000, 'Nickname must be 1-12 characters without surrounding whitespace or controls.');
        }
        if (account.tutorial_completed) {
          if (state.user_info.nickname === nickname) {
            return { nick: nickname };
          }
          throw new ApiError(4003, 'Free tutorial nickname change has already been used.');
        }
        return transaction(() => {
          state.user_info.nickname = nickname;
          state.user_info.gold = String(Number(state.user_info.gold) + common.TutoReward_Gold);
          state.user_info.jewel = String(Number(state.user_info.jewel) + common.TutoReward_Jewel);
          state.chest_info[2].chest_id = String(tutorialChest.ChestID);
          state.chest_info[2].chest_instance = crypto.randomUUID();
          deliverWelcome(account.gsn, now);
          saveState(account.gsn, state);
          db.prepare('UPDATE accounts SET tutorial_completed = 1 WHERE gsn = ?').run(account.gsn);
          return { nick: nickname };
        });
      }
      case 'chest_unlock': {
        if (!account.tutorial_completed) {
          throw new ApiError(4003, 'Complete the tutorial before unlocking reward chests.');
        }
        return mutation(fields, account, state, ['slot_id', 'chest_id', 'chest_instance'], () => {
          const chest = ownedChest(fields, state, 3);
          if (chest.complete_type === '1') {
            return { completeValue: chest.complete_value };
          }
          if (chest.complete_type !== '0') {
            throw new ApiError(4003, 'Chest cannot be unlocked in its current state.');
          }
          if (state.chest_info.some((row) => Number(row.slot_id) >= 3 && row.complete_type === '1'
            && row.complete_value > utcTime(new Date()))) {
            throw new ApiError(4003, 'Another reward chest is already unlocking.');
          }
          const settings = chests.find((row) => String(row.ChestID) === chest.chest_id);
          chest.complete_type = '1';
          chest.complete_value = utcTime(new Date(Date.now() + settings.OpenTime * 60000));
          return { completeValue: chest.complete_value };
        });
      }
      default:
        throw new ApiError(4004, `API ${pg} is not implemented on the local server.`);
    }
  }

  return {
    async handle(request) {
      let pg = '(unparsed)';
      try {
        const fields = await readForm(request);
        pg = fields.pg || '(missing)';
        const data = await dispatch(fields);
        console.log(`API ${pg} -> success`);
        return { status: 200, body: { result: 'success', data } };
      } catch (error) {
        if (error instanceof ApiError) {
          console.warn(`API ${pg} -> ${error.code}: ${error.message}`);
          return {
            status: error.status,
            body: { result: 'error', data: { code: error.code, message: error.message } },
          };
        }
        console.error(`API ${pg} failed:`, error);
        return {
          status: 500,
          body: { result: 'error', data: { code: '5000', message: 'Local database or server failure. Check server logs.' } },
        };
      }
    },
    rewardCallback(url) {
      try {
        return { status: 200, body: monetization.callback(url) };
      } catch (error) {
        if (error instanceof ApiError) {
          console.warn(`Vungle callback -> ${error.code}: ${error.message}`);
          return { status: error.status, body: { error: error.message } };
        }
        console.error('Vungle callback failed:', error);
        return { status: 500, body: { error: 'Reward callback failed. Retry this transaction.' } };
      }
    },
    close() {
      db.close();
    },
  };
}

module.exports = { createGameApi };
