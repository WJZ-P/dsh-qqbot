/**
 * 水群 / 表情包面板路由
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { PULSE_ACTION_PATH, PULSE_STATUS_PATH, STICKERS_FILE_PATH, STICKERS_LIST_PATH, STICKERS_UPDATE_PATH } from "../shared/bind-protocol.js";
import { StickerLibrary } from "../features/sticker-library.js";
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
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096)
            throw new Error('request body too large');
        chunks.push(chunk);
    }
    return size === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
const errText = (err) => (err instanceof Error ? err.message : String(err));
export function registerPulseRoutes(webServer, { ctx, pulse, maintenance, manager, logger }) {
    const lib = StickerLibrary.shared();
    const running = new Set();
    const background = (name, fn) => {
        if (running.has(name))
            return false;
        running.add(name);
        void fn().catch((err) => logger.warn(`im-qqbot: ${name} 失败: ${errText(err)}`)).finally(() => running.delete(name));
        return true;
    };
    const disposers = [
        webServer.register({
            kind: 'exact',
            path: PULSE_STATUS_PATH,
            handler: (req, res) => {
                if (!guard(req, res, 'GET'))
                    return;
                if (pulse === null) {
                    sendJson(res, 200, { ok: true, available: false });
                    return;
                }
                sendJson(res, 200, {
                    ok: true, available: true, ...pulse.status(),
                    running: [...running],
                    lastHarvest: maintenance?.lastHarvest ?? null,
                    lastNightly: maintenance?.lastNightly ?? '',
                    stickers: lib.stats(),
                });
            },
        }),
        webServer.register({
            kind: 'exact',
            path: PULSE_ACTION_PATH,
            handler: async (req, res) => {
                if (!guard(req, res, 'POST'))
                    return;
                let body;
                try {
                    body = await readJsonBody(req);
                }
                catch (err) {
                    sendJson(res, 400, { ok: false, error: errText(err) });
                    return;
                }
                if (pulse === null || maintenance === null) {
                    sendJson(res, 409, { ok: false, error: '水群引擎未启用' });
                    return;
                }
                const gid = typeof body.groupOpenid === 'string' ? body.groupOpenid : '';
                switch (body.action) {
                    case 'reset':
                        if (!gid) {
                            sendJson(res, 400, { ok: false, error: '缺少 groupOpenid' });
                            return;
                        }
                        pulse.resetGroup(gid);
                        sendJson(res, 200, { ok: true });
                        return;
                    case 'profile':
                        if (!gid || maintenance.store === null) {
                            sendJson(res, 400, { ok: false, error: '缺少 groupOpenid 或消息存储未启用' });
                            return;
                        }
                        sendJson(res, 200, { ok: true, started: background('群档案', async () => maintenance.summarize(gid, await maintenance.route())) });
                        return;
                    case 'harvest': {
                        const q = typeof body.query === 'string' && body.query.trim() ? body.query.trim().slice(0, 40) : '';
                        sendJson(res, 200, {
                            ok: true,
                            started: background('网上搜集表情包', async () => maintenance.harvest(await maintenance.route(), q ? { keywords: [q], perKeyword: 6 } : { perKeyword: 3, maxKeywords: 3 })),
                        });
                        return;
                    }
                    case 'tag':
                        sendJson(res, 200, { ok: true, started: background('表情包打标签', async () => lib.tagPending(ctx, await maintenance.route(), 20, logger)) });
                        return;
                    default:
                        sendJson(res, 400, { ok: false, error: '未知操作' });
                }
            },
        }),
        webServer.register({
            kind: 'exact',
            path: STICKERS_LIST_PATH,
            handler: (req, res) => {
                if (!guard(req, res, 'GET'))
                    return;
                try {
                    sendJson(res, 200, { ok: true, stats: lib.stats(), stickers: lib.list() });
                }
                catch (err) {
                    sendJson(res, 500, { ok: false, error: errText(err) });
                }
            },
        }),
        webServer.register({
            kind: 'exact',
            path: STICKERS_FILE_PATH,
            handler: (req, res) => {
                if (!guard(req, res, 'GET'))
                    return;
                const id = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? '';
                const e = /^[0-9A-F]{32}$/i.test(id) ? lib.get(id.toUpperCase()) : undefined;
                const path = e ? lib.filePath(e.id) : undefined;
                if (!e || !path || !existsSync(path)) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                res.writeHead(200, {
                    'content-type': e.mime || 'application/octet-stream',
                    'content-length': statSync(path).size,
                    'cache-control': 'private, max-age=86400',
                });
                createReadStream(path).pipe(res);
            },
        }),
        webServer.register({
            kind: 'exact',
            path: STICKERS_UPDATE_PATH,
            handler: async (req, res) => {
                if (!guard(req, res, 'POST'))
                    return;
                let body;
                try {
                    body = await readJsonBody(req);
                }
                catch (err) {
                    sendJson(res, 400, { ok: false, error: errText(err) });
                    return;
                }
                const id = String(body.id ?? '').toUpperCase();
                if (!lib.get(id)) {
                    sendJson(res, 404, { ok: false, error: '表情包不存在' });
                    return;
                }
                switch (body.action) {
                    case 'enable':
                    case 'disable':
                        lib.update(id, { enabled: body.action === 'enable' });
                        break;
                    case 'delete':
                        lib.remove(id);
                        break;
                    case 'retag':
                        lib.update(id, { retag: true });
                        if (maintenance !== null)
                            background(`重新打标签 ${id}`, async () => lib.tagOne(ctx, await maintenance.route(), id));
                        break;
                    default:
                        sendJson(res, 400, { ok: false, error: '未知操作' });
                        return;
                }
                sendJson(res, 200, { ok: true, sticker: lib.get(id) ?? null });
            },
        }),
    ];
    void manager;
    return () => { for (const d of disposers)
        d(); };
}
//# sourceMappingURL=pulse-routes.js.map
