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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import https from "node:https";
import http from "node:http";
import { read } from "./api.js";

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
export function checkPluginSafety(p) {
  if (!p || typeof p !== "object" || typeof p.name !== "string" || typeof p.marketplace !== "string") return { ok: false, error: "invalid plugin entry" };
  if (typeof p.source !== "string" || !(GH_SHORTHAND_RE.test(p.source) || /^https?:\/\//.test(p.source))) {
    return { ok: false, error: "plugin source must be a GitHub owner/repo or an http(s) URL" };
  }
  return { ok: true };
}
/** The exact commands a human runs to install a declared plugin in Claude Code. */
export function pluginCommands(p) {
  return [`claude plugin marketplace add ${p.source}`, `claude plugin install ${p.name}@${p.marketplace}`];
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
  if (registry === "registered") return { sym: "✓ ", text: "in the MCP Registry", risky: false };
  if (registry === "unlisted") return { sym: "⚠ ", text: "NOT in the MCP Registry", risky: true };
  return { sym: "? ", text: "registry unchecked", risky: true };
}

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

function httpGetBuffer(url, timeoutMs) {
  return new Promise((res, rej) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers: { "User-Agent": "wrfi-cli" }, timeout: timeoutMs }, (r) => {
      if ((r.statusCode || 0) >= 400) { r.resume(); rej(new Error(`HTTP ${r.statusCode}`)); return; }
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
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
  console.log(`\nMCP servers (${mcps.length}):`);
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

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const additions = {};
  const skillInstalls = [];
  const pluginCmds = [];
  try {
    // MCP servers
    for (const { m, trust } of plan) {
      const risky = anonymous || trust.risky;
      let approve = opts.yes && !risky;
      if (!approve) {
        if (opts.yes && risky) console.log(`\n--yes does not apply to "${m.name}" (${anonymous ? "anonymous publisher" : trust.text}) — confirm manually.`);
        const ans = await ask(rl, `\nInstall "${m.name}" (${m.package || m.url})?${risky ? "  ⚠ review carefully" : ""} [y/N] `);
        approve = /^y(es)?$/i.test(ans);
      }
      if (!approve) { console.log(`  skipped ${m.name}`); continue; }
      const envValues = {};
      for (const e of m.env || []) {
        const v = await ask(rl, `  ${e.name}${e.required ? " (required)" : " (optional — blank to skip)"}: `);
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
    let existing = {};
    if (existsSync(target)) {
      try { existing = JSON.parse(readFileSync(target, "utf-8")); }
      catch { console.error(`\n${target} is not valid JSON — aborting (your file is untouched).`); process.exit(1); }
    }
    const { config, conflicts } = mergeMcpConfig(existing, additions);
    if (conflicts.length) console.log(`\nReplaced existing server(s): ${conflicts.join(", ")}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
    console.log(`\nWrote ${Object.keys(additions).length} MCP server(s) to ${target}.`);
  }
  // Write skill files.
  for (const sk of skillInstalls) {
    for (const f of sk.files) {
      const dest = join(sk.dir, f.rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content);
    }
    console.log(`Wrote skill "${sk.name}" (${sk.files.length} file(s)) to ${sk.dir}.`);
  }

  // Plugins can't be installed from a file — print the commands to run in Claude Code.
  if (pluginCmds.length) {
    console.log(`\nPlugins can't be installed from a file — run these in Claude Code:`);
    for (const c of [...new Set(pluginCmds)]) console.log(`  ${c}`);
  }

  if (Object.keys(additions).length === 0 && skillInstalls.length === 0 && pluginCmds.length === 0) console.log("\nNothing installed.");
  else if (Object.keys(additions).length) console.log("\nRestart your MCP client to load the new servers.");
}
