"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const tls = require("node:tls");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  console.error(`This needs Node 22.5 or newer (you have ${process.version}). Get the LTS from nodejs.org.`);
  process.exit(1);
}

// ===================== Config (.env is optional) =====================
const envReport = { found: false, overridden: [] };  // shown in the startup messages
function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  envReport.found = true;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(["']).*\1$/.test(value);
    if (quoted) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim(); // allow  KEY=value  # comment
    if (!(m[1] in process.env)) process.env[m[1]] = value;
    else if (process.env[m[1]] !== value) envReport.overridden.push(m[1]); // a variable already set on the computer wins over .env
  }
}
loadEnv(path.join(__dirname, ".env"));
// SEED_DEMO: true = actual device data only; anything else = fake demo readings. "true", "True", " TRUE " all count.
const SEED_DEMO_TRUE = String(process.env.SEED_DEMO || "").trim().toLowerCase() === "true";

const PRODUCTION = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || "";
const GMAIL_USER = (process.env.GMAIL_USER || "").trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""); // Google shows it with spaces
const CODE_MINUTES = Number(process.env.CODE_MINUTES) || 10;
// How people become admin: "email" = emailed code (Gmail set up), "secret" = ADMIN_SECRET, "first" = first account wins
const ADMIN_MODE = GMAIL_USER && GMAIL_APP_PASSWORD ? "email" : ADMIN_SECRET ? "secret" : "first";
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const MAX_READINGS = 20000;
// REACTION TIME: the dashboard shows "Online" the instant the ESP32 contacts the server, and
// "Offline" when it has been silent for longer than this. Set DEVICE_TIMEOUT_SECONDS in .env to about
// 3x how often the ESP32 posts (or pings). Default: 30 seconds.
let DEVICE_TIMEOUT_MS = (Number(process.env.DEVICE_TIMEOUT_SECONDS) || 30) * 1000;
const COOKIE = "wm_token";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// Signing key for login cookies: created once and kept in data/session.key
const SECRET = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, "session.key");
  try { return fs.readFileSync(file, "utf8").trim(); } catch { /* first run */ }
  const key = crypto.randomBytes(48).toString("hex");
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
})();

const DEFAULT_LIMITS = { phmin: 6.5, phmax: 8.5, tds: 500, ntu: 5, temp: 35 };

// ===================== Database =====================
const db = new DatabaseSync(path.join(DATA_DIR, "water.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY, name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','admin')),
    password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    ph REAL NOT NULL, tds REAL NOT NULL, ntu REAL NOT NULL,
    temp REAL NOT NULL, flow REAL NOT NULL, total REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings (ts DESC);
  CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, value REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS admin_codes (
    email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
  );
`);

// Remember where each reading came from: "device" = the real ESP32, anything else = typed in by hand / old demo data.
if (!db.prepare("PRAGMA table_info(readings)").all().some((c) => c.name === "source")) {
  db.exec("ALTER TABLE readings ADD COLUMN source TEXT");
}

const sql = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  userCount: db.prepare("SELECT COUNT(*) AS n FROM users"),
  insertUser: db.prepare("INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?,?,?,?,?)"),
  allUsers: db.prepare("SELECT email, name, role, created_at FROM users ORDER BY created_at"),
  deleteUser: db.prepare("DELETE FROM users WHERE email = ?"),
  updateName: db.prepare("UPDATE users SET name = ? WHERE email = ?"),
  updatePassword: db.prepare("UPDATE users SET password_hash = ? WHERE email = ?"),

  latest: db.prepare("SELECT * FROM readings ORDER BY ts DESC, id DESC LIMIT 1"),
  readings: db.prepare("SELECT ts, ph, tds, ntu, temp, flow, total FROM readings ORDER BY ts DESC, id DESC LIMIT ?"),
  insertReading: db.prepare("INSERT INTO readings (ts, ph, tds, ntu, temp, flow, total, source) VALUES (?,?,?,?,?,?,?,?)"),
  purgeNonDevice: db.prepare("DELETE FROM readings WHERE source IS NOT 'device'"),
  prune: db.prepare("DELETE FROM readings WHERE id <= (SELECT MAX(id) FROM readings) - ?"),
  clearReadings: db.prepare("DELETE FROM readings"),
  countReadings: db.prepare("SELECT COUNT(*) AS n FROM readings"),

  getCode: db.prepare("SELECT * FROM admin_codes WHERE email = ?"),
  setCode: db.prepare(`INSERT INTO admin_codes (email, code_hash, expires, attempts) VALUES (?,?,?,0)
                       ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, attempts = 0`),
  bumpCode: db.prepare("UPDATE admin_codes SET attempts = attempts + 1 WHERE email = ?"),
  deleteCode: db.prepare("DELETE FROM admin_codes WHERE email = ?"),

  limits: db.prepare("SELECT key, value FROM limits"),
  setLimit: db.prepare("INSERT INTO limits (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
};

// ===================== Helpers =====================
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message) => new HttpError(400, message);

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const round = (n, d) => +n.toFixed(d);
const num = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN);

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

// ----- sending email through Gmail (SMTP over TLS, no packages) -----
function sendMail({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const host = process.env.SMTP_HOST || "smtp.gmail.com";
    const socket = tls.connect({ host, port: Number(process.env.SMTP_PORT) || 465, servername: host });
    let buffer = "";
    let pending = null;

    const fail = (err) => { socket.destroy(); reject(err); if (pending) { pending.reject(err); pending = null; } };
    socket.setTimeout(20000, () => fail(new Error("SMTP timeout")));
    socket.on("error", fail);

    // A reply is finished when a line looks like "250 text" (a space after the code, not a dash)
    const flush = () => {
      if (!pending) return;
      const lines = buffer.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const reply = lines.slice(0, i + 1).join("\r\n");
          buffer = lines.slice(i + 1).join("\r\n");
          const { resolve: ok } = pending;
          pending = null;
          return ok(reply);
        }
      }
    };
    socket.on("data", (chunk) => { buffer += chunk.toString(); flush(); });

    const reply = () => new Promise((ok, no) => { pending = { resolve: ok, reject: no }; flush(); });
    const step = async (line, expect) => {
      if (line !== null) socket.write(line + "\r\n");
      const r = await reply();
      if (!r.startsWith(expect)) throw new Error("SMTP " + r.split("\r\n").pop());
      return r;
    };

    (async () => {
      const b64 = (t) => Buffer.from(t).toString("base64");
      await step(null, "220");
      await step("EHLO localhost", "250");
      await step("AUTH LOGIN", "334");
      await step(b64(GMAIL_USER), "334");
      await step(b64(GMAIL_APP_PASSWORD), "235");
      await step(`MAIL FROM:<${GMAIL_USER}>`, "250");
      await step(`RCPT TO:<${to}>`, "250");
      await step("DATA", "354");
      const body = String(text).split(/\r?\n/).map((l) => (l.startsWith(".") ? "." + l : l)).join("\r\n");
      const message = [
        `From: Water Monitor <${GMAIL_USER}>`, `To: <${to}>`, `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", body,
      ].join("\r\n");
      await step(message + "\r\n.", "250");
      socket.write("QUIT\r\n");
      socket.end();
      resolve();
    })().catch(fail);
  });
}

// ----- passwords (scrypt, built into Node) -----
const scrypt = (password, salt) =>
  new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return salt.toString("hex") + ":" + (await scrypt(password, salt)).toString("hex");
}

async function checkPassword(password, stored) {
  const [saltHex = "", hashHex = ""] = String(stored || "").split(":");
  const key = await scrypt(password, Buffer.from(saltHex, "hex")); // runs even for unknown users (same timing)
  const wanted = Buffer.from(hashHex, "hex");
  return wanted.length === key.length && crypto.timingSafeEqual(wanted, key);
}

// ----- login cookie: signed token (HMAC-SHA256) -----
const mac = (text) => crypto.createHmac("sha256", SECRET).update(text).digest("base64url");

function makeToken(email) {
  const body = Buffer.from(JSON.stringify({ email, exp: Date.now() + 7 * 24 * 3600 * 1000 })).toString("base64url");
  return body + "." + mac(body);
}

function readToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || !safeEqual(sig, mac(body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const cookieFlags = () => `; HttpOnly; SameSite=Strict; Path=/${PRODUCTION ? "; Secure" : ""}`;

function userFromRequest(req) {
  const payload = readToken(parseCookies(req.headers.cookie)[COOKIE]);
  return payload ? sql.userByEmail.get(payload.email) || null : null; // re-check DB so deleted users lose access
}

const publicUser = (u) => ({ email: u.email, name: u.name, role: u.role });

// ----- tiny rate limiter (per IP, in memory) -----
const hits = new Map();
function rateLimit(req, name, max, windowMs = 15 * 60 * 1000) {
  const key = name + ":" + req.socket.remoteAddress;
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now > entry.reset) { hits.set(key, { count: 1, reset: now + windowMs }); return; }
  if (++entry.count > max) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, 60000).unref();

// ===================== Readings =====================
const RANGES = { ph: [0, 14], tds: [0, 10000], ntu: [0, 3000], temp: [-10, 100], flow: [0, 1000] };

function parseReading(body) {
  const out = {};
  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    const v = num(body[key]);
    if (!Number.isFinite(v) || v < lo || v > hi) throw bad(`"${key}" must be a number between ${lo} and ${hi}.`);
    out[key] = v;
  }
  return out;
}

function insertReading(v, { demo = false, total, source = "device" } = {}) {
  const now = Date.now();
  const prev = sql.latest.get();
  let newTotal;
  if (Number.isFinite(total) && total >= 0) newTotal = total;                  // device sent its own total
  else if (demo) newTotal = (prev?.total ?? 0) + v.flow * 5;                   // same fake maths as demo data
  else {
    const minutes = prev ? Math.min(10, Math.max(0, (now - prev.ts) / 60000)) : 0;
    newTotal = (prev?.total ?? 0) + v.flow * minutes;                          // L/min x minutes
  }
  const row = { ts: now, ...v, total: round(newTotal, 1) };
  sql.insertReading.run(row.ts, row.ph, row.tds, row.ntu, row.temp, row.flow, row.total, source);
  sql.prune.run(MAX_READINGS);
  return row;
}


const getLimits = () => ({ ...DEFAULT_LIMITS, ...Object.fromEntries(sql.limits.all().map((r) => [r.key, r.value])) });

// ===================== API routes =====================
// Each handler gets { req, res, body, params } and returns an object (sent as JSON) or throws HttpError.
const needUser = (req) => {
  const user = userFromRequest(req);
  if (!user) throw new HttpError(401, "Please log in.");
  return user;
};
const needAdmin = (req) => {
  const user = needUser(req);
  if (user.role !== "admin") throw new HttpError(403, "Admins only.");
  return user;
};

// SEED_DEMO=true = actual data only: remove every reading that did not come from the device (old fake/demo rows).
// Readings the ESP32 sent are kept, so a restart never loses real data.
const ACTUAL_ONLY = SEED_DEMO_TRUE;
if (ACTUAL_ONLY) {
  const removed = sql.purgeNonDevice.run().changes;
  if (removed) console.log(`[clean] SEED_DEMO=true: removed ${removed} reading(s) that did not come from the device.`);
}

// ===================== Live status (Server-Sent Events) =====================
// Every open dashboard keeps one connection to /api/stream. The server pushes:
//   "status"   every 5 s, and instantly when the ESP32 connects or goes quiet
//   "reading"  the moment a new reading is saved
// If that connection breaks, the dashboard knows the server is offline.
let lastDeviceAt = 0;            // last time the ESP32 contacted us (memory only: after a restart we wait for its next post)
let announcedConnected = false;  // what dashboards were last told
const streams = new Map();       // open response -> email of the logged-in user

const deviceConnected = () => lastDeviceAt > 0 && Date.now() - lastDeviceAt < DEVICE_TIMEOUT_MS;
const statusPayload = () => ({
  device: deviceConnected(),
  deviceAgeMs: lastDeviceAt ? Date.now() - lastDeviceAt : null, // age, not a timestamp, so clock differences don't matter
  timeoutMs: DEVICE_TIMEOUT_MS,
});

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of streams.keys()) {
    try { res.write(message); } catch { streams.delete(res); }
  }
}

function markDeviceSeen() {
  lastDeviceAt = Date.now();
  if (!announcedConnected) { announcedConnected = true; broadcast("status", statusPayload()); }
}

// Notice the moment the ESP32 goes quiet
setInterval(() => {
  if (announcedConnected && !deviceConnected()) { announcedConnected = false; broadcast("status", statusPayload()); }
}, 1000).unref();

// Heartbeat: lets dashboards detect a dead connection, and drops streams of deleted accounts
setInterval(() => {
  for (const [res, email] of streams) {
    if (!sql.userByEmail.get(email)) { res.end(); streams.delete(res); }
  }
  broadcast("status", statusPayload());
}, 5000).unref();

function openStream(req, res) {
  const user = needUser(req); // 401 if not logged in
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no", // stops nginx from holding messages back
  });
  res.write(`retry: 3000\n\nevent: status\ndata: ${JSON.stringify(statusPayload())}\n\n`);
  streams.set(res, user.email);
  req.on("close", () => streams.delete(res));
}

const routes = {
  "GET /api/health": () => ({ ok: true }),

  // SEED_DEMO=true  -> actual readings only (nothing fake is ever shown or saved).
  // SEED_DEMO=false -> demoFallback: the dashboard shows fake demo readings (browser only, never saved)
  //                    until the first real reading arrives.
  "GET /api/config": () => ({ adminMode: ADMIN_MODE, demoFallback: !SEED_DEMO_TRUE }),

  "POST /api/auth/send-code": async ({ req, body }) => {
    rateLimit(req, "code", 5);
    if (ADMIN_MODE !== "email") throw bad("Email codes are not set up on this server.");
    const email = String(body.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw bad("Type your email first.");
    if (ADMIN_EMAILS.length && !ADMIN_EMAILS.includes(email)) throw bad("This email is not allowed to be an admin.");
    if (sql.userByEmail.get(email)) throw bad("This email already has an account.");

    const code = String(100000 + crypto.randomInt(900000));
    sql.setCode.run(email, sha256(email + ":" + code), Date.now() + CODE_MINUTES * 60000);
    try {
      await sendMail({
        to: email,
        subject: "Your Water Monitor admin code",
        text: `Your admin code is ${code}\nIt is valid for ${CODE_MINUTES} minutes.\nIf you did not ask for this, ignore this email.`,
      });
    } catch (err) {
      console.error("[mail]", err.message);
      sql.deleteCode.run(email);
      throw new HttpError(502, /535|534/.test(err.message)
        ? "Gmail refused the login. Use a Gmail App Password in .env (see README)."
        : "Could not send the email. Check GMAIL_USER, GMAIL_APP_PASSWORD and your internet.");
    }
    return { message: `Code sent to ${email}. It is valid for ${CODE_MINUTES} minutes.` };
  },

  "POST /api/auth/signup": async ({ req, res, body }) => {
    rateLimit(req, "auth", 30);
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.name || "").trim().slice(0, 80);
    const password = String(body.password || "");
    let role = body.role === "admin" ? "admin" : "user";

    if (!EMAIL_RE.test(email)) throw bad("Enter a valid email.");
    if (password.length < 6 || password.length > 200) throw bad("Password must be at least 6 characters.");
    if (!name) throw bad("Enter your name.");
    if (sql.userByEmail.get(email)) throw bad("This email already has an account.");

    if (ADMIN_MODE === "email") {
      if (role === "admin") {
        if (ADMIN_EMAILS.length && !ADMIN_EMAILS.includes(email)) throw bad("This email is not allowed to be an admin.");
        const row = sql.getCode.get(email);
        const wrong = () => bad("Wrong or expired code. Click 'Send code to my email'.");
        if (!row || Date.now() > row.expires || row.attempts >= 5) throw wrong();
        if (!safeEqual(sha256(email + ":" + String(body.code || "").trim()), row.code_hash)) {
          sql.bumpCode.run(email);
          throw wrong();
        }
        sql.deleteCode.run(email);
      }
    } else if (ADMIN_MODE === "secret") {
      if (role === "admin") {
        if (ADMIN_EMAILS.length && !ADMIN_EMAILS.includes(email)) throw bad("This email is not allowed to be an admin.");
        if (!safeEqual(String(body.code || ""), ADMIN_SECRET)) throw bad("Wrong admin secret.");
      }
    } else if (sql.userCount.get().n === 0) {
      role = "admin";                       // nothing configured: the first account becomes the admin
    } else if (role === "admin") {
      throw bad("Admin sign-up is closed. Ask the admin, or set up Gmail / ADMIN_SECRET in .env.");
    }

    sql.insertUser.run(email, name, role, await hashPassword(password), Date.now());
    res.setHeader("Set-Cookie", `${COOKIE}=${makeToken(email)}; Max-Age=604800${cookieFlags()}`);
    res.statusCode = 201;
    return { user: publicUser(sql.userByEmail.get(email)) };
  },

  "POST /api/auth/login": async ({ req, res, body }) => {
    rateLimit(req, "auth", 30);
    const email = String(body.email || "").trim().toLowerCase();
    const user = sql.userByEmail.get(email);
    const ok = await checkPassword(String(body.password || ""), user?.password_hash);
    if (!user || !ok) throw new HttpError(401, "Wrong email or password.");
    res.setHeader("Set-Cookie", `${COOKIE}=${makeToken(email)}; Max-Age=604800${cookieFlags()}`);
    return { user: publicUser(user) };
  },

  "POST /api/auth/logout": ({ res }) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Max-Age=0${cookieFlags()}`);
    return { ok: true };
  },

  "GET /api/me": ({ req }) => ({ user: publicUser(needUser(req)) }),

  "PUT /api/me": async ({ req, body }) => {
    const user = needUser(req);
    const name = String(body.name || "").trim().slice(0, 80);
    const password = body.password ? String(body.password) : "";
    if (!name) throw bad("Enter your name.");
    if (password && (password.length < 6 || password.length > 200)) throw bad("Password must be at least 6 characters.");
    sql.updateName.run(name, user.email);
    if (password) sql.updatePassword.run(await hashPassword(password), user.email);
    return { user: publicUser(sql.userByEmail.get(user.email)) };
  },

  "GET /api/readings": ({ req, url }) => {
    needUser(req);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit"), 10) || 300, 1), 2000);
    return { readings: sql.readings.all(limit) }; // newest first
  },

  // ESP32 (x-api-key header) or a logged-in admin (demo buttons)
  "POST /api/readings": ({ req, res, body }) => {
    const key = req.headers["x-api-key"];
    const isDevice = DEVICE_API_KEY && key && safeEqual(key, DEVICE_API_KEY);
    if (!isDevice) {
      if (ACTUAL_ONLY) throw new HttpError(401, "Missing or wrong API key. Only the connected device can add readings.");
      const user = userFromRequest(req);
      if (!user) throw new HttpError(401, "Missing or wrong API key.");
      if (user.role !== "admin") throw new HttpError(403, "Admins only.");
    }
    if (isDevice) markDeviceSeen(); // any authorised contact from the ESP32 counts, even a bad payload
    const reading = insertReading(parseReading(body), { demo: !isDevice, total: num(body.total), source: isDevice ? "device" : "manual" });
    broadcast("reading", reading);  // open dashboards update immediately
    res.statusCode = 201;
    return { reading };
  },

  "DELETE /api/readings": ({ req }) => {
    needAdmin(req);
    sql.clearReadings.run();
    broadcast("cleared", {}); // every open dashboard empties its history at once
    return { ok: true };
  },

  // The ESP32 can call this every few seconds (just the x-api-key header, no body) to say "I'm connected",
  // so the status stays accurate even when readings are sent less often.
  "POST /api/ping": ({ req }) => {
    const key = req.headers["x-api-key"];
    if (!(DEVICE_API_KEY && key && safeEqual(key, DEVICE_API_KEY))) throw new HttpError(401, "Missing or wrong API key.");
    markDeviceSeen();
    return { ok: true };
  },

  "GET /api/limits": ({ req }) => { needUser(req); return { limits: getLimits() }; },

  "PUT /api/limits": ({ req, body }) => {
    needAdmin(req);
    const next = {};
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      const v = num(body[key]);
      if (!Number.isFinite(v) || v < 0) throw bad(`"${key}" must be a positive number.`);
      next[key] = v;
    }
    if (next.phmin >= next.phmax) throw bad("pH min must be lower than pH max.");
    if (next.phmax > 14) throw bad("pH max cannot be above 14.");
    db.exec("BEGIN");
    for (const [k, v] of Object.entries(next)) sql.setLimit.run(k, v);
    db.exec("COMMIT");
    return { limits: getLimits() };
  },

  "GET /api/users": ({ req }) => { needAdmin(req); return { users: sql.allUsers.all() }; },

  "DELETE /api/users/:email": ({ req, params }) => {
    const me = needAdmin(req);
    const email = params.email.toLowerCase();
    if (email === me.email) throw bad("You cannot delete your own account.");
    if (!sql.deleteUser.run(email).changes) throw new HttpError(404, "User not found.");
    return { ok: true };
  },
};

// Turn "DELETE /api/users/:email" into a matcher
const compiled = Object.entries(routes).map(([key, handler]) => {
  const [method, pattern] = key.split(" ");
  const names = [];
  const regex = new RegExp("^" + pattern.replace(/:([a-z]+)/g, (_, n) => { names.push(n); return "([^/]+)"; }) + "$");
  return { method, regex, names, handler };
});

// ===================== HTTP server =====================
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 20000) { reject(new HttpError(413, "Request too large.")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(bad("Invalid JSON.")); }
    });
    req.on("error", reject);
  });
}

function send(res, status, body, type) {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.end(body);
}

async function handleApi(req, res, url) {
  const route = compiled.map((r) => ({ r, m: r.method === req.method && url.pathname.match(r.regex) })).find((x) => x.m);
  if (!route) throw new HttpError(404, "Not found.");
  const params = Object.fromEntries(route.r.names.map((n, i) => [n, decodeURIComponent(route.m[i + 1])]));
  const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
  const result = await route.r.handler({ req, res, body, params, url });
  send(res, res.statusCode === 200 || res.statusCode === 201 ? res.statusCode : 200, JSON.stringify(result), "application/json");
}

function serveStatic(req, res, url) {
  let file = path.join(PUBLIC_DIR, decodeURIComponent(url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", "text/plain");
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/stream" && req.method === "GET") openStream(req, res);
    else if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else if (req.method === "GET" || req.method === "HEAD") serveStatic(req, res, url);
    else send(res, 405, "Method not allowed", "text/plain");
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) send(res, status, JSON.stringify({ error: status >= 500 && PRODUCTION ? "Server error." : err.message }), "application/json");
  }
});

server.listen(PORT, () => {
  console.log(`\nWater Monitor is running: open  http://localhost:${PORT}\n`);
  if (ADMIN_MODE === "email") console.log(`[info] Admin sign-up: a 6-digit code is emailed from ${GMAIL_USER}.`);
  else if (ADMIN_MODE === "secret") console.log("[info] Admin sign-up: needs ADMIN_SECRET.");
  else console.log("[info] No Gmail or ADMIN_SECRET set: the first account you create becomes the admin.");
  if (!envReport.found) {
    const hasExample = fs.existsSync(path.join(__dirname, ".env.example"));
    console.log(`[warn] No ".env" file found next to server.js, so every setting uses its default.${hasExample ? ' (".env.example" is only a template and is NOT read: copy it and name the copy ".env".)' : ""}`);
  }
  for (const key of envReport.overridden) console.log(`[warn] ${key} is already set on this computer/terminal to "${process.env[key]}", which wins over the value in .env. Remove that variable or restart VS Code.`);
  console.log(SEED_DEMO_TRUE
    ? "[info] SEED_DEMO=true: only readings sent by the connected device are collected and shown."
    : `[info] SEED_DEMO is "${process.env.SEED_DEMO ?? "(not set)"}", not true: fake demo readings are shown until the device sends its first real reading.`);
  if (!DEVICE_API_KEY) console.log("[info] No DEVICE_API_KEY set: the ESP32 endpoint is off.");
  else console.log(`[info] Device status reaction time: ${DEVICE_TIMEOUT_MS / 1000} s (Offline if the ESP32 is silent that long; set DEVICE_TIMEOUT_SECONDS in .env).`);
});
