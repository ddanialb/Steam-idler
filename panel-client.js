/* Client-side script for the control panel (served at /static/panel.js) */
/* global ISADMIN */

var S = null;

function toast(m, ok) {
    var t = document.getElementById('toast');
    t.textContent = m;
    t.style.borderColor = ok === false ? '#ef4444' : '#34d399';
    t.className = 'show';
    setTimeout(function() { t.className = ''; }, 2600);
}

function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return (d ? d + ' روز و ' : '') + (h ? h + ' ساعت و ' : '') + m + ' دقیقه';
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function post(u, d) {
    return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d || {}) })
        .then(function(r) { return r.json(); })
        .then(function(j) { load(); return j; });
}

function logout() {
    fetch('/api/logout', { method: 'POST' })
        .then(function() { location.replace('/'); })
        .catch(function() { location.replace('/'); });
}

function act(i, a, d) {
    d = d || {};
    d.a = a;
    return post('/api/acc/' + i, d);
}

function farm(i, on) {
    act(i, 'farm', { on: on }).then(function(d) {
        toast(d.ok !== false ? (on ? '▶ فارم شروع شد' : '⏸ فارم متوقف شد') : (d.err || 'خطا'), d.ok !== false);
    });
}

function power(i, on) {
    act(i, 'power', { on: on }).then(function(d) {
        toast(d.ok !== false ? (on ? '⏻ بات روشن شد' : '⏻ بات خاموش شد') : (d.err || 'خطا'), d.ok !== false);
    });
}

function arestart(i, on) {
    act(i, 'autorestart', { on: on }).then(function() {
        toast('🔄 ری‌استارت خودکار ' + (on ? 'روشن' : 'خاموش') + ' شد');
    });
}

function setstop(i) {
    var h = parseInt(document.getElementById('sh' + i).value || '0', 10);
    var m = parseInt(document.getElementById('sm' + i).value || '0', 10);
    act(i, 'autostop', { h: h, m: m }).then(function(d) {
        toast(d.err || '⏱ تایمر توقف ثبت شد', !d.err);
    });
}

function clearstop(i) {
    act(i, 'autostop', { clear: true }).then(function() { toast('⏱ تایمر حذف شد'); });
}

function restartacc(i) {
    act(i, 'restart').then(function(d) {
        toast(d.err || '🔄 داره ری‌استارت می‌شه...', !d.err);
    });
}

function gettoken(i) {
    fetch('/api/acc/' + i + '/token')
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (!d.ok) { toast(d.err || 'توکنی نیست', false); return; }
            document.getElementById('tok' + i).style.display = 'flex';
            document.getElementById('tokv' + i).value = d.env;
        });
}

function copytok(i) {
    var v = document.getElementById('tokv' + i);
    v.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(v.value);
    } else {
        document.execCommand('copy');
    }
    toast('📋 کپی شد! همین رو توی رندر بذار داخل env به اسم REFRESH_TOKENS');
}

function delgame(i, appid) {
    act(i, 'delgame', { appid: appid });
}

function addgame(i, appid, name) {
    act(i, 'addgame', { appid: appid, name: name }).then(function(d) {
        if (d.err) toast(d.err, false); else toast('🎮 بازی اضافه شد');
    });
    var r = document.getElementById('res' + i); if (r) r.innerHTML = '';
    var q = document.getElementById('q' + i); if (q) q.value = '';
}

function search(i) {
    var el = document.getElementById('q' + i);
    var q = el.value.trim();
    if (q.length < 2) { toast('حداقل ۲ حرف بنویس', false); return; }

    document.getElementById('res' + i).innerHTML = '<p class="muted">🔍 در حال جستجو...</p>';

    fetch('/api/search?q=' + encodeURIComponent(q))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var h = '';
            if (!d.r || !d.r.length) h = '<p class="muted">چیزی پیدا نشد.</p>';
            (d.r || []).forEach(function(g) {
                h += '<div class="resitem"><span>🕹 ' + esc(g.name) + ' <b style="color:#7dd3fc">(' + g.appid + ')</b></span>'
                   + '<button data-n="' + esc(g.name) + '" onclick="addgame(' + i + ',' + g.appid + ',this.dataset.n)">➕ افزودن</button></div>';
            });
            document.getElementById('res' + i).innerHTML = h;
        })
        .catch(function() { toast('خطا در سرچ', false); });
}

function adduser() {
    var u = document.getElementById('nu').value.trim();
    var p = document.getElementById('np').value;
    var a = document.getElementById('na').value;
    if (!u || !p) { toast('یوزر و رمز لازمه', false); return; }
    post('/api/admin/user', { u: u, p: p, accounts: a ? [a] : [] }).then(function(d) {
        if (d.err) toast(d.err, false);
        else {
            toast('✅ کاربر «' + u + '» ساخته شد');
            document.getElementById('nu').value = '';
            document.getElementById('np').value = '';
        }
    });
}

function deluser(u) {
    if (!confirm('حذف کاربر ' + u + '؟')) return;
    post('/api/admin/deluser', { u: u }).then(function() { toast('کاربر حذف شد'); });
}

function addaccount() {
    var el = document.getElementById('newacc');
    var pw = document.getElementById('newpass');
    var v = el.value.trim();
    if (v.length < 3) { toast('یوزرنیم استیم معتبر نیست', false); return; }
    post('/api/my/addaccount', { steamUser: v, steamPass: pw.value }).then(function(d) {
        if (d.err) toast(d.err, false);
        else { el.value = ''; pw.value = ''; toast('✅ اکانت اضافه شد'); }
        load();
    });
}

function qrretry(t) {
    t.onerror = null;
    t.style.opacity = 0.25;
    setTimeout(function() {
        t.src = t.src.split('&t=')[0] + '&t=' + Date.now();
        t.style.opacity = 1;
    }, 3000);
}

var QRID = null;
var QRT = null;

function openQrLogin() {
    post('/api/qrlogin/start', {}).then(function(d) {
        if (!d.id) { toast('خطا در ساخت QR', false); return; }

        QRID = d.id;
        var m = document.getElementById('qrmodal');
        document.getElementById('qrimg').style.display = 'none';
        document.getElementById('qrspin').style.display = 'block';
        m.style.display = 'flex';

        qrpoll();
        clearInterval(QRT);
        QRT = setInterval(qrpoll, 4000);
    });
}

function qrpoll() {
    if (!QRID) return;

    fetch('/api/qrlogin/' + QRID)
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.status === 'done') {
                closeQrLogin(true);
                toast('✅ ورود انجام شد: ' + d.account);
                load();
                return;
            }

            if (d.status === 'gone') { closeQrLogin(true); return; }

            if (d.img) {
                var im = document.getElementById('qrimg');
                if (im.getAttribute('src') !== d.img) im.setAttribute('src', d.img);
                im.style.display = 'block';
                document.getElementById('qrspin').style.display = 'none';
            }
        })
        .catch(function() {});
}

function closeQrLogin(keepQuiet) {
    if (QRT) { clearInterval(QRT); QRT = null; }
    if (QRID && !keepQuiet) {
        var id = QRID;
        QRID = null;
        fetch('/api/qrlogin/' + id, { method: 'POST' }).catch(function() {});
    } else {
        QRID = null;
    }

    var m = document.getElementById('qrmodal');
    if (m) m.style.display = 'none';
}

function send2fa(i) {
    var el = document.getElementById('fa' + i);
    var code = el.value.trim();
    if (!code) { toast('کد رو بنویس', false); return; }
    act(i, '2fa', { code: code }).then(function(d) {
        if (d.err) toast(d.err, false);
        else { el.value = ''; toast('✅ کد قبول شد — دارم لاگین می‌کنم...'); }
    });
}

function accCard(a) {
    var userPlaying = !!a.userPlaying;
    var cls = userPlaying ? 'wait' : (a.online ? (a.isFarming ? 'ok' : 'wait') : 'bad');
    var st  = userPlaying ? '🖥 داری روی PC بازی می‌کنی' : (a.online ? (a.isFarming ? 'در حال فارم' : 'آنلاین') : (a.enabled ? 'آفلاین' : 'خاموش'));

    var h = '<div class="card"><div class="row"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
        + '<b style="font-size:17px">' + esc(a.name) + '</b>'
        + '<span class="chip ' + cls + '"><span class="dot"></span>' + st + '</span></div>'
        + (a.session ? '<span class="chip ok">⏱ سشن: ' + fmt(a.session) + '</span>' : '')
        + '</div>';

    if (a.waitingQR) {
        h += '<div class="qrblock"><div class="qrtitle">🔐 با اپ Steam اسکن کن</div>'
            + '<img class="qr" width="230" height="230" alt="QR" src="/api/qr?acc=' + encodeURIComponent(a.nameRaw) + '&t=' + Date.now() + '" onerror="qrretry(this)"></div>';
    }

    if (a.needs2FA) {
        h += '<div class="qrblock"><div class="qrtitle">🛡 کد Steam Guard' + (a.guardType === 'email' ? ' (ایمیل)' : ' (اپ)') + '</div>'
            + '<div class="gline" style="justify-content:center;margin:10px 0 0"><input id="fa' + a.i + '" maxlength="6" autocomplete="off" placeholder="کد..." style="width:130px;text-align:center;font-size:18px;letter-spacing:4px" onkeydown="if(event.keyCode===13)send2fa(' + a.i + ')"><button onclick="send2fa(' + a.i + ')">تأیید</button></div></div>';
    }

    if (a.enabled && !a.online && !a.waitingQR && !a.needs2FA && !a.userPlaying) {
        h += '<div class="gline" style="margin-top:10px;justify-content:center"><span class="muted"><span class="spin"></span>در حال آماده‌سازی ورود...</span></div>';
    }

    h += '<div class="divider"></div><div class="gline"><span class="muted">🎯 بازی‌ها:</span>';

    a.games.forEach(function(g) {
        h += '<span class="gamechip">' + esc(g.name || g.appid) + ' <b>' + g.appid + '</b> '
            + '<span class="x" onclick="delgame(' + a.i + ',' + g.appid + ')">✕</span></span>';
    });

    if (!a.games.length) h += '<span class="muted">—</span>';
    h += '</div>';

    h += '<div class="gline"><input id="q' + a.i + '" placeholder="اسم بازی رو سرچ کن... مثلا CS2" style="flex:1;min-width:150px" '
        + 'onkeydown="if(event.keyCode===13)search(' + a.i + ')">'
        + '<button class="ghost" onclick="search(' + a.i + ')">🔍 سرچ</button></div>'
        + '<div class="res" id="res' + a.i + '"></div>';

    h += '<div class="divider"></div><div class="gline">';
    h += a.isFarming
        ? '<button class="warn" onclick="farm(' + a.i + ',false)">⏸ توقف فارم</button>'
        : '<button class="bfarm" onclick="farm(' + a.i + ',true)">▶ شروع فارم</button>';
    h += a.enabled
        ? '<button class="danger" onclick="power(' + a.i + ',false)">⏻ خاموش</button>'
        : '<button class="bfarm" onclick="power(' + a.i + ',true)">⏻ روشن</button>';
    h += '<button class="brestart" onclick="restartacc(' + a.i + ')">🔄 ری‌استارت</button>';
    h += '<button class="ghost" onclick="gettoken(' + a.i + ')">🔑 توکن</button>';
    h += '<label class="switch"><input type="checkbox" ' + (a.autoRestart ? 'checked' : '') + ' onchange="arestart(' + a.i + ',this.checked)"><span class="sw"></span>ری‌استارت خودکار</label></div>';
    h += '<div class="tokenbox" id="tok' + a.i + '" style="display:none">'
        + '<input id="tokv' + a.i + '" readonly value="">'
        + '<button class="ghost" onclick="copytok(' + a.i + ')">📋 کپی</button></div>';

    h += '<div class="gline">⏱ توقف خودکار: '
        + '<input id="sh' + a.i + '" type="number" min="0" style="width:75px" placeholder="ساعت"> ساعت '
        + '<input id="sm' + a.i + '" type="number" min="0" style="width:75px" placeholder="دقیقه"> دقیقه '
        + '<button onclick="setstop(' + a.i + ')">ثبت</button>';

    if (a.stopRemain) h += '<span class="chip wait">⏳ ' + fmt(a.stopRemain) + '</span><button class="ghost" onclick="clearstop(' + a.i + ')">✕</button>';
    h += '</div></div>';

    return h;
}

function render() {
    var d = S;
    if (!d) return;

    document.getElementById('up').textContent = '⏱ ' + fmt(d.uptime);

    var h = '';
    d.accounts.forEach(function(a) { h += accCard(a); });

    if (!d.accounts.length) {
        h = '<div class="card" style="text-align:center;color:#8ea3c2">👆 از بالا یوزرنیم استیم رو اضافه کن</div>';
    }

    document.getElementById('accs').innerHTML = h;

    if (ISADMIN) {
        var se = document.getElementById('na');
        if (se && se.options.length <= 1) {
            d.allAccounts.forEach(function(n) {
                var o = document.createElement('option');
                o.value = n;
                o.textContent = n;
                se.appendChild(o);
            });
        }

        var ut = '<tr><th>یوزر</th><th>اکانت‌ها</th><th></th></tr>';
        if (!d.users.length) ut += '<tr><td colspan="3" class="muted" style="text-align:center">هنوز کاربری نساختی</td></tr>';
        d.users.forEach(function(u) {
            ut += '<tr><td>👤 ' + esc(u.name) + '</td><td>'
                + (u.accounts.length ? u.accounts.map(esc).join('، ') : '<span class="muted">(خودش اکانتش رو اضافه می‌کنه)</span>')
                + '</td><td><button class="danger" style="padding:5px 12px" data-u="' + esc(u.name) + '" onclick="deluser(this.dataset.u)">حذف</button></td></tr>';
        });
        var tb = document.getElementById('users');
        if (tb) tb.innerHTML = ut;
    }
}

function load() {
    fetch('/api/state')
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.ok) { S = d; render(); }
            else if (d.err === 'unauthorized') location.replace('/');
        })
        .catch(function() {});
}

load();
setInterval(load, 8000);
