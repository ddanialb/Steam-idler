/*
 * File: idler.js
 * Project: steam-idler
 * Created Date: 2021-03-31 21:05:47
 * Author: 3urobeat
 *
 * Render edition: config & accounts come from environment variables,
 * plus a small status page so the Web Service passes health checks.
 */


// --- RENDER: let environment variables override config.json (keeps secrets out of the repo!) ---
const config = require("./config.json");

// PLAYING_GAMES="730" or "730,440,Some Custom Text"
if (process.env.PLAYING_GAMES) {
    config.playingGames = process.env.PLAYING_GAMES
        .split(",")
        .map(e => e.trim())
        .filter(e => e.length > 0)
        .map(e => (/^\d+$/.test(e) ? parseInt(e, 10) : e));
}

if (process.env.ONLINE_STATUS) config.onlinestatus = parseInt(process.env.ONLINE_STATUS, 10);
if (process.env.AFK_MESSAGE !== undefined) config.afkMessage = process.env.AFK_MESSAGE;


// --- Start the bot ---
const controller = require("./src/controller.js");
controller.start();


// --- RENDER: tiny status page (health check + live overview, nothing sensitive shown) ---
const http      = require("http");
const startedAt = Date.now();
const PORT      = process.env.PORT || 3000;

// Escape user generated strings before putting them into HTML
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Partially hide the account name (the Render URL is technically public)
const mask = (name) => esc(String(name).slice(0, 2)) + "***";

// Format milliseconds as "Xd Xh Xm Xs"
const fmtDur = (ms) => {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return (d > 0 ? d + " روز و " : "") + (h > 0 ? h + " ساعت و " : "") + m + " دقیقه";
};

// CS2 & co. appid -> readable name for nicer display
const GAME_NAMES = { "730": "CS2", "440": "TF2", "570": "Dota 2", "10": "CS 1.6", "252490": "Rust" };
const gameName = (g) => (typeof g === "number" && GAME_NAMES[g] ? `${GAME_NAMES[g]} (${g})` : esc(g));

function renderPage() {
    const bots   = controller.allBots || [];
    const uptime = fmtDur(Date.now() - startedAt);
    const games  = config.playingGames.map(gameName).join("، ") || "-";

    let rows = "";

    if (bots.length == 0) {
        rows = `<tr><td colspan="3" class="empty">⏳ در حال راه‌اندازی... اگه این پیام موند، یعنی env مربوط به ACCOUNTS درست تنظیم نشده.</td></tr>`;
    } else {
        for (const b of bots) {
            let status, css;

            if (b.startedPlayingTimestamp) {
                status = "🎮 در حال فارم"; css = "ok";
            } else if (b.client.steamID) {
                status = "✅ آنلاین"; css = "wait";
            } else {
                status = "⏳ در حال اتصال"; css = "wait";
            }

            const session = b.startedPlayingTimestamp ? fmtDur(Date.now() - b.startedPlayingTimestamp) : "-";

            rows += `<tr><td>${mask(b.logOnOptions.accountName)}</td><td><span class="chip ${css}">${status}</span></td><td>${session}</td></tr>`;
        }
    }

    return `<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>🎮 Steam Idler</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Tahoma, Arial, sans-serif; background: #0b1120; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 28px; width: 100%; max-width: 480px; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
  h1 { font-size: 22px; }
  .sub { color: #94a3b8; font-size: 13px; margin: 6px 0 18px; }
  .stats { display: flex; flex-direction: column; gap: 8px; background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 14px; margin-bottom: 16px; font-size: 14px; }
  .stats b { color: #7dd3fc; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: right; color: #94a3b8; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid #334155; }
  td { padding: 10px 8px; border-bottom: 1px solid #1e293b; }
  .empty { text-align: center; color: #94a3b8; }
  .chip { padding: 3px 10px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
  .chip.ok { background: rgba(74,222,128,.15); color: #4ade80; }
  .chip.wait { background: rgba(250,204,21,.15); color: #facc15; }
  .hint { margin-top: 14px; font-size: 11px; color: #64748b; text-align: center; }
</style>
</head>
<body>
  <div class="card">
    <h1>🎮 Steam Idler</h1>
    <p class="sub">ساعت‌زنی خودکار استیم روی Render</p>
    <div class="stats">
      <div>⏱ آپتایم سرویس: <b>${uptime}</b></div>
      <div>🎯 بازی‌های در صف فارم: <b>${games}</b></div>
    </div>
    <table>
      <tr><th>اکانت</th><th>وضعیت</th><th>مدت این سشن</th></tr>
      ${rows}
    </table>
    <p class="hint">هر ۳۰ ثانیه خودکار رفرش می‌شود 🔄</p>
  </div>
</body>
</html>`;
}

http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPage());
}).listen(PORT, () => {
    console.log(`Status page listening on port ${PORT}`);
});
