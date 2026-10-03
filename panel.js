/*
 * File: panel.js
 * Render control panel for steam-idler:
 * - Login system (admin via env, extra users created in-panel, hashed passwords)
 * - Start/Stop farming & bot power per account
 * - Game search by name (multi-game idling)
 * - Auto-Stop timer & Auto-Restart watchdog per account
 * - Per-account QR login inside the panel (users can add their own Steam account!)
 * State is kept in ./state.json (persists until redeploy)
 */

const http   = require("http");
const fs     = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");

let controller = null;
let config     = null;

const PORT        = process.env.PORT || 3000;
const startedAt   = Date.now();
const STATE_FILE  = "./state.json";

const PANEL_USER  = process.env.PANEL_USER || "";
const PANEL_PASS  = process.env.PANEL_PASS || "";

/* ---------------- State ---------------- */

let state = { users: [], accounts: {}, gameNames: {}, extraAccounts: [] };

function loadState() {
    try {
        state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        if (!state.users) state.users = [];
        if (!state.accounts) state.accounts = {};
        if (!state.gameNames) state.gameNames = {};
        if (!state.extraAccounts) state.extraAccounts = [];
    } catch (err) { /* fresh state */ }
}

let saveTimer = null;
function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (err) { console.log("state save failed: " + err); }
    }, 500);
}

function getAccState(name, defaultGames) {
    if (!state.accounts[name]) {
        state.accounts[name] = { enabled: true, farming: true, games: defaultGames.slice(), autoRestart: true, stopAt: null, startedAt: 0 };
        saveState();
    }
    return state.accounts[name];
}

/* ---------------- Auth ---------------- */

const sessions = new Map(); // sid -> { name, exp }

function hashPass(pass, salt) {
    if (!salt) salt = crypto.randomBytes(16).toString("hex");
    return salt + ":" + crypto.scryptSync(String(pass), salt, 32).toString("hex");
}

function checkAuth(username, pass) {
    if (PANEL_USER && username === PANEL_USER && pass === PANEL_PASS) return { name: username, role: "admin" };

    const u = state.users.find(e => e.name === username);
    if (!u || !u.hash) return null;

    const [salt, hash] = u.hash.split(":");
    const calc = crypto.scryptSync(String(pass), salt, 32);
    const ref  = Buffer.from(hash, "hex");
    if (ref.length == calc.length && crypto.timingSafeEqual(ref, calc)) return { name: u.name, role: "user" };

    return null;
}

// Resolve fresh user data per request (so account assignments take effect without re-login)
function resolveUser(name) {
    if (PANEL_USER && name === PANEL_USER) return { name, role: "admin", accounts: null };
    const u = state.users.find(e => e.name === name);
    if (!u) return null;
    return { name: u.name, role: "user", accounts: u.accounts || [] };
}

const loginFails = new Map();
function tooManyFails(ip) {
    const now = Date.now();
    const arr = (loginFails.get(ip) || []).filter(t => now - t < 300000);
    loginFails.set(ip, arr);
    return arr.length >= 8;
}

function getSession(req) {
    const c = req.headers.cookie || "";
    const m = c.match(/sid=([a-f0-9]{32})/);
    if (!m) return null;
    const s = sessions.get(m[1]);
    if (!s || s.exp < Date.now()) { sessions.delete(m[1]); return null; }
    return resolveUser(s.name); // fresh data every request
}

/* ---------------- Steam helpers ---------------- */

function allBotsSafe() { return (controller && controller.allBots) ? controller.allBots : []; }

function gameNameOf(g) {
    const names = { "730": "CS2", "440": "TF2", "570": "Dota 2", "252490": "Rust" };
    if (state.gameNames && state.gameNames[String(g)]) return state.gameNames[String(g)];
    return names[g] || null;
}

// Create a bot for a user-added Steam account (QR login only - no password ever asked)
function createDynamicBot(accountName) {
    const Bot = require("./src/bot.js");
    const loginindex = allBotsSafe().length;
    const logOnOptions = { accountName, password: "qrcode", sharedSecret: null, steamGuardCode: null };

    const bot = new Bot(logOnOptions, loginindex, [null]);
    allBotsSafe().push(bot);
    getAccState(accountName, [730]);
    bot.login();
    console.log(`[panel] User-added account '${accountName}' - QR login started`);
    return bot;
}

const searchCache = new Map();
async function searchApps(q) {
    const key = q.toLowerCase();
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.t < 60000) return hit.r;

    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 8000);

    try {
        const res  = await fetch("https://steamcommunity.com/actions/SearchApps/" + encodeURIComponent(q), { signal: ac.signal });
        const data = await res.json();
        const out  = (Array.isArray(data) ? data : []).slice(0, 12).map(e => ({ appid: e.appid, name: e.name }));
        searchCache.set(key, { t: Date.now(), r: out });
        return out;
    } finally {
        clearTimeout(to);
    }
}

/* ---------------- Watchdog ---------------- */

function startWatchdog() {
    setInterval(() => {
        const now = Date.now();

        for (const b of allBotsSafe()) {
            const name = b.logOnOptions.accountName;
            const s    = state.accounts[name];
            if (!s) continue;

            const online = !!b.client.steamID;

            if (s.stopAt && now >= s.stopAt) { // Auto-Stop
                s.stopAt = null; s.enabled = false; s.farming = false;
                if (online) b.client.logOff();
                b.startedPlayingTimestamp = 0;
                b.playedAppIDs = [];
                saveState();
                if (global.logger) logger("info", `[${name}] Auto-Stop: timer reached, bot stopped by panel.`);
                continue;
            }

            if (!s.enabled && online) { // Power off desired
                b.client.logOff();
                b.startedPlayingTimestamp = 0;
                b.playedAppIDs = [];
                continue;
            }

            if (s.enabled && !online && s.autoRestart) { // Auto-Restart
                const loginPhaseDone = controller.nextacc > b.loginindex;
                const inRelogQueue   = controller.relogQueue.includes(b.loginindex);
                const lastTry        = b._panelLastLoginTry || 0;
                const qrPending      = global.renderQrChallenges && global.renderQrChallenges[name];
                const cooldown       = b.userPlayingElsewhere ? 180000 : 60000; // fast retry normally, gentler while the user plays on PC

                if (loginPhaseDone && !inRelogQueue && !qrPending && now - lastTry > cooldown) {
                    b._panelLastLoginTry = now;
                    if (global.logger) logger("info", `[${name}] Panel watchdog: account offline, restarting login...`);

                    try { b.login(); } catch (e) { console.log(`[${name}] watchdog login failed: ${e}`); }
                }
            }

            if (s.enabled && online) { // Farm enforcement + keep-alive/auto-resume probe
                if (s.farming) {
                    if (b.startedPlayingTimestamp == 0 && !b.userPlayingElsewhere) {
                        b.client.gamesPlayed(s.games);
                        b.startedPlayingTimestamp = now;
                        b.playedAppIDs = s.games.slice();
                    } else {
                        // Re-assert gamesPlayed to keep the claim alive & resume instantly after the user stops
                        // playing on their PC. While blocked, probe every 25s for a near-instant resume (~3 min otherwise).
                        const probeMs = b.userPlayingElsewhere ? 25000 : 180000;

                        if (now - (b._lastPlayProbe || 0) > probeMs) {
                            b._lastPlayProbe = now;
                            b.client.gamesPlayed(s.games);
                        }
                    }
                } else if (!s.farming && b.startedPlayingTimestamp != 0) {
                    b.client.gamesPlayed([]);
                    b.startedPlayingTimestamp = 0;
                    b.playedAppIDs = [];
                }
            }
        }
    }, 15000);
}

/* ---------------- UI ---------------- */

const maskName = (n) => String(n).slice(0, 2) + "***";
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

const CSS = ""
    + "*{box-sizing:border-box;margin:0;padding:0}"
    + "body{font-family:Tahoma,'Segoe UI',Arial,sans-serif;min-height:100vh;color:#e2e8f0;background:#060b18;background-image:radial-gradient(800px 400px at 85% -10%,rgba(37,99,235,.25),transparent),radial-gradient(700px 400px at 10% 110%,rgba(124,58,237,.18),transparent);padding:18px}"
    + ".wrap{max-width:880px;margin:0 auto}"
    + ".card{background:rgba(21,31,54,.85);border:1px solid #263855;border-radius:18px;padding:22px;margin-bottom:18px;backdrop-filter:blur(6px);box-shadow:0 8px 30px rgba(0,0,0,.35)}"
    + "h1{font-size:22px;background:linear-gradient(90deg,#7dd3fc,#a5b4fc);-webkit-background-clip:text;background-clip:text;color:transparent}"
    + "h2{font-size:15px;margin-bottom:8px;color:#a5b4fc}"
    + ".sub{color:#8ea3c2;font-size:12px;margin-top:5px;line-height:1.7}"
    + "input,select{background:#0b1526;border:1px solid #2c4066;color:#e2e8f0;border-radius:10px;padding:9px 12px;font-size:14px;font-family:inherit;outline:none;transition:border-color .15s, box-shadow .15s}"
    + "input:focus,select:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.18)}"
    + "button{border:none;color:#fff;border-radius:12px;padding:10px 18px;font-size:13px;cursor:pointer;font-family:inherit;font-weight:bold;letter-spacing:.2px;transition:transform .12s,filter .15s,box-shadow .15s;background:linear-gradient(135deg,#3b82f6,#6366f1);box-shadow:0 4px 14px rgba(59,130,246,.35)}"
    + "button:hover{filter:brightness(1.15);transform:translateY(-1px);box-shadow:0 6px 18px rgba(59,130,246,.45)} button:active{transform:scale(.95)}"
    + "button.warn{background:linear-gradient(135deg,#f59e0b,#f97316);box-shadow:0 4px 14px rgba(245,158,11,.35)}"
    + "button.danger{background:linear-gradient(135deg,#ef4444,#be123c);box-shadow:0 4px 14px rgba(239,68,68,.35)}"
    + "button.ghost{background:#263855;box-shadow:none}"
    + "button.bfarm{background:linear-gradient(135deg,#22c55e,#059669);box-shadow:0 4px 14px rgba(34,197,94,.4)}"
    + "button.brestart{background:linear-gradient(135deg,#8b5cf6,#06b6d4);box-shadow:0 4px 14px rgba(139,92,246,.4)}"
    + ".tokenbox{display:flex;gap:8px;align-items:center;margin-top:12px;background:#0b1526;border:1px dashed #3b82f6;border-radius:12px;padding:10px}"
    + ".tokenbox input{flex:1;direction:ltr;font-family:monospace;font-size:11px;background:#060b18;border:1px solid #2c4066;min-width:0}"
    + ".tokenbox button{padding:8px 12px}"
    + ".chip{display:inline-flex;align-items:center;gap:5px;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:bold}"
    + ".ok{background:rgba(52,211,153,.14);color:#34d399}.wait{background:rgba(251,191,36,.14);color:#fbbf24}.bad{background:rgba(248,113,113,.14);color:#f87171}"
    + ".dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block;animation:p 1.4s infinite}"
    + "@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}"
    + ".gline{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:7px 0}"
    + ".gamechip{background:#0b1526;border:1px solid #2c4066;border-radius:9px;padding:5px 10px;font-size:12px;display:inline-flex;gap:7px;align-items:center}"
    + ".gamechip b{color:#7dd3fc}"
    + ".x{color:#f87171;cursor:pointer;font-weight:bold;padding:0 2px}"
    + ".x:hover{color:#fca5a5}"
    + ".row{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}"
    + ".res{border-top:1px dashed #2c4066;margin-top:10px;padding-top:6px;max-height:260px;overflow:auto}"
    + ".resitem{display:flex;justify-content:space-between;align-items:center;padding:7px 2px;font-size:13px;border-bottom:1px solid rgba(44,64,102,.4)}"
    + ".resitem:last-child{border-bottom:none}"
    + ".muted{color:#64748b;font-size:11px}"
    + "table{width:100%;font-size:13px;border-collapse:collapse} td,th{padding:7px 6px;text-align:right;border-bottom:1px solid rgba(44,64,102,.5)} th{color:#94a3b8;font-size:11px;border-bottom:1px solid #2c4066}"
    + "img.qr{border-radius:12px;display:block;margin:12px auto;box-shadow:0 0 0 6px rgba(125,211,252,.15), 0 10px 30px rgba(0,0,0,.5)}"
    + ".bar{position:sticky;top:0;z-index:10;background:rgba(6,11,24,.85);backdrop-filter:blur(10px);padding:12px 4px;margin:0 -4px 14px;border-bottom:1px solid rgba(44,64,102,.5)}"
    + "#toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(80px);background:#0f1d38;border:1px solid #3b82f6;color:#e2e8f0;padding:10px 20px;border-radius:12px;font-size:13px;z-index:99;opacity:0;transition:all .3s;box-shadow:0 8px 30px rgba(0,0,0,.5)}"
    + "#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}"
    + ".qrblock{border:1px solid #38bdf8;border-radius:14px;padding:16px;margin-top:14px;text-align:center;background:rgba(56,189,248,.06)}"
    + ".qrtitle{color:#7dd3fc;font-weight:bold;font-size:15px;animation:p 1.6s infinite}"
    + ".divider{border-top:1px dashed #2c4066;margin:14px 0 10px}"
    + ".bigbtn{width:100%;padding:12px;font-size:15px;margin-top:6px}"
    ;

function pageWrap(title, body) {
    return "<!DOCTYPE html><html dir=\"rtl\" lang=\"fa\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        + "<title>" + title + "</title><style>" + CSS + "</style></head><body><div id=\"toast\"></div><div class=\"wrap\">" + body + "</div></body></html>";
}

function loginPage(msg) {
    return pageWrap("ورود | Steam Idler",
        "<div style=\"min-height:85vh;display:flex;align-items:center;justify-content:center\">"
        + "<div class=\"card\" style=\"width:100%;max-width:400px;text-align:center\">"
        + "<div style=\"font-size:52px;line-height:1\">🎮</div>"
        + "<h1 style=\"margin-top:8px\">Steam Idler</h1>"
        + (msg ? "<div class=\"chip bad\" style=\"margin:12px auto;display:table\">" + esc(msg) + "</div>" : "")
        + "<div style=\"text-align:right;margin-top:16px\">"
        + "<div class=\"gline\"><input id=\"u\" placeholder=\"👤 یوزرنیم\" style=\"flex:1\" autocomplete=\"username\"></div>"
        + "<div class=\"gline\"><input id=\"p\" type=\"password\" placeholder=\"🔑 رمز عبور\" style=\"flex:1\" autocomplete=\"current-password\"></div>"
        + "<button class=\"bigbtn\" onclick=\"login()\">ورود به پنل 🚀</button></div>"
        + "</div></div>"
        + "<script>function login(){fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({u:document.getElementById('u').value,p:document.getElementById('p').value})}).then(r=>r.json()).then(d=>{if(d.ok)location.replace('/');else location.replace('/?err='+encodeURIComponent(d.err||'خطا'))}).catch(()=>{location.replace('/?err=خطای اتصال')})}document.addEventListener('keydown',function(e){if(e.key==='Enter')login()});</script>");
}

function dashPage(user) {
    const isAdmin = user.role === "admin";
    const body =
        "<div class=\"bar row\"><div><h1>🎮 Steam Idler</h1><p class=\"sub\" style=\"margin-top:2px\">👤 <b style=\"color:#a5b4fc\">" + esc(user.name) + "</b>" + (isAdmin ? " 👑" : "") + "</p></div>"
        + "<div class=\"gline\" style=\"margin:0\"><span class=\"chip ok\" id=\"up\">⏱ ...</span><button class=\"ghost\" onclick=\"logout()\">خروج ⎋</button></div></div>"
        + "<div class=\"card\"><div class=\"gline\" style=\"margin:0\"><input id=\"newacc\" placeholder=\"➕ یوزرنیم استیم...\" style=\"flex:1;min-width:150px\"><button onclick=\"addaccount()\">افزودن اکانت</button></div></div>"
        + "<div id=\"accs\"></div>"
        + (isAdmin ? adminHtml() : "")
        + "<script>var ISADMIN=" + (isAdmin ? "true" : "false") + ";</script>"
        + "<script src=\"/static/panel.js\"></script>";

    return pageWrap("🎮 پنل | Steam Idler", body);
}

function adminHtml() {
    return "<div class=\"card\"><h2>👥 کاربرها</h2>"
        + "<div class=\"gline\" style=\"margin-top:8px\"><input id=\"nu\" placeholder=\"یوزرنیم\"><input id=\"np\" placeholder=\"رمز عبور\"><select id=\"na\"><option value=\"\">— اکانت —</option></select><button class=\"warn\" onclick=\"adduser()\">➕ ساخت</button></div>"
        + "<table id=\"users\" style=\"margin-top:8px\"><tr><th>یوزر</th><th>اکانت‌ها</th><th></th></tr></table></div>";
}

/* ---------------- HTTP ---------------- */

function send(res, code, data, type) {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    res.writeHead(code, { "Content-Type": (type || "application/json") + "; charset=utf-8" });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve) => {
        let d = "";
        req.on("data", c => { d += c; if (d.length > 1e5) req.destroy(); });
        req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (e) { resolve({}); } });
    });
}

const qrImgCache = new Map(); // accountName -> { url, dataUrl }

let CLIENT_JS = ""; // contents of panel-client.js, loaded in attach()

function stateFor(user) {
    const now = Date.now();
    let accounts = allBotsSafe().map((b) => {
        const name = b.logOnOptions.accountName;
        const s    = getAccState(name, config.playingGames.filter(e => !isNaN(e)));
        const online = !!b.client.steamID;

        return {
            i: b.loginindex,
            name: maskName(name),
            nameRaw: name,
            online,
            enabled: s.enabled,
            isFarming: online && b.startedPlayingTimestamp != 0,
            userPlaying: !!b.userPlayingElsewhere,
            autoRestart: s.autoRestart,
            stopRemain: s.stopAt ? Math.max(0, s.stopAt - now) : 0,
            session: b.startedPlayingTimestamp ? now - b.startedPlayingTimestamp : 0,
            games: s.games.map(g => ({ appid: g, name: gameNameOf(g) })),
            waitingQR: !!(global.renderQrChallenges && global.renderQrChallenges[name])
        };
    });

    if (user.role !== "admin") accounts = accounts.filter(a => (user.accounts || []).includes(a.nameRaw));

    const out = {
        ok: true,
        uptime: now - startedAt,
        accounts,
        allAccounts: allBotsSafe().map(b => b.logOnOptions.accountName),
        users: []
    };

    if (user.role === "admin") out.users = state.users.map(u => ({ name: u.name, accounts: u.accounts || [] }));

    return out;
}

function botByIdx(idx, user) {
    const b = allBotsSafe().find(e => e.loginindex == idx);
    if (!b) return null;
    if (user.role !== "admin" && !(user.accounts || []).includes(b.logOnOptions.accountName)) return null;
    return b;
}

// Read the current refresh token for an account straight from tokens.db (JSON-lines file, last entry wins)
function readTokenFromDb(name) {
    try {
        const lines = fs.readFileSync("./src/tokens.db", "utf8").split("\n");
        let tok = null;

        for (const l of lines) {
            if (!l.trim()) continue;
            try {
                const d = JSON.parse(l);
                if (d.accountName === name && d.token) tok = d.token;
            } catch (e) { /* skip */ }
        }

        return tok;
    } catch (e) {
        return null;
    }
}

async function handle(req, res) {
    const url  = new URL(req.url, "http://x");
    const path = url.pathname;
    const user = getSession(req);

    if (path === "/" && req.method === "GET") {
        if (!user) return send(res, 200, loginPage(url.searchParams.get("err")), "text/html");
        return send(res, 200, dashPage(user), "text/html");
    }

    if (path === "/api/login" && req.method === "POST") {
        const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
        if (tooManyFails(ip)) return send(res, 429, { ok: false, err: "تلاش‌های ناموفق زیاد! چند دقیقه صبر کن." });

        const body = await readBody(req);
        const u    = checkAuth(String(body.u || ""), String(body.p || ""));

        if (!u) {
            const arr = loginFails.get(ip) || []; arr.push(Date.now()); loginFails.set(ip, arr);
            return send(res, 401, { ok: false, err: "یوزرنیم یا رمز اشتباهه!" });
        }

        const sid = crypto.randomBytes(16).toString("hex");
        sessions.set(sid, { name: u.name, exp: Date.now() + 86400000 * 7 });
        res.setHeader("Set-Cookie", "sid=" + sid + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + 86400 * 7);
        return send(res, 200, { ok: true });
    }

    /* ----- auth required ----- */
    if (!user) return send(res, 401, { ok: false, err: "unauthorized" });

    if (path === "/api/logout" && req.method === "POST") {
        const c = req.headers.cookie || ""; const m = c.match(/sid=([a-f0-9]{32})/);
        if (m) sessions.delete(m[1]);
        res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
        return send(res, 200, { ok: true });
    }

    if (path === "/static/panel.js" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(CLIENT_JS);
    }

    if (path === "/api/state" && req.method === "GET") return send(res, 200, stateFor(user));

    // Return the account's refresh token ready-to-paste as a REFRESH_TOKENS env value (user:token)
    const tokM = path.match(/^\/api\/acc\/(\d+)\/token$/);
    if (tokM && req.method === "GET") {
        const b = botByIdx(parseInt(tokM[1], 10), user);
        if (!b) return send(res, 403, { ok: false });

        const name = b.logOnOptions.accountName;
        const tok  = readTokenFromDb(name);

        if (!tok) return send(res, 404, { ok: false, err: "هنوز توکنی ذخیره نشده — اول یه بار لاگین کن (QR یا env)" });
        return send(res, 200, { ok: true, env: name + ":" + tok });
    }

    if (path === "/api/search" && req.method === "GET") {
        const q = (url.searchParams.get("q") || "").trim();
        if (q.length < 2) return send(res, 200, { r: [] });
        try { return send(res, 200, { r: await searchApps(q) }); }
        catch (e) { return send(res, 200, { r: [], err: String(e) }); }
    }

    if (path === "/api/qr" && req.method === "GET") {
        const acc = url.searchParams.get("acc") || "";
        const qr  = global.renderQrChallenges ? global.renderQrChallenges[acc] : null;
        if (!qr) return send(res, 404, { ok: false });
        if (user.role !== "admin" && !(user.accounts || []).includes(acc)) return send(res, 403, { ok: false });

        try {
            const cached = qrImgCache.get(acc);
            if (!cached || cached.url !== qr.url) {
                qrImgCache.set(acc, { url: qr.url, dataUrl: await QRCode.toDataURL(qr.url, { scale: 9, margin: 2, color: { dark: "#0b1526", light: "#ffffff" } }) });
            }
            const buf = Buffer.from(qrImgCache.get(acc).dataUrl.split(",")[1], "base64");
            res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
            return res.end(buf);
        } catch (e) { return send(res, 500, { ok: false, err: String(e) }); }
    }

    // Any logged-in user can add their OWN steam account (QR login only)
    if (path === "/api/my/addaccount" && req.method === "POST") {
        const body = await readBody(req);
        const su = String(body.steamUser || "").trim();

        if (!/^[A-Za-z0-9_]{3,32}$/.test(su)) return send(res, 400, { ok: false, err: "یوزرنیم استیم معتبر نیست (انگلیسی، ۳ تا ۳۲ کاراکتر)" });

        const exists = allBotsSafe().find(b => b.logOnOptions.accountName.toLowerCase() === su.toLowerCase());
        if (exists) {
            // Already known account - only allow if it belongs to this user (or admin)
            if (user.role === "admin" || (user.accounts || []).includes(exists.logOnOptions.accountName)) {
                return send(res, 200, { ok: true, msg: "این اکانت از قبل هست" });
            }
            return send(res, 400, { ok: false, err: "این اکانت قبلاً توسط کس دیگه‌ای اضافه شده!" });
        }

        createDynamicBot(su);
        state.extraAccounts.push({ name: su, owner: user.name });

        if (user.role !== "admin") {
            const u = state.users.find(e => e.name === user.name);
            if (u) { if (!u.accounts) u.accounts = []; u.accounts.push(su); }
        }

        saveState();
        return send(res, 200, { ok: true });
    }

    const accM = path.match(/^\/api\/acc\/(\d+)$/);
    if (accM && req.method === "POST") {
        const b = botByIdx(parseInt(accM[1], 10), user);
        if (!b) return send(res, 403, { ok: false, err: "به این اکانت دسترسی نداری" });

        const body = await readBody(req);
        const name = b.logOnOptions.accountName;
        const s    = getAccState(name, config.playingGames.filter(e => !isNaN(e)));
        const now  = Date.now();

        switch (body.a) {
            case "farm":
                s.farming = !!body.on;
                if (body.on && b.client.steamID) {
                    b.client.gamesPlayed(s.games);
                    b.startedPlayingTimestamp = now;
                    b.playedAppIDs = s.games.slice();
                } else if (!body.on) {
                    b.client.gamesPlayed([]);
                    b.startedPlayingTimestamp = 0;
                    b.playedAppIDs = [];
                }
                break;

            case "power":
                s.enabled = !!body.on;
                if (body.on) {
                    b._panelLastLoginTry = 0;
                    b.login();
                } else {
                    s.farming = false;
                    if (b.client.steamID) b.client.logOff();
                    b.startedPlayingTimestamp = 0;
                    b.playedAppIDs = [];
                }
                break;

            case "autorestart":
                s.autoRestart = !!body.on;
                break;

            case "restart": // Hard restart: force fresh login (drops any stale/blocked session state)
                s.enabled = true;
                b.userPlayingElsewhere = false;
                b._panelLastLoginTry = 0;

                try { if (b.client.steamID) b.client.logOff(); } catch (e) { /* ignore */ }

                b.startedPlayingTimestamp = 0;
                b.playedAppIDs = [];

                setTimeout(() => {
                    try { b.login(); } catch (e) { console.log(`[${name}] manual restart failed: ${e}`); }
                }, 3000);
                break;

            case "autostop":
                if (body.clear) {
                    s.stopAt = null;
                } else {
                    const ms = ((parseInt(body.h, 10) || 0) * 3600 + (parseInt(body.m, 10) || 0) * 60) * 1000;
                    if (ms < 60000) return send(res, 400, { ok: false, err: "حداقل ۱ دقیقه!" });
                    s.stopAt = now + ms;
                }
                break;

            case "addgame": {
                const id = parseInt(body.appid, 10);
                if (!id) return send(res, 400, { ok: false });
                if (s.games.length >= 32 && !s.games.includes(id)) return send(res, 400, { ok: false, err: "استیم سقف ۳۲ بازی داره!" });
                if (!s.games.includes(id)) s.games.push(id);
                if (body.name) state.gameNames[String(id)] = String(body.name).slice(0, 60);
                if (s.farming && b.client.steamID) {
                    b.client.gamesPlayed(s.games);
                    b.playedAppIDs = s.games.slice();
                }
                break;
            }

            case "delgame": {
                const id = parseInt(body.appid, 10);
                s.games = s.games.filter(g => g !== id);
                if (s.farming && b.client.steamID) {
                    b.client.gamesPlayed(s.games);
                    b.playedAppIDs = s.games.slice();
                }
                break;
            }

            default:
                return send(res, 400, { ok: false, err: "درخواست نامعتبر" });
        }

        saveState();
        return send(res, 200, { ok: true });
    }

    if (path === "/api/admin/user" && req.method === "POST") {
        if (user.role !== "admin") return send(res, 403, { ok: false });
        const body = await readBody(req);
        const nu = String(body.u || "").trim(), np = String(body.p || "");

        if (!/^[A-Za-z0-9_.-]{3,20}$/.test(nu)) return send(res, 400, { ok: false, err: "یوزر باید ۳ تا ۲۰ کاراکتر انگلیسی باشه" });
        if (np.length < 4) return send(res, 400, { ok: false, err: "رمز حداقل ۴ کاراکتر!" });
        if (nu === PANEL_USER || state.users.some(e => e.name === nu)) return send(res, 400, { ok: false, err: "این یوزر تکراریه!" });

        state.users.push({ name: nu, hash: hashPass(np), accounts: Array.isArray(body.accounts) ? body.accounts.filter(a => allBotsSafe().some(b => b.logOnOptions.accountName === a)) : [] });
        saveState();
        return send(res, 200, { ok: true });
    }

    if (path === "/api/admin/deluser" && req.method === "POST") {
        if (user.role !== "admin") return send(res, 403, { ok: false });
        const body = await readBody(req);
        state.users = state.users.filter(e => e.name !== body.u);
        saveState();
        return send(res, 200, { ok: true });
    }

    send(res, 404, { ok: false });
}

function attach(ctrl, cfg) {
    controller = ctrl; config = cfg;

    try { CLIENT_JS = fs.readFileSync(__dirname + "/panel-client.js", "utf8"); } catch (e) { console.log("panel-client.js missing: " + e); }

    loadState();

    if (!PANEL_USER || !PANEL_PASS) {
        console.log("⚠️  PANEL_USER / PANEL_PASS env vars are NOT set! Panel login will reject everyone - set them in Render!");
    }

    // Restore user-added accounts (they'll need a fresh QR scan, which shows in the panel)
    setTimeout(() => {
        for (const e of state.extraAccounts) {
            if (!allBotsSafe().some(b => b.logOnOptions.accountName == e.name)) {
                createDynamicBot(e.name);

                // Re-assign ownership (state.users keeps accounts array, but make sure)
                const owner = state.users.find(u => u.name === e.owner);
                if (owner && !owner.accounts.includes(e.name)) owner.accounts.push(e.name);
            }
        }
        saveState();
    }, 12000);

    http.createServer((req, res) => {
        handle(req, res).catch((err) => {
            console.log("panel error: " + (err.stack || err));
            try { send(res, 500, { ok: false, err: "server error" }); } catch (e) { /* ignore */ }
        });
    }).listen(PORT, () => console.log(`Panel listening on port ${PORT}`));

    startWatchdog();
}

module.exports = { attach };
