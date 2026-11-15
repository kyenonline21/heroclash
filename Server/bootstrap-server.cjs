const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createGameApi } = require('./game-api.cjs');
const { createMicrosoftStore } = require('./microsoft-store.cjs');
const { createAmazonStore } = require('./amazon-store.cjs');

function createBootstrapServer({
  databasePath = path.join(__dirname, 'data', 'game.sqlite'),
  monetizationConfig = JSON.parse(fs.readFileSync(path.join(
    __dirname, '..', 'Assets', 'Resources', 'UwpMonetization.json'), 'utf8')),
  store = createMicrosoftStore(),
  amazonStore = createAmazonStore(),
  callbackSecret = process.env.VUNGLE_CALLBACK_SECRET,
} = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'bootstrap-config.json'), 'utf8'));
  config.api = process.env.PUBLIC_API_URL || config.api;
  config.host = process.env.PUBLIC_SOCKET_HOST || config.host;
  config.port = process.env.PUBLIC_SOCKET_PORT || config.port;
  const tablesDirectory = path.join(__dirname, '..', 'Assets', 'Resources', 'jsonres');
  const routes = new Map();
  const tables = new Map();

  for (const [name, version] of Object.entries(config.tabledata)) {
    if (!/^[A-Za-z]+Table$/.test(name) || !Number.isSafeInteger(version) || version < 0) {
      throw new Error(`Invalid table name or version: ${name}`);
    }
    const filename = `JSON${name}.json`;
    const content = fs.readFileSync(path.join(tablesDirectory, filename));
    const rows = JSON.parse(content.toString('utf8'));
    if (!Array.isArray(rows)) {
      throw new Error(`Table must contain a JSON array: ${filename}`);
    }
    routes.set(`/${filename}`, content);
    tables.set(name, rows);
  }

  const weeklyRewardRows = JSON.parse(fs.readFileSync(
    path.join(tablesDirectory, 'JSONWeeklyRankingRewardTable.json'), 'utf8',
  ));
  if (!Array.isArray(weeklyRewardRows)) {
    throw new Error('WeeklyRankingRewardTable must contain a JSON array.');
  }
  tables.set('WeeklyRankingRewardTable', weeklyRewardRows);

  // The legacy Unity parser expects these nested objects as JSON strings.
  routes.set('/mph_config.json', Buffer.from(JSON.stringify({
    ...config,
    maintenance: JSON.stringify(config.maintenance),
    tabledata: JSON.stringify(config.tabledata),
  })));

  const api = createGameApi({ tables, databasePath, monetizationConfig, store, amazonStore, callbackSecret });
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    let status = 200;
    let body;
    if (pathname === '/mph') {
      if (request.method !== 'POST') {
        status = 405;
        response.setHeader('Allow', 'POST');
        body = Buffer.from(JSON.stringify({ result: 'error', data: { code: '4000', message: 'Use POST for /mph.' } }));
      } else {
        const result = await api.handle(request);
        status = result.status;
        body = Buffer.from(JSON.stringify(result.body));
      }
    } else if (pathname === '/vungle/reward') {
      if (request.method !== 'GET') {
        status = 405;
        response.setHeader('Allow', 'GET');
        body = Buffer.from(JSON.stringify({ error: 'Use GET for the Vungle callback.' }));
      } else {
        const result = api.rewardCallback(new URL(request.url, 'http://localhost'));
        status = result.status;
        body = Buffer.from(JSON.stringify(result.body));
      }
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      status = 405;
      response.setHeader('Allow', 'GET, HEAD');
      body = Buffer.from(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }));
    } else if (routes.has(pathname)) {
      body = routes.get(pathname);
    } else {
      status = 404;
      body = Buffer.from(JSON.stringify({ error: 'NOT_FOUND' }));
    }
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
    console.log(`${request.method} ${pathname} -> ${status}`);
  });
  server.requestTimeout = 15000;
  server.on('close', () => api.close());
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 38500);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const server = createBootstrapServer();
  server.on('error', (error) => {
    console.error('Bootstrap server failed:', error);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Bootstrap server: http://${host}:${port}/mph_config.json`);
    console.log('Config and tables are loaded at startup. Restart after editing them.');
    console.log('Local guest login, lobby, heroes and tutorial nickname/chest unlock are available.');
    console.log('Database: Server\\data\\game.sqlite. Guest-only development server; do not expose publicly.');
    console.log('Bot battle entry fees and results are available. Local clients stay in bot matchmaking.');
    console.log('Chest timers/opening and hero skill upgrades are available.');
    console.log('Total/weekly ranking is available; weekly reset: Monday 00:00 UTC+7.');
    console.log('Shop: daily cards, gold/chests for jewels, paid rerolls and daily gift (00:00 UTC).');
    console.log('Original tutorial, quest/achievement, chest and level-up jewel rewards are restored.');
    console.log('Daily quests reset at 00:00 UTC. BR fee/payouts stay unchanged.');
    console.log('League settlement and pending league/global Top 50 reward chests are available (Monday 00:00 UTC+7).');
    console.log('Mailbox: one welcome gift (100 gold + chest 304001), no fixed 5-jewel bonus; 7-day expiry.');
    console.log('UWP Store packs and Vungle rewards require UwpMonetization.json and server credentials; disabled until configured.');
    console.log('Gold Doubler, external accounts and Socket.IO are NOT implemented.');
  });
}

module.exports = { createBootstrapServer };
