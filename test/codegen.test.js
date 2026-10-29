import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureFor, generateFiles, LANGUAGES } from '../src/codegen.js';
import { formatEvent } from '../src/eventView.js';
import { sampleLog } from './helpers/fakeServer.js';

test('every language gives types and a fixture; all but Go a test', () => {
    for (const key of Object.keys(LANGUAGES)) {
        const { files, notes } = generateFiles(sampleLog(), key, 'http://localhost:3000/webhooks');
        const names = files.map((f) => f.name);
        assert.ok(names.includes('invoice_paid.json'), `${key}: ${names}`);
        assert.equal(files.length, key === 'go' ? 2 : 3, key);
        assert.equal(notes.length, key === 'go' ? 1 : 0, key);
    }
    const ts = generateFiles(sampleLog(), 'typescript', 'http://localhost:3000/webhooks');
    assert.deepEqual(ts.files.map((f) => [f.name, f.language]), [
        ['InvoicePaid.ts', 'typescript'], ['invoice_paid.json', 'json'], ['invoice_paid.test.js', 'javascript']
    ]);
    assert.match(ts.files[2].content, /localhost:3000\/webhooks/);
    // Signature headers expire, so tests leave them out
    assert.doesNotMatch(ts.files[2].content, /Stripe-Signature/i);
});

test('truncated events are refused', () => {
    assert.throws(() => generateFiles(sampleLog({ is_truncated: 1 }), 'php', 'http://x'), /capture limit/);
});

test('fixture is the pretty-printed body', () => {
    assert.equal(fixtureFor(sampleLog()), JSON.stringify(JSON.parse(sampleLog().body), null, 2) + '\n');
    assert.equal(fixtureFor(sampleLog({ body: 'a=1&b=2' })), 'a=1&b=2');
});

test('the event tab inlines a JSON body and keeps other bodies as text', () => {
    const doc = JSON.parse(formatEvent({ ...sampleLog(), event_type: 'invoice.paid' }));
    assert.equal(doc.event, 12);
    assert.equal(doc.event_type, 'invoice.paid');
    assert.equal(doc.body.data.object.id, 'in_1');
    assert.equal(doc.signature, 'valid');
    assert.equal(JSON.parse(formatEvent(sampleLog({ body: '<xml/>' }))).body, '<xml/>');
    assert.match(JSON.parse(formatEvent(sampleLog({ is_truncated: 1 }))).truncated, /capture limit/);
});
