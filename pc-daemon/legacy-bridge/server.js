#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// File logger, kept in the module dir and rotated to avoid unbounded growth
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, "server.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB
function logToFile(msg) {
  try {
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_BYTES) {
        fs.writeFileSync(logPath, `[${new Date().toISOString()}] [log rotated] previous log truncated\n`);
      }
    } catch {}
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

logToFile("Server process starting...");

// Keep process alive on errors, but never let error reporting itself recurse.
// When the MCP client disconnects, stdio breaks and console.error throws EPIPE;
// an unguarded handler would re-trigger uncaughtException forever (this filled
// server.log with ~118GB once). On EPIPE the parent is gone, so we shut down.
let crashing = false;
process.on("uncaughtException", (err) => {
  if (crashing) return;
  crashing = true;
  logToFile(`Uncaught exception: ${err?.stack || err}`);
  try {
    console.error("[Bridge] Uncaught exception:", err);
  } catch {}
  if (err?.code === "EPIPE" || /EPIPE/i.test(err?.message || "")) {
    process.exit(0);
  }
});
process.on("unhandledRejection", (err) => {
  logToFile(`Unhandled rejection: ${err?.stack || err}`);
});

// When the MCP client (parent Claude Code session) closes its stdin, the session
// is over. Exit promptly so we don't linger as an orphan holding port 8085 and
// blocking future sessions from reaching the extension.
const exitOnStdinClose = () => {
  logToFile("stdin closed — parent MCP client disconnected, exiting");
  process.exit(0);
};
process.stdin.on("end", exitOnStdinClose);
process.stdin.on("close", exitOnStdinClose);

let wss = null;
let bindAttempts = 0;
function startWebSocketServer() {
  bindAttempts++;
  wss = new WebSocketServer({ port: 8085 });
  wss.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      if (bindAttempts < 30) {
        logToFile(`Port 8085 busy (attempt ${bindAttempts}/30) — another bridge instance owns it, retrying in 2s...`);
        setTimeout(startWebSocketServer, 2000);
      } else {
        logToFile("Port 8085 still busy after 30 retries — keeping MCP server alive, but the extension cannot be reached.");
        console.error("[Bridge] WARNING: port 8085 is busy, another bridge instance is running.");
      }
    } else {
      logToFile(`WebSocket server error: ${err?.stack || err}`);
      console.error("[Bridge] WebSocket server error:", err);
    }
  });
  wss.on("connection", attachConnectionHandlers);
}

let chromeClient = null;
const pendingRequests = new Map();   // MCP requests: reqId -> {resolve, timeout}
const directRequests = new Map();    // Direct WS requests: reqId -> ws (from ask.mjs etc)
let requestIdCounter = 0;

// Ping all connected clients every 15s to keep connections alive
const keepaliveInterval = setInterval(() => {
  if (chromeClient && chromeClient.readyState === 1) { // OPEN
    chromeClient.ping();
  }
}, 15_000);

function attachConnectionHandlers(ws) {
  logToFile("New WebSocket client connected");
  // First connection is assumed to be the chrome extension
  if (!chromeClient) {
    chromeClient = ws;
    logToFile("Set as chromeClient (extension)");
    console.error("[Bridge] Extension connected");
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Ignore keepalive pings
      if (msg.action === "ping") return;

      // If it's an "ask" request (from ask.mjs or MCP), forward to extension
      if (msg.action === "ask") {
        if (chromeClient && chromeClient.readyState === 1) {
          // Register the requesting client so response routes back
          if (ws !== chromeClient) {
            directRequests.set(msg.requestId, ws);
          }
          logToFile(`Forwarding ask to extension (req: ${msg.requestId})`);
          chromeClient.send(JSON.stringify(msg), (err) => {
            if (err) logToFile(`Error forwarding: ${err.message}`);
          });
        } else {
          logToFile("Cannot forward ask: extension not connected");
        }
        return;
      }

      // Treat as a response to a pending request
      let reqId = msg.requestId;

      // First check: direct WS requests (from ask.mjs)
      if (reqId && directRequests.has(reqId)) {
        logToFile(`Direct response (${msg.text?.length ?? 0} chars) for req ${reqId}`);
        const wsTarget = directRequests.get(reqId);
        directRequests.delete(reqId);
        if (wsTarget && wsTarget.readyState === 1) {
          wsTarget.send(JSON.stringify({ text: msg.text, requestId: reqId }));
        }
        return;
      }

      // Second check: MCP pending requests
      let req = null;
      if (reqId) {
        req = pendingRequests.get(reqId);
      } else if (pendingRequests.size > 0) {
        reqId = pendingRequests.keys().next().value;
        req = pendingRequests.get(reqId);
        logToFile(`Warning: No requestId, fallback to req ${reqId}`);
      }

      if (req) {
        logToFile(`MCP response (${msg.text?.length ?? 0} chars) for req ${reqId}`);
        clearTimeout(req.timeout);
        pendingRequests.delete(reqId);
        req.resolve({ content: [{ type: "text", text: msg.text }] });
      } else {
        logToFile(`No matching pending request (reqId: ${reqId})`);
      }
    } catch (e) {
      logToFile(`Parse error: ${e?.message}`);
    }
  });

  ws.on("close", () => {
    logToFile("WebSocket client disconnected");
    if (chromeClient === ws) {
      chromeClient = null;
      logToFile("chromeClient set to null");
    }
  });

  ws.on("error", (err) => {
    logToFile(`WebSocket error: ${err?.message}`);
    if (chromeClient === ws) {
      chromeClient = null;
    }
  });
}

startWebSocketServer();

const server = new Server(
  { name: "gemini-web-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  logToFile("ListToolsRequest called by MCP client");
  return {
    tools: [
      {
        name: "ask_gemini_web",
        description:
          "Send a prompt to Gemini Pro via browser extension and return the response.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The prompt to send to Gemini",
            },
          },
          required: ["prompt"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  logToFile(`CallToolRequest: ${request.params.name}`);
  if (request.params.name !== "ask_gemini_web") {
    logToFile(`Error: Unknown tool ${request.params.name}`);
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  // Attendre la connexion si l'extension se reconnecte
  if (!chromeClient) {
    logToFile("Warning: Chrome extension not connected, waiting up to 20s...");
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (chromeClient) {
        logToFile("Extension reconnected during wait time");
        break;
      }
    }
  }

  if (!chromeClient) {
    logToFile("Error: Chrome extension not connected (no client)");
    return {
      content: [
        {
          type: "text",
          text: "Error: Chrome extension not connected. Open a Gemini page with the extension loaded.",
        },
      ],
    };
  }

  const prompt = String(request.params.arguments?.prompt ?? "");
  const requestId = `req_${Date.now()}_${++requestIdCounter}`;
  logToFile(`Sending prompt (${prompt.length} chars) to extension (req: ${requestId})...`);
  console.error(`[Bridge] Sending prompt (${prompt.length} chars, req: ${requestId})...`);

  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logToFile(`Error: Request ${requestId} timed out after 600s`);
        pendingRequests.delete(requestId);
        resolve({
          content: [
            {
              type: "text",
              text: `Error: Request timed out after 600s. Gemini may still be generating (req: ${requestId}).`,
            },
          ],
        });
      }, 600_000);

      pendingRequests.set(requestId, { resolve, timeout });

      chromeClient.send(JSON.stringify({ action: "ask", prompt, requestId }), (err) => {
        if (err) {
          logToFile(`Error sending to extension via WS for req ${requestId}: ${err.message}`);
          clearTimeout(timeout);
          pendingRequests.delete(requestId);
          resolve({
            content: [{ type: "text", text: `Error sending to extension: ${err.message}` }],
          });
        }
      });
    });
  } catch (err) {
    logToFile(`Request error wrapper: ${err?.message}`);
    console.error("[Bridge] Request error:", err);
    return {
      content: [{ type: "text", text: `Internal error: ${err.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
logToFile("MCP server ready on stdio");
console.error("[Bridge] MCP server ready on stdio");
