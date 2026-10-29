import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { sampleLog, startFakeSlingHook, startHandler } from './helpers/fakeServer.js';

// Runs the bundled extension against a fake VS Code and a fake SlingHook server,
// from activation through the live feed, replay, fixtures and sign-in.

const require = createRequire(import.meta.url);
const Module = require('node:module');
const { createFakeVscode, fakeContext } = require('./helpers/fakeVscode.cjs');

let fake;
let handler;
let host;
let context;
let ext;

function loadExtension(vscode) {
    const original = Module._load;
    Module._load = function (request, ...rest) {
        return request === 'vscode' ? vscode : original.call(this, request, ...rest);
    };
    try {
        const path = require.resolve('../dist/extension.cjs');
        delete require.cache[path];
        return require(path);
    } finally {
        Module._load = original;
    }
}

function waitFor(check, ms = 5000) {
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

before(async () => {
    execFileSync(process.execPath, ['esbuild.mjs'], { cwd: new URL('..', import.meta.url), stdio: 'ignore' });
    fake = await startFakeSlingHook();
    handler = await startHandler(200);
    host = createFakeVscode({ settings: { server: fake.url } });
    context = fakeContext();
    await context.secrets.store(`token:${fake.url}`, 'shk_test');
    ext = loadExtension(host.vscode);
    await ext.activate(context);
});

after(async () => {
    for (const d of context.subscriptions) d.dispose();
    await handler.close();
    await fake.close();
});

test('registers every command package.json contributes', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    for (const { command } of manifest.contributes.commands) {
        assert.ok(host.commands.has(command), `${command} is not registered`);
    }
});

test('signs in with the saved token and lists endpoints', () => {
    assert.equal(host.recorded.contexts['slinghook.signedIn'], true);
    const roots = host.tree.getChildren();
    assert.deepEqual(roots, [{ kind: 'endpoint', uuid: fake.state.endpoints[0].uuid }]);
    assert.equal(host.tree.getTreeItem(roots[0]).label, 'Stripe dev');
});

test('expanding an endpoint streams its feed and counts new events', async () => {
    const [endpoint] = host.tree.getChildren();
    host.tree.getChildren(endpoint);
    await waitFor(() => host.tree.getChildren(endpoint)[0]?.kind === 'event');

    const [first] = host.tree.getChildren(endpoint);
    const item = host.tree.getTreeItem(first);
    assert.equal(item.label, '#12 POST invoice.paid');
    assert.equal(item.iconPath.id, 'pass');
    assert.equal(host.tree.getTreeItem(endpoint).description, 'live');

    host.vscode.window.state.focused = false;
    fake.push(sampleLog({ id: 102, number: 13, body: JSON.stringify({ type: 'customer.created' }) }));
    await waitFor(() => host.tree.getChildren(endpoint).length === 2);
    assert.match(host.statusBar.text, /1 new/);
    assert.equal(host.tree.getTreeItem(host.tree.getChildren(endpoint)[0]).label, '#13 POST customer.created');

    await host.vscode.commands.executeCommand('slinghook.showFeed');
    assert.doesNotMatch(host.statusBar.text, /new/);
});

test('opens an event as a JSON tab', async () => {
    await host.vscode.commands.executeCommand('slinghook.openEvent', { kind: 'event', id: 101 });
    const doc = host.recorded.opened.at(-1);
    assert.equal(doc.uri.scheme, 'slinghook-event');
    assert.equal(doc.uri.path, '/#12 POST invoice.paid.json');
    const shown = JSON.parse(doc.getText());
    assert.equal(shown.event_type, 'invoice.paid');
    assert.equal(shown.body.data.object.id, 'in_1');
});

test('replays from the open event tab to the target it asks for, once', async () => {
    host.answers.inputBox.push(handler.url);
    await host.vscode.commands.executeCommand('slinghook.replayEvent');
    assert.equal(handler.received.length, 1);
    assert.match(host.recorded.messages.at(-1).text, /^#12 → HTTP 200 in \d+ ms$/);

    // The second replay reuses the saved target and gets a verdict
    const asked = host.recorded.messages.filter((m) => m.level === 'input').length;
    await host.vscode.commands.executeCommand('slinghook.replayEvent', { kind: 'event', id: 101 });
    assert.equal(host.recorded.messages.filter((m) => m.level === 'input').length, asked);
    assert.match(host.recorded.messages.at(-1).text, /still passing/);
    assert.equal(fake.state.replays.length, 2);
});

test('copies an event as a fixture', async () => {
    await host.vscode.commands.executeCommand('slinghook.copyFixture', { kind: 'event', id: 101 });
    assert.equal(await host.vscode.env.clipboard.readText(), JSON.stringify(JSON.parse(sampleLog().body), null, 2) + '\n');
});

test('generates types, a fixture and a test into new editors', async () => {
    const before = host.recorded.opened.length;
    host.answers.quickPick.push('typescript');
    await host.vscode.commands.executeCommand('slinghook.generateCode', { kind: 'event', id: 101 });
    const opened = host.recorded.opened.slice(before);
    assert.deepEqual(opened.map((d) => d.languageId), ['typescript', 'json', 'javascript']);
    // The test posts to the replay target saved for this endpoint
    assert.ok(opened[2].getText().includes(handler.url.replace('http://', '')));
});

test('signs out, then back in through the browser', async () => {
    await host.vscode.commands.executeCommand('slinghook.signOut');
    assert.equal(host.recorded.contexts['slinghook.signedIn'], false);
    assert.equal(context.secrets.raw.size, 0);
    assert.deepEqual(host.tree.getChildren(), []);
    await waitFor(() => fake.state.streams.length === 0);

    await host.vscode.commands.executeCommand('slinghook.signIn');
    assert.match(host.recorded.external.at(-1), /\/app\/\?device=BCDF-GHJK$/);
    assert.equal(fake.state.logins.get('dev123').clientName.split(' on ')[0], 'VS Code');
    assert.equal(context.secrets.raw.get(`token:${fake.url}`), 'shk_test');
    assert.equal(host.recorded.contexts['slinghook.signedIn'], true);
    assert.match(host.recorded.messages.at(-1).text, /Signed in to SlingHook as dev@example.com/);
});

test('a revoked token signs the person out', async () => {
    fake.state.token = 'rotated';
    host.answers.messages.push(undefined);
    await host.vscode.commands.executeCommand('slinghook.refresh');
    assert.equal(host.recorded.contexts['slinghook.signedIn'], false);
    assert.match(host.recorded.messages.at(-1).text, /expired or was revoked/);
});
