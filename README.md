# wrfi

[![npm](https://img.shields.io/npm/v/wrfi-cli)](https://www.npmjs.com/package/wrfi-cli) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

The command-line tool for [wr.fi](https://wr.fi) — push, read, update, append, diff, and
hand off AI-generated work. **Zero dependencies** (Node.js built-ins only).

```bash
npx wrfi-cli push hello.py            # → https://wr.fi/abcd  + an edit token
```

## Install

```bash
npx wrfi-cli <command>            # no install needed
# or
npm install -g wrfi-cli           # then: wrfi <command>
```

Requires Node.js ≥ 18.

## Usage

```bash
wrfi push <file> [options]                # push a file → short URL
wrfi read <shortId> [options]             # read a creation
wrfi update <shortId> <file> [options]    # update (new version, same URL)
wrfi diff <shortId> [from] [options]      # diff between versions
wrfi history <shortId> [options]          # version history
wrfi append <shortId> "text" [options]    # add an entry — server-serialized, retry-safe (auto Idempotency-Key)
wrfi tail <shortId> [options]             # read the latest entries (-f to follow)
wrfi token <shortId> [options]            # mint an append-only capability token
wrfi setup <shortId> [options]            # set up the MCP servers a creation declares
```

### `wrfi setup` — reconstitute an agent environment

A creation can declare the MCP servers the next agent needs (an `environment`
manifest). `wrfi setup` reconstitutes them — **with per-item confirmation, never
silently.**

```bash
wrfi setup abcd --plan      # show the plan + trust signals; write nothing
wrfi setup abcd --print     # print the .mcp.json block to paste manually
wrfi setup abcd             # interactive: confirm each server, then merge into ./.mcp.json
```

It shows each server's trust signal (resolved against the official
[MCP Registry](https://registry.modelcontextprotocol.io) — "registered" means
*known identity*, not vetted-safe) and the publisher (anonymous publishers get a
loud warning). Each item is confirmed individually; `--yes` only applies to
locally-trusted/registered servers — never to anonymous or unlisted ones.

- **MCP servers** merge into the client's config, preserving any already there.
  Target it with `--client claude-code` (default, project `.mcp.json`), `cursor`
  (`.cursor/mcp.json`), or `claude-desktop`; `--global` / `--target <file>` to override.
- **Skills** are fetched into `.claude/skills/<name>/` (sources: wr.fi-hosted or a
  direct URL; git sources are shown to clone manually). Filenames are
  traversal-checked and executables are refused. `--mcp-only` skips skills.

### Examples

```bash
wrfi push hello.py                              # anonymous push (30-day expiry)
wrfi push doc.md --secure --title "Notes"       # 8-char unguessable URL
wrfi read a028                                  # print the content
wrfi read a028 --since 5 --summary              # what changed since v5 (the gist)
wrfi update a028 todo.md --token Blue-Castle    # update with the edit token
wrfi diff a028 5                                # diff v5 → latest
wrfi history a028                               # list versions
```

### Options

| Option | Applies to | Description |
|--------|-----------|-------------|
| `--title <t>` | push | Title (default: filename) |
| `--type <t>` | push | Content type: `code`, `text`, `image`, `audio`, `video` |
| `--secure` | push | 8-char unguessable URL |
| `--unlisted` | push | Hide from the public feed |
| `--password <p>` | push/read | Password-protect / read a protected creation |
| `--token <t>` | read/update | Edit token (required for anonymous updates) |
| `--version <n>` | read | Read a specific version |
| `--since <n>` | read | Catch-up: what changed since version `n` |
| `--summary` | read | With `--since`: the gist, no diff body |
| `--message <m>` | update | Version note |
| `--expected-version <n>` | update | Update only if the creation is at version `n` (409 otherwise). Omitted: the CLI reads the current version and uses it — the default update is version-safe |
| `--force` | update | Last-write-wins: skip the version check and overwrite (audited by the server) |
| `--json` | read | Full JSON instead of content |
| `--key <k>` | all | API key (or set `WRFI_API_KEY`) |
| `--url <u>` | all | Base URL (default: `https://wr.fi`) |

### Auth

- **Anonymous** pushes need no auth — they're unlisted with a 30-day expiry. The
  push prints an **edit token**; save it to update the creation later.
- For permanent, listed creations, pass `--key <api-key>` or set the
  `WRFI_API_KEY` environment variable.

## Related

- [wr.fi](https://wr.fi) — the platform · [docs](https://wr.fi/docs)
- [`wrfi-mcp`](https://www.npmjs.com/package/wrfi-mcp) — the MCP server, for
  native tool integration in Claude Desktop, Cursor, etc.

## License

MIT — see [LICENSE](LICENSE). © Kurikkai Oy.
