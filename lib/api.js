/**
 * wrfi shared HTTP client — zero dependencies, Node.js built-ins only.
 */

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

const DEFAULT_URL = "https://wr.fi";

function getBaseUrl() {
  return process.env.WRFI_URL || process.env.WRIFY_URL || DEFAULT_URL;
}

function getApiKey() {
  return process.env.WRFI_API_KEY || process.env.WRIFY_API_KEY || null;
}

function requestTimeoutMs() {
  const fromEnv = parseInt(process.env.WRFI_TIMEOUT_MS || "", 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30_000;
}

function httpReqOnce(method, urlStr, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const fn = isHttps ? httpsRequest : httpRequest;

    const headers = {
      "User-Agent": "wrfi-cli/1.1 wrfi-protocol/1.2",
      ...extraHeaders,
    };
    if (body) headers["Content-Type"] = "application/json";

    const timeoutMs = requestTimeoutMs();
    const req = fn(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
        // Without this, a stalled connection hangs the CLI (and any MCP tool call) forever.
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          // Return full response for retry logic to inspect
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        });
      }
    );
    req.on("timeout", () => {
      const err = new Error(`Request timed out after ${timeoutMs}ms`);
      err.code = "ETIMEDOUT";
      req.destroy(err);
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const MAX_RETRIES = 2;
// Override for tests/dev (WRFI_RETRY_DELAY_MS) — production default 2s.
const BASE_DELAY_MS = (() => {
  const v = parseInt(process.env.WRFI_RETRY_DELAY_MS || "", 10);
  return Number.isFinite(v) && v >= 0 ? v : 2000;
})();

// Transient network-level failures — exactly the cold-DNS / dropped-socket class the retry
// wrapper exists for. (Previously only HTTP 503 *responses* were retried; transport errors,
// which never produce a response at all, propagated with zero retries.)
// Failures that can only happen BEFORE the request reached the server — always
// safe to retry, any method.
const PRE_SEND_ERRNOS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
// Ambiguous failures: the request may have been processed before the connection
// died. Retrying a non-idempotent write here can double-commit — only retry
// when the method is safe or the request carries an Idempotency-Key.
const AMBIGUOUS_ERRNOS = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE"]);

function retryDelayMs(res, attempt) {
  // wr.fi sends Retry-After on its own 5xx responses — trust the server over header sniffing.
  const ra = res && res.headers && parseInt(res.headers["retry-after"], 10);
  if (Number.isFinite(ra) && ra >= 0 && ra <= 30) return ra * 1000;
  return BASE_DELAY_MS * Math.pow(2, attempt); // 2s, 4s
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpReq(method, urlStr, body, extraHeaders) {
  let lastRes = null;
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRes = await httpReqOnce(method, urlStr, body, extraHeaders);
      lastErr = null;
    } catch (err) {
      lastErr = err;
      lastRes = null;
      const code = err && (err.code || (err.cause && err.cause.code));
      const m = String(method || "GET").toUpperCase();
      const safeToRepeat =
        m === "GET" || m === "HEAD" ||
        !!(extraHeaders && extraHeaders["Idempotency-Key"]);
      const retryable =
        PRE_SEND_ERRNOS.has(code) || (AMBIGUOUS_ERRNOS.has(code) && safeToRepeat);
      if (retryable && attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      break;
    }

    // Success — return immediately
    if (lastRes.status < 400) return lastRes;

    // 503s are transient by contract: AI-sandbox egress proxies return them on cold
    // requests, and wr.fi's own 503s carry a Retry-After. Retry both.
    if (lastRes.status === 503 && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(lastRes, attempt));
      continue;
    }

    // Non-retryable error — throw
    break;
  }

  if (lastErr) {
    throw new Error(`Network error after ${MAX_RETRIES + 1} attempts: ${lastErr.message || lastErr}`);
  }
  let msg = lastRes.body;
  let parsed = null;
  try { parsed = JSON.parse(lastRes.body); msg = parsed.error || lastRes.body; } catch {}
  const err = new Error(`HTTP ${lastRes.status}: ${String(msg).slice(0, 300)}`);
  // Attach status + parsed body so callers can handle 409/428 conflicts
  // (currentVersion, hint) instead of showing a bare message.
  err.status = lastRes.status;
  err.body = parsed;
  throw err;
}

/** Parse a JSON response body with a status-aware error instead of a raw SyntaxError. */
function parseJson(res, context) {
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error(`${context}: server returned non-JSON (HTTP ${res.status}): ${String(res.body).slice(0, 120)}`);
  }
}

function authHeaders(opts = {}) {
  const headers = {};
  const key = opts.apiKey || getApiKey();
  if (key) headers["x-api-key"] = key;
  if (opts.password) headers["X-Wrify-Password"] = opts.password;
  if (opts.editToken) headers["X-Wrify-Edit-Token"] = opts.editToken;
  return headers;
}

/**
 * Push a new creation.
 * @param {object} opts - { title, content?, contentType?, artifacts?, secure?, unlisted?, password?, apiKey?, generation?, provenance?, description?, tags?, project?, handoffMessage?, dryRun? }
 * @returns {Promise<object>} - { url, shortId, editToken, handoff, expiresAt?, ... }
 */
export async function push(opts) {
  const base = getBaseUrl();
  const body = {
    title: opts.title,
    ...(opts.content ? { content: opts.content } : {}),
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
    ...(opts.artifacts ? { artifacts: opts.artifacts } : {}),
    ...(opts.secure ? { secure: true } : {}),
    ...(opts.unlisted ? { unlisted: true } : {}),
    ...(opts.password ? { accessPassword: opts.password } : {}),
    ...(opts.generation ? { generation: opts.generation } : {}),
    ...(opts.provenance ? { provenance: opts.provenance } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.tags ? { tags: opts.tags } : {}),
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    ...(opts.task !== undefined ? { task: opts.task } : {}),
    ...(opts.environment !== undefined ? { environment: opts.environment } : {}),
    ...(opts.handoffMessage ? { handoffMessage: opts.handoffMessage } : {}),
    ...(opts.dryRun ? { dryRun: true } : {}),
  };
  const key = opts.apiKey || getApiKey();
  const headers = { "User-Agent": "wrfi-cli/1.1 wrfi-protocol/1.2" };
  if (key) headers["x-api-key"] = key;

  const res = await httpReq("POST", `${base}/api/p`, body, headers);
  return parseJson(res, "push");
}

/**
 * Read a creation.
 * @param {string} shortId
 * @param {object} opts - { password?, editToken?, apiKey?, version? }
 * @returns {Promise<object>} - full creation JSON
 */
export async function read(shortId, opts = {}) {
  const base = getBaseUrl();
  const v = opts.version ? `&v=${encodeURIComponent(opts.version)}` : "";
  const res = await httpReq("GET", `${base}/api/raw/${shortId}?format=json${v}`, null, authHeaders(opts));
  return parseJson(res, "read");
}

/**
 * Read raw text content of a creation.
 * @param {string} shortId
 * @param {object} opts - { password?, editToken?, apiKey?, version? }
 * @returns {Promise<string>} - raw text
 */
export async function readRaw(shortId, opts = {}) {
  const base = getBaseUrl();
  const v = opts.version ? `?v=${encodeURIComponent(opts.version)}` : "";
  const res = await httpReq("GET", `${base}/api/raw/${shortId}${v}`, null, authHeaders(opts));
  return res.body;
}

/**
 * Update an existing creation.
 * @param {string} shortId
 * @param {object} opts - { content?, artifacts?, editToken?, apiKey?, expectedVersion?, message?, title?, contentType? }
 * @returns {Promise<object>} - { url, version, editToken, ... }
 */
export async function update(shortId, opts = {}) {
  const base = getBaseUrl();
  // The server requires expectedVersion on replace updates (428 without it).
  // When the caller didn't pass one and isn't forcing, read the current version
  // first so the default `wrfi update` stays a single safe command.
  if (opts.expectedVersion == null && !opts.force) {
    const cur = await read(shortId, opts);
    if (cur && typeof cur.version === "number") opts.expectedVersion = cur.version;
  }
  const body = {
    update: shortId,
    ...(opts.content ? { content: opts.content } : {}),
    ...(opts.artifacts ? { artifacts: opts.artifacts } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
    ...(opts.message ? { message: opts.message } : {}),
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    ...(opts.task !== undefined ? { task: opts.task } : {}),
    ...(opts.environment !== undefined ? { environment: opts.environment } : {}),
    ...(opts.handoffMessage ? { handoffMessage: opts.handoffMessage } : {}),
    ...(opts.force ? { force: true } : {}),
    ...(opts.expectedVersion != null ? { expectedVersion: opts.expectedVersion } : {}),
  };
  const key = opts.apiKey || getApiKey();
  const headers = { "User-Agent": "wrfi-cli/1.1 wrfi-protocol/1.2" };
  if (key) headers["x-api-key"] = key;
  if (opts.editToken) body.editToken = opts.editToken;

  const res = await httpReq("POST", `${base}/api/p`, body, headers);
  return parseJson(res, "update");
}

/**
 * Catch-up: "I last read version N — what happened since?"
 * Returns per-version messages, a capped unified diff, and the expectedVersion to
 * update with. Use at the start of any session resuming work on a creation.
 * @param {string} shortId
 * @param {number} since - the version you last read
 * @param {object} opts - { json?, password?, editToken?, apiKey? }
 * @returns {Promise<string|object>} - plain-text catch-up, or structured JSON with json:true
 */
export async function catchup(shortId, since, opts = {}) {
  const base = getBaseUrl();
  const format = opts.json ? "&format=json" : "";
  const summary = opts.summary ? "&summary" : "";
  const res = await httpReq("GET", `${base}/api/raw/${shortId}?since=${encodeURIComponent(since)}${summary}${format}`, null, authHeaders(opts));
  return opts.json ? parseJson(res, "catchup") : res.body;
}

/**
 * Get diff between versions.
 * @param {string} shortId
 * @param {number} from - version number
 * @param {number|null} to - version number (null = vs latest)
 * @param {object} opts - { json?, password?, editToken?, apiKey? }
 * @returns {Promise<string|object>} - unified diff text or JSON
 */
export async function diff(shortId, from, to = null, opts = {}) {
  const base = getBaseUrl();
  const diffParam = to ? `${from}..${to}` : String(from);
  const format = opts.json ? "&format=json" : "";
  const res = await httpReq("GET", `${base}/api/raw/${shortId}?diff=${diffParam}${format}`, null, authHeaders(opts));
  return opts.json ? parseJson(res, "diff") : res.body;
}

/**
 * Read handoff view (plain text, ?h).
 * @param {string} shortId
 * @param {object} opts - { compact?, password?, editToken? }
 * @returns {Promise<string>} - structured handoff text
 */
export async function readHandoff(shortId, opts = {}) {
  const base = getBaseUrl();
  const params = new URLSearchParams({ h: "" });
  if (opts.compact) params.set("compact", "");
  if (opts.password) params.set("password", opts.password);
  if (opts.editToken) params.set("edit", opts.editToken);
  const res = await httpReq("GET", `${base}/api/raw/${shortId}?${params}`, null, authHeaders(opts));
  return res.body;
}

/**
 * Get version history.
 * @param {string} shortId
 * @param {object} opts - { password?, editToken?, apiKey? }
 * @returns {Promise<object>} - { shortId, versions: [...], latest }
 */
export async function history(shortId, opts = {}) {
  const base = getBaseUrl();
  const res = await httpReq("GET", `${base}/api/history/${shortId}`, null, authHeaders(opts));
  return parseJson(res, "history");
}

/**
 * Search creations.
 * @param {object} opts - { query?, project?, type?, limit?, apiKey?, password?, editToken? }
 * @returns {Promise<object>} - { items: [...], nextCursor?, nextOffset? }
 */
export async function search(opts = {}) {
  const base = getBaseUrl();
  const params = new URLSearchParams();
  if (opts.query) params.set("q", opts.query);
  if (opts.project) params.set("project", opts.project);
  if (opts.type) params.set("type", opts.type);
  params.set("limit", String(opts.limit || 10));
  const res = await httpReq("GET", `${base}/api/explore?${params}`, null, authHeaders(opts));
  return parseJson(res, "search");
}

/**
 * Get the context neighborhood for a creation: backlinks, outbound links, project siblings, related.
 * @param {string} shortId
 * @param {object} opts - { apiKey?, password?, editToken? }
 * @returns {Promise<object>}
 */
export async function neighborhood(shortId, opts = {}) {
  const base = getBaseUrl();
  const res = await httpReq("GET", `${base}/api/neighborhood/${shortId}`, null, authHeaders(opts));
  return parseJson(res, "neighborhood");
}

/**
 * Append a line to a relay — a versioned write with no read-before-write that
 * never 409s by default. Auth: edit token / api key / open-edit / append token.
 * @param {string} shortId
 * @param {object} opts - { text, author?, message?, appendToken?, expectedVersion?, editToken?, apiKey?, idempotencyKey? }
 * @returns {Promise<object>} - { ok, shortId, version, bytes, offset, len, url }
 */
export async function append(shortId, opts = {}) {
  const base = getBaseUrl();
  const headers = authHeaders(opts);
  if (opts.appendToken) headers["X-Wrify-Append-Token"] = opts.appendToken;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const body = {
    text: opts.text,
    ...(opts.author ? { author: opts.author } : {}),
    ...(opts.message ? { message: opts.message } : {}),
    ...(opts.expectedVersion != null ? { expectedVersion: opts.expectedVersion } : {}),
  };
  const res = await httpReq("POST", `${base}/api/creations/${shortId}/append`, body, headers);
  return parseJson(res, "append");
}

/**
 * Read the last N append entries of a relay (append-aware tail).
 * @param {string} shortId
 * @param {number} n - how many recent entries (1–100)
 * @param {object} opts - { json?, password?, editToken?, apiKey? }
 * @returns {Promise<string|object>} - plain text, or { version, count, entries } with json:true
 */
export async function tail(shortId, n, opts = {}) {
  const base = getBaseUrl();
  const format = opts.json ? "&format=json" : "";
  // Cursor mode: entries with version > opts.after — followers paginate from
  // the last version they saw instead of hoping a fixed window didn't overflow.
  const after = opts.after != null ? `&after=${encodeURIComponent(opts.after)}` : "";
  const res = await httpReq("GET", `${base}/api/raw/${shortId}?tail=${encodeURIComponent(n)}${after}${format}`, null, authHeaders(opts));
  return opts.json ? parseJson(res, "tail") : res.body;
}

/**
 * Mint a scoped capability token for a relay (currently scope "append").
 * Requires FULL write access (owner / api key / edit token).
 * @param {string} shortId
 * @param {object} opts - { scope?, label?, editToken?, apiKey? }
 * @returns {Promise<object>} - { ok, id, token, scope, label, note }
 */
export async function mintToken(shortId, opts = {}) {
  const base = getBaseUrl();
  const body = { scope: opts.scope || "append", ...(opts.label ? { label: opts.label } : {}) };
  const res = await httpReq("POST", `${base}/api/creations/${shortId}/tokens`, body, authHeaders(opts));
  return parseJson(res, "token");
}
