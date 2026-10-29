# SlingHook for VS Code

**Catch. Debug. Replay.** Your [SlingHook](https://slinghook.co.za) webhook feed, live in the editor.

- **Live feed.** Every endpoint in your workspace in the sidebar. Expand one and its webhooks stream in as they arrive, with
  the signature check result on each.
- **Read any event.** Click an event to open its headers, query string and body as a JSON tab you can fold and search.
- **Replay to localhost.** Send an event to your local server from VS Code. The extension tells you whether your fix
  worked (*fixed*, *regressed*, *still failing*) and saves the attempt to the dashboard's replay history.
- **Copy as fixture.** Put the body on the clipboard, pretty-printed, ready for a test.
- **Generate code.** Turn an event into types, a fixture file and a test (TypeScript + Jest/Vitest, Python + pytest,
  PHP + Laravel/PHPUnit, or Go structs).
- **Status bar.** A count of new webhooks while you're in another file.

## Getting started

1. Open the SlingHook view in the activity bar and choose **Sign In**.
2. Approve the code in your browser. The token is kept in VS Code's secret storage and shows under
   *User Settings > API Tokens* on the dashboard as "VS Code on *your machine*".
3. Expand an endpoint to start listening. Collapse it to stop.

Self-hosting SlingHook? Use **SlingHook: Sign In to a Self-hosted Server…** or set `slinghook.server`.
You can also sign in with an API token you created on the dashboard (**SlingHook: Sign In with an API Token…**).

## Replaying

The first replay on an endpoint asks where to send events (defaulting to the endpoint's relay URL, or
`http://localhost:3000/webhooks`) and remembers it for the workspace. Change it with **Set Replay Target…** on the
endpoint. Events go from your machine, so `localhost` works, and the original headers are kept, so your handler's
signature check sees what the provider sent.

An event whose signature SlingHook found invalid should be rejected by your handler, so for those a 4xx counts as passing.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `slinghook.server` | `https://slinghook.co.za` | Your server, for self-hosted installs |
| `slinghook.eventsPerEndpoint` | `50` | Newest events kept per endpoint in the feed |
| `slinghook.notifyOnNewEvents` | `false` | A notification for each new webhook on an open endpoint |

## Plans

The extension is free. It uses the same API as the dashboard and the CLI, so what you can see and do follows your
SlingHook plan and your role in the workspace (viewers can read events but not replay them).

## Development

```bash
npm install
npm run build      # bundles src/ into dist/extension.cjs
npm test           # unit tests plus the extension against fake VS Code and SlingHook servers
npm run package    # builds slinghook-<version>.vsix
```

Press F5 in VS Code to run the extension in a new window. Point it at a local SlingHook with
`"slinghook.server": "http://127.0.0.1:8080"`.

## License

MIT
