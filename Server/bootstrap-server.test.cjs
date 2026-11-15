const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createBootstrapServer } = require('./bootstrap-server.cjs');

test('legacy config and all 26 client tables are served correctly', async () => {
  const server = createBootstrapServer({ databasePath: ':memory:' });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/mph_config.json`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const config = await response.json();
    assert.equal(typeof config.maintenance, 'string');
    assert.equal(JSON.parse(config.maintenance).onoff, '0');
    assert.equal(typeof config.tabledata, 'string');
    assert.match(config.version, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof config.port, 'string');
    assert.equal(new URL(config.api).pathname, '/mph');
    for (const key of ['moregame_turn', 'interad_turn', 'coupon']) {
      assert.match(config[key], /^-?\d+$/);
    }

    const versions = JSON.parse(config.tabledata);
    const clientSource = fs.readFileSync(path.join(
      __dirname, '..', 'Assets', 'Scripts', 'Assembly-CSharp', 'ConfigData.cs',
    ), 'utf8');
    const tableNamesBlock = clientSource.match(/TABLE_NAMES[\s\S]*?\{([\s\S]*?)\};/);
    assert.ok(tableNamesBlock, 'Client table names must be found');
    const clientNames = [...tableNamesBlock[1].matchAll(/"([A-Za-z]+Table)"/g)]
      .map((match) => match[1]);
    assert.equal(clientNames.length, 26);
    assert.deepEqual(Object.keys(versions).sort(), clientNames.sort());

    for (const name of clientNames) {
      assert.ok(Number.isSafeInteger(versions[name]) && versions[name] >= 0);
      const filename = `JSON${name}.json`;
      const tableResponse = await fetch(`${baseUrl}/${filename}`);
      assert.equal(tableResponse.status, 200, filename);
      const downloaded = Buffer.from(await tableResponse.arrayBuffer());
      assert.deepEqual(downloaded, fs.readFileSync(path.join(
        __dirname, '..', 'Assets', 'Resources', 'jsonres', filename,
      )), filename);
      assert.ok(Array.isArray(JSON.parse(downloaded.toString('utf8'))), filename);
    }

    const head = await fetch(`${baseUrl}/mph_config.json`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const missing = await fetch(`${baseUrl}/not-found.json`);
    assert.equal(missing.status, 404);
    const privateFile = await fetch(`${baseUrl}/bootstrap-server.cjs`);
    assert.equal(privateFile.status, 404);
    const invalidMethod = await fetch(`${baseUrl}/mph_config.json`, { method: 'POST' });
    assert.equal(invalidMethod.status, 405);
    const login = await fetch(`${baseUrl}/mph`, {
      method: 'POST',
      body: new URLSearchParams({ pg: 'check_login' }),
    });
    assert.equal(login.status, 200);
    const invalidLogin = await login.json();
    assert.equal(invalidLogin.result, 'error');
    assert.equal(invalidLogin.data.code, '4000');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

test('public endpoint environment variables override the served client config', async () => {
  const previous = {
    api: process.env.PUBLIC_API_URL,
    host: process.env.PUBLIC_SOCKET_HOST,
    port: process.env.PUBLIC_SOCKET_PORT,
  };
  process.env.PUBLIC_API_URL = 'https://game.example.com/mph';
  process.env.PUBLIC_SOCKET_HOST = '160.250.186.219';
  process.env.PUBLIC_SOCKET_PORT = '38800';
  const server = createBootstrapServer({ databasePath: ':memory:' });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mph_config.json`);
    const config = await response.json();
    assert.equal(config.api, 'https://game.example.com/mph');
    assert.equal(config.host, '160.250.186.219');
    assert.equal(config.port, '38800');
  } finally {
    await new Promise((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    for (const [key, value] of Object.entries({
      PUBLIC_API_URL: previous.api,
      PUBLIC_SOCKET_HOST: previous.host,
      PUBLIC_SOCKET_PORT: previous.port,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
