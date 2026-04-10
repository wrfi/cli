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

function httpReq(method, urlStr, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const fn = isHttps ? httpsRequest : httpRequest;

    const headers = {
      "User-Agent": "wrfi-cli/1.0",
      ...extraHeaders,
    };
    if (body) headers["Content-Type"] = "application/json";

    const req = fn(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            let msg = data;
            try { msg = JSON.parse(data).error || data; } catch {}
            reject(new Error(`HTTP ${res.statusCode}: ${msg}`));
            return;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
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
    ...(opts.handoffMessage ? { handoffMessage: opts.handoffMessage } : {}),
    ...(opts.dryRun ? { dryRun: true } : {}),
  };
  const key = opts.apiKey || getApiKey();
  const headers = { "User-Agent": "wrfi-cli/1.0" };
  if (key) headers["x-api-key"] = key;

  const res = await httpReq("POST", `${base}/api/p`, body, headers);
  return JSON.parse(res.body);
}

/**
 * Read a creation.
 * @param {string} shortId
 * @param {object} opts - { password?, editToken?, apiKey? }
 * @returns {Promise<object>} - full creation JSON
 */
export async function read(shortId, opts = {}) {
  const base = getBaseUrl();
  const res = await httpReq("GET", `${base}/api/raw/${shortId}?format=json`, null, authHeaders(opts));
  return JSON.parse(res.body);
}

/**
 * Read raw text content of a creation.
 * @param {string} shortId
 * @param {object} opts - { password?, editToken?, apiKey? }
 * @returns {Promise<string>} - raw text
 */
export async function readRaw(shortId, opts = {}) {
  const base = getBaseUrl();
  const res = await httpReq("GET", `${base}/api/raw/${shortId}`, null, authHeaders(opts));
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
  const body = {
    update: shortId,
    ...(opts.content ? { content: opts.content } : {}),
    ...(opts.artifacts ? { artifacts: opts.artifacts } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
    ...(opts.message ? { message: opts.message } : {}),
    ...(opts.handoffMessage ? { handoffMessage: opts.handoffMessage } : {}),
    ...(opts.expectedVersion != null ? { expectedVersion: opts.expectedVersion } : {}),
  };
  const key = opts.apiKey || getApiKey();
  const headers = { "User-Agent": "wrfi-cli/1.0" };
  if (key) headers["x-api-key"] = key;
  if (opts.editToken) body.editToken = opts.editToken;

  const res = await httpReq("POST", `${base}/api/p`, body, headers);
  return JSON.parse(res.body);
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
  return opts.json ? JSON.parse(res.body) : res.body;
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
  return JSON.parse(res.body);
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
  return JSON.parse(res.body);
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
  return JSON.parse(res.body);
}
