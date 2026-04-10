/**
 * wrfi MCP server — stdio transport.
 * Exposes wr.fi tools to Claude Desktop, Cursor, and other MCP clients.
 *
 * Usage: npx wrfi mcp
 * Config: WRFI_API_KEY env var for authenticated operations.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { push, read, readRaw, readHandoff, update, diff, history, search, neighborhood } from "./lib/api.js";

const TOOLS = [
  {
    name: "wrfi_push",
    description: "Push content to wr.fi. Returns a URL + handoff bundle for agent-to-agent transfer. No auth needed for anonymous (30-day expiry). Response includes handoff.url for the next agent.",
    inputSchema: {
      type: "object",
      required: ["title", "content"],
      properties: {
        title: { type: "string", description: "Title for the creation" },
        content: { type: "string", description: "Text content (no base64 needed). Language auto-detected." },
        contentType: { type: "string", description: "Type: code, text, image, audio, video. Auto-detected if omitted." },
        description: { type: "string", description: "Brief description for discoverability" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
        project: { type: "string", description: "Project name for grouping related creations" },
        handoffMessage: { type: "string", description: "Note for the next agent — what was done, what to do next" },
        secure: { type: "boolean", description: "8-char secret link (default: 4-char)" },
        unlisted: { type: "boolean", description: "Hide from explore and search" },
        password: { type: "string", description: "Password-protect the creation" },
        dryRun: { type: "boolean", description: "Validate without persisting" },
        apiKey: { type: "string", description: "API key for permanent creation" },
      },
    },
  },
  {
    name: "wrfi_push_secure",
    description: "Push with an 8-char secret link. Shorthand for wrfi_push with secure:true.",
    inputSchema: {
      type: "object",
      required: ["title", "content"],
      properties: {
        title: { type: "string", description: "Title for the creation" },
        content: { type: "string", description: "Text content" },
        contentType: { type: "string" },
        handoffMessage: { type: "string", description: "Note for the next agent" },
        password: { type: "string" },
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
    description: "Update an existing creation (new version, same URL). Returns updated handoff bundle. Requires edit token or API key.",
    inputSchema: {
      type: "object",
      required: ["shortId", "content"],
      properties: {
        shortId: { type: "string", description: "Short ID to update" },
        content: { type: "string", description: "New text content" },
        editToken: { type: "string", description: "2-word edit token (e.g. Blue-Castle)" },
        apiKey: { type: "string", description: "API key (alternative to edit token)" },
        message: { type: "string", description: "Version note (what changed)" },
        handoffMessage: { type: "string", description: "Note for the next agent (what to do next)" },
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
    name: "wrfi_handoff",
    description: "Read the handoff view for a creation — structured text with content, history, context, and update instructions. Use this to pick up work from another agent.",
    inputSchema: {
      type: "object",
      required: ["shortId"],
      properties: {
        shortId: { type: "string", description: "Short ID of the creation" },
        compact: { type: "boolean", description: "Compact mode — skip verbose update instructions (saves tokens)" },
        password: { type: "string" },
        editToken: { type: "string" },
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

    case "wrfi_search":
      return await search(args);

    case "wrfi_neighborhood":
      return await neighborhood(args.shortId, args);

    case "wrfi_handoff":
      return await readHandoff(args.shortId, args);

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

// Auto-start when invoked as a script (`node mcp.js`, `npx @wrfi/mcp`, `wrfi-mcp`).
// Skipped when imported by cli/index.js — `wrfi mcp` calls startMcpServer() explicitly.
function isMainModule() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  startMcpServer().catch((err) => {
    console.error(`MCP server error: ${err.message}`);
    process.exit(1);
  });
}
