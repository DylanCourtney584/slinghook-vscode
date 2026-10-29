import * as vscode from 'vscode';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createApi } from './shared/api.js';
import { fetchMe, normalizeServer, signInWithBrowser } from './signIn.js';
import { followEndpoint, StreamAuthError } from './stream.js';
import { catchUrl, endpointLabel, eventLabel, Feed } from './feed.js';
import { eventFileName, formatEvent } from './eventView.js';
import { fixtureFor, generateFiles, LANGUAGES } from './codegen.js';
import { checkTarget, describeReplay, replayEvent } from './replay.js';

const EVENT_SCHEME = 'slinghook-event';
const DEFAULT_TARGET = 'http://localhost:3000/webhooks';

/** @param {vscode.ExtensionContext} context */
export async function activate(context) {
    const ext = new SlingHookExtension(context);
    context.subscriptions.push(ext);
    await ext.start();
}

export function deactivate() {}

class SlingHookExtension {
    /** @param {vscode.ExtensionContext} context */
    constructor(context) {
        this.context = context;
        this.server = configuredServer();
        this.token = null;
        this.me = null;
        this.feed = new Feed({ maxEvents: config().get('eventsPerEndpoint', 50) });
        /** @type {Map<string, AbortController>} endpoint uuid -> its open stream */
        this.streams = new Map();
        /** @type {Map<number, object>} full log rows by id, for the event tabs */
        this.fullLogs = new Map();
        this.reloading = Promise.resolve();
        this.disposables = [];

        this.tree = new FeedTree(this);
        this.treeView = vscode.window.createTreeView('slinghook.feed', { treeDataProvider: this.tree, showCollapseAll: true });
        this.treeView.onDidCollapseElement(({ element }) => {
            if (element.kind === 'endpoint') this.unfollow(element.uuid);
        }, null, this.disposables);
        this.treeView.onDidChangeVisibility(({ visible }) => {
            if (visible) this.feed.markSeen();
        }, null, this.disposables);

        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
        this.statusBar.command = 'slinghook.showFeed';

        this.events = new EventDocuments(this);

        this.feed.onChange((change) => this.onFeedChange(change));
        this.disposables.push(this.treeView, this.statusBar, this.tree, this.events,
            vscode.workspace.registerTextDocumentContentProvider(EVENT_SCHEME, this.events),
            vscode.workspace.onDidChangeConfiguration((e) => this.onConfigChange(e)));

        this.registerCommands();
    }

    async start() {
        await this.loadSession();
    }

    dispose() {
        this.stopAllStreams();
        for (const d of this.disposables) d.dispose();
    }

    api() {
        return createApi({ server: this.server, token: this.token });
    }

    // ---------------------------------------------------------------------
    // Session
    // ---------------------------------------------------------------------

    secretKey() {
        return `token:${this.server}`;
    }

    /** Picks up the saved token for the configured server, if any */
    loadSession() {
        // Serialized, so a settings change and a sign-in can't interleave
        this.reloading = this.reloading.then(async () => {
            this.stopAllStreams();
            this.feed.clear();
            this.fullLogs.clear();
            this.server = configuredServer();
            this.loadError = null;
            this.token = (await this.context.secrets.get(this.secretKey())) ?? null;
            this.me = null;

            if (this.token) {
                try {
                    this.me = await fetchMe({ server: this.server, token: this.token });
                    if (!this.me) {
                        await this.forgetToken();
                        vscode.window.showWarningMessage('Your SlingHook sign-in has expired. Sign in again to see your feed.', 'Sign In')
                            .then((choice) => choice && vscode.commands.executeCommand('slinghook.signIn'));
                    }
                } catch (err) {
                    // Server unreachable: keep the token and let Refresh try again
                    this.loadError = err.message;
                }
            }
            await this.setSignedIn(Boolean(this.token));
            if (this.token) await this.loadEndpoints();
        });
        return this.reloading;
    }

    async setSignedIn(signedIn) {
        await vscode.commands.executeCommand('setContext', 'slinghook.signedIn', signedIn);
        this.updateStatusBar();
        this.tree.refresh();
    }

    async saveToken(token) {
        await this.context.secrets.store(this.secretKey(), token);
        await this.loadSession();
    }

    async forgetToken() {
        await this.context.secrets.delete(this.secretKey());
        this.token = null;
        this.me = null;
    }

    async loadEndpoints() {
        try {
            const { endpoints = [] } = await this.api().get('/api/endpoints');
            this.loadError = null;
            this.feed.setEndpoints(endpoints);
        } catch (err) {
            if (err.status === 401) return this.signedOutByServer();
            this.loadError = `Could not load endpoints from ${this.server}: ${err.cause?.message || err.message}`;
            this.tree.refresh();
        }
    }

    async signedOutByServer() {
        // Every open stream sees the same 401; react once
        if (!this.token) return;
        await this.forgetToken();
        this.stopAllStreams();
        this.feed.clear();
        await this.setSignedIn(false);
        const choice = await vscode.window.showWarningMessage('Your SlingHook sign-in has expired or was revoked.', 'Sign In');
        if (choice) vscode.commands.executeCommand('slinghook.signIn');
    }

    async signIn() {
        await this.reloading;
        const editor = vscode.env.appName.replace(/^Visual Studio /, 'VS ');
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'SlingHook',
            cancellable: true
        }, async (progress, cancel) => {
            progress.report({ message: 'Starting sign-in…' });
            return signInWithBrowser({
                server: this.server,
                clientName: `${editor} on ${hostname()}`,
                isCancelled: () => cancel.isCancellationRequested,
                sleep: (ms) => cancellableSleep(ms, cancel),
                onCode: async ({ userCode, urlWithCode }) => {
                    progress.report({ message: `Approve code ${userCode} in your browser. Waiting…` });
                    const opened = await vscode.env.openExternal(vscode.Uri.parse(urlWithCode));
                    if (!opened) {
                        vscode.window.showInformationMessage(`Open ${urlWithCode} and approve code ${userCode}.`, 'Copy Link')
                            .then((choice) => choice && vscode.env.clipboard.writeText(urlWithCode));
                    }
                }
            });
        });
        if (!result) return;

        await this.saveToken(result.token);
        vscode.window.showInformationMessage(`Signed in to SlingHook${result.email ? ` as ${result.email}` : ''}.`);
    }

    async signInWithToken() {
        await this.reloading;
        const token = await vscode.window.showInputBox({
            title: `Sign in to ${this.server}`,
            prompt: 'Paste an API token from User Settings > API Tokens',
            password: true,
            ignoreFocusOut: true
        });
        if (!token?.trim()) return;

        const me = await fetchMe({ server: this.server, token: token.trim() });
        if (!me) {
            vscode.window.showErrorMessage(`${this.server} refused that token. Check you copied all of it, and that it wasn't revoked.`);
            return;
        }
        await this.saveToken(token.trim());
        vscode.window.showInformationMessage(`Signed in to SlingHook as ${me.email}.`);
    }

    async signInSelfHosted() {
        const value = await vscode.window.showInputBox({
            title: 'Your SlingHook server',
            prompt: 'The address you open the dashboard on, without /app',
            placeHolder: 'https://hooks.example.com',
            value: this.server === DEFAULT_SERVER ? '' : this.server,
            ignoreFocusOut: true,
            validateInput: (v) => (normalizeServer(v) ? null : 'Enter an http:// or https:// address')
        });
        const server = normalizeServer(value);
        if (!server) return;

        await config().update('server', server === DEFAULT_SERVER ? undefined : server, vscode.ConfigurationTarget.Global);
        await this.loadSession();
        if (!this.token) await this.signIn();
    }

    async signOut() {
        await this.forgetToken();
        this.stopAllStreams();
        this.feed.clear();
        await this.setSignedIn(false);
        vscode.window.showInformationMessage('Signed out of SlingHook. The token was removed from VS Code; revoke it under User Settings > API Tokens if it may have leaked.');
    }

    onConfigChange(e) {
        if (e.affectsConfiguration('slinghook.server') && configuredServer() !== this.server) {
            this.loadSession();
        }
        if (e.affectsConfiguration('slinghook.eventsPerEndpoint')) {
            this.feed.setMaxEvents(config().get('eventsPerEndpoint', 50));
        }
    }

    // ---------------------------------------------------------------------
    // Streams
    // ---------------------------------------------------------------------

    /** Starts streaming an endpoint's feed, once */
    follow(uuid) {
        if (!this.token || this.streams.has(uuid)) return;
        const controller = new AbortController();
        this.streams.set(uuid, controller);
        this.updateStatusBar();

        followEndpoint({
            server: this.server,
            token: this.token,
            endpointUuid: uuid,
            signal: controller.signal,
            onEvent: (log, { live }) => this.feed.addEvent(uuid, log, { live }),
            onStatus: (state, detail) => this.feed.setStatus(uuid, state, detail)
        }).catch((err) => {
            if (controller.signal.aborted) return;
            if (err instanceof StreamAuthError) {
                this.signedOutByServer();
                return;
            }
            this.feed.setStatus(uuid, 'error', err.message);
        }).finally(() => {
            if (this.streams.get(uuid) === controller) this.streams.delete(uuid);
            this.updateStatusBar();
        });
    }

    unfollow(uuid) {
        this.streams.get(uuid)?.abort();
        this.streams.delete(uuid);
        this.feed.setStatus(uuid, 'paused');
        this.updateStatusBar();
    }

    stopAllStreams() {
        for (const controller of this.streams.values()) controller.abort();
        this.streams.clear();
        this.updateStatusBar();
    }

    onFeedChange(change) {
        this.tree.refreshSoon();
        if (change.type === 'event' && change.live) {
            if (this.treeView.visible && vscode.window.state.focused) {
                this.feed.markSeen();
            }
            if (config().get('notifyOnNewEvents', false)) this.notifyNewEvent(change.uuid, change.log);
        }
        if (change.type === 'event' || change.type === 'seen') this.updateStatusBar();
    }

    async notifyNewEvent(uuid, log) {
        const ep = this.feed.endpoint(uuid);
        const choice = await vscode.window.showInformationMessage(
            `New webhook on ${ep ? endpointLabel(ep) : 'SlingHook'}: ${eventLabel(log)}`, 'Open', 'Replay');
        if (choice === 'Open') vscode.commands.executeCommand('slinghook.openEvent', { kind: 'event', id: log.id });
        if (choice === 'Replay') vscode.commands.executeCommand('slinghook.replayEvent', { kind: 'event', id: log.id });
    }

    updateStatusBar() {
        if (!this.token) {
            this.statusBar.hide();
            return;
        }
        const following = this.streams.size;
        const unseen = this.feed.unseen;
        this.statusBar.text = `$(radio-tower) SlingHook${unseen ? ` · ${unseen} new` : ''}`;
        this.statusBar.tooltip = following
            ? `Listening on ${following} endpoint${following === 1 ? '' : 's'}${unseen ? `. ${unseen} new event${unseen === 1 ? '' : 's'} since you last looked.` : '.'}`
            : 'Expand an endpoint in the SlingHook feed to listen for webhooks.';
        this.statusBar.show();
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /** The full log row for an event, fetched once per tab */
    async fullLog(id, { fresh = false } = {}) {
        if (!fresh && this.fullLogs.has(id)) return this.fullLogs.get(id);
        const { log } = await this.api().get(`/api/logs/${id}`);
        this.fullLogs.set(id, log);
        return log;
    }

    endpointUuidFor(log) {
        return this.feed.findEvent(log.id)?.uuid
            ?? this.feed.endpoints.find((ep) => ep.id === log.endpoint_id)?.uuid
            ?? `endpoint-${log.endpoint_id}`;
    }

    /** The event id a command was run on: a tree item, an event tab's uri, or the active event tab */
    eventIdFrom(arg) {
        if (arg?.kind === 'event') return arg.id;
        const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
        if (uri?.scheme === EVENT_SCHEME) {
            const id = Number(new URLSearchParams(uri.query).get('id'));
            if (Number.isInteger(id) && id > 0) return id;
        }
        return null;
    }

    async openEvent(arg) {
        const id = this.eventIdFrom(arg);
        if (!id) return;
        const log = await this.fullLog(id, { fresh: true });
        const uri = vscode.Uri.from({ scheme: EVENT_SCHEME, path: `/${eventFileName(log, eventLabel(log))}`, query: `id=${id}` });
        this.events.changed(uri);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
    }

    /** The saved replay target for an endpoint, or ask for one */
    async replayTarget(uuid, { ask = false } = {}) {
        const key = `replayTarget:${uuid}`;
        const saved = this.context.workspaceState.get(key);
        if (saved && !ask) return saved;

        const ep = this.feed.endpoint(uuid);
        const value = await vscode.window.showInputBox({
            title: `Replay target for ${ep ? endpointLabel(ep) : 'this endpoint'}`,
            prompt: 'Events are sent from this machine, so localhost works. Saved for this workspace.',
            value: saved || ep?.forward_url || DEFAULT_TARGET,
            ignoreFocusOut: true,
            validateInput: (v) => checkTarget(v).error ?? null
        });
        const checked = checkTarget(value);
        if (!value || checked.error) return null;

        await this.context.workspaceState.update(key, checked.url);
        return checked.url;
    }

    async replay(arg) {
        const id = this.eventIdFrom(arg);
        if (!id) return;
        if (this.me?.workspace?.role === 'viewer') {
            vscode.window.showErrorMessage('You are a viewer in this workspace, and viewers cannot replay events. Ask the owner for the developer role.');
            return;
        }

        const log = await this.fullLog(id);
        const uuid = this.endpointUuidFor(log);
        const target = await this.replayTarget(uuid);
        if (!target) return;

        const outcome = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Replaying #${log.number} to ${target}…`
        }, () => replayEvent({ api: this.api(), log, target }));

        const message = describeReplay(log, outcome);
        const actions = ['Replay Again', 'Change Target'];
        if (outcome.body) actions.unshift('Show Response');
        const show = outcome.passed ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
        const choice = await show(message, ...actions);

        if (choice === 'Show Response') {
            const doc = await vscode.workspace.openTextDocument({ content: outcome.body, language: guessLanguage(outcome.body) });
            await vscode.window.showTextDocument(doc, { preview: true });
        } else if (choice === 'Replay Again') {
            await this.replay({ kind: 'event', id });
        } else if (choice === 'Change Target') {
            if (await this.replayTarget(uuid, { ask: true })) await this.replay({ kind: 'event', id });
        }
    }

    async copyFixture(arg) {
        const id = this.eventIdFrom(arg);
        if (!id) return;
        const log = await this.fullLog(id);
        if (Number(log.is_truncated) === 1) {
            vscode.window.showWarningMessage(`Event #${log.number} was cut at the capture limit, so the fixture holds only the start of its body.`);
        }
        await vscode.env.clipboard.writeText(fixtureFor(log));
        vscode.window.setStatusBarMessage(`$(check) Copied #${log.number} as a fixture`, 3000);
    }

    async generateCode(arg) {
        const id = this.eventIdFrom(arg);
        if (!id) return;
        const pick = await vscode.window.showQuickPick(
            Object.entries(LANGUAGES).map(([key, lang]) => ({ label: lang.label, detail: lang.detail, key })),
            { title: 'Generate types, a fixture and a test from this event' });
        if (!pick) return;

        const log = await this.fullLog(id);
        const uuid = this.endpointUuidFor(log);
        const target = this.context.workspaceState.get(`replayTarget:${uuid}`)
            || this.feed.endpoint(uuid)?.forward_url
            || DEFAULT_TARGET;

        const { files, notes } = generateFiles(log, pick.key, target);
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        for (const file of files) {
            await openUntitled(file, folder);
        }
        if (notes.length) vscode.window.showInformationMessage(notes.join(' '));
    }

    copyCatchUrl(element) {
        const ep = element?.uuid && this.feed.endpoint(element.uuid);
        if (!ep) return;
        vscode.env.clipboard.writeText(catchUrl(ep, this.server));
        vscode.window.setStatusBarMessage('$(check) Copied the catch URL', 3000);
    }

    // ---------------------------------------------------------------------

    registerCommands() {
        const guarded = (fn) => async (...args) => {
            try {
                await fn(...args);
            } catch (err) {
                if (err.status === 401) return this.signedOutByServer();
                vscode.window.showErrorMessage(`SlingHook: ${err.cause?.message || err.message}`);
            }
        };

        const commands = {
            'slinghook.signIn': () => this.signIn(),
            'slinghook.signInSelfHosted': () => this.signInSelfHosted(),
            'slinghook.signInWithToken': () => this.signInWithToken(),
            'slinghook.signOut': () => this.signOut(),
            'slinghook.refresh': () => (this.me ? this.loadEndpoints() : this.loadSession()),
            'slinghook.openDashboard': () => vscode.env.openExternal(vscode.Uri.parse(`${this.server}/app/`)),
            'slinghook.copyCatchUrl': (element) => this.copyCatchUrl(element),
            'slinghook.setReplayTarget': (element) => element?.uuid && this.replayTarget(element.uuid, { ask: true }),
            'slinghook.openEvent': (arg) => this.openEvent(arg),
            'slinghook.replayEvent': (arg) => this.replay(arg),
            'slinghook.copyFixture': (arg) => this.copyFixture(arg),
            'slinghook.generateCode': (arg) => this.generateCode(arg),
            'slinghook.showFeed': async () => {
                await vscode.commands.executeCommand('slinghook.feed.focus');
                this.feed.markSeen();
            }
        };
        for (const [name, fn] of Object.entries(commands)) {
            this.disposables.push(vscode.commands.registerCommand(name, guarded(fn)));
        }
    }
}

/**
 * The sidebar: endpoints, and under each one its newest events. Expanding an
 * endpoint opens its live stream; collapsing it closes the stream.
 */
class FeedTree {
    constructor(ext) {
        this.ext = ext;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
        this.timer = null;
    }

    refresh() {
        clearTimeout(this.timer);
        this.timer = null;
        this.emitter.fire(undefined);
    }

    /** Bursts of events (a backlog of 50) redraw once */
    refreshSoon() {
        if (this.timer) return;
        this.timer = setTimeout(() => this.refresh(), 100);
    }

    dispose() {
        clearTimeout(this.timer);
        this.emitter.dispose();
    }

    getChildren(element) {
        const { ext } = this;
        if (!ext.token) return [];

        if (!element) {
            if (ext.loadError) return [{ kind: 'message', text: ext.loadError, icon: 'warning' }];
            return ext.feed.endpoints.map((ep) => ({ kind: 'endpoint', uuid: ep.uuid }));
        }

        if (element.kind === 'endpoint') {
            ext.follow(element.uuid);
            const events = ext.feed.eventsFor(element.uuid);
            const status = ext.feed.status.get(element.uuid);
            if (status?.state === 'error') return [{ kind: 'message', text: status.detail, icon: 'error' }];
            if (events.length === 0) {
                const connecting = !status || status.state === 'connecting';
                return [{ kind: 'message', text: connecting ? 'Connecting…' : 'No webhooks yet. Copy the catch URL and send one.', icon: connecting ? 'loading~spin' : 'inbox' }];
            }
            return events.map((log) => ({ kind: 'event', uuid: element.uuid, id: log.id }));
        }

        return [];
    }

    getTreeItem(element) {
        const { ext } = this;

        if (element.kind === 'message') {
            const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon(element.icon);
            item.tooltip = element.text;
            return item;
        }

        if (element.kind === 'endpoint') {
            const ep = ext.feed.endpoint(element.uuid);
            const item = new vscode.TreeItem(ep ? endpointLabel(ep) : element.uuid, vscode.TreeItemCollapsibleState.Collapsed);
            item.id = `endpoint:${element.uuid}`;
            item.contextValue = 'endpoint';
            const status = ext.feed.status.get(element.uuid);
            const live = status?.state === 'live';
            item.iconPath = new vscode.ThemeIcon(
                live ? 'radio-tower' : status?.state === 'reconnecting' || status?.state === 'error' ? 'debug-disconnect' : 'plug',
                live ? new vscode.ThemeColor('charts.green') : undefined);
            item.description = live ? 'live' : status?.state === 'reconnecting' ? 'reconnecting…' : (ep?.is_active === 0 || ep?.is_active === false ? 'paused' : '');
            if (ep) {
                const url = catchUrl(ep, ext.server);
                item.tooltip = new vscode.MarkdownString(`**${escapeMd(endpointLabel(ep))}**\n\nCatch URL: \`${url}\`${ep.forward_url ? `\n\nRelays to: \`${ep.forward_url}\`` : ''}${status?.detail ? `\n\n${escapeMd(status.detail)}` : ''}`);
            }
            return item;
        }

        const found = ext.feed.findEvent(element.id);
        const log = found?.log ?? { id: element.id, method: '?' };
        const item = new vscode.TreeItem(eventLabel(log), vscode.TreeItemCollapsibleState.None);
        item.id = `event:${element.id}`;
        item.contextValue = 'event';
        item.description = describeTime(log.created_at);
        item.iconPath = signatureIcon(log.signature_status);
        item.tooltip = new vscode.MarkdownString([
            `**${escapeMd(eventLabel(log))}**`,
            `Received ${log.created_at ? new Date(log.created_at).toLocaleString() : 'unknown'}`,
            `Signature: ${log.signature_status ?? 'unverified'}${log.provider ? ` · ${escapeMd(log.provider)}` : ''}`,
            log.note ? `Note: ${escapeMd(log.note)}` : ''
        ].filter(Boolean).join('\n\n'));
        item.command = { command: 'slinghook.openEvent', title: 'Open Event', arguments: [element] };
        return item;
    }
}

/** Serves the read-only JSON tab for an event */
class EventDocuments {
    constructor(ext) {
        this.ext = ext;
        this.emitter = new vscode.EventEmitter();
        this.onDidChange = this.emitter.event;
    }

    changed(uri) {
        this.emitter.fire(uri);
    }

    async provideTextDocumentContent(uri) {
        const id = Number(new URLSearchParams(uri.query).get('id'));
        try {
            return formatEvent(await this.ext.fullLog(id));
        } catch (err) {
            return `// Could not load this event: ${err.message}\n`;
        }
    }

    dispose() {
        this.emitter.dispose();
    }
}

const DEFAULT_SERVER = 'https://slinghook.co.za';

function config() {
    return vscode.workspace.getConfiguration('slinghook');
}

function configuredServer() {
    return normalizeServer(config().get('server')) ?? DEFAULT_SERVER;
}

function signatureIcon(status) {
    if (status === 'valid') return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    if (status === 'invalid') return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    return new vscode.ThemeIcon('circle-outline');
}

/** "14:02:31" today, "Oct 27 14:02" before */
function describeTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
        ? date.toLocaleTimeString()
        : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeMd(text) {
    return String(text).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

function guessLanguage(text) {
    try {
        JSON.parse(text);
        return 'json';
    } catch {
        return /^\s*</.test(text) ? 'html' : 'plaintext';
    }
}

/** A new unsaved editor holding generated code; named inside the workspace when there is one */
async function openUntitled(file, folder) {
    if (!folder) {
        const doc = await vscode.workspace.openTextDocument({ content: file.content, language: file.language });
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
    }
    const uri = vscode.Uri.file(join(folder.fsPath, file.name)).with({ scheme: 'untitled' });
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await editor.edit((edit) => edit.replace(new vscode.Range(0, 0, doc.lineCount, 0), file.content));
    if (doc.languageId !== file.language) await vscode.languages.setTextDocumentLanguage(doc, file.language);
}

function cancellableSleep(ms, cancel) {
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        const sub = cancel.onCancellationRequested(done);
        function done() {
            clearTimeout(timer);
            sub.dispose();
            resolve();
        }
    });
}
