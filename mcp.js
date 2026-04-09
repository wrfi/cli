/**
 * wrfi MCP server — stdio transport.
 * Exposes wr.fi tools to Claude Desktop, Cursor, and other MCP clients.
 *
 * Usage: npx wrfi mcp
 * Config: WRFI_API_KEY env var for authenticated operations.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { push, read, readRaw, update, diff, history } from "./lib/api.js";

const TOOLS = [
  {
    name: "wrfi_push",
    description: "Create a new creation on wr.fi. Returns a short URL. No auth required for anonymous pushes (30-day expiry). Set secure:true for an 8-char unguessable URL.",
    inputSchema: {
      type: "object",
      required: ["title", "content"],
      properties: {
        title: { type: "string", description: "Title for the creation" },
        content: { type: "string", description: "Text content (no base64 needed)" },
        contentType: { type: "string", description: "Type: code, text, image, audio, video, document. Auto-detected if omitted." },
        secure: { type: "boolean", description: "Generate 8-char unguessable URL (default: 4-char)" },
        unlisted: { type: "boolean", description: "Hide from public feed" },
        password: { type: "string", description: "Password-protect the creation" },
        apiKey: { type: "string", description: "API key for permanent (non-expiring) creation" },
      },
    },
  },
  {
    name: "wrfi_push_secure",
    description: "Create a creation with an 8-char unguessable URL. Shorthand for wrfi_push with secure:true.",
    inputSchema: {
      type: "object",
      required: ["title", "content"],
      properties: {
        title: { type: "string", description: "Title for the creation" },
        content: { type: "string", description: "Text content" },
        contentType: { type: "string" },
        password: { type: "string", description: "Password-protect the creation" },
        apiKey: { type: "string" },
      },
    },
  },
  {
    name: "wrfi_read",
    description: "Read a creation from wr.fi by its short ID. Returns the content and metadata.",
    inputSchema: {
      type: "object",
      required: ["shortId"],
      properties: {
        shortId: { type: "string", description: "Short ID (e.g. a028, bg8u)" },
        password: { type: "string", description: "Password for protected creations" },
        editToken: { type: "string", description: "Edit token grants read access too" },
        apiKey: { type: "string" },
      },
    },
  },
  {
    name: "wrfi_update",
    description: "Update an existing creation (creates a new version, same URL). Requires edit token or API key.",
    inputSchema: {
      type: "object",
      required: ["shortId", "content"],
      properties: {
        shortId: { type: "string", description: "Short ID to update" },
        content: { type: "string", description: "New text content" },
        editToken: { type: "string", description: "2-word edit token (e.g. Blue-Castle)" },
        apiKey: { type: "string", description: "API key (alternative to edit token)" },
        message: { type: "string", description: "Version note (like a commit message)" },
        expectedVersion: { type: "number", description: "Reject if version mismatch (409). Omit for last-write-wins." },
      },
    },
  },
  {
    name: "wrfi_diff",
    description: "Get a unified diff between two versions of a creation. Efficient for syncing changes.",
    inputSchema: {
      type: "object",
      required: ["shortId", "from"],
      properties: {
        shortId: { type: "string", description: "Short ID" },
        from: { type: "number", description: "From version number" },
        to: { type: "number", description: "To version number (default: latest)" },
        password: { type: "string" },
        editToken: { type: "string" },
        apiKey: { type: "string" },
      },
    },
  },
  {
    name: "wrfi_search",
    description: "Search for creations on wr.fi. Returns titles, shortIds, and content types. Use to discover existing context before creating new content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (matches title, description, tags)" },
        project: { type: "string", description: "Filter by project name" },
        type: { type: "string", description: "Filter by content type (code, text, image, etc.)" },
        limit: { type: "number", description: "Max results (default 10, max 50)" },
      },
    },
  },
  {
    name: "wrfi_neighborhood",
    description: "Get the context neighborhood for a creation: backlinks, outbound links, project siblings, and related creations. Use to understand what context exists around a creation.",
    inputSchema: {
      type: "object",
      required: ["shortId"],
      properties: {
        shortId: { type: "string", description: "Short ID of the creation" },
      },
    },
  },
  {
    name: "wrfi_history",
    description: "Get version history for a creation. Shows version numbers, titles, messages, authors, and timestamps.",
    inputSchema: {
      type: "object",
      required: ["shortId"],
      properties: {
        shortId: { type: "string", description: "Short ID" },
        password: { type: "string" },
        editToken: { type: "string" },
        apiKey: { type: "string" },
      },
    },
  },
];

async function handleTool(name, args) {
  switch (name) {
    case "wrfi_push":
      return await push(args);

    case "wrfi_push_secure":
      return await push({ ...args, secure: true });

    case "wrfi_read": {
      const data = await read(args.shortId, args);
      // Also fetch raw text for convenience
      let rawText;
      try { rawText = await readRaw(args.shortId, args); } catch { rawText = null; }
      return { ...data, rawContent: rawText };
    }

    case "wrfi_update":
      return await update(args.shortId, args);

    case "wrfi_diff":
      return await diff(args.shortId, args.from, args.to || null, args);

    case "wrfi_search": {
      const params = new URLSearchParams();
      if (args.query) params.set("q", args.query);
      if (args.project) params.set("project", args.project);
      if (args.type) params.set("type", args.type);
      params.set("limit", String(args.limit || 10));
      const base = process.env.WRFI_URL || process.env.WRIFY_URL || "https://wr.fi";
      const res = await fetch(`${base}/api/explore?${params}`);
      return await res.json();
    }

    case "wrfi_neighborhood": {
      const base = process.env.WRFI_URL || process.env.WRIFY_URL || "https://wr.fi";
      const res = await fetch(`${base}/api/neighborhood/${args.shortId}`);
      return await res.json();
    }

    case "wrfi_history":
      return await history(args.shortId, args);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function startMcpServer() {
  const server = new Server(
    { name: "wrfi", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleTool(name, args || {});
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
