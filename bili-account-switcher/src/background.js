/* ============================================================================
 * B站账号切换 — 后台服务（MV3 Service Worker）
 *
 * 职责：
 *   1. 全扩展唯一的 Cookie 读写入口（chrome.cookies）
 *   2. 账号库与当前账号指针的持久化（chrome.storage.local）
 *   3. 无 B 站标签页时的兜底网络请求（读取当前登录用户信息）
 *
 * 设计红线（对应需求「切换账号不更改其他设置」）：
 *   只读 / 只写 LOGIN_COOKIE_NAMES 里的 5 个登录凭证 Cookie。
 *   绝不调用 cookies.getAll() + 全量清除，也绝不触碰 localStorage，
 *   因此音量、连播、弹幕设置、播放器偏好、设备指纹（buvid3 等）全部保持原样。
 * ========================================================================== */
'use strict';

/* ==================== 常量 ==================== */
const STORAGE_KEY  = 'bili_multi_accounts';
const ACTIVE_KEY   = 'bili_active_account';
const SETTINGS_KEY = 'bili_settings';

const LOGIN_COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
const COOKIE_DOMAIN = 'bilibili.com';
const COOKIE_URL    = 'https://www.bilibili.com/';
const NAV_API       = 'https://api.bilibili.com/x/web-interface/nav';

const DEFAULT_SETTINGS = { autoSync: true };

/* ==================== 存储层 ==================== */
async function getAccounts() {
    const r = await chrome.storage.local.get(STORAGE_KEY);
    const list = r[STORAGE_KEY];
    return Array.isArray(list) ? list : [];
}
async function saveAccounts(list) {
    await chrome.storage.local.set({ [STORAGE_KEY]: list });
    return list;
}
async function getActiveUid() {
    const r = await chrome.storage.local.get(ACTIVE_KEY);
    return r[ACTIVE_KEY] ? String(r[ACTIVE_KEY]) : '';
}
async function setActiveUid(uid) {
    await chrome.storage.local.set({ [ACTIVE_KEY]: uid == null ? '' : String(uid) });
}
async function getSettings() {
    const r = await chrome.storage.local.get(SETTINGS_KEY);
    return Object.assign({}, DEFAULT_SETTINGS, r[SETTINGS_KEY] || {});
}
async function setSetting(patch) {
    const next = Object.assign(await getSettings(), patch || {});
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
}

/* 对外只暴露账号的展示信息，Cookie 明细留在后台，不进内容脚本 */
function publicView(list, activeMid, settings) {
    return {
        accounts: (list || []).map(a => ({
            mid: a.mid,
            uname: a.uname || '未知用户',
            face: a.face || '',
            savedAt: a.savedAt || 0,
            lastUsedAt: a.lastUsedAt || 0,
            hasCookies: !!(a.cookies && a.cookies.SESSDATA)
        })),
        activeMid: activeMid || '',
        settings: settings || DEFAULT_SETTINGS
    };
}

/* ==================== Cookie 层 ==================== */
function buildUrl(domain, path) {
    const host = String(domain || COOKIE_DOMAIN).replace(/^\./, '');
    return 'https://' + host + (path || '/');
}

/* 读取登录 Cookie（只挑 5 个名字），同名 Cookie 优先保留 path='/' 的那条 */
async function listLoginCookies() {
    const all = await chrome.cookies.getAll({ domain: COOKIE_DOMAIN });
    const out = {};
    for (const c of all) {
        if (LOGIN_COOKIE_NAMES.indexOf(c.name) === -1) continue;
        const prev = out[c.name];
        if (prev && !(c.path === '/' && prev.path !== '/')) continue;
        out[c.name] = {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
            expirationDate: c.expirationDate
        };
    }
    return out;
}

/* 删除登录 Cookie（仅限 5 个名字，保持其它 Cookie 原封不动） */
async function removeLoginCookies() {
    const all = await chrome.cookies.getAll({ domain: COOKIE_DOMAIN });
    const targets = all.filter(c => LOGIN_COOKIE_NAMES.indexOf(c.name) !== -1);
    const jobs = targets.map(c =>
        chrome.cookies.remove({ url: buildUrl(c.domain, c.path), name: c.name }).catch(() => null)
    );
    // 兜底：某些分区场景 getAll 可能拿不到，按已知域再尝试一次
    if (!jobs.length) {
        for (const name of LOGIN_COOKIE_NAMES) {
            jobs.push(chrome.cookies.remove({ url: COOKIE_URL, name }).catch(() => null));
        }
    }
    await Promise.all(jobs);
}

function normalizeSameSite(v) {
    const s = String(v || '').toLowerCase();
    if (s === 'none') return 'no_restriction';
    if (s === 'no_restriction' || s === 'lax' || s === 'strict' || s === 'unspecified') return s;
    return undefined;
}

/* 写入登录 Cookie，域的写法与保存时保持一致，避免产生重复 Cookie */
async function writeLoginCookies(map) {
    const entries = Object.entries(map || {});
    let written = 0;
    for (const [name, d] of entries) {
        const domain = d.domain || ('.' + COOKIE_DOMAIN);
        const path = d.path || '/';
        const opts = {
            url: buildUrl(domain, path),
            name,
            value: d.value == null ? '' : String(d.value),
            domain,
            path,
            secure: true,
            httpOnly: d.httpOnly !== false
        };
        const ss = normalizeSameSite(d.sameSite);
        if (ss) opts.sameSite = ss;
        if (d.expirationDate) opts.expirationDate = d.expirationDate;

        try {
            const c = await chrome.cookies.set(opts);
            if (c) written++;
        } catch (e) {
            // sameSite=no_restriction 必须配合 secure，个别组合会被拒 → 降级重试一次
            delete opts.sameSite;
            try {
                const c = await chrome.cookies.set(opts);
                if (c) written++;
            } catch (e2) {
                console.warn('[B站账号切换] 写入 Cookie 失败：', name, e2);
            }
        }
    }
    return written;
}

/* ==================== 网络层 ==================== */
/* 兜底：后台直接请求 nav 接口（标签页不在 B 站时使用） */
async function fetchNavFromBackground() {
    try {
        const r = await fetch(NAV_API + '?t=' + Date.now(), { credentials: 'include', cache: 'no-store' });
        const j = await r.json();
        if (j && j.code === 0 && j.data && j.data.isLogin) {
            return { mid: String(j.data.mid), uname: j.data.uname, face: j.data.face };
        }
    } catch (e) {
        console.warn('[B站账号切换] 后台获取用户信息失败', e);
    }
    return null;
}

/* ==================== 业务层 ==================== */
async function requireUserInfo(info) {
    const user = info && info.mid ? info : await fetchNavFromBackground();
    if (!user) throw new Error('未检测到登录状态，请先打开并登录 bilibili.com');
    return user;
}

/* 保存（或覆盖）当前账号 */
async function saveCurrentAccount(info) {
    const user = await requireUserInfo(info);
    const cookies = await listLoginCookies();
    if (!cookies.SESSDATA) throw new Error('无法读取登录凭证 SESSDATA，请确认已登录且已授权 Cookie 权限');

    const list = await getAccounts();
    const idx = list.findIndex(a => a.mid === user.mid);
    const data = {
        mid: user.mid,
        uname: user.uname,
        face: user.face,
        cookies,
        savedAt: Date.now(),
        lastUsedAt: idx >= 0 ? (list[idx].lastUsedAt || 0) : 0
    };
    if (idx >= 0) list[idx] = data; else list.push(data);

    await saveAccounts(list);
    await setActiveUid(user.mid);
    return Object.assign(publicView(list, user.mid, await getSettings()), { saved: { mid: user.mid, uname: user.uname } });
}

/* 静默刷新某个已保存账号的 Cookie（不新增、不报错） */
async function refreshAccount(info) {
    const user = await requireUserInfo(info);
    const list = await getAccounts();
    const idx = list.findIndex(a => a.mid === user.mid);
    if (idx < 0) return publicView(list, await getActiveUid(), await getSettings());

    const cookies = await listLoginCookies();
    if (cookies.SESSDATA) list[idx].cookies = cookies;
    list[idx].uname = user.uname || list[idx].uname;
    list[idx].face = user.face || list[idx].face;
    await saveAccounts(list);
    return publicView(list, await getActiveUid(), await getSettings());
}

/* 切换到目标账号：先回写当前账号凭据，再只替换 5 个登录 Cookie */
async function applyAccount(targetMid, refreshInfo) {
    const list = await getAccounts();
    const target = list.find(a => a.mid === String(targetMid));
    if (!target) throw new Error('账号不存在');
    if (!target.cookies || !target.cookies.SESSDATA) throw new Error('该账号没有可用的登录凭证，请重新保存');

    const user = refreshInfo && refreshInfo.mid ? refreshInfo : await fetchNavFromBackground();
    if (user) {
        const idx = list.findIndex(a => a.mid === user.mid);
        if (idx >= 0) {
            const cookies = await listLoginCookies();
            if (cookies.SESSDATA) list[idx].cookies = cookies;
            list[idx].uname = user.uname || list[idx].uname;
            list[idx].face = user.face || list[idx].face;
        }
    }
    const tIdx = list.findIndex(a => a.mid === String(targetMid));
    list[tIdx].lastUsedAt = Date.now();
    await saveAccounts(list);

    await removeLoginCookies();
    await writeLoginCookies(target.cookies);
    await setActiveUid(targetMid);

    return {
        mid: target.mid,
        uname: target.uname || '未知用户',
        state: publicView(list, target.mid, await getSettings())
    };
}

async function deleteAccount(mid) {
    const list = (await getAccounts()).filter(a => a.mid !== String(mid));
    await saveAccounts(list);
    if ((await getActiveUid()) === String(mid)) await setActiveUid('');
    return publicView(list, await getActiveUid(), await getSettings());
}

async function exportData() {
    return {
        version: 1,
        exportedAt: new Date().toISOString(),
        activeMid: await getActiveUid(),
        accounts: await getAccounts()
    };
}

async function importData(payload, mode) {
    const incoming = payload && Array.isArray(payload.accounts) ? payload.accounts : payload;
    if (!Array.isArray(incoming) || !incoming.length) throw new Error('导入内容里没有账号数据');

    const valid = incoming.filter(a => a && a.mid && a.cookies && a.cookies.SESSDATA);
    if (!valid.length) throw new Error('导入内容里没有有效的账号（缺少 SESSDATA）');

    let list = mode === 'replace' ? [] : await getAccounts();
    let added = 0, updated = 0;
    for (const acc of valid) {
        const idx = list.findIndex(a => a.mid === String(acc.mid));
        const data = {
            mid: String(acc.mid),
            uname: acc.uname || '未知用户',
            face: acc.face || '',
            cookies: acc.cookies,
            savedAt: acc.savedAt || Date.now(),
            lastUsedAt: acc.lastUsedAt || 0
        };
        if (idx >= 0) { list[idx] = data; updated++; } else { list.push(data); added++; }
    }
    await saveAccounts(list);
    if (payload && payload.activeMid) await setActiveUid(payload.activeMid);
    return Object.assign(publicView(list, await getActiveUid(), await getSettings()), { added, updated });
}

/* ==================== 消息路由 ==================== */
async function handle(msg, sender) {
    const type = msg && msg.type;
    switch (type) {
        case 'GET_STATE':
            return publicView(await getAccounts(), await getActiveUid(), await getSettings());

        case 'SAVE_CURRENT':
            return saveCurrentAccount(msg.info);

        case 'REFRESH_CURRENT':
            return refreshAccount(msg.info);

        case 'APPLY_ACCOUNT':
            return applyAccount(msg.mid, msg.refreshInfo);

        case 'DELETE_ACCOUNT':
            return deleteAccount(msg.mid);

        case 'SET_SETTING':
            return publicView(await getAccounts(), await getActiveUid(), await setSetting(msg.patch));

        case 'EXPORT':
            return exportData();

        case 'IMPORT':
            return importData(msg.payload, msg.mode);

        /* 供内容脚本 / 弹窗确认后台存活 */
        case 'PING':
            return { pong: true, at: Date.now(), from: sender && sender.tab ? sender.tab.id : null };

        default:
            throw new Error('未知指令：' + type);
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        try {
            const data = await handle(msg, sender);
            sendResponse({ ok: true, data });
        } catch (e) {
            sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
        }
    })();
    return true; /* 保持消息通道，等待异步结果 */
});

/* 首次安装时写入默认设置 */
chrome.runtime.onInstalled.addListener(async () => {
    const r = await chrome.storage.local.get(SETTINGS_KEY);
    if (!r[SETTINGS_KEY]) await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    console.log('[B站账号切换] 扩展已安装 / 更新');
});
