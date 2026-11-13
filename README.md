# Water Monitor – VS Code version (no npm install)

Only needs **Node.js 22.5 or newer** (get the LTS from nodejs.org). No packages to install.

## Run it in VS Code
1. Unzip the folder, then in VS Code: **File → Open Folder** → pick `water-monitor`.
2. Press **F5** (or open **Terminal → New Terminal** and type `node server.js`).
3. Open **http://localhost:3000** in your browser.
4. Click **Create account**. Until you set up Gmail (below), **the first account you create becomes the admin.**

Stop the server with **Ctrl+C** in the terminal (or the red square in the debug bar).

> Tip: type `node server.js` instead of `npm start`. It skips npm, so the PowerShell
> "running scripts is disabled" error can't happen.

## Real-time status (no refresh, no delay)
The dashboard keeps one live connection to the server (Server-Sent Events, `/api/stream`). The server **pushes**
every change, so the screen reacts in milliseconds instead of waiting for a 10-second refresh.

The pill next to your name has two states:
- **● Online**: the ESP32 contacted the server within the *reaction time* (default 30 s). Turns on the instant it posts a reading or pings.
- **● Offline**: the browser can't reach the server, or the ESP32 has been silent longer than the reaction time. The last data stays on screen.

What updates live: new readings (the table row flashes), Online/Offline, and "Clear history" (on every open dashboard at once).
If the server stops, the page shows Offline within a second and reconnects by itself when the server is back.

**Reaction time:** the device counts as Offline after `DEVICE_TIMEOUT_SECONDS` of silence (default 30). Set it in `.env`
to about 3x how often your ESP32 sends (for example ESP32 sends every 2 s, set 6 to 10), then restart the server.

**Actual vs demo readings (`SEED_DEMO`):**
- `SEED_DEMO=true` collects and shows **only actual data from the connected device**. Only requests carrying the `x-api-key` are stored (nobody can add readings by hand), and on every start the server deletes any reading that did not come from the device (for example old fake data from an earlier version). Readings your ESP32 sent are kept. Until the ESP32 sends its first reading the pages show zeros and *No device data yet*.
- `SEED_DEMO=false` shows fake demo readings (banner: *Demo data: no device connected*) until the device sends its first real reading. They exist only in your browser, are never saved, and are replaced the moment a real reading arrives. If an admin clears the history, they come back.

## Gmail: emailed admin codes
When you choose **I am an Admin**, a **Send code to my Gmail** button appears. The server emails a 6-digit
code (valid 10 minutes, 5 tries) and the person types it in. To turn this on you need a Gmail account that sends the emails:

1. Go to **myaccount.google.com → Security** and turn on **2-Step Verification** (required by Google).
2. Open **myaccount.google.com/apppasswords**, name it `Water Monitor`, click **Create**, and copy the 16-letter password.
3. In the project folder, copy `.env.example`, rename the copy to `.env`, and fill in:
   ```
   GMAIL_USER=yourname@gmail.com
   GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
   ```
   (Spaces in the password are fine. Use the App Password, **not** your normal Gmail password.)
4. Restart the server. The terminal should say: `Admin sign-up: a 6-digit code is emailed from ...`.

Want only certain people to be admin? Add `ADMIN_EMAILS=you@gmail.com,friend@gmail.com`.
If the email doesn't arrive, check Spam. If the terminal says "Gmail refused the login", the App Password is wrong.
Your computer needs internet access to smtp.gmail.com on port 465 (some school/work networks block it).

## Optional settings (.env)
Copy `.env.example`, rename the copy to `.env`, edit, and **restart the server** (the file is read only at start).
The server only reads a file named exactly `.env`; `.env.example` is just a template and is ignored. The terminal shows
which setting it picked up, and warns when no `.env` is found.

| Setting | Meaning |
|---|---|
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Turns on emailed admin codes (see above) |
| `ADMIN_SECRET` | Used only if Gmail is not set: people must type this to create an admin account |
| `ADMIN_EMAILS` | Only these emails may become admin |
| `DEVICE_API_KEY` | Secret the ESP32 sends in the `x-api-key` header |
| `DEVICE_TIMEOUT_SECONDS` | Reaction time: Offline after this many seconds of ESP32 silence (default 30) |
| `SEED_DEMO` | `true` = only actual readings from the connected device are collected and shown (old fake data is removed at start). `false` = fake demo readings (browser only) until the first real reading arrives |
| `NODE_ENV` | `production` only when deployed with HTTPS |

Write values as `KEY=value`. A comment after the value (`KEY=value  # note`) is fine.

## ESP32
`POST http://YOUR-PC-IP:3000/api/readings` with header `x-api-key: <DEVICE_API_KEY>` and JSON:
`{"ph":7.2,"tds":210,"ntu":1.1,"temp":27.5,"flow":6.5}`  (flow = L/min).
Optional `"total"` = meter liters; if omitted the server works it out from the flow.

To keep the status accurate even when readings are sent rarely, the ESP32 can also call
`POST http://YOUR-PC-IP:3000/api/ping` with just the `x-api-key` header (no body) every few seconds.
For the most live feel, send a reading every 1-2 seconds.
Your PC and the ESP32 must be on the same WiFi, and Windows Firewall must allow Node on port 3000.

## Where is my data?
In `data/water.db` (one file). Delete the `data` folder to start fresh.

## What's inside
- `server.js` – the whole backend (Node built-ins only: http, crypto, SQLite)
- `public/index.html` – the dashboard
- `.vscode/launch.json` – makes F5 work
