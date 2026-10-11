// AJ Predict — Cloudflare Worker (D1 + KV). همه محاسبات امتیاز، قفل و جایزه فقط سمت سرور.
const LOCK_MS = 10 * 60 * 1000;
const enc = new TextEncoder();
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const err = (m, s = 400) => json({ error: m }, s);

// ---------- Auth: تایید JWT سوپابیس (HS256) ----------
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function verifyJWT(token, secret) {
  const [h, p, s] = (token || '').split('.');
  if (!s) return null;
  try {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('HMAC', key, b64u(s), enc.encode(h + '.' + p)))) return null;
    const pl = JSON.parse(new TextDecoder().decode(b64u(p)));
    return pl.exp * 1000 > Date.now() && pl.sub && pl.email ? pl : null;
  } catch { return null; }
}
async function authUser(req, env) {
  const pl = await verifyJWT((req.headers.get('authorization') || '').slice(7), env.SUPABASE_JWT_SECRET);
  if (!pl) return null;
  const name = pl.email.split('@')[0].replace(/[^\w]/g, '').slice(0, 14) || 'user';
  await env.DB.prepare('INSERT OR IGNORE INTO users (id,email,username,created_at) VALUES (?,?,?,?)')
    .bind(pl.sub, pl.email, name + Math.floor(Math.random() * 900 + 100), Date.now()).run();
  const u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(pl.sub).first();
  if (!u || u.banned) return null;
  u.isAdmin = (env.ADMIN_EMAILS || '').toLowerCase().split(',').map(x => x.trim()).includes(u.email.toLowerCase());
  return u;
}

// ---------- apifootball v3 با کش KV (همه کاربران از یک فراخوانی مشترک استفاده می‌کنند) ----------
async function af(env, params, ttl = 0) {
  const ck = 'af:' + new URLSearchParams(params);
  if (ttl) { const c = await env.CACHE.get(ck); if (c) return JSON.parse(c); }
  const u = new URL('https://apiv3.apifootball.com/');
  for (const k in params) u.searchParams.set(k, params[k]);
  u.searchParams.set('APIkey', env.API_KEY);
  const d = await fetch(u).then(r => r.json()).catch(() => null);
  if (!Array.isArray(d)) return [];
  if (ttl) await env.CACHE.put(ck, JSON.stringify(d), { expirationTtl: Math.max(60, ttl) });
  return d;
}
const startOf = (m, env) => Date.parse(`${m.match_date}T${m.match_time}:00${env.TZ_OFFSET}`);
const isFinal = s => /^(finished|after|ft$|aet$|pen$)/.test(s);
const isVoid = s => /(postp|cancel|^canc|aband)/.test(s);

// ---------- فرمول امتیاز ----------
// نتیجه درست ۳ | تفاضل گل درست ۱+ | نتیجه دقیق ۲+ | جوکر ×۲ | الماس = نصف امتیاز (رو به بالا)
function scorePred(p, rh, ra) {
  let pts = 0, st = 'lost';
  if (Math.sign(p.h - p.a) === Math.sign(rh - ra)) {
    pts = 3; st = 'winner';
    if (p.h - p.a === rh - ra) pts += 1;
    if (p.h === rh && p.a === ra) { pts += 2; st = 'exact'; }
  }
  pts = Math.round(pts * (p.mult || 1));
  return { pts: p.joker ? pts * 2 : pts, st };
}
// ضریب سختی: بر اساس احتمال آماری نتیجه‌ی پیش‌بینی‌شده (get_predictions). هیچ ضریب شرط‌بندی/odds استفاده نمی‌شود.
function multOf(pr, h, a) {
  if (!pr) return 1;
  const p = parseFloat(pr[h > a ? 'prob_HW' : h < a ? 'prob_AW' : 'prob_D']);
  return isNaN(p) ? 1 : p < 25 ? 1.5 : p < 40 ? 1.25 : 1;
}
const wdl = (e, id) => { const f = parseInt(e.match_hometeam_score), g = parseInt(e.match_awayteam_score); if (isNaN(f) || isNaN(g)) return null; const home = String(e.match_hometeam_id) === String(id), my = home ? f : g, op = home ? g : f; return my > op ? 'W' : my < op ? 'L' : 'D'; };
async function streaks(env, uid) {
  const { results } = await env.DB.prepare("SELECT status FROM predictions WHERE user_id=? AND status IN ('exact','winner','lost') ORDER BY match_ts DESC LIMIT 300").bind(uid).all();
  let cur = 0, best = 0, run = 0, live = true;
  for (const { status } of results) { if (status !== 'lost') { run++; best = Math.max(best, run); if (live) cur = run; } else { run = 0; live = false; } }
  return { cur, best };
}
// ماموریت‌ها: [id, عنوان, الماس, هدف] — کاملاً قطعی و مبتنی بر مهارت (بدون شانس)
const MIS = [['welcome', 'ورود به اپلیکیشن', 5, 1], ['first_pred', 'اولین پیش‌بینی', 10, 1], ['streak3', '۳ پیش‌بینی درست پشت‌سرهم', 10, 3], ['streak5', '۵ پیش‌بینی درست پشت‌سرهم', 25, 5], ['wins10', '۱۰ پیش‌بینی درست', 20, 10], ['exact3', '۳ نتیجه دقیق', 15, 3], ['exact10', '۱۰ نتیجه دقیق', 40, 10]];
async function misState(env, u) {
  const st = await env.DB.prepare("SELECT COUNT(*) allp,COALESCE(SUM(status IN ('exact','winner')),0) wins,COALESCE(SUM(status='exact'),0) ex FROM predictions WHERE user_id=?").bind(u.id).first();
  const sk = await streaks(env, u.id);
  const { results } = await env.DB.prepare('SELECT mission_id FROM user_missions WHERE user_id=?').bind(u.id).all();
  return { val: { welcome: 1, first_pred: st.allp, streak3: sk.best, streak5: sk.best, wins10: st.wins, exact3: st.ex, exact10: st.ex }, cl: new Set(results.map(r => r.mission_id)) };
}

// ---------- تسویه (Cron) — idempotent: هر پیش‌بینی فقط یک‌بار و اتمیک ----------
async function settle(env) {
  const { results: ms } = await env.DB.prepare("SELECT DISTINCT match_id FROM predictions WHERE status='pending' AND match_ts<=? LIMIT 30").bind(Date.now()).all();
  for (const { match_id } of ms) {
    const [m] = await af(env, { action: 'get_events', match_id });
    if (!m) continue;
    const s = (m.match_status || '').toLowerCase();
    const now = Date.now();
    const { results: ps } = await env.DB.prepare("SELECT id,user_id,h,a,joker,mult FROM predictions WHERE match_id=? AND status='pending'").bind(match_id).all();
    const stmts = [];
    if (isVoid(s)) {
      ps.forEach(p => stmts.push(env.DB.prepare("UPDATE predictions SET status='void',settled_at=? WHERE id=? AND status='pending'").bind(now, p.id)));
    } else if (isFinal(s)) {
      // نتیجه ۹۰ دقیقه (ft_score)؛ در نبود آن، نتیجه نهایی
      const pick = (a, b) => (a !== '' && a != null && !isNaN(a) ? parseInt(a) : parseInt(b));
      const rh = pick(m.match_hometeam_ft_score, m.match_hometeam_score), ra = pick(m.match_awayteam_ft_score, m.match_awayteam_score);
      if (isNaN(rh) || isNaN(ra)) continue;
      for (const p of ps) {
        const { pts, st } = scorePred(p, rh, ra);
        stmts.push(env.DB.prepare("UPDATE predictions SET status=?,points=?,real_h=?,real_a=?,settled_at=? WHERE id=? AND status='pending'").bind(st, pts, rh, ra, now, p.id));
        stmts.push(env.DB.prepare('UPDATE users SET diamonds=diamonds+? WHERE id=? AND changes()>0').bind(Math.ceil(pts / 2), p.user_id));
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
  }
}

// ---------- دوئل: بدون شرط‌بندی؛ برنده پاداش ثابت از سیستم می‌گیرد (سقف هفتگی) ----------
const DUEL_REWARD = 3, DUEL_WEEKLY_CAP = 5;
function finalScore(m) {
  const s = (m.match_status || '').toLowerCase();
  if (isVoid(s)) return { void: true };
  if (!isFinal(s)) return null;
  const pick = (a, b) => (a !== '' && a != null && !isNaN(a) ? parseInt(a) : parseInt(b));
  const rh = pick(m.match_hometeam_ft_score, m.match_hometeam_score), ra = pick(m.match_awayteam_ft_score, m.match_awayteam_score);
  return isNaN(rh) || isNaN(ra) ? null : { rh, ra };
}
async function settleDuels(env) {
  const now = Date.now();
  await env.DB.prepare("UPDATE duels SET status='expired',settled_at=? WHERE status='pending' AND match_ts-600000<=?").bind(now, now).run();
  const { results: ms } = await env.DB.prepare("SELECT DISTINCT match_id FROM duels WHERE status='active' AND match_ts<=? LIMIT 20").bind(now).all();
  for (const { match_id } of ms) {
    const [m] = await af(env, { action: 'get_events', match_id });
    const f = m && finalScore(m);
    if (!f) continue;
    const { results: ds } = await env.DB.prepare("SELECT * FROM duels WHERE match_id=? AND status='active'").bind(match_id).all();
    for (const d of ds) {
      if (f.void) { await env.DB.prepare("UPDATE duels SET status='void',settled_at=? WHERE id=? AND status='active'").bind(now, d.id).run(); continue; }
      const A = { h: d.ch_h, a: d.ch_a }, B = { h: d.op_h, a: d.op_a };
      const pa = scorePred(A, f.rh, f.ra).pts, pb = scorePred(B, f.rh, f.ra).pts;
      const da = Math.abs(A.h - f.rh) + Math.abs(A.a - f.ra), db = Math.abs(B.h - f.rh) + Math.abs(B.a - f.ra);
      const win = pa !== pb ? (pa > pb ? d.challenger : d.opponent) : da !== db ? (da < db ? d.challenger : d.opponent) : null;
      let reward = 0;
      if (win) { const c = await env.DB.prepare('SELECT COUNT(*) n FROM duels WHERE winner=? AND reward>0 AND settled_at>=?').bind(win, now - 7 * 864e5).first(); reward = c.n < DUEL_WEEKLY_CAP ? DUEL_REWARD : 0; }
      const st = [env.DB.prepare("UPDATE duels SET status='settled',winner=?,reward=?,real_h=?,real_a=?,settled_at=? WHERE id=? AND status='active'").bind(win, reward, f.rh, f.ra, now, d.id)];
      if (reward) st.push(env.DB.prepare('UPDATE users SET diamonds=diamonds+? WHERE id=? AND changes()>0').bind(reward, win));
      await env.DB.batch(st);
    }
  }
}
async function duelStats(env, uid) {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(winner=?1),0) w, COALESCE(SUM(winner IS NOT NULL AND winner!=?1),0) l, COALESCE(SUM(winner IS NULL),0) d FROM duels WHERE status='settled' AND (challenger=?1 OR opponent=?1)").bind(uid).first();
  return { w: r.w, d: r.d, l: r.l };
}

// ---------- جدول رتبه ----------
const since = p => (p === 'week' ? Date.now() - 7 * 864e5 : p === 'month' ? Date.now() - 30 * 864e5 : 0);
async function board(env, period, uid, limit, withEmail, leagueId = null) {
  const { results } = await env.DB.prepare(`
    WITH t AS (
      SELECT u.id,u.username,u.avatar_url,u.email,SUM(p.points) pts,SUM(p.status='exact') ex,COUNT(p.id) n
      FROM users u JOIN predictions p ON p.user_id=u.id AND p.status IN ('exact','winner','lost') AND p.settled_at>=?1
      WHERE u.banned=0 AND (?2 IS NULL OR u.id IN (SELECT user_id FROM league_members WHERE league_id=?2)) GROUP BY u.id),
    r AS (SELECT *,RANK() OVER (ORDER BY pts DESC,ex DESC,n ASC) rk FROM t)
    SELECT * FROM r WHERE rk<=?3 OR id=?4 ORDER BY rk`).bind(since(period), leagueId, limit, uid || '').all();
  return results.map(r => ({ rank: r.rk, id: r.id, username: r.username, avatar: r.avatar_url, points: r.pts, exact: r.ex, n: r.n, ...(withEmail ? { email: r.email } : {}) }));
}

// ---------- مسیرها ----------
async function route(req, env) {
  const url = new URL(req.url), path = url.pathname, method = req.method;
  // ----- تشخیص سلامت (بدون راز؛ بعد از رفع مشکل می‌توانید پاکش کنید) -----
  if (path === '/api/health') {
    const k = env.API_KEY || '', r = { TZ: !!env.TZ, TZ_OFFSET: !!env.TZ_OFFSET, ADMIN_EMAILS: !!env.ADMIN_EMAILS, JWT_SECRET: !!env.SUPABASE_JWT_SECRET, API_KEY_length: k.length, API_KEY_only_hex: /^[0-9a-f]+$/i.test(k) };
    for (const t of ['users', 'predictions', 'leagues', 'league_members', 'user_missions']) { try { await env.DB.prepare(`SELECT 1 FROM ${t} LIMIT 1`).first(); r['table_' + t] = 'ok'; } catch (e) { r['table_' + t] = 'خطا: ' + String(e.message).slice(0, 90); } }
    try { await env.CACHE.put('health', '1', { expirationTtl: 60 }); r.kv = 'ok'; } catch (e) { r.kv = 'خطا: ' + String(e.message).slice(0, 90); }
    try { const d = await fetch(`https://apiv3.apifootball.com/?action=get_countries&APIkey=${k}`).then(x => x.json()); r.apifootball = Array.isArray(d) ? 'ok' : JSON.stringify(d).slice(0, 120); } catch (e) { r.apifootball = 'خطا: ' + String(e.message).slice(0, 90); }
    return json(r);
  }
  // پروکسی لوگوی تیم‌ها (هم‌دامنه می‌شود تا عکس اشتراک‌گذاری ساخته شود). فقط apifootball.
  if (path === '/api/img') {
    let t; try { t = new URL(url.searchParams.get('u') || ''); } catch { return err('نامعتبر'); }
    if (t.hostname !== 'apiv3.apifootball.com' || !t.pathname.startsWith('/badges/')) return err('forbidden', 403);
    const r = await fetch(t, { cf: { cacheTtl: 86400, cacheEverything: true } });
    return r.ok ? new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || 'image/png', 'cache-control': 'public,max-age=86400' } }) : new Response(null, { status: 404 });
  }
  const av = path.match(/^\/api\/avatar\/([\w-]+)$/);
  if (av && method === 'GET') {
    const v = await env.CACHE.get('av:' + av[1]);
    return v ? new Response(Uint8Array.from(atob(v), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public,max-age=86400' } }) : new Response(null, { status: 404 });
  }
  const u = await authUser(req, env);
  if (!u) return err('unauthorized', 401);

  if (path === '/api/matches') {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date')) ? url.searchParams.get('date') : new Date().toISOString().slice(0, 10);
    const ev = await af(env, { action: 'get_events', from: d, to: d, timezone: env.TZ }, 120);
    const t0 = Date.parse(`${d}T00:00:00${env.TZ_OFFSET}`);
    const { results } = await env.DB.prepare('SELECT match_id,h,a,joker,mult,status,points FROM predictions WHERE user_id=? AND match_ts>=? AND match_ts<?').bind(u.id, t0 - 864e5, t0 + 2 * 864e5).all();
    const mine = Object.fromEntries(results.map(r => [r.match_id, r]));
    const prs = Object.fromEntries((await af(env, { action: 'get_predictions', from: d, to: d, timezone: env.TZ }, 3600)).map(x => [x.match_id, x]));
    const { results: cmr } = await env.DB.prepare('SELECT match_id,SUM(h>a) hw,SUM(h=a) d,SUM(h<a) aw FROM predictions WHERE match_ts>=? AND match_ts<? GROUP BY match_id').bind(t0, t0 + 864e5).all();
    const cms = Object.fromEntries(cmr.map(r => [r.match_id, r]));
    const now = Date.now();
    return json(ev.map(m => {
      const ts = startOf(m, env), s = m.match_status || '', pe = prs[m.match_id], c = cms[m.match_id];
      return { id: m.match_id, ts, status: s, live: m.match_live === '1', league: m.league_name, country: m.country_name, lbadge: m.league_logo,
        home: m.match_hometeam_name, away: m.match_awayteam_name, hb: m.team_home_badge, ab: m.team_away_badge,
        hid: m.match_hometeam_id, aid: m.match_awayteam_id, pr: pe && !isNaN(+pe.prob_HW) ? [+pe.prob_HW, +pe.prob_D, +pe.prob_AW] : null, cm: c && c.hw + c.d + c.aw >= 5 ? [c.hw, c.d, c.aw] : null,
        hs: m.match_hometeam_score, as: m.match_awayteam_score, locked: s !== '' || now >= ts - LOCK_MS, mine: mine[m.match_id] || null };
    }).filter(m => m.id && !isNaN(m.ts)).sort((a, b) => a.ts - b.ts));
  }

  if (path === '/api/predict' && method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const h = Number(b.h), a = Number(b.a);
    if (![h, a].every(n => Number.isInteger(n) && n >= 0 && n <= 20)) return err('نتیجه نامعتبر است');
    const [m] = await af(env, { action: 'get_events', match_id: String(b.match_id) }, 60);
    if (!m) return err('بازی پیدا نشد', 404);
    const ts = startOf(m, env);
    if ((m.match_status || '') !== '' || Date.now() >= ts - LOCK_MS) return err('ثبت پیش‌بینی برای این بازی بسته شده است', 423);
    const pr = (await af(env, { action: 'get_predictions', from: m.match_date, to: m.match_date, timezone: env.TZ }, 3600)).find(x => x.match_id === m.match_id), mult = multOf(pr, h, a);
    const wk = Math.floor((ts / 864e5 + 3) / 7), joker = b.joker ? 1 : 0;
    if (joker) {
      const j = await env.DB.prepare('SELECT 1 FROM predictions WHERE user_id=? AND wk=? AND joker=1 AND match_id!=?').bind(u.id, wk, m.match_id).first();
      if (j) return err('جوکر این هفته را قبلاً استفاده کرده‌اید', 409);
    }
    await env.DB.prepare(`INSERT INTO predictions (user_id,match_id,match_ts,wk,league,home,away,hbadge,abadge,h,a,joker,mult,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,match_id) DO UPDATE SET h=excluded.h,a=excluded.a,joker=excluded.joker,mult=excluded.mult WHERE predictions.status='pending'`)
      .bind(u.id, m.match_id, ts, wk, m.league_name, m.match_hometeam_name, m.match_awayteam_name, m.team_home_badge, m.team_away_badge, h, a, joker, mult, Date.now()).run();
    return json({ ok: true });
  }

  if (path === '/api/me') {
    if (method === 'POST') {
      const { username } = await req.json().catch(() => ({}));
      if (!/^[\w\u0600-\u06FF]{3,16}$/.test(username || '')) return err('نام کاربری ۳ تا ۱۶ حرف (بدون فاصله) باشد');
      try { await env.DB.prepare('UPDATE users SET username=? WHERE id=?').bind(username, u.id).run(); }
      catch { return err('این نام کاربری گرفته شده است', 409); }
      return json({ ok: true });
    }
    const st = await env.DB.prepare(`SELECT COUNT(*) n,COALESCE(SUM(status IN ('exact','winner')),0) wins,COALESCE(SUM(status='exact'),0) ex,COALESCE(SUM(points),0) pts
      FROM predictions WHERE user_id=? AND status IN ('exact','winner','lost')`).bind(u.id).first();
    const { results: hist } = await env.DB.prepare('SELECT match_id,league,home,away,hbadge,abadge,h,a,joker,status,points,real_h,real_a,match_ts FROM predictions WHERE user_id=? ORDER BY match_ts DESC LIMIT 40').bind(u.id).all();
    const rk = (await board(env, 'all', u.id, 0, false)).find(r => r.id === u.id);
    return json({ username: u.username, email: u.email, avatar: u.avatar_url, diamonds: u.diamonds, isAdmin: u.isAdmin, stats: { ...st, rank: rk?.rank || null, streak: await streaks(env, u.id), duels: await duelStats(env, u.id) }, history: hist });
  }

  if (path === '/api/leaderboard') {
    const p = ['week', 'month', 'all'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'week';
    const rows = await board(env, p, u.id, 50, false);
    return json({ rows, me: rows.find(r => r.id === u.id) || null });
  }

  // ----- تحلیل بازی: فرم ۵ بازی اخیر + تقابل‌ها (کش ۶ ساعته) -----
  if (path === '/api/info') {
    const hid = url.searchParams.get('hid'), aid = url.searchParams.get('aid');
    if (!/^\d+$/.test(hid || '') || !/^\d+$/.test(aid || '')) return err('نامعتبر');
    const ck = `h2h:${hid}:${aid}`;
    let d = await env.CACHE.get(ck, 'json');
    if (!d) {
      const x = await fetch(`https://apiv3.apifootball.com/?action=get_H2H&firstTeamId=${hid}&secondTeamId=${aid}&APIkey=${env.API_KEY}`).then(r => r.json()).catch(() => null) || {};
      const h2h = (x.firstTeam_VS_secondTeam || []).slice(0, 10), c = { hw: 0, d: 0, aw: 0 };
      h2h.forEach(e => { const r = wdl(e, hid); if (r) c[r === 'W' ? 'hw' : r === 'D' ? 'd' : 'aw']++; });
      d = { hf: (x.firstTeam_lastResults || []).slice(0, 5).map(e => wdl(e, hid)).filter(Boolean), af: (x.secondTeam_lastResults || []).slice(0, 5).map(e => wdl(e, aid)).filter(Boolean), h2h: c,
        last: h2h.slice(0, 3).map(e => ({ d: e.match_date, h: e.match_hometeam_name, a: e.match_awayteam_name, s: `${e.match_hometeam_score}-${e.match_awayteam_score}` })) };
      await env.CACHE.put(ck, JSON.stringify(d), { expirationTtl: 21600 });
    }
    return json(d);
  }

  // ----- آواتار (JPEG کوچک، ذخیره در KV) -----
  if (path === '/api/avatar' && method === 'POST') {
    const { img } = await req.json().catch(() => ({}));
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(img || '');
    if (!m || m[1].length > 60000 || !m[1].startsWith('/9j/')) return err('تصویر نامعتبر یا بزرگ است');
    await env.CACHE.put('av:' + u.id, m[1]);
    const link = `/api/avatar/${u.id}?v=${Date.now()}`;
    await env.DB.prepare('UPDATE users SET avatar_url=? WHERE id=?').bind(link, u.id).run();
    return json({ url: link });
  }

  // ----- دوئل رو در رو -----
  if (path === '/api/duels' && method === 'POST') {
    const b = await req.json().catch(() => ({})), h = Number(b.h), a = Number(b.a);
    if (![h, a].every(n => Number.isInteger(n) && n >= 0 && n <= 20)) return err('نتیجه نامعتبر است');
    const opp = await env.DB.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE AND banned=0').bind(String(b.opponent || '').trim()).first();
    if (!opp) return err('کاربری با این نام پیدا نشد', 404);
    if (opp.id === u.id) return err('نمی‌توانی با خودت دوئل کنی');
    const [m] = await af(env, { action: 'get_events', match_id: String(b.match_id) }, 60);
    if (!m) return err('بازی پیدا نشد', 404);
    const ts = startOf(m, env);
    if ((m.match_status || '') !== '' || Date.now() >= ts - LOCK_MS) return err('زمان این بازی گذشته است', 423);
    const open = await env.DB.prepare("SELECT COUNT(*) n FROM duels WHERE challenger=? AND status IN ('pending','active')").bind(u.id).first();
    if (open.n >= 10) return err('حداکثر ۱۰ دوئل باز همزمان داری', 409);
    const dup = await env.DB.prepare("SELECT 1 FROM duels WHERE match_id=?1 AND status IN ('pending','active') AND ((challenger=?2 AND opponent=?3) OR (challenger=?3 AND opponent=?2))").bind(m.match_id, u.id, opp.id).first();
    if (dup) return err('برای این بازی با این کاربر دوئل باز داری', 409);
    await env.DB.prepare('INSERT INTO duels (match_id,match_ts,league,home,away,hbadge,abadge,challenger,opponent,ch_h,ch_a,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(m.match_id, ts, m.league_name, m.match_hometeam_name, m.match_awayteam_name, m.team_home_badge, m.team_away_badge, u.id, opp.id, h, a, Date.now()).run();
    return json({ ok: true });
  }
  if (path === '/api/duels' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT d.*,cu.username cn,cu.avatar_url ca,ou.username onm,ou.avatar_url oa FROM duels d JOIN users cu ON cu.id=d.challenger JOIN users ou ON ou.id=d.opponent WHERE d.challenger=?1 OR d.opponent=?1 ORDER BY d.created_at DESC LIMIT 60').bind(u.id).all();
    const now = Date.now();
    const rows = results.map(d => {
      const mine = d.challenger === u.id, locked = now >= d.match_ts - LOCK_MS, opPick = d.op_h == null ? null : [d.op_h, d.op_a], chPick = [d.ch_h, d.ch_a];
      const reveal = d.status === 'settled' || (d.status === 'active' && locked);
      return { id: d.id, status: d.status, mine, incoming: !mine && d.status === 'pending',
        opp: { username: mine ? d.onm : d.cn, avatar: mine ? d.oa : d.ca },
        match: { home: d.home, away: d.away, hb: d.hbadge, ab: d.abadge, league: d.league, ts: d.match_ts },
        my: mine ? chPick : opPick, theirs: reveal ? (mine ? opPick : chPick) : null,
        winner: d.status === 'settled' ? (d.winner === null ? 'draw' : d.winner === u.id ? 'me' : 'opp') : null, reward: d.reward, real: d.real_h == null ? null : [d.real_h, d.real_a] };
    });
    return json({ rows, stats: await duelStats(env, u.id) });
  }
  if (path === '/api/duels/respond' && method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const d = await env.DB.prepare('SELECT * FROM duels WHERE id=?').bind(Number(b.id)).first();
    if (!d) return err('پیدا نشد', 404);
    if (b.action === 'cancel') {
      if (d.challenger !== u.id || d.status !== 'pending') return err('امکان لغو نیست', 409);
      await env.DB.prepare("UPDATE duels SET status='cancelled',settled_at=? WHERE id=? AND status='pending'").bind(Date.now(), d.id).run();
      return json({ ok: true });
    }
    if (d.opponent !== u.id || d.status !== 'pending') return err('این درخواست قابل پاسخ نیست', 409);
    if (Date.now() >= d.match_ts - LOCK_MS) return err('زمان پاسخ به این دوئل گذشته است', 423);
    if (b.action === 'decline') { await env.DB.prepare("UPDATE duels SET status='declined',settled_at=? WHERE id=? AND status='pending'").bind(Date.now(), d.id).run(); return json({ ok: true }); }
    const h = Number(b.h), a = Number(b.a);
    if (![h, a].every(n => Number.isInteger(n) && n >= 0 && n <= 20)) return err('نتیجه نامعتبر است');
    await env.DB.prepare("UPDATE duels SET status='active',op_h=?,op_a=? WHERE id=? AND status='pending'").bind(h, a, d.id).run();
    return json({ ok: true });
  }

  // ----- لیگ خصوصی -----
  if (path === '/api/leagues' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT l.id,l.name,l.code,(SELECT COUNT(*) FROM league_members WHERE league_id=l.id) n FROM leagues l JOIN league_members m ON m.league_id=l.id WHERE m.user_id=? ORDER BY l.id DESC').bind(u.id).all();
    return json({ rows: results });
  }
  if (path === '/api/leagues' && method === 'POST') {
    const { name } = await req.json().catch(() => ({}));
    if (!/^.{3,24}$/.test((name || '').trim())) return err('نام لیگ ۳ تا ۲۴ حرف باشد');
    const mine = await env.DB.prepare('SELECT COUNT(*) n FROM league_members WHERE user_id=?').bind(u.id).first();
    if (mine.n >= 10) return err('حداکثر در ۱۰ لیگ می‌توانید عضو باشید', 409);
    const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
    const r = await env.DB.prepare('INSERT INTO leagues (name,code,owner,created_at) VALUES (?,?,?,?)').bind(name.trim(), code, u.id, Date.now()).run();
    await env.DB.prepare('INSERT INTO league_members (league_id,user_id,joined_at) VALUES (?,?,?)').bind(r.meta.last_row_id, u.id, Date.now()).run();
    return json({ ok: true, code });
  }
  if (path === '/api/leagues/join' && method === 'POST') {
    const { code } = await req.json().catch(() => ({}));
    const l = await env.DB.prepare('SELECT id FROM leagues WHERE code=?').bind(String(code || '').toUpperCase().trim()).first();
    if (!l) return err('کد لیگ پیدا نشد', 404);
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM league_members WHERE league_id=?').bind(l.id).first();
    if (n.n >= 50) return err('ظرفیت لیگ تکمیل است', 409);
    await env.DB.prepare('INSERT OR IGNORE INTO league_members (league_id,user_id,joined_at) VALUES (?,?,?)').bind(l.id, u.id, Date.now()).run();
    return json({ ok: true });
  }
  if (path === '/api/leagues/board') {
    const id = Number(url.searchParams.get('id')), p = ['week', 'month', 'all'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'month';
    if (!await env.DB.prepare('SELECT 1 FROM league_members WHERE league_id=? AND user_id=?').bind(id, u.id).first()) return err('عضو این لیگ نیستید', 403);
    const rows = await board(env, p, u.id, 50, false, id);
    return json({ rows, me: rows.find(r => r.id === u.id) || null });
  }

  // ----- ماموریت‌ها و حضور روزانه (جایگزین گردونه شانس) -----
  const today = new Date().toLocaleDateString('en-CA', { timeZone: env.TZ });
  if (path === '/api/missions' && method === 'GET') {
    const { val, cl } = await misState(env, u);
    return json({ rows: MIS.map(([id, t, r, n]) => ({ id, t, r, n, v: val[id], claimed: cl.has(id) })), checkin: cl.has('checkin:' + today), diamonds: u.diamonds });
  }
  if (path === '/api/missions/claim' && method === 'POST') {
    const { id } = await req.json().catch(() => ({}));
    let mid, rw;
    if (id === 'checkin') { mid = 'checkin:' + today; rw = 2; }
    else { const { val } = await misState(env, u), d = MIS.find(x => x[0] === id); if (!d || val[id] < d[3]) return err('شرایط ماموریت کامل نیست', 409); mid = id; rw = d[2]; }
    const res = await env.DB.batch([env.DB.prepare('INSERT OR IGNORE INTO user_missions (user_id,mission_id,claimed_at) VALUES (?,?,?)').bind(u.id, mid, Date.now()), env.DB.prepare('UPDATE users SET diamonds=diamonds+? WHERE id=? AND changes()>0').bind(rw, u.id)]);
    return res[0].meta.changes ? json({ ok: true, reward: rw }) : err('قبلاً دریافت شده است', 409);
  }

  // ----- ادمین: فقط ایمیل‌های ADMIN_EMAILS -----
  if (path.startsWith('/api/admin/')) {
    if (!u.isAdmin) return err('forbidden', 403);
    if (path === '/api/admin/banned') { const { results } = await env.DB.prepare('SELECT id,username,email FROM users WHERE banned=1 ORDER BY created_at DESC LIMIT 500').all(); return json({ rows: results }); }
    if (path === '/api/admin/ban' && method === 'POST') {
      const { id, banned } = await req.json().catch(() => ({}));
      await env.DB.prepare('UPDATE users SET banned=? WHERE id=?').bind(banned ? 1 : 0, String(id)).run();
      return json({ ok: true });
    }
    const rows = await board(env, ['week', 'month', 'all'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'month', null, 500, true);
    if (path === '/api/admin/users') return json({ rows });
    if (path === '/api/admin/export.csv') {
      const csv = 'rank,username,email,points,exact,predictions\n' + rows.map(r => [r.rank, r.username, r.email, r.points, r.exact, r.n].join(',')).join('\n');
      return new Response('\ufeff' + csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename=leaderboard.csv' } });
    }
    if (path === '/api/admin/ban' && method === 'POST') {
      const { id, banned } = await req.json().catch(() => ({}));
      await env.DB.prepare('UPDATE users SET banned=? WHERE id=?').bind(banned ? 1 : 0, id).run();
      return json({ ok: true });
    }
  }
  return err('not found', 404);
}

export default {
  async fetch(req, env) { try { return await route(req, env); } catch (e) { console.error(e); return err('server error', 500); } },
  async scheduled(_e, env, ctx) { ctx.waitUntil((async () => { await settle(env); await settleDuels(env); })()); },
};
