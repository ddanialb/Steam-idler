/*
 * File: panel.js
 * Render control panel for steam-idler:
 * - Login system (admin via env, extra users created in-panel)
 * - Start/Stop farming & bot power per account
 * - Game search by name (multi-game idling)
 * - Auto-Stop timer & Auto-Restart watchdog per account
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

let state = { users: [], accounts: {} };

function loadState() {
    try {
        state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        if (!state.users) state.users = [];
        if (!state.accounts) state.accounts = {};
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

const sessions = new Map(); // sid -> { user, exp }

function hashPass(pass, salt) {
    if (!salt) salt = crypto.randomBytes(16).toString("hex");
    return salt + ":" + crypto.scryptSync(String(pass), salt, 32).toString("hex");
}

function checkAuth(username, pass) {
    // Admin from env
    if (PANEL_USER && username === PANEL_USER && pass === PANEL_PASS) return { name: username, role: "admin", accounts: null };

    // Extra users
    const u = state.users.find(e => e.name === username);
    if (!u || !u.hash) return null;

    const [salt, hash] = u.hash.split(":");
    const calc = crypto.scryptSync(String(pass), salt, 32);
    const ref  = Buffer.from(hash, "hex");
    if (ref.length == calc.length && crypto.timingSafeEqual(ref, calc)) return { name: u.name, role: "user", accounts: u.accounts || [] };

    return null;
}

const loginFails = new Map(); // ip -> [timestamps]
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
    return s;
}

/* ---------------- Steam helpers ---------------- */

function allBotsSafe() { return (controller && controller.allBots) ? controller.allBots : []; }

function gameNameOf(g) {
    const names = { "730": "CS2", "440": "TF2", "570": "Dota 2", "252490": "Rust" };
    if (state.gameNames && state.gameNames[String(g)]) return state.gameNames[String(g)];
    return names[g] || null;
}

// Search Steam apps by name (with short cache)
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

/* ---------------- Watchdog: Auto-Restart + Auto-Stop + state enforcement ---------------- */

function startWatchdog() {
    setInterval(() => {
        const now = Date.now();

        for (const b of allBotsSafe()) {
            const name = b.logOnOptions.accountName;
            const s    = state.accounts[name];
            if (!s) continue;

            const online = !!b.client.steamID;

            // Auto-Stop timer reached -> turn everything off
            if (s.stopAt && now >= s.stopAt) {
                s.stopAt = null; s.enabled = false; s.farming = false;
                if (online) b.client.logOff();
                b.startedPlayingTimestamp = 0;
                b.playedAppIDs = [];
                saveState();
                if (global.logger) logger("info", `[${name}] Auto-Stop: timer reached, bot was stopped by the panel.`);
                continue;
            }

            // Power off desired
            if (!s.enabled && online) {
                b.client.logOff();
                b.startedPlayingTimestamp = 0;
                b.playedAppIDs = [];
                continue;
            }

            // Auto-Restart: went down without being disabled -> log in again
            if (s.enabled && !online && s.autoRestart) {
                const loginPhaseDone = controller.nextacc > b.loginindex;
                const inRelogQueue   = controller.relogQueue.includes(b.loginindex);
                const lastTry        = b._panelLastLoginTry || 0;

                if (loginPhaseDone && !inRelogQueue && now - lastTry > 120000 && !(global.renderQrChallenge && global.renderQrChallenge.accountName == name)) {
                    b._panelLastLoginTry = now;
                    if (global.logger) logger("info", `[${name}] Panel watchdog: account is offline, restarting login...`);
                    b.login();
                }
            }

            // Farm state enforcement (also re-applies games after relog)
            if (s.enabled && online) {
                if (s.farming && b.startedPlayingTimestamp == 0) {
                    b.client.gamesPlayed(s.games);
                    b.startedPlayingTimestamp = now;
                    b.playedAppIDs = s.games.slice();
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

function pageWrap(title, body, extraHead) {
    return "<!DOCTYPE html><html dir=\"rtl\" lang=\"fa\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        + "<title>" + title + "</title><style>"
        + "*{box-sizing:border-box;margin:0;padding:0}"
        + "body{font-family:Tahoma,Arial,sans-serif;background:#0b1120;color:#e2e8f0;min-height:100vh;padding:16px}"
        + ".wrap{max-width:860px;margin:0 auto}"
        + ".card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:20px;margin-bottom:16px}"
        + "h1{font-size:20px} h2{font-size:16px;margin-bottom:10px} .sub{color:#94a3b8;font-size:12px;margin-top:4px}"
        + "input,select{background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:8px 10px;font-size:14px;font-family:inherit}"
        + "button{background:#2563eb;border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;font-family:inherit}"
        + "button:hover{background:#1d4ed8} button.warn{background:#b45309} button.danger{background:#b91c1c} button.ghost{background:#334155}"
        + ".chip{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px}"
        + ".ok{background:rgba(74,222,128,.15);color:#4ade80}.wait{background:rgba(250,204,21,.15);color:#facc15}.bad{background:rgba(248,113,113,.15);color:#f87171}"
        + ".gline{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}"
        + ".gamechip{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:4px 8px;font-size:12px;display:inline-flex;gap:6px;align-items:center}"
        + ".gamechip b{color:#7dd3fc}"
        + ".x{color:#f87171;cursor:pointer;font-weight:bold}"
        + ".row{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}"
        + ".res{border-top:1px dashed #334155;margin-top:8px;padding-top:8px}"
        + ".resitem{display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:13px}"
        + ".muted{color:#64748b;font-size:11px}"
        + "table{width:100%;font-size:13px} td,th{padding:6px;text-align:right} th{color:#94a3b8;font-size:11px}"
        + "img.qr{border-radius:10px;display:block;margin:10px auto}"
        + ".bar{position:sticky;top:0;background:#0b1120;padding:10px 0;z-index:5}"
        + "</style>" + (extraHead || "") + "</head><body><div class=\"wrap\">" + body + "</div></body></html>";
}

function loginPage(msg) {
    return pageWrap("ورود | Steam Idler",
        "<div class=\"card\" style=\"max-width:380px;margin:10vh auto 0;text-align:center\">"
        + "<h1>🎮 Steam Idler</h1><p class=\"sub\">برای ورود به پنل، یوزرنیم و رمز رو وارد کن</p>"
        + (msg ? "<p style=\"color:#f87171;font-size:13px;margin:10px 0\">" + msg + "</p>" : "")
        + "<div class=\"gline\" style=\"margin-top:14px\"><input id=\"u\" placeholder=\"یوزرنیم\" style=\"flex:1\"></div>"
        + "<div class=\"gline\"><input id=\"p\" type=\"password\" placeholder=\"رمز عبور\" style=\"flex:1\"></div>"
        + "<button onclick=\"login()\" style=\"width:100%;margin-top:6px\">ورود</button>"
        + "<p class=\"muted\" style=\"margin-top:14px\">دسترسی بدون رمز به هیچ بخشی از پنل ممکن نیست 🔒</p></div>"
        + "<script>function login(){fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({u:document.getElementById('u').value,p:document.getElementById('p').value})}).then(r=>r.json()).then(d=>{if(d.ok)location.href='/';else location.href='/?err='+encodeURIComponent(d.err||'خطا')}).catch(()=>{location.href='/?err=خطا'})}document.addEventListener('keydown',e=>{if(e.key==='Enter')login()})</script>");
}

function dashPage(user) {
    const isAdmin = user.role === "admin";
    const body =
        "<div class=\"bar row\"><div><h1>🎮 Steam Idler</h1><p class=\"sub\">پنل مدیریت — سلام <b>" + esc(user.name) + "</b>" + (isAdmin ? " (ادمین)" : "") + "</p></div>"
        + "<div class=\"gline\"><span class=\"chip ok\" id=\"up\">⏱ ...</span><button class=\"ghost\" onclick=\"logout()\">خروج</button></div></div>"
        + "<div id=\"accs\"></div>"
        + (isAdmin ? adminHtml() : "")
        + "<p class=\"muted\" style=\"text-align:center\">وضعیت‌ها هر ۸ ثانیه به‌روزرسانی می‌شوند 🔄 — تنظیمات این پنل تا Redeploy بعدی حفظ می‌شود.</p>"
        + "<script>var ISADMIN=" + (isAdmin ? "true" : "false") + ";</script>"
        + "<script>" + clientJs() + "</script>";

    return pageWrap("پنل | Steam Idler", body);
}

function adminHtml() {
    return "<div class=\"card\"><h2>👥 مدیریت کاربرها (ادمین)</h2>"
        + "<p class=\"sub\">برای هر رفیق یه یوزر/رمز بساز و اکانتش رو بهش اختصاص بده — خودش لاگین می‌کنه و بازی‌هاش رو تنظیم می‌کنه.</p>"
        + "<div class=\"gline\" style=\"margin-top:10px\"><input id=\"nu\" placeholder=\"یوزرنیم\"><input id=\"np\" placeholder=\"رمز عبور\"><select id=\"na\"></select><button onclick=\"adduser()\" class=\"warn\">➕ ساخت کاربر</button></div>"
        + "<table id=\"users\"><tr><th>یوزر</th><th>اکانت‌ها</th><th></th></tr></table></div>";
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* Client-side JS (no template literals inside!) */
function clientJs() {
    return ""
        + "var S=null;"
        + "function fmt(ms){var s=Math.max(0,Math.floor(ms/1000));var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+' روز و ':'')+(h?h+' ساعت و ':'')+m+' دقیقه'}"
        + "function esc(s){return String(s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]))}"
        + "function post(u,d){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d||{})}).then(r=>r.json()).then(j=>{load();return j})}"
        + "function logout(){fetch('/api/logout',{method:'POST'}).then(()=>location.href='/')}"
        + "function act(i,a,d){d=d||{};d.a=a;return post('/api/acc/'+i,d)}"
        + "function farm(i,on){act(i,'farm',{on:on})}"
        + "function power(i,on){act(i,'power',{on:on})}"
        + "function arestart(i,on){act(i,'autorestart',{on:on})}"
        + "function setstop(i){var h=parseInt(document.getElementById('sh'+i).value||'0'),m=parseInt(document.getElementById('sm'+i).value||'0');act(i,'autostop',{h:h,m:m})}"
        + "function clearstop(i){act(i,'autostop',{clear:true})}"
        + "function delgame(i,appid){act(i,'delgame',{appid:appid})}"
        + "function addgame(i,appid,name){act(i,'addgame',{appid:appid,name:name});document.getElementById('res'+i).innerHTML='';document.getElementById('q'+i).value=''}"
        + "function search(i){var q=document.getElementById('q'+i).value.trim();if(q.length<2)return;document.getElementById('res'+i).innerHTML='<p class=\"muted\">جستجو...</p>';"
        + "fetch('/api/search?q='+encodeURIComponent(q)).then(r=>r.json()).then(d=>{var h='';if(!d.r||!d.r.length)h='<p class=\"muted\">چیزی پیدا نشد.</p>';(d.r||[]).forEach(function(g){h+='<div class=\"resitem\"><span>'+esc(g.name)+' <b style=\"color:#7dd3fc\">('+g.appid+')</b></span><button onclick=\"addgame('+i+','+g.appid+',\''+esc(g.name).replace(/'/g,'')+'\')\">➕ افزودن</button></div>'});document.getElementById('res'+i).innerHTML=h})}"
        + "function adduser(){var u=document.getElementById('nu').value,p=document.getElementById('np').value,a=document.getElementById('na').value;if(!u||!p)return alert('یوزر و رمز لازمه');post('/api/admin/user',{u:u,p:p,accounts:a?[a]:[]}).then(d=>{if(d.err)alert(d.err)})}"
        + "function deluser(u){if(confirm('حذف کاربر '+u+'؟'))post('/api/admin/deluser',{u:u})}"
        + "function load(){fetch('/api/state').then(r=>r.json()).then(d=>{S=d;document.getElementById('up').textContent='⏱ '+fmt(d.uptime);var h='';"
        + "d.accounts.forEach(function(a){var cls=a.online?(a.farming?'ok':'wait'):'bad';var st=a.online?(a.farming?'🎮 در حال فارم':'✅ آنلاین (فارم خاموش)'):(a.enabled?'⏳ آفلاین':'⛔ خاموش');"
        + "h+='<div class=\"card\"><div class=\"row\"><div><b style=\"font-size:16px\">'+esc(a.name)+'</b> <span class=\"chip '+cls+'\">'+st+'</span>'+(a.waitingQR?' <span class=\"chip wait\">📱 QR آماده‌ست</span>':'')+'</div>'"
        + "+(a.session?'<span class=\"chip ok\">سشن: '+fmt(a.session)+'</span>':'')+'</div>';"
        + "if(a.waitingQR){h+='<div class=\"card\" style=\"border-color:#7dd3fc;margin-top:10px\"><h2>🔐 تأیید ورود</h2><p class=\"sub\">با اپ Steam (بخش Steam Guard) این کد رو اسکن کن:</p><img class=\"qr\" id=\"qrimg'+a.i+'\" width=\"240\" height=\"240\" src=\"/api/qr?acc='+encodeURIComponent(a.nameRaw)+'\"></div>'}"
        + "h+='<div class=\"gline\" style=\"margin-top:12px\"><span class=\"muted\">بازی‌ها:</span>';a.games.forEach(function(g){h+='<span class=\"gamechip\">'+esc(g.name||g.appid)+' <b>'+g.appid+'</b> <span class=\"x\" onclick=\"delgame('+a.i+','+g.appid+')\">✕</span></span>'});if(!a.games.length)h+='<span class=\"muted\">—</span>';h+='</div>';"
        + "h+='<div class=\"gline\"><input id=\"q'+a.i+'\" placeholder=\"اسم بازی رو سرچ کن... مثلا CS2\" style=\"flex:1;min-width:160px\" onkeydown=\"if(event.key===\'Enter\')search('+a.i+')\"><button class=\"ghost\" onclick=\"search('+a.i+')\">🔍</button></div><div class=\"res\" id=\"res'+a.i+'\"></div>';"
        + "h+='<div class=\"gline\" style=\"margin-top:12px;border-top:1px dashed #334155;padding-top:12px\">';"
        + "h+=a.farming?'<button class=\"warn\" onclick=\"farm('+a.i+',false)\">⏸ توقف فارم</button>':'<button onclick=\"farm('+a.i+',true)\">▶ شروع فارم</button>';"
        + "h+=a.enabled?'<button class=\"danger\" onclick=\"power('+a.i+',false)\">⏻ خاموش کردن بات</button>':'<button onclick=\"power('+a.i+',true)\">⏻ روشن کردن بات</button>';"
        + "h+='<label class=\"muted\" style=\"cursor:pointer\"><input type=\"checkbox\" '+(a.autoRestart?'checked':'')+' onchange=\"arestart('+a.i+',this.checked)\"> ری‌استارت خودکار</label>';"
        + "h+='</div>';"
        + "h+='<div class=\"gline\">⏱ توقف خودکار بعد از <input id=\"sh'+a.i+'\" type=\"number\" min=\"0\" style=\"width:70px\" placeholder=\"ساعت\"> ساعت و <input id=\"sm'+a.i+'\" type=\"number\" min=\"0\" style=\"width:70px\" placeholder=\"دقیقه\"> دقیقه <button onclick=\"setstop('+a.i+')\">ثبت</button>';"
        + "if(a.stopRemain)h+='<span class=\"chip wait\">باقی‌مانده: '+fmt(a.stopRemain)+'</span> <button class=\"ghost\" onclick=\"clearstop('+a.i+')\">حذف تایمر</button>';h+='</div></div>';});"
        + "document.getElementById('accs').innerHTML=h;"
        + "if(ISADMIN){var sel='<option value=\"\">— اکانت —</option>';d.allAccounts.forEach(function(n){sel+='<option value=\"'+esc(n)+'\">'+esc(n)+'</option>'});var se=document.getElementById('na');if(se)se.innerHTML=sel;var ut='<tr><th>یوزر</th><th>اکانت‌ها</th><th></th></tr>';d.users.forEach(function(u){ut+='<tr><td>'+esc(u.name)+'</td><td>'+u.accounts.map(esc).join(', ')+'</td><td><button class=\"danger\" onclick=\"deluser(\''+esc(u.name)+'\')\">حذف</button></td></tr>'});var tb=document.getElementById('users');if(tb)tb.innerHTML=ut;}})}"
        + "load();setInterval(load,8000);";
}

/* ---------------- HTTP Server ---------------- */

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

const qrImgCache = new Map();

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
            farming: s.farming && online && b.startedPlayingTimestamp != 0 ? true : s.farming,
            autoRestart: s.autoRestart,
            stopRemain: s.stopAt ? Math.max(0, s.stopAt - now) : 0,
            session: b.startedPlayingTimestamp ? now - b.startedPlayingTimestamp : 0,
            games: s.games.map(g => ({ appid: g, name: gameNameOf(g) })),
            waitingQR: !!(global.renderQrChallenge && global.renderQrChallenge.accountName == name)
        };
    });

    // Permission filter for regular users
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

async function handle(req, res) {
    const url  = new URL(req.url, "http://x");
    const path = url.pathname;
    const user = getSession(req);

    /* ----- Public ----- */

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
        sessions.set(sid, { ...u, exp: Date.now() + 86400000 * 7 });
        res.setHeader("Set-Cookie", "sid=" + sid + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + 86400 * 7);
        return send(res, 200, { ok: true });
    }

    /* ----- Below: auth required ----- */
    if (!user) return send(res, 401, { ok: false, err: "unauthorized" });

    if (path === "/api/logout" && req.method === "POST") {
        const c = req.headers.cookie || ""; const m = c.match(/sid=([a-f0-9]{32})/);
        if (m) sessions.delete(m[1]);
        return send(res, 200, { ok: true });
    }

    if (path === "/api/state" && req.method === "GET") return send(res, 200, stateFor(user));

    if (path === "/api/search" && req.method === "GET") {
        const q = (url.searchParams.get("q") || "").trim();
        if (q.length < 2) return send(res, 200, { r: [] });
        try { return send(res, 200, { r: await searchApps(q) }); }
        catch (e) { return send(res, 200, { r: [], err: String(e) }); }
    }

    if (path === "/api/qr" && req.method === "GET") {
        const qr  = global.renderQrChallenge;
        const acc = url.searchParams.get("acc") || "";
        if (!qr || qr.accountName !== acc) return send(res, 404, { ok: false });
        if (user.role !== "admin" && !(user.accounts || []).includes(acc)) return send(res, 403, { ok: false });

        try {
            if (!qrImgCache.has(qr.url)) qrImgCache.set(qr.url, await QRCode.toDataURL(qr.url, { scale: 9, margin: 2, color: { dark: "#0b1120", light: "#ffffff" } }));
            const dataUrl = qrImgCache.get(qr.url);
            const b64 = dataUrl.split(",")[1];
            const buf = Buffer.from(b64, "base64");
            res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
            return res.end(buf);
        } catch (e) { return send(res, 500, { ok: false, err: String(e) }); }
    }

    const accM = path.match(/^\/api\/acc\/(\d+)$/);
    if (accM && req.method === "POST") {
        const b = botByIdx(parseInt(accM[1], 10), user);
        if (!b) return send(res, 403, { ok: false, err: "دسترسی نداری" });

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
                if (!s.games.includes(id)) s.games.push(id);
                if (s.games.length > 32) return send(res, 400, { ok: false, err: "استیم سقف ۳۲ بازی داره!" });
                if (s.farming && b.client.steamID) {
                    b.client.gamesPlayed(s.games);
                    b.playedAppIDs = s.games.slice();
                }

                // Remember friendly name in a side map (nothing else persists names)
                if (body.name) {
                    if (!state.gameNames) state.gameNames = {};
                    state.gameNames[String(id)] = String(body.name).slice(0, 60);
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
                return send(res, 400, { ok: false, err: "بد درخواست" });
        }

        saveState();
        return send(res, 200, { ok: true });
    }

    if (path === "/api/admin/user" && req.method === "POST") {
        if (user.role !== "admin") return send(res, 403, { ok: false });
        const body = await readBody(req);
        const nu = String(body.u || "").trim(), np = String(body.p || "");

        if (nu.length < 3 || np.length < 4) return send(res, 400, { ok: false, err: "یوزر حداقل ۳ و رمز حداقل ۴ کاراکتر!" });
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

    loadState();

    if (!PANEL_USER || !PANEL_PASS) {
        console.log("⚠️  PANEL_USER / PANEL_PASS env vars are NOT set! Panel login is DISABLED — set them in Render!");
    }

    http.createServer((req, res) => {
        handle(req, res).catch((err) => {
            console.log("panel error: " + (err.stack || err));
            try { send(res, 500, { ok: false, err: "server error" }); } catch (e) { /* ignore */ }
        });
    }).listen(PORT, () => console.log(`Panel listening on port ${PORT}`));

    startWatchdog();
}

module.exports = { attach };
