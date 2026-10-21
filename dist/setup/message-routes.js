/**
 * 消息存储面板路由（统计 / 预览 / 清理）
 *
 * 与绑定路由同风格：同源校验 + JSON 收发；store 为 null 表示存储未启用。
 */
import { MESSAGES_CLEAR_PATH, MESSAGES_RECENT_PATH, MESSAGES_SENDERS_PATH, MESSAGES_STATS_PATH, SLEEP_STATUS_PATH } from "../shared/bind-protocol.js";
import { getActiveSleepClock } from "../features/sleep-clock.js";
import { GroupDirectory } from "../features/group-directory.js";
const MAX_BODY_BYTES = 4096;
function trusted(req) {
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host === req.headers.host;
    }
    catch {
        return false;
    }
}
function sendJson(res, status, body) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
}
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES)
            throw new Error('request body too large');
        chunks.push(chunk);
    }
    if (size === 0)
        return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function guard(req, res, method) {
    if (!trusted(req)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return false;
    }
    if (req.method !== method) {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return false;
    }
    return true;
}
function parseClearTarget(body) {
    if (typeof body !== 'object' || body === null)
        return null;
    const kind = body.kind;
    if (kind === 'all')
        return { kind };
    if (kind === 'group' || kind === 'c2c') {
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        return id.length > 0 && id.length <= 256 ? { kind, id } : null;
    }
    if (kind === 'older') {
        const days = Number(body.days);
        return Number.isFinite(days) && days >= 0 && days <= 36500 ? { kind, days } : null;
    }
    return null;
}
/**
 * @param webServer ctx.webServer
 * @param getStore 当前存储（可能为 null：未启用或打开失败）
 * @param info 额外回显（启用状态、保留天数、打开错误）
 */
export function registerMessageRoutes(webServer, getStore, info, logger) {
    const disposers = [
        webServer.register({
            kind: 'exact',
            path: MESSAGES_SENDERS_PATH,
            handler: (req, res) => {
                if (!guard(req, res, 'GET'))
                    return;
                const store = getStore();
                if (store === null) {
                    sendJson(res, 200, { ok: true, senders: [] });
                    return;
                }
                try {
                    sendJson(res, 200, { ok: true, senders: store.senders(30) });
                }
                catch (err) {
                    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
                }
            },
        }),
        webServer.register({
            kind: 'exact',
            path: SLEEP_STATUS_PATH,
            handler: (req, res) => {
                if (!guard(req, res, 'GET'))
                    return;
                const clock = getActiveSleepClock();
                sendJson(res, 200, clock === null ? { ok: true, active: false } : { ok: true, active: true, ...clock.status() });
            },
        }),
        webServer.register({
            kind: 'exact',
            path: MESSAGES_STATS_PATH,
            handler: (req, res) => {
                if (!guard(req, res, 'GET'))
                    return;
                const store = getStore();
                if (store === null) {
                    sendJson(res, 200, { enabled: false, ...info() });
                    return;
                }
                try {
                    const stats = store.stats();
                    stats.groups = stats.groups.map((g) => {
                        const d = GroupDirectory.get(g.groupOpenid);
                        const label = d ? [d.name, d.number ? `群号 ${d.number}` : ''].filter(Boolean).join(' · ') : '';
                        return label ? { ...g, label } : g;
                    });
                    sendJson(res, 200, { enabled: true, ...info(), ...stats });
                }
                catch (err) {
                    sendJson(res, 500, { enabled: true, error: err instanceof Error ? err.message : String(err) });
                }
            },
        }),
        webServer.register({
            kind: 'exact',
            path: MESSAGES_RECENT_PATH,
            handler: async (req, res) => {
                if (!guard(req, res, 'POST'))
                    return;
                const store = getStore();
                if (store === null) {
                    sendJson(res, 409, { ok: false, error: '消息存储未启用' });
                    return;
                }
                let body;
                try {
                    body = await readJsonBody(req);
                }
                catch (err) {
                    sendJson(res, 400, { ok: false, error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` });
                    return;
                }
                const scene = body?.scene === 'c2c' ? 'c2c' : body?.scene === 'group' ? 'group' : null;
                const id = typeof body?.id === 'string' ? body.id : '';
                if (scene === null || id.length === 0) {
                    sendJson(res, 400, { ok: false, error: 'scene / id 无效' });
                    return;
                }
                try {
                    sendJson(res, 200, { ok: true, messages: store.recent(scene, id, Number(body.limit) || 20) });
                }
                catch (err) {
                    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
                }
            },
        }),
        webServer.register({
            kind: 'exact',
            path: MESSAGES_CLEAR_PATH,
            handler: async (req, res) => {
                if (!guard(req, res, 'POST'))
                    return;
                const store = getStore();
                if (store === null) {
                    sendJson(res, 409, { ok: false, error: '消息存储未启用' });
                    return;
                }
                let body;
                try {
                    body = await readJsonBody(req);
                }
                catch (err) {
                    sendJson(res, 400, { ok: false, error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` });
                    return;
                }
                const target = parseClearTarget(body);
                if (target === null) {
                    sendJson(res, 400, { ok: false, error: '清理目标无效' });
                    return;
                }
                try {
                    const deleted = store.clear(target);
                    logger.info(`im-qqbot: 消息清理 ${JSON.stringify(target)} → 删除 ${deleted} 条`);
                    sendJson(res, 200, { ok: true, deleted });
                }
                catch (err) {
                    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
                }
            },
        }),
    ];
    return () => { for (const dispose of disposers)
        dispose(); };
}
