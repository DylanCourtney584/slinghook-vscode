import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followEndpoint, StreamAuthError } from '../src/stream.js';
import { sampleEndpoint, sampleLog, startFakeSlingHook } from './helpers/fakeServer.js';

const uuid = sampleEndpoint().uuid;

function waitFor(check, ms = 2000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            if (check()) return resolve();
            if (Date.now() - started > ms) return reject(new Error('timed out'));
            setTimeout(tick, 10);
        };
        tick();
    });
}

test('streams the backlog as not live, then new events as live', async () => {
    const fake = await startFakeSlingHook();
    const seen = [];
    const statuses = [];
    const controller = new AbortController();
    const done = followEndpoint({
        server: fake.url, token: 'shk_test', endpointUuid: uuid, signal: controller.signal,
        onEvent: (log, info) => seen.push({ id: log.id, live: info.live }),
        onStatus: (s) => statuses.push(s)
    });

    await waitFor(() => seen.length === 1);
    fake.push(sampleLog({ id: 102, number: 13 }));
    await waitFor(() => seen.length === 2);

    assert.deepEqual(seen, [{ id: 101, live: false }, { id: 102, live: true }]);
    assert.deepEqual(statuses, ['connecting', 'live']);
    assert.equal(fake.state.requests.at(-1).headers.authorization, 'Bearer shk_test');

    controller.abort();
    await done;
    await fake.close();
});

test('reconnects with Last-Event-ID after the server closes the stream', async () => {
    const fake = await startFakeSlingHook();
    const seen = [];
    const controller = new AbortController();
    const done = followEndpoint({
        server: fake.url, token: 'shk_test', endpointUuid: uuid, signal: controller.signal,
        onEvent: (log) => seen.push(log.id), sleep: () => Promise.resolve()
    });

    await waitFor(() => fake.state.streams.length === 1 && seen.length === 1);
    fake.state.streams[0].res.end();
    await waitFor(() => fake.state.requests.filter((r) => r.path.startsWith('/v1/events')).length === 2);

    const second = fake.state.requests.filter((r) => r.path.startsWith('/v1/events'))[1];
    assert.equal(second.headers['last-event-id'], '101');
    assert.deepEqual(seen, [101]);

    controller.abort();
    await done;
    await fake.close();
});

test('a refused token rejects with StreamAuthError', async () => {
    const fake = await startFakeSlingHook();
    await assert.rejects(
        followEndpoint({ server: fake.url, token: 'wrong', endpointUuid: uuid, signal: new AbortController().signal, onEvent() {} }),
        StreamAuthError
    );
    await fake.close();
});

test('an endpoint outside the workspace rejects', async () => {
    const fake = await startFakeSlingHook();
    await assert.rejects(
        followEndpoint({ server: fake.url, token: 'shk_test', endpointUuid: '00000000-0000-4000-8000-000000000000', signal: new AbortController().signal, onEvent() {} }),
        /not found/
    );
    await fake.close();
});
