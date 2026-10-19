const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
// Three.js is served from your own server, so no outside CDN can break Michael
app.use("/vendor/three", express.static(path.join(__dirname, "node_modules/three/build")));
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const SYSTEM =
  "You are Michael, Royal's personal AI assistant with a glowing 3D interface. " +
  "Be warm, quick and clear. Keep replies to one to three short sentences, since they are spoken aloud. " +
  "Never use markdown, lists or emoji. You cannot control the laptop yet; if asked, say that comes in a later phase.";

for (const k of ["ANTHROPIC_API_KEY", "ACCESS_CODE"]) {
  if (!process.env[k]) console.warn("WARNING: environment variable " + k + " is not set");
}

// Simple per-IP rate limit: 20 requests per minute (also slows down code guessing)
const hits = new Map();
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();
function tooMany(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 20;
}
function codeOk(given) {
  const real = process.env.ACCESS_CODE || "";
  if (!real || !given) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(real);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post("/api/chat", async (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: "slow down" });
  if (!codeOk(req.get("x-access-code"))) return res.status(401).json({ error: "bad access code" });

  const raw = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  let messages = raw.slice(-20).map((m) => ({
    role: m && m.role === "assistant" ? "assistant" : "user",
    content: String((m && m.content) || "").slice(0, 4000),
  })).filter((m) => m.content.trim());
  while (messages.length && messages[0].role !== "user") messages.shift(); // API needs a user turn first
  if (!messages.length) return res.status(400).json({ error: "no messages" });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, system: SYSTEM, messages }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Anthropic error:", r.status, JSON.stringify(data));
      return res.status(502).json({ error: "upstream error" });
    }
    const reply = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    // `actions` is the hook for phase three: later, commands for the laptop helper go here
    res.json({ reply: reply || "I'm not sure what to say to that.", actions: [] });
  } catch (err) {
    console.error(err.name === "AbortError" ? "Anthropic timeout" : err);
    res.status(504).json({ error: "timeout or server error" });
  } finally {
    clearTimeout(timer);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Michael is awake"));
