/**
 * Terminal Bridge — lets one Claude session control another via REST
 *
 * Start: node server/terminal-bridge.js
 *
 * Endpoints:
 *   POST /send/:conversationId    — { text } write to terminal
 *   POST /start/:conversationId   — { sessionId, mode } start terminal
 *   GET  /screen/:conversationId  — read last N chars of screen
 *   GET  /list                    — list active terminals
 *   POST /destroy/:conversationId — kill terminal
 */

import { io } from "socket.io-client";
import express from "express";

const CHRISTOPHER_URL = process.env.CHRISTOPHER_URL || "http://localhost:3000";
const PORT = process.env.BRIDGE_PORT || 3200;

const app = express();
app.use(express.json());

// Persistent socket connection to Christopher
const socket = io(CHRISTOPHER_URL);
const outputBuffers = new Map(); // conversationId -> last 50KB of output

socket.on("connect", () => console.log("[Bridge] Connected to Christopher"));
socket.on("disconnect", () => console.log("[Bridge] Disconnected from Christopher"));

// Capture all PTY output
socket.on("pty:output", ({ conversationId, data }) => {
  const buf = (outputBuffers.get(conversationId) || "") + data;
  outputBuffers.set(conversationId, buf.length > 50000 ? buf.slice(-50000) : buf);
});

// Strip ANSI for clean reading
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/[\x00-\x08\x0e-\x1f]/g, "");

// Send text to a terminal
app.post("/send/:id", (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });
  socket.emit("pty:input", { conversationId: req.params.id, data: text + "\r" });
  res.json({ ok: true });
});

// Start a terminal
app.post("/start/:id", (req, res) => {
  const { sessionId, mode } = req.body;
  socket.emit("pty:create", {
    conversationId: req.params.id,
    mode: mode || "terminal-persistent",
    config: { sessionId }
  });
  socket.once("pty:ready", (d) => {
    if (d.conversationId === req.params.id) {
      res.json({ ok: true, pid: d.pid });
    }
  });
  setTimeout(() => res.json({ ok: true, status: "timeout" }), 10000);
});

// Read screen
app.get("/screen/:id", (req, res) => {
  const chars = parseInt(req.query.chars) || 2000;
  const raw = (outputBuffers.get(req.params.id) || "").slice(-chars);
  const clean = stripAnsi(raw);
  res.json({ clean, raw: raw.slice(-chars), bufferSize: outputBuffers.get(req.params.id)?.length || 0 });
});

// List terminals with output
app.get("/list", (req, res) => {
  const terminals = [];
  for (const [id, buf] of outputBuffers) {
    terminals.push({ conversationId: id, bufferSize: buf.length });
  }
  res.json(terminals);
});

// Kill terminal
app.post("/destroy/:id", (req, res) => {
  socket.emit("pty:destroy", { conversationId: req.params.id });
  outputBuffers.delete(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[Bridge] Terminal bridge running on http://localhost:${PORT}`);
  console.log(`[Bridge] Connected to Christopher at ${CHRISTOPHER_URL}`);
  console.log(`[Bridge] Endpoints:`);
  console.log(`  POST /send/:id      — type into terminal`);
  console.log(`  POST /start/:id     — start terminal`);
  console.log(`  GET  /screen/:id    — read screen`);
  console.log(`  GET  /list          — list terminals`);
});
