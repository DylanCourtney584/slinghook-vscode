import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catchUrl, endpointLabel, eventLabel, Feed } from '../src/feed.js';
import { sampleEndpoint, sampleLog } from './helpers/fakeServer.js';

test('keeps events newest first, ignores duplicates and caps the list', () => {
    const feed = new Feed({ maxEvents: 2 });
    const changes = [];
    feed.onChange((c) => changes.push(c.type));

    assert.equal(feed.addEvent('a', sampleLog({ id: 1 })), true);
    assert.equal(feed.addEvent('a', sampleLog({ id: 3 }), { live: true }), true);
    assert.equal(feed.addEvent('a', sampleLog({ id: 3 }), { live: true }), false);
    feed.addEvent('a', sampleLog({ id: 2 }));

    assert.deepEqual(feed.eventsFor('a').map((e) => e.id), [3, 2]);
    assert.equal(feed.unseen, 1);
    assert.equal(feed.findEvent(2).uuid, 'a');
    feed.markSeen();
    assert.equal(feed.unseen, 0);
    assert.deepEqual(changes, ['event', 'event', 'event', 'seen']);
});

test('dropping an endpoint from the list forgets its events', () => {
    const feed = new Feed();
    feed.setEndpoints([sampleEndpoint({ uuid: 'a' }), sampleEndpoint({ uuid: 'b' })]);
    feed.addEvent('b', sampleLog());
    feed.setEndpoints([sampleEndpoint({ uuid: 'a' })]);
    assert.deepEqual(feed.eventsFor('b'), []);
});

test('labels name events and endpoints the way the dashboard does', () => {
    assert.equal(eventLabel(sampleLog()), '#12 POST invoice.paid');
    assert.equal(eventLabel(sampleLog({ body: 'plain', headers: {} })), '#12 POST');
    assert.equal(eventLabel(sampleLog({ body: '{}', headers: { 'X-GitHub-Event': 'push' } })), '#12 POST push');

    assert.equal(endpointLabel(sampleEndpoint()), 'Stripe dev');
    assert.equal(endpointLabel(sampleEndpoint({ name: null })), '/c/3a8f9b2c…');
    assert.equal(endpointLabel(sampleEndpoint({ name: null, catch_id: 'stripe-dev' })), '/c/stripe-dev');
});

test('catch URLs use the custom domain when there is one', () => {
    assert.equal(catchUrl(sampleEndpoint({ catch_id: 'stripe' }), 'https://slinghook.co.za'), 'https://slinghook.co.za/c/stripe');
    assert.equal(catchUrl(sampleEndpoint({ catch_id: 'stripe', catch_host: 'hooks.acme.dev' }), 'https://slinghook.co.za'), 'https://hooks.acme.dev/stripe');
});
