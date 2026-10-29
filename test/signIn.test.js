import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMe, normalizeServer, signInWithBrowser } from '../src/signIn.js';
import { startFakeSlingHook } from './helpers/fakeServer.js';

test('browser sign-in shows the code, polls until approved and returns the token', async () => {
    const fake = await startFakeSlingHook();
    let shown = null;
    const result = await signInWithBrowser({
        server: fake.url,
        clientName: 'VS Code on dev-box',
        onCode: (info) => { shown = info; },
        sleep: () => Promise.resolve()
    });

    assert.deepEqual(result, { token: 'shk_test', email: 'dev@example.com' });
    assert.equal(shown.userCode, 'BCDF-GHJK');
    assert.match(shown.urlWithCode, /\/app\/\?device=BCDF-GHJK$/);
    assert.equal(fake.state.logins.get('dev123').clientName, 'VS Code on dev-box');
    await fake.close();
});

test('browser sign-in returns null when cancelled', async () => {
    const fake = await startFakeSlingHook();
    const result = await signInWithBrowser({
        server: fake.url, clientName: 'x', onCode() {}, isCancelled: () => true, sleep: () => Promise.resolve()
    });
    assert.equal(result, null);
    await fake.close();
});

test('fetchMe returns null for a refused token and throws when the server is down', async () => {
    const fake = await startFakeSlingHook();
    assert.equal((await fetchMe({ server: fake.url, token: 'shk_test' })).email, 'dev@example.com');
    assert.equal(await fetchMe({ server: fake.url, token: 'nope' }), null);
    await fake.close();
    await assert.rejects(fetchMe({ server: fake.url, token: 'shk_test' }));
});

test('normalizeServer tidies what people paste', () => {
    assert.equal(normalizeServer('hooks.example.com'), 'https://hooks.example.com');
    assert.equal(normalizeServer('https://hooks.example.com/app/'), 'https://hooks.example.com');
    assert.equal(normalizeServer('http://localhost:8080/'), 'http://localhost:8080');
    assert.equal(normalizeServer('https://example.com/slinghook/app/?x=1'), 'https://example.com/slinghook');
    assert.equal(normalizeServer('ftp://example.com'), null);
    assert.equal(normalizeServer(''), null);
});
