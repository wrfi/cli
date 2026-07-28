#!/usr/bin/env node

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { push, read, readRaw, update, diff, history, catchup, append, tail, mintToken } from "./lib/api.js";


// --task / --environment take JSON files; parse eagerly so a typo fails
// before any network call, not after a successful push.
function loadJsonFlag(path, flag) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`${flag}: could not read/parse ${path}: ${e.message}`);
    process.exit(1);
  }
}

// Extension → { contentType, mimeType }
const EXT_MAP = {
  ".ts": { ct: "code", mime: "application/typescript" },
  ".tsx": { ct: "code", mime: "application/typescript" },
  ".js": { ct: "code", mime: "application/javascript" },
  ".jsx": { ct: "code", mime: "application/javascript" },
  ".py": { ct: "code", mime: "text/x-python" },
  ".rb": { ct: "code", mime: "text/x-ruby" },
  ".rs": { ct: "code", mime: "text/x-rustsrc" },
  ".go": { ct: "code", mime: "text/x-go" },
  ".java": { ct: "code", mime: "text/x-java" },
  ".kt": { ct: "code", mime: "text/x-kotlin" },
  ".swift": { ct: "code", mime: "text/x-swift" },
  ".c": { ct: "code", mime: "text/x-csrc" },
  ".cpp": { ct: "code", mime: "text/x-c++src" },
  ".h": { ct: "code", mime: "text/x-csrc" },
  ".hpp": { ct: "code", mime: "text/x-c++src" },
  ".cs": { ct: "code", mime: "text/x-csharp" },
  ".php": { ct: "code", mime: "text/x-php" },
  ".sh": { ct: "code", mime: "text/x-sh" },
  ".bash": { ct: "code", mime: "text/x-sh" },
  ".sql": { ct: "code", mime: "text/x-sql" },
  ".html": { ct: "code", mime: "text/html" },
  ".css": { ct: "code", mime: "text/css" },
  ".json": { ct: "code", mime: "application/json" },
  ".yaml": { ct: "code", mime: "text/yaml" },
  ".yml": { ct: "code", mime: "text/yaml" },
  ".toml": { ct: "code", mime: "text/x-toml" },
  ".xml": { ct: "code", mime: "application/xml" },
  ".svg": { ct: "image", mime: "image/svg+xml" },
  ".md": { ct: "text", mime: "text/markdown" },
  ".mdx": { ct: "text", mime: "text/markdown" },
  ".txt": { ct: "text", mime: "text/plain" },
  ".log": { ct: "text", mime: "text/plain" },
  ".lua": { ct: "code", mime: "text/x-lua" },
  ".r": { ct: "code", mime: "text/x-r" },
  ".dart": { ct: "code", mime: "text/x-dart" },
  ".zig": { ct: "code", mime: "text/x-zig" },
  ".vue": { ct: "code", mime: "text/x-vue" },
  ".svelte": { ct: "code", mime: "text/x-svelte" },
  ".prisma": { ct: "code", mime: "text/x-prisma" },
  ".png": { ct: "image", mime: "image/png" },
  ".jpg": { ct: "image", mime: "image/jpeg" },
  ".jpeg": { ct: "image", mime: "image/jpeg" },
  ".gif": { ct: "image", mime: "image/gif" },
  ".webp": { ct: "image", mime: "image/webp" },
  ".mp3": { ct: "audio", mime: "audio/mpeg" },
  ".wav": { ct: "audio", mime: "audio/wav" },
  ".ogg": { ct: "audio", mime: "audio/ogg" },
  ".mp4": { ct: "video", mime: "video/mp4" },
  ".webm": { ct: "video", mime: "video/webm" },
};

function usage() {
  console.log(`wrfi — push and manage content on wr.fi

Usage:
  wrfi push <file> [options]         Push a file to wr.fi
  wrfi read <shortId> [options]      Read a creation
  wrfi update <shortId> <file> [options]  Update a creation
  wrfi diff <shortId> [from] [options]    Show diff between versions
  wrfi history <shortId> [options]   Show version history
  wrfi setup <shortId> [options]     Set up the agent environment (MCP servers) a creation declares
  wrfi append <shortId> "text"       Append a line (no read-before-write, never conflicts; text may be piped)
  wrfi tail <shortId> [n] [-f]       Show the last n append entries; -f follows
  wrfi token <shortId> --append-only Mint an append-only token for a fleet

Setup options:
  --plan                 Show the plan + trust signals; write nothing (safe default to start)
  --print                Print the .mcp.json block to paste manually (no prompts, no writes)
  --client <name>        Target client config: claude-code (default), cursor, claude-desktop
  --global               Use the client's global config instead of project-local
  --target <file>        Write to a specific mcp config file
  --mcp-only             Install MCP servers only; ignore declared skills
  --yes                  Auto-approve — only for locally-trusted/registered servers (never anonymous)

Push options:
  --title <title>        Title (default: filename)
  --type <type>          Content type: code, text, image, audio, video
  --secure               Generate 8-char unguessable URL
  --unlisted             Hide from public feed
  --password <pass>      Password-protect the creation

Read options:
  --password <pass>      Password for protected creations
  --token <token>        Edit token for protected creations
  --version <n>          Read a specific version (default: latest)
  --since <n>            Catch-up: what changed since version n (messages + diff)
  --summary              With --since: the gist (shape + why + where), no diff body
  --json                 Output full JSON instead of content

Update options:
  --token <token>        Edit token (required for anonymous updates)
  --message <msg>        Version note
  --expected-version <n> Update only if the creation is at version n (409 otherwise).
                         Omitted: the CLI reads the current version and uses it.
  --force                Last-write-wins: skip the version check and overwrite (audited)

Append options:
  --author <name>        Attribution recorded with the entry (e.g. crawler-2)
  --append-token <tok>   Append-only token (from wrfi token --append-only)
  --message <msg>        Version note
  --expected-version <n> Opt into strict mode (409 if not this version)
  --idempotency-key <k>  Repeat-safe retries: the same Idempotency-Key within 10 min replays the first result
  --task <file.json>     Attach the task layer (objective, requestedAction, completed[], …) on push/update
  --environment <f.json> Declare the workspace (MCP servers, skills) the next agent needs
  --status <s>           Relay status: open | done | needs-human

Tail options:
  -f, --follow           Stream new entries as they arrive
  --interval <sec>       Poll interval for --follow (default 3)
  --json                 Output structured JSON

Token options:
  --append-only          Mint an append-only capability token (required)
  --label <name>         Human label stored with the token

Common options:
  --key <api-key>        API key (or set WRFI_API_KEY env var)
  --url <base-url>       Base URL (default: https://wr.fi)
  --help                 Show this help

Examples:
  wrfi push hello.py
  wrfi push doc.md --secure --title "Private notes"
  wrfi read a028
  wrfi update a028 todo.md --token Millet-Barrel
  wrfi diff a028 5
  wrfi history a028
  wrfi append a028 "deploy started at 14:03" --author ci-bot
  tail -f app.log | wrfi append a028 --append-token wrfi_ap_...
  wrfi tail a028 20 -f
  wrfi token a028 --append-only --label "crawler fleet"`);
}

// A non-numeric int flag (e.g. --expected-version latest) previously became NaN,
// which JSON-serializes to null → the server treats it as omitted → optimistic
// concurrency silently disabled. Fail loudly instead.
function intArg(raw, name) {
  const v = parseInt(raw, 10);
  if (Number.isNaN(v)) { console.error(`${name} must be an integer`); process.exit(1); }
  return v;
}

function parseArgs(argv) {
  const args = { _: [] };
  // Expand --flag=value into --flag value so the space-separated matchers below
  // catch it. Without this, `--password=secret` was silently dropped and the
  // push went out UNPROTECTED with no error.
  argv = argv.flatMap((a) => {
    const m = /^(--[a-z][a-z-]*)=(.*)$/s.exec(a);
    return m ? [m[1], m[2]] : [a];
  });
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--title" && i + 1 < argv.length) args.title = argv[++i];
    else if (arg === "--type" && i + 1 < argv.length) args.type = argv[++i];
    else if (arg === "--key" && i + 1 < argv.length) args.key = argv[++i];
    else if (arg === "--url" && i + 1 < argv.length) args.url = argv[++i];
    else if (arg === "--token" && i + 1 < argv.length) args.token = argv[++i];
    else if (arg === "--password" && i + 1 < argv.length) args.password = argv[++i];
    else if (arg === "--message" && i + 1 < argv.length) args.message = argv[++i];
    else if (arg === "--expected-version" && i + 1 < argv.length) args.expectedVersion = intArg(argv[++i], "--expected-version");
    else if (arg === "--force") args.force = true;
    else if (arg === "--version" && i + 1 < argv.length) args.version = intArg(argv[++i], "--version");
    else if (arg === "--since" && i + 1 < argv.length) args.since = intArg(argv[++i], "--since");
    else if (arg === "--summary") args.summary = true;
    else if (arg === "--secure") args.secure = true;
    else if (arg === "--unlisted") args.unlisted = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--plan") args.plan = true;
    else if (arg === "--print") args.print = true;
    else if (arg === "--global") args.global = true;
    else if (arg === "--mcp-only") args.mcpOnly = true;
    else if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--target" && i + 1 < argv.length) args.target = argv[++i];
    else if (arg === "--client" && i + 1 < argv.length) args.client = argv[++i];
    else if (arg === "--author" && i + 1 < argv.length) args.author = argv[++i];
    else if (arg === "--append-token" && i + 1 < argv.length) args.appendToken = argv[++i];
    else if (arg === "--idempotency-key" && i + 1 < argv.length) args.idempotencyKey = argv[++i];
    else if (arg === "--task" && i + 1 < argv.length) args.taskFile = argv[++i];
    else if (arg === "--environment" && i + 1 < argv.length) args.environmentFile = argv[++i];
    else if (arg === "--status" && i + 1 < argv.length) args.status = argv[++i];
    else if (arg === "--append-only") args.appendOnly = true;
    else if (arg === "--label" && i + 1 < argv.length) args.label = argv[++i];
    else if (arg === "--follow" || arg === "-f") args.follow = true;
    else if (arg === "--interval" && i + 1 < argv.length) args.interval = intArg(argv[++i], "--interval");
    else if (arg.startsWith("-")) {
      // Unknown flag (or a known value-flag missing its value): fail loudly
      // rather than dropping it, which previously turned a typo like
      // `--pasword secret` into an unprotected push + a stray positional.
      console.error(`Unknown or malformed option: ${arg}`);
      process.exit(1);
    }
    else args._.push(arg);
    i++;
  }
  return args;
}

function detect(filename) {
  const ext = extname(filename).toLowerCase();
  return EXT_MAP[ext] || { ct: "text", mime: "application/octet-stream" };
}

async function cmdPush(args) {
  const file = args._[0];
  if (!file) { console.error("Usage: wrfi push <file>"); process.exit(1); }

  const data = readFileSync(file);
  const name = basename(file);
  const { ct, mime } = detect(name);

  const result = await push({
    title: args.title || name,
    contentType: args.type || ct,
    artifacts: [{ data: data.toString("base64"), mimeType: mime, filename: name }],
    secure: args.secure,
    unlisted: args.unlisted,
    password: args.password,
    apiKey: args.key,
    provenance: { tool: "wrfi-cli" },
    ...(args.status ? { status: args.status } : {}),
    ...(args.taskFile ? { task: loadJsonFlag(args.taskFile, "--task") } : {}),
    ...(args.environmentFile ? { environment: loadJsonFlag(args.environmentFile, "--environment") } : {}),
  });

  // Receipt: the proof-of-publish block (URL on stdout for piping; receipt on
  // stderr). "Don't consider it published until you hold a receipt" is the
  // verification pattern that replaces trusting an agent's claim.
  console.log(result.url);
  console.error(`─ Receipt ──────────────────────────────`);
  console.error(`Handoff:    ${result.url}  (v${result.version ?? 1})`);
  if (result.visibility) console.error(`Visibility: ${result.visibility}`);
  const lc = result.lifecycle;
  if (lc) {
    console.error(`Lifecycle:  ${lc.accessMode}${lc.expiresAt ? ` — expires ${lc.expiresAt.slice(0, 10)}` : ""}`);
    console.error(`Research:   ${lc.researchEligible ? "eligible (Terms §10)" : "not eligible"}`);
  } else if (result.expiresAt) {
    console.error(`Expires:    ${result.expiresAt}`);
  }
  if (result.editToken) console.error(`Edit token: ${result.editToken}  (save it — cannot be recovered)`);
  if (result.protocol) console.error(`Protocol:   ${result.protocol}`);
  console.error(`────────────────────────────────────────`);
}

async function cmdRead(args) {
  const shortId = args._[0];
  if (!shortId) { console.error("Usage: wrfi read <shortId>"); process.exit(1); }

  const auth = { password: args.password, editToken: args.token, apiKey: args.key };

  if (args.since) {
    const out = await catchup(shortId, args.since, { ...auth, json: args.json, summary: args.summary });
    if (args.json) console.log(JSON.stringify(out, null, 2));
    else process.stdout.write(out);
    return;
  }

  if (args.json) {
    const data = await read(shortId, { ...auth, version: args.version });
    console.log(JSON.stringify(data, null, 2));
  } else {
    const text = await readRaw(shortId, { ...auth, version: args.version });
    process.stdout.write(text);
  }
}

async function cmdUpdate(args) {
  const shortId = args._[0];
  const file = args._[1];
  if (!shortId || !file) { console.error("Usage: wrfi update <shortId> <file>"); process.exit(1); }

  const data = readFileSync(file);
  const name = basename(file);
  const { ct, mime } = detect(name);

  let result;
  try {
    result = await update(shortId, {
      artifacts: [{ data: data.toString("base64"), mimeType: mime, filename: name }],
      editToken: args.token,
      apiKey: args.key,
      message: args.message,
      expectedVersion: args.expectedVersion,
      force: args.force,
      ...(args.status ? { status: args.status } : {}),
      ...(args.taskFile ? { task: loadJsonFlag(args.taskFile, "--task") } : {}),
      ...(args.environmentFile ? { environment: loadJsonFlag(args.environmentFile, "--environment") } : {}),
    });
  } catch (err) {
    // Conflict responses carry structure — surface it instead of a bare message.
    if (err.status === 409 && err.body) {
      console.error(`Version conflict: the creation is now at v${err.body.currentVersion}.`);
      console.error(`Re-read it (wrfi read ${shortId} --since <yourVersion>), merge, and retry —`);
      console.error(`or pass --force to overwrite the newer version.`);
      process.exit(1);
    }
    if (err.status === 428 && err.body) {
      console.error(`The server requires a version check (current: v${err.body.currentVersion}).`);
      console.error(`Retry with --expected-version ${err.body.currentVersion}, or --force to overwrite.`);
      process.exit(1);
    }
    throw err;
  }

  console.log(result.url);
  console.error(`Version: ${result.version}`);
  if (result.forced) console.error(`Forced: overwrote v${result.forcedOverwriteOfVersion} (last-write-wins)`);
  // Surface concurrency warnings (e.g. overwrote_different_author) — silently
  // dropping them is how two agents end up clobbering each other's work.
  if (result.warning) console.error(`Warning: ${result.warning}`);
  if (result.conflict) console.error(`Conflict: ${JSON.stringify(result.conflict)}`);
}

async function cmdDiff(args) {
  const shortId = args._[0];
  if (!shortId) { console.error("Usage: wrfi diff <shortId> [fromVersion]"); process.exit(1); }

  const from = args._[1] ? parseInt(args._[1], 10) : 1;
  const text = await diff(shortId, from, null, { json: args.json, password: args.password, editToken: args.token, apiKey: args.key });

  if (args.json) {
    console.log(JSON.stringify(text, null, 2));
  } else {
    process.stdout.write(text);
  }
}

async function cmdHistory(args) {
  const shortId = args._[0];
  if (!shortId) { console.error("Usage: wrfi history <shortId>"); process.exit(1); }

  const data = await history(shortId, { password: args.password, editToken: args.token, apiKey: args.key });

  for (const v of data.versions) {
    const latest = v.version === data.latest ? " (latest)" : "";
    const msg = v.message ? ` — ${v.message}` : "";
    console.log(`v${v.version}${latest}  ${v.createdAt}  ${v.creator || "anonymous"}${msg}`);
  }
}

// --- Main ---

const argv = process.argv.slice(2);
const command = argv[0];
const args = parseArgs(argv.slice(1));

if (args.url) process.env.WRFI_URL = args.url;

if (!command || command === "--help" || command === "-h" || args.help) {
  usage();
  // Bare `wrfi` (no command) is an error; explicit --help is success.
  process.exit(command || args.help ? 0 : 1);
}

async function cmdSetup(args) {
  const shortId = args._[0];
  if (!shortId) { console.error("Usage: wrfi setup <shortId> [--plan | --print | --global | --target <file> | --yes | --mcp-only]"); process.exit(1); }
  const { runSetup } = await import("./lib/setup.js");
  await runSetup(shortId, {
    plan: !!args.plan,
    print: !!args.print,
    global: !!args.global,
    target: args.target,
    yes: !!args.yes,
    mcpOnly: !!args.mcpOnly,
    client: args.client,
    editToken: args.token,
    password: args.password,
    apiKey: args.key,
  });
}

async function cmdAppend(args) {
  const shortId = args._[0];
  if (!shortId) { console.error('Usage: wrfi append <shortId> "text"   (or pipe text via stdin)'); process.exit(1); }
  // Text from the positional arg, or stdin when omitted / "-" (for piping logs).
  let text = args._[1];
  if (text === undefined || text === "-") {
    text = readFileSync(0, "utf8").replace(/\n$/, "");
  }
  if (!text) { console.error("Nothing to append (empty text)."); process.exit(1); }

  const result = await append(shortId, {
    text,
    author: args.author,
    message: args.message,
    appendToken: args.appendToken,
    editToken: args.token,
    apiKey: args.key,
    // Auto-key: every append is retry-safe even if the caller never thinks
    // about idempotency — one UUID per command invocation, reused across the
    // client's internal retries.
    idempotencyKey: args.idempotencyKey || crypto.randomUUID(),
    expectedVersion: args.expectedVersion,
  });
  if (result.error) { console.error(`Error: ${result.error}${result.hint ? ` (hint: ${result.hint})` : ""}`); process.exit(1); }
  console.log(result.url);
  console.error(`v${result.version}  +${result.bytes} bytes @ offset ${result.offset}`);
}

async function cmdTail(args) {
  const shortId = args._[0];
  if (!shortId) { console.error("Usage: wrfi tail <shortId> [n] [-f]"); process.exit(1); }
  const n = args._[1] ? parseInt(args._[1], 10) : 20;
  const auth = { password: args.password, editToken: args.token, apiKey: args.key };

  if (!args.follow) {
    const out = await tail(shortId, n, { ...auth, json: args.json });
    if (args.json) console.log(JSON.stringify(out, null, 2));
    else process.stdout.write(out.endsWith("\n") ? out : out + "\n");
    return;
  }

  // Follow mode: poll, print only entries newer than the last version we saw.
  const intervalMs = Math.max((args.interval || 3), 1) * 1000;
  let lastVersion = 0;
  // Prime with the recent window so -f doesn't dump the whole history.
  const first = await tail(shortId, n, { ...auth, json: true });
  for (const e of first.entries) { printEntry(e); lastVersion = Math.max(lastVersion, e.version); }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let out;
    try { out = await tail(shortId, 100, { ...auth, json: true }); }
    catch (err) { console.error(`(tail retry: ${err.message})`); continue; }
    for (const e of out.entries) {
      if (e.version > lastVersion) { printEntry(e); lastVersion = e.version; }
    }
  }
}

function printEntry(e) {
  const who = e.author ? ` ${e.author}` : "";
  process.stdout.write(`[v${e.version}${who}] ${e.text}\n`);
}

async function cmdToken(args) {
  const shortId = args._[0];
  if (!shortId) { console.error("Usage: wrfi token <shortId> --append-only [--label <name>]"); process.exit(1); }
  if (!args.appendOnly) { console.error("Only --append-only tokens are supported. Run: wrfi token <shortId> --append-only"); process.exit(1); }
  const result = await mintToken(shortId, { scope: "append", label: args.label, editToken: args.token, apiKey: args.key });
  if (result.error) { console.error(`Error: ${result.error}`); process.exit(1); }
  console.log(result.token);
  console.error(`Append-only token minted (id ${result.id}${result.label ? `, "${result.label}"` : ""}). Shown once — store it now.`);
  console.error(`Use: wrfi append ${shortId} "..." --append-token ${result.token}`);
}

const commands = {
  push: cmdPush,
  read: cmdRead,
  update: cmdUpdate,
  diff: cmdDiff,
  history: cmdHistory,
  setup: cmdSetup,
  append: cmdAppend,
  tail: cmdTail,
  token: cmdToken,
};

const fn = commands[command];
if (!fn) {
  console.error(`Unknown command: ${command}\nRun 'wrfi --help' for usage.`);
  process.exit(1);
}

fn(args).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
