/* ============================================================================
 * B站账号切换 — 页面内脚本（内容脚本）
 *
 * 完全沿用油猴 1.4.0 的操作逻辑：
 *   · 找到 B 站头像悬浮面板里的「退出登录」元素
 *   · 向上回溯定位面板容器，把「保存账号 / 切换账号」按钮作为面板最后一个
 *     子元素注入（absolute + top:100%），随面板显隐、跟随面板宽度
 *   · 点击「切换账号」弹出账号选择弹窗（头像 + 昵称 + 当前标记）
 *   · 保存：读 nav 接口拿 mid/uname/face → 交给后台写 storage
 *   · 切换：回写当前账号凭据 → 只替换 5 个登录 Cookie → reload 生效
 *
 * 新增：删除账号、弹窗 ESC / 遮罩关闭保留、支持来自扩展弹窗的指令。
 * ========================================================================== */
(function () {
    'use strict';

    /* ==================== 与后台通信 ==================== */
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

    /* ==================== 页面内状态 ==================== */
    let state = { accounts: [], activeMid: '', settings: { autoSync: true } };

    async function refreshState() {
        try {
            state = await bg('GET_STATE');
        } catch (e) {
            console.warn('[B站账号切换] 读取状态失败', e);
        }
        return state;
    }

    /* ==================== 网络层（页面内请求，与油猴一致） ==================== */
    async function fetchCurrentUserInfo() {
        try {
            const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
            const j = await r.json();
            if (j.code === 0 && j.data && j.data.isLogin) {
                return { mid: String(j.data.mid), uname: j.data.uname, face: j.data.face };
            }
        } catch (e) {
            console.warn('[B站账号切换] 获取用户信息失败', e);
        }
        return null;
    }

    /* ==================== Toast ==================== */
    function showToast(msg) {
        const old = document.getElementById('bili-multi-toast');
        if (old) old.remove();
        const el = document.createElement('div');
        el.id = 'bili-multi-toast';
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; }, 2200);
        setTimeout(() => { el.remove(); }, 2600);
    }

    /* ==================== 业务层 ==================== */
    async function saveCurrentAccount() {
        const info = await fetchCurrentUserInfo();
        if (!info) { showToast('未检测到登录状态，请先登录 B 站'); return false; }
        try {
            await bg('SAVE_CURRENT', { info });
            await refreshState();
            showToast(`已保存账号：${info.uname}`);
            return true;
        } catch (e) {
            showToast('保存失败：' + e.message);
            return false;
        }
    }

    async function switchToAccount(targetMid) {
        targetMid = String(targetMid);
        const target = state.accounts.find(a => a.mid === targetMid);
        if (!target) { showToast('账号不存在'); return false; }

        showToast('正在切换账号...');
        try {
            const info = await fetchCurrentUserInfo(); /* 回写当前账号的最新凭据 */
            await bg('APPLY_ACCOUNT', { mid: targetMid, refreshInfo: info });
            await refreshState();
            showToast(`正在切换到 ${target.uname}...`);
            setTimeout(() => location.reload(), 800);
            return true;
        } catch (e) {
            showToast('切换失败：' + e.message);
            return false;
        }
    }

    async function deleteAccount(mid) {
        try {
            await bg('DELETE_ACCOUNT', { mid: String(mid) });
            await refreshState();
            return true;
        } catch (e) {
            showToast('删除失败：' + e.message);
            return false;
        }
    }

    /* ==================== 工具 ==================== */
    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (parseFloat(cs.opacity || '1') < 0.05) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function queryDeep(root, predicate) {
        const walk = (node) => {
            let walker;
            try { walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT); }
            catch (e) { return null; }
            while (walker.nextNode()) {
                const el = walker.currentNode;
                if (predicate(el)) return el;
                if (el.shadowRoot) {
                    const r = walk(el.shadowRoot);
                    if (r) return r;
                }
            }
            return null;
        };
        return walk(root);
    }

    /* ==================== 查找面板 ==================== */
    function findLogoutEl() {
        const fast = document.querySelectorAll('.logout, [class*="logout" i], [class*="quit" i]');
        for (const el of fast) {
            if (!isVisible(el)) continue;
            const t = (el.textContent || '').trim();
            if (t.includes('退出') || el.tagName === 'A' || el.tagName === 'BUTTON') return el;
        }
        return queryDeep(document, el => {
            if (el.children.length > 0) return false;
            const t = (el.textContent || '').trim();
            return (t === '退出登录' || t === '退出登陆' || t === '退出') && isVisible(el);
        });
    }

    function findPanel(logoutEl) {
        if (!logoutEl) return null;
        let el = logoutEl;
        let fallback = null;
        for (let i = 0; i < 12 && el && el !== document.body; i++) {
            const r = el.getBoundingClientRect();
            if (r.width >= 150 && r.width <= 600 && r.height >= 60) {
                const cs = getComputedStyle(el);
                if (cs.position === 'absolute' || cs.position === 'fixed') return el;
                if (!fallback) fallback = el;
            }
            el = el.parentElement;
        }
        return fallback;
    }

    /* ==================== 按钮注入（绑定进面板） ==================== */
    /**
     * 把按钮作为面板的最后一个子元素注入。
     * - 位置：absolute + top: 100% → 始终吸附在面板底部下方，跟随面板位置与宽度
     * - 显隐：作为面板子元素，面板隐藏/移除时按钮自动消失，无需独立轮询
     * - 面板 overflow 被改成 visible，让按钮能“探出”面板底部
     */
    function ensureButtons(panel) {
        if (panel.querySelector(':scope > .bili-multi-btn-wrap')) return;

        /* 清掉挂错位置的历史按钮 */
        document.querySelectorAll('.bili-multi-btn-wrap').forEach(el => {
            if (el.parentElement !== panel) el.remove();
        });

        const cs = getComputedStyle(panel);
        if (cs.position === 'static') panel.style.position = 'relative';

        /* 让按钮能探出面板底部 —— 只改这一处，最小侵入 */
        if (!panel.hasAttribute('data-bili-multi-ovf')) {
            panel.setAttribute('data-bili-multi-ovf', '1');
            panel.style.overflow = 'visible';
        }

        const wrap = document.createElement('div');
        wrap.className = 'bili-multi-btn-wrap';
        wrap.innerHTML =
            '<div class="bili-multi-btn" data-role="save">保存账号</div>' +
            '<div class="bili-multi-btn" data-role="switch">切换账号</div>';
        panel.appendChild(wrap);

        wrap.querySelector('[data-role="save"]').addEventListener('click', e => {
            e.stopPropagation(); e.preventDefault(); saveCurrentAccount();
        });
        wrap.querySelector('[data-role="switch"]').addEventListener('click', async e => {
            e.stopPropagation(); e.preventDefault();
            await refreshState();
            openSwitchModal();
        });
        /* 阻止鼠标事件冒泡回面板，防止点击按钮时误触发面板内部逻辑 */
        wrap.addEventListener('mousedown', e => e.stopPropagation());
        wrap.addEventListener('mouseup', e => e.stopPropagation());
    }

    /* ==================== 主监听（只在面板出现时注入一次） ==================== */
    function tryInject() {
        try {
            const logout = findLogoutEl();
            if (!logout) return;
            const panel = findPanel(logout);
            if (!panel) return;
            ensureButtons(panel);
        } catch (e) { /* 静默 */ }
    }

    const observer = new MutationObserver(() => {
        if (observer._pending) return;
        observer._pending = true;
        queueMicrotask(() => {
            observer._pending = false;
            tryInject();
        });
    });

    function start() {
        observer.observe(document.body, { childList: true, subtree: true });
        setInterval(tryInject, 1500); /* 兜底轮询，防止 MutationObserver 漏掉 */
        tryInject();
    }

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });

    /* ==================== 切换弹窗 ==================== */
    function defaultAvatar() {
        return 'data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
            '<circle cx="24" cy="24" r="24" fill="#e3e5e7"/>' +
            '<text x="24" y="30" text-anchor="middle" font-size="18" fill="#9499a0">?</text></svg>'
        );
    }

    function closeModal() {
        const el = document.getElementById('bili-multi-overlay');
        if (!el) return;
        el.style.opacity = '0';
        el.style.transition = 'opacity .15s';
        setTimeout(() => el.remove(), 160);
    }

    let escHandler = null;

    function openSwitchModal() {
        if (document.getElementById('bili-multi-overlay')) return;
        if (escHandler) document.removeEventListener('keydown', escHandler);

        const accounts = state.accounts || [];
        const activeMid = state.activeMid || '';

        const overlay = document.createElement('div');
        overlay.id = 'bili-multi-overlay';
        const modal = document.createElement('div');
        modal.id = 'bili-multi-modal';

        const header = document.createElement('div');
        header.className = 'bili-modal-header';
        header.textContent = '选择账号';
        modal.appendChild(header);

        const body = document.createElement('div');
        body.className = 'bili-modal-body';

        if (!accounts.length) {
            const tip = document.createElement('div');
            tip.className = 'bili-empty-tip';
            tip.textContent = '暂无已保存的账号';
            body.appendChild(tip);
        } else {
            accounts.forEach(acc => {
                const isCurrent = acc.mid === activeMid;
                const row = document.createElement('div');
                row.className = 'bili-account-row' + (isCurrent ? ' current' : '');

                const img = document.createElement('img');
                img.className = 'bili-account-avatar';
                img.src = acc.face || defaultAvatar();
                img.alt = acc.uname || '';
                img.onerror = function () { this.src = defaultAvatar(); };

                const name = document.createElement('span');
                name.className = 'bili-account-name';
                name.textContent = acc.uname || '未知用户';

                row.appendChild(img);
                row.appendChild(name);

                if (isCurrent) {
                    const tag = document.createElement('span');
                    tag.className = 'bili-current-tag';
                    tag.textContent = '当前';
                    row.appendChild(tag);
                }

                /* 删除按钮：首次点击变“确认删除”，再点才真的删 */
                const del = document.createElement('span');
                del.className = 'bili-account-del';
                del.textContent = '×';
                del.title = '删除该账号记录';
                del.addEventListener('click', async e => {
                    e.stopPropagation();
                    e.preventDefault();
                    if (!del.classList.contains('confirm')) {
                        del.classList.add('confirm');
                        del.textContent = '确认删除';
                        setTimeout(() => {
                            if (del.isConnected) { del.classList.remove('confirm'); del.textContent = '×'; }
                        }, 2600);
                        return;
                    }
                    await deleteAccount(acc.mid);
                    closeModal();
                    setTimeout(openSwitchModal, 200);
                    showToast(`已删除账号：${acc.uname}`);
                });
                row.appendChild(del);

                if (!isCurrent) {
                    row.addEventListener('click', () => { closeModal(); switchToAccount(acc.mid); });
                }
                body.appendChild(row);
            });
        }
        modal.appendChild(body);

        const footer = document.createElement('div');
        footer.className = 'bili-modal-footer';

        const saveBtn = document.createElement('div');
        saveBtn.className = 'bili-modal-btn primary';
        saveBtn.textContent = '保存当前账号';
        saveBtn.addEventListener('click', async e => {
            e.stopPropagation();
            const ok = await saveCurrentAccount();
            if (ok) { closeModal(); setTimeout(openSwitchModal, 300); }
        });

        const closeBtn = document.createElement('div');
        closeBtn.className = 'bili-modal-btn secondary';
        closeBtn.textContent = '关闭';
        closeBtn.addEventListener('click', e => { e.stopPropagation(); closeModal(); });

        footer.appendChild(saveBtn);
        footer.appendChild(closeBtn);
        modal.appendChild(footer);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

        escHandler = e => {
            if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escHandler); escHandler = null; }
        };
        document.addEventListener('keydown', escHandler);
    }

    /* ==================== 来自扩展弹窗的指令 ==================== */
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        (async () => {
            try {
                switch (msg && msg.type) {
                    case 'PING':
                        return { ok: true, data: { href: location.href, loggedIn: !!(await fetchCurrentUserInfo()) } };

                    case 'SAVE_CURRENT': {
                        const ok = await saveCurrentAccount();
                        return { ok: true, data: { saved: ok } };
                    }

                    case 'SWITCH_TO':
                        await switchToAccount(msg.mid);
                        return { ok: true, data: true };

                    case 'OPEN_MODAL':
                        await refreshState();
                        openSwitchModal();
                        return { ok: true, data: true };

                    case 'SYNC_STATE':
                        await refreshState();
                        return { ok: true, data: true };

                    default:
                        return { ok: false, error: '未知指令' };
                }
            } catch (e) {
                return { ok: false, error: e.message };
            }
        })().then(sendResponse);   /* 必须回传结果，否则扩展弹窗会一直等不到响应 */
        return true;               /* 保持消息通道打开，等待异步 sendResponse */
    });

    /* ==================== 初始化 ==================== */
    (async function init() {
        await refreshState();

        /* 自动同步：页面加载时若已登录且该账号已记录，静默更新其登录凭据 */
        if (state.settings && state.settings.autoSync) {
            const info = await fetchCurrentUserInfo();
            if (info && state.accounts.some(a => a.mid === info.mid)) {
                try { await bg('REFRESH_CURRENT', { info }); await refreshState(); }
                catch (e) { /* 静默 */ }
            }
        }

        console.log('[B站账号切换] 内容脚本已加载 v1.0.0');
    })();
})();
