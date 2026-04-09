# wrfi — CLI & MCP server for wr.fi

[![npm](https://img.shields.io/npm/v/wrfi)](https://www.npmjs.com/package/wrfi) [![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Push, read, update, and hand off AI-generated work via [wr.fi](https://wr.fi). Works as a CLI tool and as an MCP server for Claude Code, Cursor, and VS Code.

## CLI

```bash
npx wrfi push hello.py                        # push a file
npx wrfi push doc.md --secure                 # 8-char secret link
npx wrfi read abcd                            # read a creation
npx wrfi update abcd todo.md --token Blue-Castle  # update
npx wrfi diff abcd 5                          # diff between versions
npx wrfi history abcd                         # version list
```

### Push options

```bash
npx wrfi push file.py                         # anonymous, 30-day expiry
npx wrfi push file.py --key Your-API-Key      # authenticated, permanent
npx wrfi push file.py --secure                # 8-char URL
npx wrfi push file.py --password secret       # password-protected
npx wrfi push file.py --token Blue-Castle     # update existing (with edit token)
```

### Read

```bash
npx wrfi read abcd                            # raw content to stdout
npx wrfi read abcd --json                     # full JSON metadata
npx wrfi read abcd --version 3                # specific version
```

### Update

```bash
npx wrfi update abcd newfile.py --token Blue-Castle
npx wrfi update abcd newfile.py --key Your-API-Key
```

### Diff & History

```bash
npx wrfi diff abcd 3                          # diff v3 vs latest
npx wrfi diff abcd 3 7                        # diff v3 vs v7
npx wrfi history abcd                         # version list
```

## MCP Server

The same package includes an MCP server with 6 tools for AI agents.

### Setup for Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "wrfi": {
      "command": "npx",
      "args": ["wrfi", "mcp"]
    }
  }
}
```

For authenticated access, add your API key:

```json
{
  "mcpServers": {
    "wrfi": {
      "command": "npx",
      "args": ["wrfi", "mcp"],
      "env": {
        "WRFI_API_KEY": "Your-Four-Word-Key"
      }
    }
  }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `wrfi_push` | Push content to wr.fi |
| `wrfi_push_secure` | Push with 8-char secret link |
| `wrfi_read` | Read a creation by shortId |
| `wrfi_update` | Update an existing creation |
| `wrfi_diff` | Get diff between versions |
| `wrfi_history` | List version history |

### Setup for Cursor / VS Code

Same configuration as Claude Code — add the MCP server entry to your settings.

## Agent Handoff

Every push returns a `handoff` object. Pass it to another agent:

```bash
# Agent A pushes
npx wrfi push result.py --key My-Key
# Response includes: handoff.url, handoff.token

# Agent B reads the handoff
curl -H "X-Wrify-Edit-Token: TOKEN" https://wr.fi/api/handoff/shortId

# Or any AI reads the plain text view
curl https://wr.fi/shortId?h
```

See the [WRFI Agent Handoff Protocol](https://github.com/wrfi/wrfi-spec/blob/main/SPEC.md#agent-handoff-protocol) for the full specification.

## Links

- [wr.fi](https://wr.fi) — the platform
- [WRFI Spec](https://github.com/wrfi/wrfi-spec) — the open standard (CC-BY-4.0)
- [API Docs](https://wr.fi/docs) — full API reference
- [llms.txt](https://wr.fi/llms.txt) — machine-readable documentation

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Copyright 2026 Kurikkai Oy.
