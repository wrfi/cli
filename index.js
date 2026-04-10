#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { push, read, readRaw, update, diff, history } from "./lib/api.js";

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

Push options:
  --title <title>        Title (default: filename)
  --type <type>          Content type: code, text, image, audio, video
  --secure               Generate 8-char unguessable URL
  --unlisted             Hide from public feed
  --password <pass>      Password-protect the creation

Read options:
  --password <pass>      Password for protected creations
  --token <token>        Edit token for protected creations
  --json                 Output full JSON instead of content

Update options:
  --token <token>        Edit token (required for anonymous updates)
  --message <msg>        Version note
  --expected-version <n> Reject if version mismatch (409)

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
  wrfi history a028`);
}

function parseArgs(argv) {
  const args = { _: [] };
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
    else if (arg === "--expected-version" && i + 1 < argv.length) args.expectedVersion = parseInt(argv[++i], 10);
    else if (arg === "--secure") args.secure = true;
    else if (arg === "--unlisted") args.unlisted = true;
    else if (arg === "--json") args.json = true;
    else if (!arg.startsWith("-")) args._.push(arg);
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
  });

  console.log(result.url);
  if (result.editToken) console.error(`Edit token: ${result.editToken}`);
  if (result.expiresAt) console.error(`Expires: ${result.expiresAt}`);
}

async function cmdRead(args) {
  const shortId = args._[0];
  if (!shortId) { console.error("Usage: wrfi read <shortId>"); process.exit(1); }

  if (args.json) {
    const data = await read(shortId, { password: args.password, editToken: args.token, apiKey: args.key });
    console.log(JSON.stringify(data, null, 2));
  } else {
    const text = await readRaw(shortId, { password: args.password, editToken: args.token, apiKey: args.key });
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

  const result = await update(shortId, {
    artifacts: [{ data: data.toString("base64"), mimeType: mime, filename: name }],
    editToken: args.token,
    apiKey: args.key,
    message: args.message,
    expectedVersion: args.expectedVersion,
  });

  console.log(result.url);
  console.error(`Version: ${result.version}`);
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

if (!command || args.help) {
  usage();
  process.exit(command ? 0 : 1);
}

const commands = {
  push: cmdPush,
  read: cmdRead,
  update: cmdUpdate,
  diff: cmdDiff,
  history: cmdHistory,
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
