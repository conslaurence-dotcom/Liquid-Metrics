"use strict";
// Reads JSON lines from the Arduino over USB and posts them to the Water Monitor server.
// Only REAL measurements are saved: if a sensor is not measuring (probe dry, unplugged,
// voltage out of range), that value is shown as 0 and nothing fake is made up.
const fs = require("node:fs");
const path = require("node:path");
const { SerialPort, ReadlineParser } = require("serialport");

// ---- read DEVICE_API_KEY from .env ----
let KEY = process.env.DEVICE_API_KEY || "";
try {
  const m = fs.readFileSync(path.join(__dirname, ".env"), "utf8").match(/^\s*DEVICE_API_KEY\s*=\s*(.+?)\s*$/m);
  if (m && !KEY) KEY = m[1].replace(/^["']|["']$/g, "");
} catch {}
if (!KEY) { console.error("DEVICE_API_KEY is missing in .env"); process.exit(1); }

const SERVER = "http://localhost:3000";
const BAUD = 9600;                               // must match Serial.begin() in the sketch
const FORCED_PORT = process.env.COM_PORT || "";  // optional: set COM_PORT=COM3

// ---- calibration / limits (adjust for your sensors) ----
const PH_SLOPE = 3.5;          // common analog pH board: pH = 3.5 x voltage + offset
const PH_OFFSET = 0;           // change after calibrating with a pH 7 buffer
const TDS_MAX_VOLTAGE = 2.5;   // TDS modules output about 0-2.3 V; higher means probe not connected/dry

const warned = new Set();
function warnOnce(msg) { if (!warned.has(msg)) { warned.add(msg); console.log("[note]", msg); } }

//#region convert
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

// Returns { reading, measuring }.  measuring = at least one sensor gave a real value.
function toReading(raw) {
  const d = {};
  for (const [k, v] of Object.entries(raw)) d[k.toLowerCase()] = v;

  // pH: valid only if it lands between 0 and 14
  let ph = isNum(d.ph) ? d.ph : isNum(d.phvoltage) ? PH_SLOPE * d.phvoltage + PH_OFFSET : null;
  const phOk = ph !== null && ph >= 0 && ph <= 14;
  if (!phOk) { warnOnce("pH is not measuring (probe dry/unplugged or needs calibration), showing 0."); ph = 0; }

  // TDS: valid only if the sensor voltage is in its working range
  let tds = null;
  if (isNum(d.tds)) tds = d.tds;
  else if (isNum(d.tdsvoltage) && d.tdsvoltage > 0.01 && d.tdsvoltage <= TDS_MAX_VOLTAGE) {
    const v = d.tdsvoltage;
    tds = (133.42 * v ** 3 - 255.86 * v ** 2 + 857.39 * v) * 0.5;
  }
  const tdsOk = tds !== null && tds >= 0 && tds <= 10000;
  if (!tdsOk) { warnOnce("TDS is not measuring (probe dry/unplugged), showing 0."); tds = 0; }

  // Turbidity
  let ntu = isNum(d.ntu) ? d.ntu : isNum(d.turbidity) ? d.turbidity : null;
  const ntuOk = ntu !== null && ntu >= 0 && ntu <= 3000;
  if (!ntuOk) { warnOnce("No turbidity value from the Arduino, showing 0."); ntu = 0; }

  // Temperature
  let temp = isNum(d.temp) ? d.temp : isNum(d.temperaturec) ? d.temperaturec : null;
  const tempOk = temp !== null && temp >= -10 && temp <= 100;
  if (!tempOk) { warnOnce("Temperature sensor is not reading, showing 0."); temp = 0; }

  // Flow (0 is a real value when water is not flowing)
  let flow = isNum(d.flow) ? d.flow : isNum(d.flowlmin) ? d.flowlmin : null;
  const flowOk = flow !== null && flow >= 0.5 && flow <= 30;
  if (!flowOk) flow = 0;

  const reading = {
    ph: +ph.toFixed(2), tds: +tds.toFixed(0), ntu: +ntu.toFixed(2),
    temp: +temp.toFixed(1), flow: +flow.toFixed(2),
  };
  const total = isNum(d.total) ? d.total : isNum(d.flowtotall) ? d.flowtotall : null;
  if (total !== null && total >= 0) reading.total = total;

  const measuring = phOk || tdsOk || ntuOk || tempOk || (flowOk && flow > 0);
  return { reading, measuring };
}
//#endregion

async function findPort() {
  if (FORCED_PORT) return FORCED_PORT;
  const ports = await SerialPort.list();
  console.log("Ports found:", ports.map((p) => `${p.path} (${p.manufacturer || "unknown"})`).join(", ") || "none");
  const pick = ports.find((p) => /arduino|wch|ch340|ftdi|silicon|usb/i.test(p.manufacturer || "")) || ports[0];
  return pick ? pick.path : null;
}

// Tell the server "the device is connected". Called ONLY when the Arduino is really sending data,
// so unplugging the USB cable makes the dashboard go Offline.
async function ping() {
  try { await fetch(`${SERVER}/api/ping`, { method: "POST", headers: { "x-api-key": KEY } }); } catch {}
}

// One retry timer only (avoids several reconnect loops running at once)
let retryTimer = null;
function retry(ms = 3000) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; start(); }, ms);
}

async function sendReading(data) {
  try {
    const res = await fetch(`${SERVER}/api/readings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": KEY },
      body: JSON.stringify(data),
    });
    if (!res.ok) console.log("Server said:", res.status, await res.text(), "| data sent:", JSON.stringify(data));
    else console.log("Sent:", data);
  } catch (e) {
    console.log("Cannot reach server (is `node server.js` running?):", e.message);
  }
}

async function start() {
  const portPath = await findPort();
  if (!portPath) {
    console.log("No COM port found. Check the USB cable. Retrying...");
    return retry();
  }

  console.log(`Opening ${portPath} at ${BAUD} baud...`);
  const port = new SerialPort({ path: portPath, baudRate: BAUD }, (err) => {
    if (err) {
      console.log("Cannot open port:", err.message, "(close Arduino IDE!)");
      retry();
    }
  });
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

  parser.on("data", (line) => {
    ping(); // data is arriving from the Arduino = device connected
    try {
      const { reading, measuring } = toReading(JSON.parse(line.trim()));
      if (measuring) sendReading(reading);
      else console.log("Connected, but no sensor is measuring yet (probes dry/unplugged). Nothing saved.");
    } catch { console.log("Ignored line:", line.trim()); }
  });
  port.on("close", () => { console.log("Cable unplugged / port closed. Dashboard will go Offline. Reconnecting..."); retry(); });
  port.on("error", (e) => console.log("Serial error:", e.message));
}

start();        