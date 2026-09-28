/* ============================================================================
 * B站账号切换 — 扩展弹窗逻辑
 * 与页面内面板共用同一套后台服务，操作逻辑保持一致：
 *   点击账号行 = 切换；底部按钮 = 保存当前账号；悬停 × = 删除记录。
 * ========================================================================== */
'use strict';

const BILI_HOSTS = ['https://www.bilibili.com/', 'https://space.bilibili.com/', 'https://t.bilibili.com/'];

/* ==================== 通信 ==================== */
function bg(type, payload) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (res) => {
            const err = chrome.runtime.lastError;
            if (err) return reject(new Error(err.message));
            if (!res) return reject(new Error('后台服务无响应'));
            if (!res.ok) return reject(new Error(res.error || '操作失败'));
            resolve(res.data);
        });
    });
}

function sendToTab(tabId, msg) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, msg, (res) => {
            const err = chrome.runtime.lastError;
            if (err) return reject(new Error(err.message));
            if (!res) return reject(new Error('页面脚本无响应，请刷新 B 站页面'));
            if (!res.ok) return reject(new Error(res.error || '操作失败'));
            resolve(res.data);
        });
    });
}

async function biliTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs
        .filter(t => t.url && BILI_HOSTS.some(h => t.url.indexOf(h) === 0))
        .sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
}

/* ==================== UI ==================== */
const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const chkSync = document.getElementById('chk-sync');

function setStatus(msg, isError) {
    if (!msg) { statusEl.hidden = true; return; }
    statusEl.hidden = false;
    statusEl.textContent = msg;
    statusEl.className = 'pop-status' + (isError ? ' error' : '');
}

function timeAgo(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60000) return '刚刚更新';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前更新';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前更新';
    return Math.floor(d / 86400000) + ' 天前更新';
}

function defaultAvatar() {
    return 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
        '<circle cx="24" cy="24" r="24" fill="#e3e5e7"/>' +
        '<text x="24" y="30" text-anchor="middle" font-size="18" fill="#9499a0">?</text></svg>'
    );
}

let state = { accounts: [], activeMid: '', settings: { autoSync: true } };

function render() {
    listEl.textContent = '';

    if (!state.accounts.length) {
        const tip = document.createElement('div');
        tip.className = 'pop-empty';
        tip.textContent = '暂无已保存的账号';
        listEl.appendChild(tip);
        return;
    }

    /* 当前账号置顶，其余按最近使用排序 */
    const sorted = state.accounts.slice().sort((a, b) => {
        if (a.mid === state.activeMid) return -1;
        if (b.mid === state.activeMid) return 1;
        return (b.lastUsedAt || b.savedAt || 0) - (a.lastUsedAt || a.savedAt || 0);
    });

    sorted.forEach(acc => {
        const isCurrent = acc.mid === state.activeMid;
        const row = document.createElement('div');
        row.className = 'pop-row' + (isCurrent ? ' current' : '');

        const img = document.createElement('img');
        img.className = 'pop-avatar';
        img.src = acc.face || defaultAvatar();
        img.alt = acc.uname || '';
        img.onerror = function () { this.src = defaultAvatar(); };

        const meta = document.createElement('div');
        meta.className = 'pop-meta';
        const name = document.createElement('div');
        name.className = 'pop-name';
        name.textContent = acc.uname || '未知用户';
        const time = document.createElement('div');
        time.className = 'pop-time';
        time.textContent = (acc.hasCookies ? '' : '⚠ 凭据缺失 · ') + timeAgo(acc.savedAt);
        meta.appendChild(name);
        meta.appendChild(time);

        row.appendChild(img);
        row.appendChild(meta);

        if (isCurrent) {
            const tag = document.createElement('span');
            tag.className = 'pop-tag';
            tag.textContent = '当前';
            row.appendChild(tag);
        }

        const del = document.createElement('span');
        del.className = 'pop-del';
        del.textContent = '×';
        del.title = '删除该账号记录';
        del.addEventListener('click', async e => {
            e.stopPropagation();
            if (!del.classList.contains('confirm')) {
                del.classList.add('confirm');
                del.textContent = '确认';
                setTimeout(() => {
                    if (del.isConnected) { del.classList.remove('confirm'); del.textContent = '×'; }
                }, 2600);
                return;
            }
            await bg('DELETE_ACCOUNT', { mid: acc.mid });
            await load();
            setStatus(`已删除：${acc.uname}`);
        });
        row.appendChild(del);

        if (!isCurrent) row.addEventListener('click', () => switchTo(acc.mid));
        listEl.appendChild(row);
    });
}

async function load() {
    state = await bg('GET_STATE');
    chkSync.checked = !!(state.settings && state.settings.autoSync);
    render();
}

/* ==================== 业务动作 ==================== */
async function switchTo(mid) {
    const acc = state.accounts.find(a => a.mid === mid);
    setStatus(`正在切换到 ${acc ? acc.uname : mid}...`);

    const tabs = await biliTabs();
    const pageTab = tabs.find(t => t.url.indexOf('https://www.bilibili.com/') === 0) || tabs[0];

    if (pageTab) {
        /* 交给页面脚本：先回写当前账号凭据，再替换 Cookie，然后自动刷新页面 */
        try {
            await sendToTab(pageTab.id, { type: 'SWITCH_TO', mid });
            setStatus(`已切换到 ${acc ? acc.uname : mid}，页面正在刷新`);
        } catch (e) {
            await bg('APPLY_ACCOUNT', { mid });
            chrome.tabs.reload(pageTab.id);
            setStatus(`已切换并刷新：${e.message}`);
        }
    } else {
        await bg('APPLY_ACCOUNT', { mid });
        chrome.tabs.create({ url: 'https://www.bilibili.com/' });
        setStatus(`已切换到 ${acc ? acc.uname : mid}，已打开 B 站`);
    }
    await load();
}

async function saveCurrent() {
    setStatus('正在读取当前登录状态...');
    const tabs = await biliTabs();
    const pageTab = tabs.find(t => t.url.indexOf('https://www.bilibili.com/') === 0) || tabs[0];

    try {
        if (pageTab) {
            const r = await sendToTab(pageTab.id, { type: 'SAVE_CURRENT' });
            if (!r || !r.saved) { setStatus('未检测到登录状态，请先在 B 站登录', true); return; }
        } else {
            /* 没有 B 站标签页时由后台自行请求 nav 接口 */
            await bg('SAVE_CURRENT');
        }
        await load();
        const cur = state.accounts.find(a => a.mid === state.activeMid);
        setStatus(`已保存账号：${cur ? cur.uname : state.activeMid}`);
    } catch (e) {
        setStatus('保存失败：' + e.message, true);
    }
}

async function openPagePanel() {
    const tabs = await biliTabs();
    if (!tabs.length) { setStatus('请先打开 bilibili.com 页面', true); return; }
    try {
        await sendToTab(tabs[0].id, { type: 'OPEN_MODAL' });
        window.close();
    } catch (e) {
        setStatus('打开面板失败：' + e.message, true);
    }
}

async function exportAccounts() {
    const data = await bg('EXPORT');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bili-accounts-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus(`已导出 ${data.accounts.length} 个账号（含登录凭据，请妥善保管）`);
}

async function importAccounts(file) {
    try {
        const text = await file.text();
        const payload = JSON.parse(text);
        const r = await bg('IMPORT', { payload, mode: 'merge' });
        await load();
        setStatus(`导入完成：新增 ${r.added} 个，更新 ${r.updated} 个`);
    } catch (e) {
        setStatus('导入失败：' + e.message, true);
    }
}

/* ==================== 事件绑定 ==================== */
document.getElementById('btn-save').addEventListener('click', saveCurrent);
document.getElementById('btn-panel').addEventListener('click', openPagePanel);
document.getElementById('btn-export').addEventListener('click', exportAccounts);
document.getElementById('btn-import').addEventListener('click', () => document.getElementById('file-import').click());
document.getElementById('file-import').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) importAccounts(f);
    e.target.value = '';
});
chkSync.addEventListener('change', async () => {
    await bg('SET_SETTING', { patch: { autoSync: chkSync.checked } });
    await load();
    setStatus(chkSync.checked ? '已开启自动同步' : '已关闭自动同步');
});

/* ==================== 初始化 ==================== */
(async function init() {
    try {
        await load();
        const tabs = await biliTabs();
        if (!tabs.length) setStatus('提示：先打开 bilibili.com 才能保存/切换账号');
    } catch (e) {
        setStatus('初始化失败：' + e.message, true);
    }
})();
