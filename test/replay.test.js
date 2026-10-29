import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/shared/api.js';
import { checkTarget, describeReplay, replayEvent } from '../src/replay.js';
import { sampleLog, startFakeSlingHook, startHandler } from './helpers/fakeServer.js';

test('replays to the local handler, records it and works out the verdict', async () => {
    const fake = await startFakeSlingHook();
    const handler = await startHandler(500);
    const api = createApi({ server: fake.url, token: 'shk_test' });
    const log = sampleLog();

    const first = await replayEvent({ api, log, target: handler.url });
    assert.equal(first.status, 500);
    assert.equal(first.passed, false);
    assert.equal(first.recorded, true);
    assert.equal(first.verdict, null);

    handler.status = 200;
    const second = await replayEvent({ api, log, target: handler.url });
    assert.equal(second.verdict, 'fixed');
    assert.match(describeReplay(log, second), /^#12 → HTTP 200 in \d+ ms · fixed/);

    // The original headers go along, marked as a replay
    const sent = handler.received[1];
    assert.equal(sent.headers['stripe-signature'], 't=1,v1=abc');
    assert.equal(sent.headers['x-webhook-replay'], 'true');
    assert.equal(sent.body, log.body);
    assert.equal(fake.state.replays.length, 2);
    assert.equal(fake.state.replays[1].target_url, handler.url);

    await handler.close();
    await fake.close();
});

test('an invalid signature should be rejected, so a 4xx passes', async () => {
    const fake = await startFakeSlingHook();
    const handler = await startHandler(401);
    const api = createApi({ server: fake.url, token: 'shk_test' });
    const outcome = await replayEvent({ api, log: sampleLog({ signature_status: 'invalid' }), target: handler.url });
    assert.equal(outcome.passed, true);
    assert.match(describeReplay(sampleLog(), outcome), /rejected, as it should be/);
    await handler.close();
    await fake.close();
});

test('a handler that is down is reported, not thrown', async () => {
    const fake = await startFakeSlingHook();
    const api = createApi({ server: fake.url, token: 'shk_test' });
    const down = await startHandler();
    await down.close();
    const outcome = await replayEvent({ api, log: sampleLog(), target: down.url });
    assert.equal(outcome.status, null);
    assert.match(outcome.error, /Connection refused/);
    await fake.close();
});

test('checkTarget accepts http(s) URLs only', () => {
    assert.equal(checkTarget('http://localhost:3000/webhooks').url, 'http://localhost:3000/webhooks');
    assert.ok(checkTarget('localhost:3000').error);
    assert.ok(checkTarget('file:///etc/passwd').error);
});
