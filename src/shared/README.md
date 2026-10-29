# Shared with the CLI

These files are copies from [slinghook-cli](https://github.com/DylanCourtney584/slinghook-cli), so the extension
replays, parses streams and generates code exactly like `shk listen` and the MCP tools do:

| File | Copied from |
| --- | --- |
| `api.js`, `sse.js`, `forward.js` | `src/` |
| `eventToCode.js`, `codeHelpers.js`, `verdict.js` | `src/mcp/` (themselves copies of the dashboard's) |

Change them in the CLI first, then copy them here, and keep the two in step.
