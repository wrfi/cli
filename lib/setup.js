/**
 * `wrfi setup <shortId>` — reconstitute the agent environment a creation declares
 * (its MCP servers), with explicit per-item human consent. Never silent, never
 * auto for untrusted sources. See planning/agent-environment-handoff.md.
 *
 * Installs MCP servers (merges into the client's mcp config) and skills (fetches
 * files into .claude/skills/), and surfaces the exact commands to install any
 * declared Claude Code plugins (which have no project-file install path).
 * Per-item consent; never silent for untrusted sources.
 */

import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, lstatSync, realpathSync, openSync, fsyncSync, closeSync, copyFileSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import https from "node:https";
import http from "node:http";
import { read } from "./api.js";


/** Atomic, permission-preserving config write: tmp file in the same directory,
 *  fsync, rename. New credential-bearing files default to 0600; an existing
 *  file keeps its mode and gets a .bak copy first. */
export function writeFileAtomic(target, data, { sensitive = false } = {}) {
  let mode = sensitive ? 0o600 : 0o644;
  if (existsSync(target)) {
    try { mode = statSync(target).mode & 0o777; } catch {}
    try { copyFileSync(target, target + ".bak"); } catch {}
  }
  const tmp = target + `.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  const fd = openSync(tmp, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, target);
}

/** True when dest (or any created parent) escapes base — including via a
 *  pre-planted symlink. Call AFTER mkdirSync so realpath resolves. */
export function escapesBase(dest, base) {
  try {
    const realBase = realpathSync(base);
    const realDir = realpathSync(dirname(dest));
    if (realDir !== realBase && !realDir.startsWith(realBase + sep)) return true;
  } catch { return true; }
  try {
    if (lstatSync(dest).isSymbolicLink()) return true;
  } catch { /* dest doesn't exist yet — fine */ }
  return false;
}

// Defense in depth: the server validated the manifest on push, but the CLI never
// trusts it blindly before writing/running. A manifest may only LAUNCH via a known
// runner — never an arbitrary command.
const ALLOWED_LAUNCHERS = new Set(["npx", "node", "uvx", "uv", "python", "python3", "docker", "deno", "bun", "bunx", "pnpm"]);
// Mirror of the server guard: an allowed launcher plus an inline-eval arg
// (`node -e`, `python -c`, `deno eval`) is arbitrary code execution. Reject it.
const EVAL_ARG_TOKENS = new Set(["-e", "--eval", "-p", "--print", "-c", "--command", "eval", "exec", "--exec"]);

export function checkMcpSafety(m) {
  if (!m || typeof m !== "object" || typeof m.name !== "string") return { ok: false, error: "invalid mcp entry" };
  const transport = m.transport === "http" || m.transport === "sse" ? m.transport : "stdio";
  if (transport === "stdio") {
    if (typeof m.command !== "string" || !ALLOWED_LAUNCHERS.has(m.command)) return { ok: false, error: `command "${m.command}" is not an allowed launcher` };
    if (m.args && (!Array.isArray(m.args) || m.args.some((a) => typeof a !== "string"))) return { ok: false, error: "args must be strings" };
    if (Array.isArray(m.args)) {
      const evalArg = m.args.find((a) => EVAL_ARG_TOKENS.has(String(a).trim().toLowerCase()));
      if (evalArg) return { ok: false, error: `args may not contain the inline-execution flag "${evalArg}"` };
    }
  } else if (typeof m.url !== "string" || !/^https?:\/\//.test(m.url)) {
    return { ok: false, error: "url must be http(s)" };
  }
  if (m.env && (!Array.isArray(m.env) || m.env.some((e) => !e || typeof e.name !== "string" || "value" in e))) {
    return { ok: false, error: "env must declare names only" };
  }
  return { ok: true };
}

// A Claude Code plugin installs from a marketplace the human `claude plugin
// marketplace add`s. Constrain the source to a GitHub owner/repo or http(s) URL —
// never a local path or shell string. Mirrors the server validator.
const GH_SHORTHAND_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9._-]+(#[a-zA-Z0-9._/-]{1,100})?$/;
// These strings are interpolated into commands we tell a HUMAN to run. Strict
// slugs + parsed URLs, not "starts with http" — `http://evil; curl…|sh` must
// never survive validation, and quoting below is belt-and-braces, not the fence.
const PLUGIN_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export function checkPluginSafety(p) {
  if (!p || typeof p !== "object" || typeof p.name !== "string" || typeof p.marketplace !== "string") return { ok: false, error: "invalid plugin entry" };
  if (!PLUGIN_SLUG_RE.test(p.name)) return { ok: false, error: `plugin name "${p.name}" is not a valid slug` };
  if (!PLUGIN_SLUG_RE.test(p.marketplace)) return { ok: false, error: `marketplace "${p.marketplace}" is not a valid slug` };
  if (typeof p.source !== "string" || /[\s'"\`$;|&<>(){}\\]/.test(p.source)) {
    return { ok: false, error: "plugin source contains forbidden characters" };
  }
  if (!GH_SHORTHAND_RE.test(p.source)) {
    let u;
    try { u = new URL(p.source); } catch { return { ok: false, error: "plugin source must be a GitHub owner/repo or a valid https URL" }; }
    const localhost = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && localhost)) {
      return { ok: false, error: "plugin source URL must be https (http only for localhost)" };
    }
    if (u.username || u.password) return { ok: false, error: "plugin source URL must not embed credentials" };
  }
  return { ok: true };
}
/** POSIX single-quote — safe against every shell metacharacter. */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
/** The exact commands a human runs to install a declared plugin in Claude Code. */
export function pluginCommands(p) {
  return [
    `claude plugin marketplace add ${shellQuote(p.source)}`,
    `claude plugin install ${shellQuote(`${p.name}@${p.marketplace}`)}`,
  ];
}

/** Build a `.mcp.json` server entry from a manifest mcp + any entered env values. */
export function mcpToConfigEntry(m, envValues = {}) {
  const transport = m.transport === "http" || m.transport === "sse" ? m.transport : "stdio";
  if (transport !== "stdio") return { type: transport, url: m.url };
  const entry = { command: m.command, args: m.args || [] };
  const env = {};
  for (const e of m.env || []) if (envValues[e.name]) env[e.name] = envValues[e.name];
  if (Object.keys(env).length) entry.env = env;
  return entry;
}

/** Merge new servers into an existing `.mcp.json` object. Returns { config, conflicts }. */
export function mergeMcpConfig(existing, additions) {
  const config = existing && typeof existing === "object" ? { ...existing } : {};
  config.mcpServers = { ...(config.mcpServers || {}) };
  const conflicts = [];
  for (const [name, entry] of Object.entries(additions)) {
    if (config.mcpServers[name]) conflicts.push(name);
    config.mcpServers[name] = entry;
  }
  return { config, conflicts };
}

/** Local pre-approval list at ~/.wrfi/trusted.json (array of package names, or { packages: [...] }). */
export function loadTrustFile() {
  try {
    const p = join(homedir(), ".wrfi", "trusted.json");
    if (!existsSync(p)) return new Set();
    const j = JSON.parse(readFileSync(p, "utf-8"));
    return new Set(Array.isArray(j) ? j : j.packages || []);
  } catch {
    return new Set();
  }
}

function httpGetJson(url, timeoutMs) {
  return new Promise((res, rej) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers: { "User-Agent": "wrfi-cli", Accept: "application/json" }, timeout: timeoutMs }, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => { try { res(JSON.parse(body)); } catch (e) { rej(e); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", rej);
  });
}

/**
 * Best-effort lookup against the official MCP Registry. Returns "registered",
 * "unlisted", or "unknown" (unreachable). NOTE: registered = known identity, NOT a
 * safety blessing — it is one input to the human's decision, never a gate.
 */
export async function registryTrust(pkg, { timeoutMs = 4000, base = "https://registry.modelcontextprotocol.io" } = {}) {
  if (!pkg) return "unknown";
  try {
    const data = await httpGetJson(`${base}/v0/servers?search=${encodeURIComponent(pkg)}&limit=30`, timeoutMs);
    const servers = data?.servers || data?.data || [];
    for (const s of servers) {
      const pkgs = s.packages || [];
      if (pkgs.some((p) => (p.identifier || p.name) === pkg)) return "registered";
    }
    return "unlisted";
  } catch {
    return "unknown";
  }
}

function trustLabel(m, trustSet, registry) {
  if (m.package && trustSet.has(m.package)) return { sym: "✓✓", text: "trusted (local list)", risky: false };
  if (registry === "registered") return { sym: "✓ ", text: "in the MCP Registry (identity, not endorsement)", risky: false };
  if (registry === "unlisted") return { sym: "⚠ ", text: "NOT in the MCP Registry", risky: true };
  return { sym: "? ", text: "registry unchecked", risky: true };
}


// Secrets are typed for MCP env values — mask the echo. readline's private
// _writeToOutput is the standard trick; worst case (API change) it degrades
// to a visible prompt, never to a crash.
const askSecret = (rl, q) =>
  new Promise((r) => {
    const orig = rl._writeToOutput;
    rl._writeToOutput = function (str) {
      if (str.includes(q)) { orig.call(rl, str); return; }
      orig.call(rl, str.replace(/[^\r\n]/g, "*"));
    };
    rl.question(q, (a) => { rl._writeToOutput = orig; rl.output.write("\n"); r(a.trim()); });
  });

// Resolve a pending prompt as blank if stdin reaches EOF — a closed input means
// "no answer", which (for the install question) is a decline, never an approval.
const ask = (rl, q) =>
  new Promise((r) => {
    let done = false;
    const onClose = () => { if (!done) { done = true; r(""); } };
    rl.once("close", onClose);
    rl.question(q, (a) => { done = true; rl.removeListener("close", onClose); r(a.trim()); });
  });

// ── Client config targets ───────────────────────────────────────────────────
function claudeDesktopConfigPath() {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}
/** Resolve the mcp config file for a client. Claude Desktop is always app-global. */
export function targetForClient(client, global) {
  const cwd = process.cwd();
  const home = homedir();
  switch (client) {
    case "cursor": return global ? join(home, ".cursor", "mcp.json") : join(cwd, ".cursor", "mcp.json");
    case "claude-desktop": return claudeDesktopConfigPath();
    case "claude-code":
    default: return global ? join(home, ".claude.json") : join(cwd, ".mcp.json");
  }
}

// ── Skill files ─────────────────────────────────────────────────────────────
const EXEC_EXT = new Set([".sh", ".bash", ".zsh", ".fish", ".exe", ".bat", ".cmd", ".ps1", ".com", ".scr", ".msi", ".app", ".dll", ".so", ".dylib", ".bin"]);

/** A relative, traversal-free path, or null. Filenames in fetched skills are untrusted. */
export function safeRelPath(name) {
  const cleaned = String(name).replace(/^[/\\]+/, "").replace(/\\/g, "/");
  if (!cleaned || cleaned.includes("..") || /[\x00]/.test(cleaned)) return null;
  if (!/^[a-zA-Z0-9._/-]+$/.test(cleaned)) return null;
  return cleaned;
}
export function isExecutableName(name) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && EXEC_EXT.has(name.slice(dot).toLowerCase());
}
export function skillSrcLabel(s) {
  return s.source.type === "wrfi" ? `wr.fi/${s.source.shortId}` : s.source.url;
}

// Per-file / total caps on fetched skill bytes: a hostile manifest must not be
// able to fill the disk. node's http.get does NOT follow redirects, so a 3xx is
// an error here, never a silent cross-origin hop.
const SKILL_FILE_MAX_BYTES = 2 * 1024 * 1024;
const SKILL_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
function requireFetchableUrl(url) {
  const u = new URL(url);
  const localhost = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && localhost)) {
    throw new Error(`refusing non-https source: ${u.protocol}//${u.hostname}`);
  }
}
function httpGetBuffer(url, timeoutMs) {
  requireFetchableUrl(url);
  return new Promise((res, rej) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers: { "User-Agent": "wrfi-cli" }, timeout: timeoutMs }, (r) => {
      if ((r.statusCode || 0) >= 300) { r.resume(); rej(new Error(`HTTP ${r.statusCode}${r.headers.location ? " (redirects are not followed)" : ""}`)); return; }
      const chunks = [];
      let size = 0;
      r.on("data", (c) => {
        size += c.length;
        if (size > SKILL_FILE_MAX_BYTES) { req.destroy(new Error(`file exceeds ${SKILL_FILE_MAX_BYTES / 1048576}MB cap`)); return; }
        chunks.push(c);
      });
      r.on("end", () => res(Buffer.concat(chunks)));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", rej);
  });
}

/** Fetch a skill's files as [{ path, content }]. wrfi + url are auto-fetched; git is manual. */
async function fetchSkillFiles(skill, timeoutMs = 15000) {
  const src = skill.source;
  if (src.type === "wrfi") {
    const creation = await read(src.shortId, {});
    const arts = creation.artifacts || [];
    if (arts.length === 0) throw new Error("source creation has no files");
    // Fetch from the host we're actually talking to (the response URL may carry the
    // server's build-time base, which can differ from the CLI's --url / WRFI_URL).
    const base = (process.env.WRFI_URL || process.env.WRIFY_URL || "https://wr.fi").replace(/\/+$/, "");
    const files = [];
    for (const a of arts.slice(0, 50)) {
      let u;
      try { u = new URL(a.url); } catch { continue; }
      files.push({ path: a.filename || "SKILL.md", content: await httpGetBuffer(base + u.pathname + u.search, timeoutMs) });
    }
    return files;
  }
  if (src.type === "url") {
    const name = src.url.split("?")[0].split("/").pop() || "SKILL.md";
    return [{ path: name, content: await httpGetBuffer(src.url, timeoutMs) }];
  }
  throw new Error(`git source — fetch manually: git clone ${src.url || ""}`.trim());
}

export async function runSetup(shortId, opts = {}) {
  const creation = await read(shortId, opts);
  const env = creation.environment;
  if (!env || (!Array.isArray(env.mcp) && !Array.isArray(env.skills) && !Array.isArray(env.plugins))) {
    console.log(`No environment manifest on ${shortId}. Nothing to set up.`);
    return;
  }

  const anonymous = !creation.creator;
  const allMcp = env.mcp || [];
  const mcps = allMcp.filter((m) => checkMcpSafety(m).ok);
  const dropped = allMcp.length - mcps.length;
  const skills = env.skills || [];
  const allPlugins = env.plugins || [];
  const plugins = allPlugins.filter((p) => checkPluginSafety(p).ok);
  const droppedPlugins = allPlugins.length - plugins.length;

  console.log(`\nEnvironment for "${creation.title || shortId}" (v${creation.version ?? "?"})`);
  console.log(`Published by: ${anonymous ? "ANONYMOUS — treat with extra caution" : creation.creator}`);
  if (env.note) console.log(`Note: ${env.note}`);
  if (dropped) console.log(`(${dropped} mcp entr${dropped === 1 ? "y" : "ies"} skipped — failed the local safety check)`);
  if (droppedPlugins) console.log(`(${droppedPlugins} plugin(s) skipped — unsafe source)`);

  const trustSet = loadTrustFile();
  const plan = [];
  console.log(`\nMCP servers (${mcps.length}) — launchers are allowlisted, but an installed server still executes code; review publisher, package, and args:`);
  for (const m of mcps) {
    const registry = await registryTrust(m.package);
    const t = trustLabel(m, trustSet, registry);
    const how = m.command ? `${m.command} ${(m.args || []).join(" ")}`.trim() : m.url;
    console.log(`  ${t.sym} ${m.name}   [${t.text}]`);
    console.log(`       ${m.package ? m.package + " — " : ""}${how}`);
    if (m.homepage) console.log(`       ${m.homepage}`);
    if (m.env?.length) console.log(`       env: ${m.env.map((e) => e.name + (e.required ? " (required)" : "")).join(", ")}`);
    plan.push({ m, trust: t, anonymous });
  }
  const installSkills = !opts.mcpOnly && skills.length > 0;
  if (skills.length) {
    console.log(`\nSkills (${skills.length})${opts.mcpOnly ? " — skipped (--mcp-only)" : ""}:`);
    for (const s of skills) console.log(`  - ${s.name}: ${skillSrcLabel(s)}`);
  }
  const installPlugins = !opts.mcpOnly && plugins.length > 0;
  if (plugins.length) {
    console.log(`\nPlugins (${plugins.length})${opts.mcpOnly ? " — skipped (--mcp-only)" : ""}:`);
    for (const p of plugins) console.log(`  - ${p.name}@${p.marketplace} (from ${p.source})${p.marketplace === "claude-plugins-official" ? "" : " — third-party"}`);
  }

  const target = opts.target ? resolve(opts.target) : targetForClient(opts.client, opts.global);
  console.log(`\nMCP target: ${target}`);

  if (opts.plan) { console.log("\n(plan only — nothing written. Re-run without --plan to install.)"); return; }
  if (opts.print) {
    const additions = {};
    for (const { m } of plan) additions[m.name] = mcpToConfigEntry(m);
    console.log(`\nAdd to ${target}:\n${JSON.stringify({ mcpServers: additions }, null, 2)}`);
    if (installSkills) console.log(`\n(${skills.length} skill(s) are files — run \`wrfi setup ${shortId}\` without --print to fetch them.)`);
    if (installPlugins) console.log(`\nPlugins — run in Claude Code:\n${[...new Set(plugins.flatMap(pluginCommands))].join("\n")}`);
    return;
  }
  if (plan.length === 0 && !installSkills && !installPlugins) { console.log("\nNothing to install."); return; }

  // Load the target config BEFORE consent: replacing an existing server is a
  // materially different decision from installing a new one, and the human must
  // see the collision at prompt time, not in a post-hoc "Replaced:" line.
  let existingConfig = {};
  if (existsSync(target)) {
    try { existingConfig = JSON.parse(readFileSync(target, "utf-8")); }
    catch { console.error(`\n${target} is not valid JSON — aborting (your file is untouched).`); process.exit(1); }
  }
  const existingServers = (existingConfig && existingConfig.mcpServers) || {};

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const additions = {};
  const skillInstalls = [];
  const pluginCmds = [];
  try {
    // MCP servers
    for (const { m, trust } of plan) {
      const proposed = mcpToConfigEntry(m);
      const existing = existingServers[m.name];
      const identical = existing && JSON.stringify({ ...existing, env: undefined }) === JSON.stringify({ ...proposed, env: undefined });
      const collides = !!existing && !identical;
      const risky = anonymous || trust.risky;
      // --yes auto-approves ONLY the local trust list (~/.wrfi/trusted.json) —
      // registry presence is identity evidence, not an endorsement — and never
      // a replacement of an existing, different server.
      let approve = opts.yes && trust.sym === "✓✓" && !collides;
      if (identical && existing && !(m.env || []).length) { console.log(`  ${m.name} already installed — unchanged`); continue; }
      if (!approve) {
        if (opts.yes && trust.sym !== "✓✓" && !risky) console.log(`\n--yes covers only your local trust file — confirm "${m.name}" manually (${trust.text}).`);
        if (opts.yes && risky) console.log(`\n--yes does not apply to "${m.name}" (${anonymous ? "anonymous publisher" : trust.text}) — confirm manually.`);
        if (collides) {
          console.log(`\n  ⚠ "${m.name}" ALREADY EXISTS in ${target} and would be REPLACED:`);
          console.log(`     existing: ${JSON.stringify(existing)}`);
          console.log(`     proposed: ${JSON.stringify(proposed)}`);
        }
        const ans = await ask(rl, `\n${collides ? `Replace existing server "${m.name}"` : `Install "${m.name}"`} (${m.package || m.url})?${risky ? "  ⚠ review carefully" : ""} [y/N] `);
        approve = /^y(es)?$/i.test(ans);
      }
      if (!approve) { console.log(`  skipped ${m.name}`); continue; }
      const envValues = {};
      for (const e of m.env || []) {
        const v = await askSecret(rl, `  ${e.name}${e.required ? " (required)" : " (optional — blank to skip, or set externally later)"}: `);
        if (v) envValues[e.name] = v;
        else if (e.required) console.log(`  (left ${e.name} blank — set it later in ${target})`);
      }
      if (Object.keys(envValues).length) console.log(`  note: those values are saved in ${target} (plaintext) and used by ${m.package || m.name}.`);
      additions[m.name] = mcpToConfigEntry(m, envValues);
      console.log(`  ${m.name} ready`);
    }
    // Skills — files an agent will read and follow as instructions.
    if (installSkills) {
      for (const s of skills) {
        const ans = await ask(rl, `\nInstall skill "${s.name}" from ${skillSrcLabel(s)}? (files an agent will read & follow)${anonymous ? "  ⚠ anonymous publisher" : ""} [y/N] `);
        if (!/^y(es)?$/i.test(ans)) { console.log(`  skipped ${s.name}`); continue; }
        let files;
        try { files = await fetchSkillFiles(s); }
        catch (e) { console.log(`  could not fetch ${s.name}: ${e.message}`); continue; }
        // Both the target AND the default-dir name come from an untrusted manifest.
        // The per-file paths below are safeRelPath'd, but the BASE dir was not: a
        // skill named "../../../.config" would relocate the whole install outside
        // the project. Sanitize the name the same way.
        const rel = s.target && safeRelPath(s.target);
        const nameSafe = safeRelPath(s.name);
        if (!rel && !nameSafe) { console.log(`  skipped unsafe skill name: ${s.name}`); continue; }
        const dir = rel ? join(process.cwd(), rel) : join(process.cwd(), ".claude", "skills", nameSafe);
        const safe = [];
        for (const f of files) {
          const p = safeRelPath(f.path);
          if (!p) { console.log(`  skipped unsafe path: ${f.path}`); continue; }
          if (isExecutableName(p)) { console.log(`  skipped executable file: ${p}`); continue; }
          safe.push({ rel: p, content: f.content });
        }
        if (safe.length === 0) { console.log(`  no installable files for ${s.name}`); continue; }
        console.log(`  → ${dir}  (${safe.map((f) => f.rel).join(", ")})`);
        skillInstalls.push({ name: s.name, dir, files: safe });
      }
    }
    // Plugins — Claude Code only, no file to write, so we collect the commands to run.
    if (installPlugins) {
      for (const p of plugins) {
        const official = p.marketplace === "claude-plugins-official";
        const warn = `${official ? "" : "  ⚠ third-party marketplace"}${anonymous ? "  ⚠ anonymous publisher" : ""}`;
        const ans = await ask(rl, `\nInstall plugin "${p.name}@${p.marketplace}"? (a plugin can run arbitrary code in your agent)${warn} [y/N] `);
        if (!/^y(es)?$/i.test(ans)) { console.log(`  skipped ${p.name}`); continue; }
        pluginCmds.push(...pluginCommands(p));
        console.log(`  ${p.name} queued`);
      }
    }
  } finally {
    rl.close();
  }

  // Write MCP servers (merge, preserving existing).
  if (Object.keys(additions).length) {
    const existing = existingConfig;
    const { config, conflicts } = mergeMcpConfig(existing, additions);
    if (conflicts.length) console.log(`\nReplaced existing server(s): ${conflicts.join(", ")} (confirmed above)`);
    mkdirSync(dirname(target), { recursive: true });
    const sensitive = Object.values(additions).some((a) => a.env && Object.keys(a.env).length);
    writeFileAtomic(target, JSON.stringify(config, null, 2) + "\n", { sensitive });
    console.log(`\nWrote ${Object.keys(additions).length} MCP server(s) to ${target}.`);
  }
  // Write skill files.
  for (const sk of skillInstalls) {
    const total = sk.files.reduce((n, f) => n + f.content.length, 0);
    if (total > SKILL_TOTAL_MAX_BYTES) { console.log(`Skipped skill "${sk.name}" — ${(total / 1048576).toFixed(1)}MB exceeds the ${SKILL_TOTAL_MAX_BYTES / 1048576}MB cap.`); continue; }
    let wrote = 0;
    for (const f of sk.files) {
      const dest = join(sk.dir, f.rel);
      mkdirSync(dirname(dest), { recursive: true });
      // A pre-planted symlink under .claude/skills/ must not let writes escape
      // the project — verify the REAL path stayed inside, and never follow a
      // symlink at the destination itself.
      if (escapesBase(dest, process.cwd())) { console.log(`  skipped ${f.rel} — path escapes the project (symlink?)`); continue; }
      writeFileSync(dest, f.content);
      wrote++;
    }
    console.log(`Wrote skill "${sk.name}" (${wrote} file(s)) to ${sk.dir}.`);
  }

  // Plugins can't be installed from a file — print the commands to run in Claude Code.
  if (pluginCmds.length) {
    console.log(`\nPlugins can't be installed from a file — run these in Claude Code:`);
    for (const c of [...new Set(pluginCmds)]) console.log(`  ${c}`);
  }

  if (Object.keys(additions).length === 0 && skillInstalls.length === 0 && pluginCmds.length === 0) console.log("\nNothing installed.");
  else if (Object.keys(additions).length) console.log("\nRestart your MCP client to load the new servers.");
}
