// Just enough of the `vscode` API to run the bundled extension under node:test.
// Dialogs answer from queues the test fills, and everything shown is recorded.

class EventEmitter {
    constructor() {
        this.listeners = new Set();
        this.event = (listener) => {
            this.listeners.add(listener);
            return { dispose: () => this.listeners.delete(listener) };
        };
    }
    fire(value) {
        for (const l of this.listeners) l(value);
    }
    dispose() {
        this.listeners.clear();
    }
}

class Uri {
    constructor({ scheme = 'file', path = '', query = '' }) {
        this.scheme = scheme;
        this.path = path;
        this.query = query;
        this.fsPath = path;
    }
    static parse(text) {
        const url = new URL(text);
        return Object.assign(new Uri({ scheme: url.protocol.slice(0, -1), path: url.pathname, query: url.search.slice(1) }), { raw: text });
    }
    static from(parts) {
        return new Uri(parts);
    }
    static file(path) {
        return new Uri({ scheme: 'file', path });
    }
    with(change) {
        return new Uri({ ...this, ...change });
    }
    toString() {
        return this.raw ?? `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`;
    }
}

class TreeItem {
    constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
    }
}

class ThemeIcon {
    constructor(id, color) {
        this.id = id;
        this.color = color;
    }
}

class ThemeColor {
    constructor(id) {
        this.id = id;
    }
}

class MarkdownString {
    constructor(value) {
        this.value = value;
    }
}

class Range {
    constructor(...args) {
        this.args = args;
    }
}

function createFakeVscode({ settings = {} } = {}) {
    const recorded = { messages: [], contexts: {}, opened: [], external: [], statusMessages: [], languages: [] };
    const answers = { inputBox: [], quickPick: [], messages: [] };
    const commands = new Map();
    const contentProviders = new Map();
    const configListeners = new EventEmitter();
    let treeProvider = null;
    const treeView = {
        visible: false,
        collapse: new EventEmitter(),
        visibility: new EventEmitter(),
        dispose() {}
    };
    treeView.onDidCollapseElement = treeView.collapse.event;
    treeView.onDidChangeVisibility = treeView.visibility.event;

    const statusBar = { text: '', tooltip: '', visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
    let clipboard = '';

    const message = (level) => async (text, ...actions) => {
        recorded.messages.push({ level, text, actions });
        return answers.messages.shift();
    };

    const makeDoc = (uri, content, languageId) => ({
        uri,
        languageId,
        lineCount: content.split('\n').length,
        content,
        getText: () => content
    });

    const vscode = {
        EventEmitter, Uri, TreeItem, ThemeIcon, ThemeColor, MarkdownString, Range,
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        StatusBarAlignment: { Left: 1, Right: 2 },
        ProgressLocation: { Notification: 15 },
        ConfigurationTarget: { Global: 1 },
        window: {
            state: { focused: true },
            activeTextEditor: undefined,
            createTreeView(id, options) {
                treeProvider = options.treeDataProvider;
                return treeView;
            },
            createStatusBarItem: () => statusBar,
            showInformationMessage: message('info'),
            showWarningMessage: message('warning'),
            showErrorMessage: message('error'),
            setStatusBarMessage(text) {
                recorded.statusMessages.push(text);
                return { dispose() {} };
            },
            async showInputBox(options) {
                recorded.messages.push({ level: 'input', text: options.title });
                return answers.inputBox.shift();
            },
            async showQuickPick(items) {
                const want = answers.quickPick.shift();
                return (await items).find((i) => i.key === want || i.label === want);
            },
            async withProgress(options, task) {
                const progress = { report: (p) => recorded.messages.push({ level: 'progress', text: p.message }) };
                const cancel = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
                return task(progress, cancel);
            },
            async showTextDocument(doc) {
                recorded.opened.push(doc);
                const editor = {
                    document: doc,
                    async edit(fn) {
                        fn({ replace: (_range, text) => { doc.content = text; } });
                        return true;
                    }
                };
                vscode.window.activeTextEditor = editor;
                return editor;
            }
        },
        commands: {
            registerCommand(name, fn) {
                commands.set(name, fn);
                return { dispose: () => commands.delete(name) };
            },
            async executeCommand(name, ...args) {
                if (name === 'setContext') {
                    recorded.contexts[args[0]] = args[1];
                    return;
                }
                return commands.get(name)?.(...args);
            }
        },
        workspace: {
            workspaceFolders: undefined,
            getConfiguration() {
                return {
                    get: (key, fallback) => (key in settings ? settings[key] : fallback),
                    async update(key, value) {
                        settings[key] = value;
                        configListeners.fire({ affectsConfiguration: (s) => s === `slinghook.${key}` });
                    }
                };
            },
            onDidChangeConfiguration: configListeners.event,
            registerTextDocumentContentProvider(scheme, provider) {
                contentProviders.set(scheme, provider);
                return { dispose() {} };
            },
            async openTextDocument(arg) {
                if (arg instanceof Uri) {
                    const provider = contentProviders.get(arg.scheme);
                    const content = provider ? await provider.provideTextDocumentContent(arg) : '';
                    return makeDoc(arg, content, arg.path.endsWith('.json') ? 'json' : 'plaintext');
                }
                return makeDoc(Uri.from({ scheme: 'untitled', path: 'Untitled-1' }), arg.content, arg.language);
            }
        },
        languages: {
            async setTextDocumentLanguage(doc, language) {
                recorded.languages.push(language);
                doc.languageId = language;
                return doc;
            }
        },
        env: {
            appName: 'Visual Studio Code',
            async openExternal(uri) {
                recorded.external.push(uri.toString());
                return true;
            },
            clipboard: {
                writeText: async (text) => { clipboard = text; },
                readText: async () => clipboard
            }
        }
    };

    return {
        vscode,
        recorded,
        answers,
        commands,
        treeView,
        statusBar,
        settings,
        get tree() {
            return treeProvider;
        }
    };
}

function fakeContext() {
    const secrets = new Map();
    const state = new Map();
    return {
        subscriptions: [],
        secrets: {
            get: async (k) => secrets.get(k),
            store: async (k, v) => { secrets.set(k, v); },
            delete: async (k) => { secrets.delete(k); },
            raw: secrets
        },
        workspaceState: {
            get: (k) => state.get(k),
            update: async (k, v) => { state.set(k, v); }
        }
    };
}

module.exports = { createFakeVscode, fakeContext };
