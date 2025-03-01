import test from 'ava';
import * as nock from 'nock';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import InMemStorageProvider from '../repository/storage-provider-in-mem';
import FileStorageProvider from '../repository/storage-provider-file';
import Repository from '../repository';
import { DefaultBootstrapProvider } from '../repository/bootstrap-provider';
import { StorageProvider } from '../repository/storage-provider';
import { ClientFeaturesResponse, DeltaEvent } from '../feature';
import { EventEmitter } from 'events';

const appName = 'foo';
const instanceId = 'bar';
const connectionId = 'baz';

// @ts-expect-error
function setup(url, toggles, headers = {}) {
  return nock(url).persist().get('/client/features').reply(200, { features: toggles }, headers);
}

test('should fetch from endpoint', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-0.app';
    const feature = {
      name: 'feature',
      enabled: true,
      strategies: [
        {
          name: 'default',
        },
      ],
    };

    setup(url, [feature]);
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 10,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });

    repo.once('changed', () => {
      const savedFeature = repo.getToggle(feature.name);
      // @ts-expect-error
      t.is(savedFeature.enabled, feature.enabled);
      // @ts-expect-error
      t.is(savedFeature.strategies[0].name, feature.strategies[0].name);

      const featureToggles = repo.getToggles();
      t.is(featureToggles[0].name, 'feature');

      resolve();
    });
    repo.start();
  }));

test('should poll for changes', (t) =>
  new Promise((resolve, reject) => {
    const url = 'http://unleash-test-2.app';
    setup(url, []);
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 10,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });

    let assertCount = 5;
    repo.on('unchanged', resolve);
    repo.on('changed', () => {
      assertCount--;

      if (assertCount === 0) {
        repo.stop();
        t.true(assertCount === 0);
        resolve();
      }
    });

    repo.on('error', reject);
    repo.start();
  }));

test('should retry even if custom header function fails', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-2-custom-headers.app';
    setup(url, []);
    const repo = new Repository({
      // @ts-expect-error
      backupPath: 'foo-bar',
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 10,
      customHeadersFunction: () => {
        throw new Error('custom function fails');
      },
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });

    let assertCount = 2;
    repo.on('error', (error) => {
      if (error.message === 'custom function fails') {
        assertCount--;
      }
      if (assertCount === 0) {
        repo.stop();
        t.true(assertCount === 0);
        resolve();
      }
    });
    repo.start();
  }));

test('should store etag', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-3.app';
    setup(url, [], { Etag: '12345' });
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 10,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });

    repo.once('unchanged', resolve);
    repo.once('changed', () => {
      // @ts-expect-error
      t.true(repo.etag === '12345');

      resolve();
    });
    repo.start();
  }));

test('should request with etag', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-4.app';
    nock(url)
      .matchHeader('If-None-Match', '12345-1')
      .persist()
      .get('/client/features')
      .reply(200, { features: [] }, { Etag: '12345-2' });

    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 10,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });

    // @ts-expect-error
    repo.etag = '12345-1';
    repo.once('unchanged', () => {
      resolve();
    });
    repo.once('changed', () => {
      // @ts-expect-error
      t.true(repo.etag === '12345-2');
      resolve();
    });
    repo.start();
  }));

test('should request with correct custom and unleash headers', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-4-x.app';
    const randomKey = `random-${Math.random()}`;
    nock(url)
      .matchHeader('randomKey', randomKey)
      .matchHeader('unleash-appname', appName)
      .matchHeader('unleash-connection-id', connectionId)
      .matchHeader('unleash-interval', '10')
      .matchHeader('unleash-sdk', /^unleash-client-node:\d+\.\d+\.\d+/)
      .persist()
      .get('/client/features')
      .reply(200, { features: [] }, { Etag: '12345-3' });

    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 10,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      headers: {
        randomKey,
        'unleash-connection-id': 'ignore',
        'unleash-interval': 'ignore',
      },
      mode: { type: 'polling', format: 'full' },
    });

    // @ts-expect-error
    repo.etag = '12345-1';
    repo.once('unchanged', () => {
      resolve();
    });
    repo.once('changed', () => {
      // @ts-expect-error
      t.is(repo.etag, '12345-3');
      resolve();
    });
    repo.start();
  }));

test('request with customHeadersFunction should take precedence over customHeaders', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-4-x.app';
    const randomKey = `random-${Math.random()}`;
    const customHeaderKey = `customer-${Math.random()}`;
    nock(url)
      .matchHeader('customHeaderKey', customHeaderKey)
      .matchHeader('randomKey', (value) => value === undefined)
      .persist()
      .get('/client/features')
      .reply(200, { features: [] }, { Etag: '12345-3' });

    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 10,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      headers: {
        randomKey,
      },
      customHeadersFunction: () => Promise.resolve({ customHeaderKey }),
      mode: { type: 'polling', format: 'full' },
    });

    // @ts-expect-error
    repo.etag = '12345-1';
    repo.once('unchanged', () => {
      resolve();
    });
    repo.once('changed', () => {
      // @ts-expect-error
      t.is(repo.etag, '12345-3');
      resolve();
    });
    repo.start();
  }));

test('should handle 429 request error and emit warn event', async (t) => {
  const url = 'http://unleash-test-6-429.app';
  nock(url).persist().get('/client/features').reply(429, 'blabla');
  const repo = new Repository({
    url,
    appName,
    instanceId,
    connectionId,
    refreshInterval: 10,
    // @ts-expect-error
    bootstrapProvider: new DefaultBootstrapProvider({}),
    storageProvider: new InMemStorageProvider(),
    mode: { type: 'polling', format: 'full' },
  });
  const warning = new Promise<void>((resolve) => {
    repo.on('warn', (warn) => {
      t.truthy(warn);
      t.is(warn, `${url}/client/features responded TOO_MANY_CONNECTIONS (429). Backing off`);
      t.is(repo.getFailures(), 1);
      t.is(repo.nextFetch(), 20);
      resolve();
    });
  });
  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      t.fail('Failed to get warning about connections');
      resolve();
    }, 5000),
  );
  await repo.start();
  await Promise.race([warning, timeout]);
});

test('should handle 401 request error and emit error event', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-6-401.app';
    nock(url).persist().get('/client/features').reply(401, 'blabla');
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 10,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });
    repo.on('error', (err) => {
      t.truthy(err);
      // eslint-disable-next-line max-len
      t.is(
        err.message,
        // eslint-disable-next-line max-len
        `${url}/client/features responded 401 which means your API key is not allowed to connect. Stopping refresh of toggles`,
      );
      resolve();
    });
    repo.start();
  }));

test('should handle 403 request error and emit error event', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-6-403.app';
    nock(url).persist().get('/client/features').reply(403, 'blabla');
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 10,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });
    repo.on('error', (err) => {
      t.truthy(err);
      // eslint-disable-next-line max-len
      t.is(
        err.message,
        // eslint-disable-next-line max-len
        `${url}/client/features responded 403 which means your API key is not allowed to connect. Stopping refresh of toggles`,
      );
      resolve();
    });
    repo.start();
  }));

test('should handle 500 request error and emit warn event', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-6-500.app';
    nock(url).persist().get('/client/features').reply(500, 'blabla');
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 10,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });
    repo.on('warn', (warn) => {
      t.truthy(warn);
      t.is(warn, `${url}/client/features responded 500. Backing off`);
      resolve();
    });
    repo.start();
  }));
test.skip('should handle 502 request error and emit warn event', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-6-502.app';
    nock(url).persist().get('/client/features').reply(502, 'blabla');
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 10,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });
    repo.on('warn', (warn) => {
      t.truthy(warn);
      t.is(warn, `${url}/client/features responded 502. Waiting for 20ms before trying again.`);
      resolve();
    });
    repo.start();
  }));
test.skip('should handle 503 request error and emit warn event', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-6-503.app';
    nock(url).persist().get('/client/features').reply(503, 'blabla');
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 10,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });
    repo.on('warn', (warn) => {
      t.truthy(warn);
      t.is(warn, `${url}/client/features responded 503. Waiting for 20ms before trying again.`);
      resolve();
    });
    repo.start();
  }));
test.skip('should handle 504 request error and emit warn event', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-6-504.app';
    nock(url).persist().get('/client/features').reply(504, 'blabla');
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 10,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });
    repo.on('warn', (warn) => {
      t.truthy(warn);
      t.is(warn, `${url}/client/features responded 504. Waiting for 20ms before trying again.`);
      resolve();
    });
    repo.start();
  }));

test('should handle 304 as silent ok', (t) => {
  t.plan(0);

  return new Promise((resolve, reject) => {
    const url = 'http://unleash-test-6.app';
    nock(url).persist().get('/client/features').reply(304, '');

    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 0,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });
    repo.on('error', reject);
    repo.on('unchanged', resolve);
    process.nextTick(resolve);
    repo.start();
  });
});

test('should handle invalid JSON response', (t) =>
  new Promise((resolve, reject) => {
    const url = 'http://unleash-test-7.app';
    nock(url).persist().get('/client/features').reply(200, '{"Invalid payload');

    // @ts-expect-error
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });
    repo.on('error', (err) => {
      t.truthy(err);
      t.true(
        err.message.indexOf('Unexpected token') > -1 ||
          err.message.indexOf('Unexpected end of JSON input') > -1 ||
          err.message.indexOf('Unterminated string in JSON') > -1,
      );
      resolve();
    });
    repo.on('unchanged', resolve);
    repo.on('changed', reject);
    repo.start();
  }));
/*
test('should respect timeout', t =>
    new Promise((resolve, reject) => {
        const url = 'http://unleash-test-8.app';
        nock(url)
            .persist()
            .get('/client/features')
            .socketDelay(2000)
            .reply(200, 'OK');

        const repo = new Repository({
            url,
            appName,
            instanceId,
            refreshInterval: 0,
            StorageImpl: MockStorage,
            timeout: 50,
        });
        repo.on('error', err => {
            t.truthy(err);
            t.true(err.message.indexOf('ESOCKETTIMEDOUT') > -1);
            resolve();
        });
        repo.on('data', reject);
    }));
*/

test('should emit errors on invalid features', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-1.app';
    setup(url, [
      {
        name: 'feature',
        enabled: null,
        strategies: false,
      },
    ]);
    // @ts-expect-error
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });

    repo.once('error', (err) => {
      t.truthy(err);
      resolve();
    });

    repo.start();
  }));

test('should emit errors on invalid variant', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-1-invalid-bariant.app';
    setup(url, [
      {
        name: 'feature',
        enabled: true,
        strategies: [
          {
            name: 'default',
          },
        ],
        variants: 'not legal',
      },
    ]);
    // @ts-expect-error
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });

    repo.once('error', (err) => {
      t.truthy(err);
      t.is(err.message, 'feature.variants should be an array, but was string');
      resolve();
    });

    repo.start();
  }));

test('should load bootstrap first if faster than unleash-api', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-2-api-url.app';
    const bootstrap = 'http://unleash-test-2-boostrap-url.app';
    nock(url)
      .persist()
      .get('/client/features')
      .delay(100)
      .reply(200, {
        features: [
          {
            name: 'feature',
            enabled: true,
            strategies: [
              {
                name: 'default',
              },
              {
                name: 'unleash-api',
              },
            ],
          },
        ],
      });
    nock(bootstrap)
      .persist()
      .get('/')
      .reply(200, {
        features: [
          {
            name: 'feature',
            enabled: false,
            strategies: [
              {
                name: 'default',
              },
              {
                name: 'bootstrap',
              },
            ],
          },
        ],
      });
    // @ts-expect-error
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({ url: bootstrap }),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });

    let counter = 0;

    repo.on('changed', () => {
      counter++;
      if (counter === 2) {
        // @ts-expect-error
        t.is(repo.getToggle('feature').enabled, true);
        resolve();
      }
    });
    repo.start();
  }));

test('bootstrap should not override actual data', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-2-api-url.app';
    const bootstrap = 'http://unleash-test-2-boostrap-url.app';
    nock(url)
      .persist()
      .get('/client/features')
      .reply(200, {
        features: [
          {
            name: 'feature',
            enabled: true,
            strategies: [
              {
                name: 'default',
              },
              {
                name: 'unleash-api',
              },
            ],
          },
        ],
      });
    nock(bootstrap)
      .persist()
      .get('/')
      .delay(100)
      .reply(200, {
        features: [
          {
            name: 'feature',
            enabled: false,
            strategies: [
              {
                name: 'default',
              },
              {
                name: 'bootstrap',
              },
            ],
          },
        ],
      });
    // @ts-expect-error
    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({ url: bootstrap }),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });

    let counter = 0;

    repo.on('changed', () => {
      counter++;
      if (counter === 2) {
        // @ts-expect-error
        t.is(repo.getToggle('feature').enabled, true);
        resolve();
      }
    });
    repo.start();
  }));

test('should load bootstrap first from file', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-3-api-url.app';
    nock(url).persist().get('/client/features').delay(100).reply(408);

    const path = join(tmpdir(), `test-bootstrap-${Math.round(Math.random() * 100000)}`);
    writeFileSync(
      path,
      JSON.stringify({
        features: [
          {
            name: 'feature-bootstrap',
            enabled: true,
            strategies: [
              {
                name: 'default',
              },
              {
                name: 'bootstrap',
              },
            ],
          },
        ],
      }),
    );

    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 0,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({ filePath: path }),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });

    repo.on('changed', () => {
      // @ts-expect-error
      t.is(repo.getToggle('feature-bootstrap').enabled, true);
      resolve();
    });
    repo.start();
  }));

test('should not crash on bogus bootstrap', (t) =>
  new Promise((resolve) => {
    const url = 'http://unleash-test-4-api-url.app';
    nock(url).persist().get('/client/features').delay(100).reply(408);

    const path = join(tmpdir(), `test-bootstrap-${Math.round(Math.random() * 100000)}`);
    writeFileSync(path, 'just a random blob');

    const repo = new Repository({
      url,
      appName,
      instanceId,
      connectionId,
      refreshInterval: 0,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({ filePath: path }),
      storageProvider: new InMemStorageProvider(),
      mode: { type: 'polling', format: 'full' },
    });

    repo.on('warn', (msg) => {
      t.true(msg.startsWith('Unleash SDK was unable to load bootstrap'));
      resolve();
    });
    repo.start();
  }));

test('should load backup-file', (t) =>
  new Promise((resolve) => {
    const appNameLocal = 'some-backup';
    const url = 'http://unleash-test-backup-api-url.app';
    nock(url).persist().get('/client/features').delay(100).reply(408);

    const backupPath = join(tmpdir());
    const backupFile = join(backupPath, `/unleash-backup-${appNameLocal}.json`);
    writeFileSync(
      backupFile,
      JSON.stringify({
        features: [
          {
            name: 'feature-backup',
            enabled: true,
            strategies: [
              {
                name: 'default',
              },
              {
                name: 'backup',
              },
            ],
          },
        ],
      }),
    );

    const repo = new Repository({
      url,
      appName: appNameLocal,
      instanceId,
      connectionId,
      refreshInterval: 0,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new FileStorageProvider(backupPath),
      mode: { type: 'polling', format: 'full' },
    });

    repo.on('ready', () => {
      // @ts-expect-error
      t.is(repo.getToggle('feature-backup').enabled, true);
      resolve();
    });
    repo.start();
  }));

test('bootstrap should override load backup-file', (t) =>
  new Promise((resolve) => {
    const appNameLocal = 'should_override';
    const url = 'http://unleash-test-backup-api-url.app';
    nock(url).persist().get('/client/features').delay(100).reply(408);

    const backupPath = join(tmpdir());
    const backupFile = join(backupPath, `/unleash-backup-${appNameLocal}.json`);
    writeFileSync(
      backupFile,
      JSON.stringify({
        features: [
          {
            name: 'feature-backup',
            enabled: true,
            strategies: [
              {
                name: 'default',
              },
              {
                name: 'backup',
              },
            ],
          },
        ],
      }),
    );

    const repo = new Repository({
      url,
      appName: appNameLocal,
      instanceId,
      connectionId,
      refreshInterval: 0,
      // @ts-expect-error
      disableFetch: true,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({
        data: [
          {
            name: 'feature-backup',
            enabled: false,
            strategies: [
              {
                name: 'default',
              },
              {
                name: 'bootstrap',
              },
            ],
          },
        ],
      }),
      storageProvider: new FileStorageProvider(backupPath),
      mode: { type: 'polling', format: 'full' },
    });

    repo.on('changed', () => {
      // @ts-expect-error
      t.is(repo.getToggle('feature-backup').enabled, false);
      resolve();
    });
    repo.on('error', () => {});
    repo.start();
  }));

test('bootstrap should not override load backup-file', async (t) => {
  const appNameLocal = 'should_not_override';
  const url = 'http://unleash-test-backup-api-url.app';
  nock(url).persist().get('/client/features').reply(408);

  nock(url)
    .persist()
    .get('/bootstrap')
    .delay(1)
    .reply(200, {
      features: [
        {
          name: 'feature-backup',
          enabled: false,
          strategies: [
            {
              name: 'default',
            },
            {
              name: 'bootstrap',
            },
          ],
        },
      ],
    });

  const storeImp = new InMemStorageProvider();
  storeImp.set(appNameLocal, {
    features: [
      {
        name: 'feature-backup',
        enabled: true,
        strategies: [
          {
            name: 'default',
          },
          {
            name: 'backup',
          },
        ],
      },
    ],
  });

  const repo = new Repository({
    url,
    appName: appNameLocal,
    instanceId,
    connectionId,
    refreshInterval: 0,
    // @ts-expect-error
    bootstrapProvider: new DefaultBootstrapProvider({
      url: `${url}/bootstrap`,
    }),
    bootstrapOverride: false,
    // @ts-expect-error
    storageProvider: storeImp,
    mode: { type: 'polling', format: 'full' },
  });

  repo.on('error', () => {});

  await repo.start();

  // @ts-expect-error
  t.is(repo.getToggle('feature-backup').enabled, true);
});

// Skipped because make-fetch-happens actually automatically retries two extra times on 404
// with a timeout of 1000, this makes us have to wait up to 3 seconds for a single test to succeed
// eslint-disable-next-line max-len
test.skip('Failing two times and then succeed should decrease interval to 2 times initial interval (404)', async (t) => {
  const url = 'http://unleash-test-fail5times.app';
  nock(url).persist().get('/client/features').reply(404);
  const repo = new Repository({
    url,
    appName,
    instanceId,
    connectionId,
    refreshInterval: 10,
    // @ts-expect-error
    bootstrapProvider: new DefaultBootstrapProvider({}),
    storageProvider: new InMemStorageProvider(),
    mode: { type: 'polling', format: 'full' },
  });
  await repo.fetch();
  t.is(1, repo.getFailures());
  t.is(20, repo.nextFetch());
  await repo.fetch();
  t.is(2, repo.getFailures());
  t.is(30, repo.nextFetch());
  nock.cleanAll();
  nock(url)
    .persist()
    .get('/client/features')
    .reply(200, {
      version: 2,
      features: [
        {
          name: 'feature-backup',
          enabled: true,
          strategies: [
            {
              name: 'default',
            },
            {
              name: 'backup',
            },
          ],
        },
      ],
    });

  await repo.fetch();
  t.is(1, repo.getFailures());
  t.is(20, repo.nextFetch());
});

// Skipped because make-fetch-happens actually automatically retries two extra times on 429
// with a timeout of 1000, this makes us have to wait up to 3 seconds for a single test to succeed
// eslint-disable-next-line max-len
test.skip('Failing two times should increase interval to 3 times initial interval (initial interval + 2 * interval)', async (t) => {
  const url = 'http://unleash-test-fail5times.app';
  nock(url).persist().get('/client/features').reply(429);
  const repo = new Repository({
    url,
    appName,
    instanceId,
    connectionId,
    refreshInterval: 10,
    // @ts-expect-error
    bootstrapProvider: new DefaultBootstrapProvider({}),
    storageProvider: new InMemStorageProvider(),
    mode: { type: 'polling', format: 'full' },
  });
  await repo.fetch();
  t.is(1, repo.getFailures());
  t.is(20, repo.nextFetch());
  await repo.fetch();
  t.is(2, repo.getFailures());
  t.is(30, repo.nextFetch());
});

// Skipped because make-fetch-happens actually automatically retries two extra times on 429
// with a timeout of 1000, this makes us have to wait up to 3 seconds for a single test to succeed
// eslint-disable-next-line max-len
test.skip('Failing two times and then succeed should decrease interval to 2 times initial interval (429)', async (t) => {
  const url = 'http://unleash-test-fail5times.app';
  nock(url).persist().get('/client/features').reply(429);
  const repo = new Repository({
    url,
    appName,
    instanceId,
    connectionId,
    refreshInterval: 10,
    // @ts-expect-error
    bootstrapProvider: new DefaultBootstrapProvider({}),
    storageProvider: new InMemStorageProvider(),
    mode: { type: 'polling', format: 'full' },
  });
  await repo.fetch();
  t.is(1, repo.getFailures());
  t.is(20, repo.nextFetch());
  await repo.fetch();
  t.is(2, repo.getFailures());
  t.is(30, repo.nextFetch());
  nock.cleanAll();
  nock(url)
    .persist()
    .get('/client/features')
    .reply(200, {
      version: 2,
      features: [
        {
          name: 'feature-backup',
          enabled: true,
          strategies: [
            {
              name: 'default',
            },
            {
              name: 'backup',
            },
          ],
        },
      ],
    });

  await repo.fetch();
  t.is(1, repo.getFailures());
  t.is(20, repo.nextFetch());
});

test('should handle not finding a given segment id', (t) =>
  new Promise((resolve) => {
    const appNameLocal = 'missing-segments';
    const url = 'http://unleash-test-backup-api-url.app';
    nock(url).persist().get('/client/features').delay(100).reply(408);

    const backupPath = join(tmpdir());
    const backupFile = join(backupPath, `/unleash-backup-${appNameLocal}.json`);
    writeFileSync(
      backupFile,
      JSON.stringify({
        version: 1,
        features: [
          {
            name: 'feature-full-segments',
            enabled: true,
            strategies: [
              {
                name: 'default',
                segments: [5],
              },
              {
                name: 'backup',
                segments: [2, 3],
              },
            ],
          },
        ],
        segments: [
          {
            id: 1,
            constraints: [
              {
                contextName: 'appName',
                operator: 'IN',
                value: 'S1',
                values: [],
                caseInsensitive: false,
                inverted: false,
              },
            ],
          },
          {
            id: 2,
            constraints: [
              {
                contextName: 'appName',
                operator: 'IN',
                value: 'S2',
                values: [],
                caseInsensitive: false,
                inverted: false,
              },
            ],
          },

          {
            id: 3,
            constraints: [
              {
                contextName: 'appName',
                operator: 'IN',
                value: 'S3',
                values: [],
                caseInsensitive: false,
                inverted: false,
              },
            ],
          },
        ],
      }),
    );

    const repo = new Repository({
      url,
      appName: appNameLocal,
      instanceId,
      connectionId,
      refreshInterval: 0,
      // @ts-expect-error
      disableFetch: true,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new FileStorageProvider(backupPath),
      mode: { type: 'polling', format: 'full' },
    });

    repo.on('ready', () => {
      const toggles = repo.getTogglesWithSegmentData();
      t.is(
        toggles?.every((toggle) =>
          toggle.strategies?.every((strategy: any) =>
            strategy?.segments?.some((segment: any) => segment && 'constraints' in segment),
          ),
        ),
        false,
      );
      t.deepEqual(toggles![0]?.strategies![0]?.segments, [undefined]);
      resolve();
    });
    repo.on('error', () => {});
    repo.start();
  }));

test('should handle not having segments to read from', (t) =>
  new Promise((resolve) => {
    const appNameLocal = 'no-segments';
    const url = 'http://unleash-test-backup-api-url.app';
    nock(url).persist().get('/client/features').delay(100).reply(408);

    const backupPath = join(tmpdir());
    const backupFile = join(backupPath, `/unleash-backup-${appNameLocal}.json`);
    writeFileSync(
      backupFile,
      JSON.stringify({
        version: 1,
        features: [
          {
            name: 'feature-full-segments',
            enabled: true,
            strategies: [
              {
                name: 'default',
                segments: [5],
              },
              {
                name: 'backup',
                segments: [2, 3],
              },
            ],
          },
        ],
        segments: [],
      }),
    );

    const repo = new Repository({
      url,
      appName: appNameLocal,
      instanceId,
      connectionId,
      refreshInterval: 0,
      // @ts-expect-error
      disableFetch: true,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new FileStorageProvider(backupPath),
      mode: { type: 'polling', format: 'full' },
    });

    repo.on('ready', () => {
      const toggles = repo.getTogglesWithSegmentData();
      t.deepEqual(toggles![0]?.strategies![0]?.segments, [undefined]);
      t.deepEqual(toggles![0]?.strategies![1]?.segments, [undefined, undefined]);
      resolve();
    });
    repo.on('error', () => {});
    repo.start();
  }));

test('should return full segment data when requested', (t) =>
  new Promise((resolve) => {
    const appNameLocal = 'full-segments';
    const url = 'http://unleash-test-backup-api-url.app';
    nock(url).persist().get('/client/features').delay(100).reply(408);

    const backupPath = join(tmpdir());
    const backupFile = join(backupPath, `/unleash-backup-${appNameLocal}.json`);
    writeFileSync(
      backupFile,
      JSON.stringify({
        version: 1,
        features: [
          {
            name: 'feature-full-segments',
            enabled: true,
            strategies: [
              {
                name: 'default',
                segments: [1],
              },
              {
                name: 'backup',
                segments: [2, 3],
              },
            ],
          },
        ],
        segments: [
          {
            id: 1,
            constraints: [
              {
                contextName: 'appName',
                operator: 'IN',
                value: 'S1',
                values: [],
                caseInsensitive: false,
                inverted: false,
              },
            ],
          },
          {
            id: 2,
            constraints: [
              {
                contextName: 'appName',
                operator: 'IN',
                value: 'S2',
                values: [],
                caseInsensitive: false,
                inverted: false,
              },
            ],
          },

          {
            id: 3,
            constraints: [
              {
                contextName: 'appName',
                operator: 'IN',
                value: 'S3',
                values: [],
                caseInsensitive: false,
                inverted: false,
              },
            ],
          },
        ],
      }),
    );

    const repo = new Repository({
      url,
      appName: appNameLocal,
      instanceId,
      connectionId,
      refreshInterval: 0,
      // @ts-expect-error
      disableFetch: true,
      // @ts-expect-error
      bootstrapProvider: new DefaultBootstrapProvider({}),
      storageProvider: new FileStorageProvider(backupPath),
      mode: { type: 'polling', format: 'full' },
    });

    repo.on('ready', () => {
      const toggles = repo.getTogglesWithSegmentData();
      t.is(
        toggles?.every((toggle) =>
          toggle.strategies?.every((strategy: any) =>
            strategy?.segments.every((segment: any) => 'constraints' in segment),
          ),
        ),
        true,
      );
      resolve();
    });
    repo.on('error', () => {});
    repo.start();
  }));

test('Stopping repository should stop unchanged event reporting', async (t) => {
  t.plan(0);
  const url = 'http://unleash-test-stop-304.app';
  nock(url).persist().get('/client/features').reply(304, '');
  const repo = new Repository({
    url,
    appName,
    instanceId,
    connectionId,
    refreshInterval: 10,
    // @ts-expect-error
    bootstrapProvider: new DefaultBootstrapProvider({}),
    storageProvider: new InMemStorageProvider(),
    mode: { type: 'polling', format: 'full' },
  });
  repo.on('unchanged', () => {
    t.fail('Should not emit unchanged event after stopping');
  });

  const promise = repo.fetch();
  repo.stop(); // remove all listeners
  await promise;
});

test('Stopping repository should stop storage provider updates', async (t) => {
  t.plan(1);
  const url = 'http://unleash-test-stop-200.app';
  const feature = {
    name: 'feature',
    enabled: true,
    strategies: [
      {
        name: 'default',
      },
    ],
  };
  setup(url, [feature]);
  const storageProvider: StorageProvider<ClientFeaturesResponse> = new InMemStorageProvider();
  const repo = new Repository({
    url,
    appName,
    instanceId,
    connectionId,
    refreshInterval: 10,
    // @ts-expect-error
    bootstrapProvider: new DefaultBootstrapProvider({}),
    storageProvider,
    mode: { type: 'polling', format: 'full' },
  });

  const promise = repo.fetch();
  repo.stop(); // stop storage provider from accepting commands
  await promise;

  const result = await storageProvider.get(appName);
  t.is(result, undefined);
});

test('Streaming deltas', async (t) => {
  t.plan(8);
  const url = 'http://unleash-test-streaming.app';
  const feature = {
    name: 'feature',
    enabled: true,
    strategies: [
      {
        name: 'default',
      },
    ],
  };
  setup(url, [{ ...feature, name: 'initialFetch' }]);
  const storageProvider: StorageProvider<ClientFeaturesResponse> = new InMemStorageProvider();
  const eventSource: any = {
    eventEmitter: new EventEmitter(),
    listeners: new Set<string>(),
    addEventListener(eventName: string, handler: () => void) {
      eventSource.listeners.add(eventName);
      eventSource.eventEmitter.on(eventName, handler);
    },
    close() {
      eventSource.listeners.forEach((eventName: string) => {
        eventSource.eventEmitter.removeAllListeners(eventName);
      });
    },
    emit(eventName: string, data: unknown) {
      eventSource.eventEmitter.emit(eventName, data);
    },
  };

  const repo = new Repository({
    url,
    appName,
    instanceId,
    connectionId,
    refreshInterval: 10,
    // @ts-expect-error
    bootstrapProvider: new DefaultBootstrapProvider({}),
    storageProvider,
    eventSource,
    mode: { type: 'streaming' },
  });

  await repo.start();

  // first connection is ignored, since we do regular fetch
  eventSource.emit('unleash-connected', {
    type: 'unleash-connected',
    data: JSON.stringify({
      events: [
        {
          type: 'hydration',
          eventId: 1,
          features: [{ ...feature, name: 'deltaFeature' }],
          segments: [],
        },
      ],
    }),
  });

  const before = repo.getToggles();
  t.deepEqual(before, [{ ...feature, name: 'deltaFeature' }]);

  // update with feature
  eventSource.emit('unleash-updated', {
    type: 'unleash-updated',
    data: JSON.stringify({
      events: [
        {
          type: 'feature-updated',
          eventId: 2,
          feature: { ...feature, enabled: false, name: 'deltaFeature' },
        },
      ],
    }),
  });
  const firstUpdate = repo.getToggles();
  t.deepEqual(firstUpdate, [{ ...feature, enabled: false, name: 'deltaFeature' }]);

  eventSource.emit('unleash-updated', {
    type: 'unleash-updated',
    data: JSON.stringify({
      events: [
        {
          type: 'feature-removed',
          eventId: 3,
          featureName: 'deltaFeature',
          project: 'irrelevant',
        },
      ],
    }),
  });
  const secondUpdate = repo.getToggles();
  t.deepEqual(secondUpdate, []);

  eventSource.emit('unleash-updated', {
    type: 'unleash-updated',
    data: JSON.stringify({
      events: [
        {
          type: 'segment-updated',
          eventId: 4,
          segment: { id: 1, constraints: [] },
        },
      ],
    }),
  });
  const segment = repo.getSegment(1);
  t.deepEqual(segment, { id: 1, constraints: [] });

  eventSource.emit('unleash-updated', {
    type: 'unleash-updated',
    data: JSON.stringify({
      events: [
        {
          type: 'segment-removed',
          eventId: 5,
          segmentId: 1,
        },
      ],
    }),
  });
  const removedSegment = repo.getSegment(1);
  t.deepEqual(removedSegment, undefined);

  // SSE error translated to repo warning
  repo.on('warn', (msg) => {
    t.is(msg, 'some error');
  });
  eventSource.emit('error', 'some error');

  // re-connect simulation
  eventSource.emit('unleash-connected', {
    type: 'unleash-connected',
    data: JSON.stringify({
      events: [
        {
          type: 'hydration',
          eventId: 6,
          features: [{ ...feature, name: 'reconnectUpdate' }],
          segments: [],
        },
      ],
    }),
  });
  const reconnectUpdate = repo.getToggles();
  t.deepEqual(reconnectUpdate, [{ ...feature, name: 'reconnectUpdate' }]);

  // Invalid data error translated to repo error
  repo.on('error', (error) => {
    t.true(error.message.startsWith(`Invalid delta response:`));
  });
  eventSource.emit('unleash-updated', {
    type: 'unleash-updated',
    data: JSON.stringify({
      incorrectEvents: [],
    }),
  });
});

function setupPollingDeltaApi(url: string, events: DeltaEvent[]) {
  return nock(url).get('/client/delta').reply(200, { events });
}

test('Polling delta', async (t) => {
  const url = 'http://unleash-test-polling-delta.app';
  const feature = {
    name: 'deltaFeature',
    enabled: true,
    strategies: [],
  };
  setupPollingDeltaApi(url, [
    {
      type: 'hydration',
      eventId: 1,
      features: [feature],
      segments: [],
    },
  ]);
  const storageProvider: StorageProvider<ClientFeaturesResponse> = new InMemStorageProvider();

  const repo = new Repository({
    url,
    appName,
    instanceId,
    connectionId,
    refreshInterval: 10,
    // @ts-expect-error
    bootstrapProvider: new DefaultBootstrapProvider({}),
    storageProvider,
    mode: { type: 'polling', format: 'delta' },
  });
  await repo.fetch();

  const before = repo.getToggles();
  t.deepEqual(before, [feature]);

  setupPollingDeltaApi(url, [
    {
      type: 'feature-updated',
      eventId: 2,
      feature: { ...feature, enabled: false },
    },
  ]);
  await repo.fetch();

  const updatedFeature = repo.getToggles();
  t.deepEqual(updatedFeature, [{ ...feature, enabled: false }]);

  setupPollingDeltaApi(url, [
    {
      type: 'feature-removed',
      eventId: 3,
      featureName: feature.name,
      project: 'irrelevant',
    },
  ]);
  await repo.fetch();

  const noFeatures = repo.getToggles();
  t.deepEqual(noFeatures, []);

  setupPollingDeltaApi(url, [
    {
      type: 'segment-updated',
      eventId: 4,
      segment: { id: 1, constraints: [] },
    },
  ]);
  await repo.fetch();

  const segment = repo.getSegment(1);
  t.deepEqual(segment, { id: 1, constraints: [] });

  setupPollingDeltaApi(url, [
    {
      type: 'segment-removed',
      eventId: 5,
      segmentId: 1,
    },
  ]);
  await repo.fetch();

  const noSegment = repo.getSegment(1);
  t.deepEqual(noSegment, undefined);
});
