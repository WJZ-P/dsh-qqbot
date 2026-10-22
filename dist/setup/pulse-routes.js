import { pickCheapRoute, pickVisionRoute } from "../features/llm-lite.js";
import { scheduleSelfReload } from "../features/restart-tool.js";
/**
 * 水群 / 表情包面板路由
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { PULSE_ACTION_PATH, PULSE_STATUS_PATH, STICKERS_FILE_PATH, STICKERS_LIST_PATH, STICKERS_UPDATE_PATH, GROUPS_PATH, CAPABILITIES_PATH, MODELS_PATH, RESTART_PATH } from "../shared/bind-protocol.js";
import { CAPABILITIES, PROACTIVE_MODES, QUIET_MAX_MIN, describeBotState, explainApiError, pluginControls } from "../features/group-admin.js";
import { GroupDirectory, GROUP_PROMPT_MAX, MEMORY_MAX, RATE_LIMIT_MAX } from "../features/group-directory.js";
import { rateStatus } from "../features/group-rate-limit.js";
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
async function readJsonBody(req, max = 4096) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > max)
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
export function registerPulseRoutes(webServer, { ctx, pulse, maintenance, manager, logger, store = null, config = {}, groupAdmin = null }) {
    const lib = StickerLibrary.shared();
    const running = new Set();
    const background = (name, fn) => {
        if (running.has(name))
            return false;
        running.add(name);
        void fn().catch((err) => logger.warn(`im-qqbot: ${name} 失败: ${errText(err)}`)).finally(() => running.delete(name));
        return true;
    };
    /** 已知的群：群目录 ∪ 水群状态 ∪ 消息库 */
    const knownGroups = () => {
        const map = new Map();
        const touch = (id) => {
            if (typeof id !== 'string' || !id)
                return null;
            if (!map.has(id))
                map.set(id, { groupOpenid: id, count: 0, lastAt: null });
            return map.get(id);
        };
        for (const g of GroupDirectory.list())
            touch(g.openid);
        try {
            for (const g of pulse?.status?.().groups ?? [])
                touch(g.groupOpenid);
        }
        catch { /* ignore */ }
        try {
            for (const g of store?.stats?.().groups ?? []) {
                const e = touch(g.groupOpenid);
                if (e) {
                    e.count = Number(g.count ?? 0);
                    e.lastAt = g.lastAt ?? null;
                }
            }
        }
        catch { /* ignore */ }
        let daily = {};
        try {
            daily = store?.groupDailyCounts?.(7) ?? {};
        }
        catch { /* ignore */ }
        let pulseGroups = new Map();
        try {
            pulseGroups = new Map((pulse?.status?.().groups ?? []).map((g) => [g.groupOpenid, g]));
        }
        catch { /* ignore */ }
        return [...map.values()].map((e) => {
            const d = GroupDirectory.get(e.groupOpenid) ?? {};
            let top = [];
            try {
                top = (store?.groupTopSenders?.(e.groupOpenid, 5) ?? []).map((u) => ({ name: u.name || `${String(u.userOpenid).slice(0, 6)}…`, count: Number(u.count) }));
            }
            catch { /* ignore */ }
            const days = daily[e.groupOpenid] ?? new Array(7).fill(0);
            const pg = pulseGroups.get(e.groupOpenid);
            return {
                ...e,
                registered: Boolean(d.name || d.number),
                name: d.name ?? '', number: d.number ?? '', note: d.note ?? '', prompt: d.prompt ?? '',
                label: GroupDirectory.label(e.groupOpenid),
                memories: d.memories ?? [],
                rate: rateStatus(e.groupOpenid, config),
                today: days[days.length - 1] ?? 0,
                week: days.reduce((a, b) => a + b, 0),
                daily: days,
                topSenders: top,
                controls: pluginControls(e.groupOpenid, config),
                botRole: groupAdmin?.cache?.get(`state:${e.groupOpenid}`)?.data?.member_role ?? null,
                official: (() => { const i = groupAdmin?.cache?.get(`info:${e.groupOpenid}`)?.data; return i ? { name: i.group_name, members: i.group_member_num } : null; })(),
                bot: pg ? { level: pg.level, activity: pg.activity, todayProactive: pg.todayCount, stats: pg.stats ?? {} } : null,
                model: modelInfo(e.groupOpenid),
            };
        }).sort((a, b) => Number(b.lastAt ?? 0) - Number(a.lastAt ?? 0));
    };
    /** 某群当前模型：生效路由、来源（peer 单独设置 / scope 所有群默认 / default）、运行中会话实际在用的（可能是同组替补） */
    const modelInfo = (gid) => {
        try {
            const key = manager.sessionKey('group', gid);
            const r = manager.modelResolver;
            const record = manager.sessions.get(key);
            const active = record ? (record.activeRoute ?? manager.agentRoute?.(record) ?? null) : null;
            return {
                route: r.getEffectiveRoute(key) ?? null,
                source: r.getRouteSource(key),
                override: r.prefs.getOverride(key) ?? null,
                active: active ? { provider: active.provider, model: active.model } : null,
            };
        }
        catch {
            return null;
        }
    };
    const validateRoute = async (raw) => {
        if (!raw || typeof raw !== 'object' || typeof raw.provider !== 'string' || typeof raw.model !== 'string' || !raw.provider || !raw.model)
            return { error: 'model 需为 { provider, model } 或 null' };
        const groups = await manager.listModelGroups();
        const g = groups.find((x) => x.provider === raw.provider);
        if (!g)
            return { error: `模型分组「${raw.provider}」不存在` };
        if (!g.failed && !g.models.some((m) => m.id === raw.model))
            return { error: `分组「${g.label}」里没有模型「${raw.model}」` };
        return { route: { provider: raw.provider, model: raw.model } };
    };
    const disposers = [
        webServer.register({
            kind: 'exact',
            path: RESTART_PATH,
            handler: async (req, res) => {
                if (!guard(req, res, 'POST'))
                    return;
                sendJson(res, 200, scheduleSelfReload(ctx, logger, { delayMs: 500, reason: 'web' }));
            },
        }),
        webServer.register({
            kind: 'exact',
            path: MODELS_PATH,
            handler: async (req, res) => {
                if (!guard(req, res, 'GET'))
                    return;
                try {
                    const force = new URL(req.url ?? '', 'http://x').searchParams.get('refresh') === '1';
                    const groups = await manager.listModelGroups(force);
                    const r = manager.modelResolver;
                    sendJson(res, 200, {
                        ok: true,
                        configured: config.provider && config.model ? { provider: config.provider, model: config.model } : null,
                        hostDefault: r.resolveDefault?.() ?? null,
                        botDefault: r.botDefaultRoute?.() ?? null,
                        background: await pickCheapRoute(manager, config.pulse?.judgeModel).then((x) => x, (e) => ({ error: e.message })),
                        tagging: await pickVisionRoute(manager, config.pulse?.judgeModel).then((x) => x, (e) => ({ error: e.message })),
                        groups: groups.map((g) => ({ ...g, models: g.models.map((m) => ({ ...m, bad: r.isBad(g.provider, m.id) })) })),
                    });
                }
                catch (err) {
                    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
                }
            },
        }),
        webServer.register({
            kind: 'exact',
            path: CAPABILITIES_PATH,
            handler: async (req, res) => {
                if (!guard(req, res, 'GET'))
                    return;
                const gid = (new URL(req.url ?? '', 'http://x').searchParams.get('group') ?? '').trim().toUpperCase();
                const out = { ok: true, capabilities: CAPABILITIES, permission: config.groupAdmin?.permission ?? 'owner' };
                if (/^[0-9A-F]{32}$/.test(gid) && groupAdmin) {
                    const probe = {};
                    try {
                        const s = await groupAdmin.botState(gid, true);
                        probe.botState = { ok: true, role: s.member_role, text: describeBotState(s) };
                    }
                    catch (err) {
                        probe.botState = { ok: false, error: explainApiError(err) };
                    }
                    try {
                        const i = await groupAdmin.info(gid);
                        probe.info = { ok: true, name: i.group_name, members: i.group_member_num, memo: i.group_finger_memo };
                    }
                    catch (err) {
                        probe.info = { ok: false, error: explainApiError(err) };
                    }
                    try {
                        await groupAdmin.muteStatus(gid);
                        probe.mute = { ok: true };
                    }
                    catch (err) {
                        probe.mute = { ok: false, error: explainApiError(err) };
                    }
                    out.probe = probe;
                }
                sendJson(res, 200, out);
            },
        }),
        webServer.register({
            kind: 'exact',
            path: GROUPS_PATH,
            handler: async (req, res) => {
                if (req.method === 'GET') {
                    if (!guard(req, res, 'GET'))
                        return;
                    for (const g0 of knownGroups()) {
                        groupAdmin?.info?.(g0.groupOpenid).catch(() => { });
                        groupAdmin?.botState?.(g0.groupOpenid).catch(() => { });
                    }
                    const groups = knownGroups();
                    let storeInfo = null;
                    try {
                        const st = store?.stats?.();
                        if (st)
                            storeInfo = { path: st.path, sizeBytes: st.sizeBytes, total: st.total, firstAt: st.firstAt };
                    }
                    catch { /* ignore */ }
                    sendJson(res, 200, {
                        ok: true, max: GROUP_PROMPT_MAX, memoryMax: MEMORY_MAX, rateMax: RATE_LIMIT_MAX,
                        defaultRate: rateStatus('', config).limit,
                        defaultLimits: rateStatus('', config).limits,
                        summary: {
                            groups: groups.length,
                            groupMessages: groups.reduce((a, g) => a + (g.count || 0), 0),
                            today: groups.reduce((a, g) => a + (g.today || 0), 0),
                            week: groups.reduce((a, g) => a + (g.week || 0), 0),
                            limitedToday: groups.reduce((a, g) => a + (g.rate?.limitedToday || 0), 0),
                            repliesToday: groups.reduce((a, g) => a + (g.rate?.used?.day || 0), 0),
                        },
                        store: storeInfo,
                        allGroupsModel: (() => { try { return manager.modelResolver.prefs.getOverride(`qqbot:${config.appId}:group:*`) ?? null; } catch { return null; } })(),
                        fallbackModel: (() => { try { const r = manager.modelResolver; return config.provider && config.model ? { provider: config.provider, model: config.model } : (r.resolveDefault?.() ?? null); } catch { return null; } })(),
                        groups,
                    });
                    return;
                }
                if (!guard(req, res, 'POST'))
                    return;
                let body;
                try {
                    body = await readJsonBody(req, 64 * 1024);
                }
                catch (err) {
                    sendJson(res, 400, { ok: false, error: errText(err) });
                    return;
                }
                // 所有群默认模型（不带 groupOpenid）：route 或 null（清除，回落到插件 / 宿主默认）
                if (body.allGroupsModel !== undefined) {
                    let route = null;
                    if (body.allGroupsModel !== null) {
                        const v = await validateRoute(body.allGroupsModel);
                        if (v.error) {
                            sendJson(res, 400, { ok: false, error: v.error });
                            return;
                        }
                        route = v.route;
                    }
                    try {
                        // 不清各群单独设置：面板里单独选过的群保持不变
                        const r = await manager.setScopeModel('group', route, { clearPeers: body.clearPeers === true });
                        sendJson(res, 200, { ok: true, ...r, groups: knownGroups() });
                    }
                    catch (err) {
                        sendJson(res, 500, { ok: false, error: errText(err) });
                    }
                    return;
                }
                const gid = typeof body.groupOpenid === 'string' ? body.groupOpenid.trim().toUpperCase() : '';
                if (!/^[0-9A-F]{32}$/.test(gid)) {
                    sendJson(res, 400, { ok: false, error: 'groupOpenid 无效' });
                    return;
                }
                if (body.model !== undefined) {
                    let route = null;
                    if (body.model !== null) {
                        const v = await validateRoute(body.model);
                        if (v.error) {
                            sendJson(res, 400, { ok: false, error: v.error });
                            return;
                        }
                        route = v.route;
                    }
                    try {
                        const r = await manager.setPeerModelFromPanel('group', gid, route);
                        sendJson(res, 200, { ok: true, deferred: r.deferred, effective: r.effective, groups: knownGroups() });
                    }
                    catch (err) {
                        sendJson(res, 500, { ok: false, error: errText(err) });
                    }
                    return;
                }
                const patch = {};
                for (const k of ['name', 'number', 'prompt']) {
                    if (body[k] === undefined)
                        continue;
                    if (typeof body[k] !== 'string') {
                        sendJson(res, 400, { ok: false, error: `${k} 必须是字符串` });
                        return;
                    }
                    patch[k] = body[k];
                }
                if (patch.number && !/^\d{5,12}$/.test(patch.number.trim())) {
                    sendJson(res, 400, { ok: false, error: '群号应为 5–12 位数字' });
                    return;
                }
                if (patch.prompt && patch.prompt.length > GROUP_PROMPT_MAX) {
                    sendJson(res, 400, { ok: false, error: `群专属 prompt 最长 ${GROUP_PROMPT_MAX} 字` });
                    return;
                }
                if (body.rateLimit !== undefined) {
                    const r = body.rateLimit;
                    if (r !== null && !(Number.isInteger(r) && r >= 0 && r <= RATE_LIMIT_MAX)) {
                        sendJson(res, 400, { ok: false, error: `每分钟次数应为 0–${RATE_LIMIT_MAX} 的整数（0 = 不限），或 null 恢复默认` });
                        return;
                    }
                    patch.rateLimit = r;
                }
                for (const [bk, pk] of [['rateHour', 'rateHour'], ['rateDay', 'rateDay']]) {
                    if (body[bk] === undefined)
                        continue;
                    const r = body[bk];
                    if (r !== null && !(Number.isInteger(r) && r >= 0 && r <= 100000)) {
                        sendJson(res, 400, { ok: false, error: `${bk === 'rateHour' ? '每小时' : '每天'}次数应为 0–100000 的整数（0 = 不限），或 null 恢复默认` });
                        return;
                    }
                    patch[pk] = r;
                }
                if (body.proactive !== undefined) {
                    if (!PROACTIVE_MODES.includes(body.proactive)) {
                        sendJson(res, 400, { ok: false, error: 'proactive 需为 normal / less / more / off' });
                        return;
                    }
                    patch.proactive = body.proactive;
                }
                if (body.quietMinutes !== undefined) {
                    const q = Number(body.quietMinutes);
                    if (!(Number.isInteger(q) && q >= 0 && q <= QUIET_MAX_MIN)) {
                        sendJson(res, 400, { ok: false, error: `安静时长应为 0–${QUIET_MAX_MIN} 分钟` });
                        return;
                    }
                    patch.quietUntil = q === 0 ? null : Date.now() + q * 60_000;
                }
                if (body.memory && typeof body.memory === 'object') {
                    const m = body.memory;
                    const r = m.op === 'add' ? GroupDirectory.addMemory(gid, String(m.text ?? ''), 'panel')
                        : m.op === 'update' ? GroupDirectory.updateMemory(gid, String(m.id ?? ''), String(m.text ?? ''))
                            : m.op === 'remove' ? GroupDirectory.removeMemory(gid, String(m.id ?? ''))
                                : m.op === 'clear' ? { cleared: GroupDirectory.clearMemories(gid) }
                                    : { error: '未知的记忆操作' };
                    if (r.error) {
                        sendJson(res, 400, { ok: false, error: r.error });
                        return;
                    }
                }
                GroupDirectory.set(gid, patch);
                logger.info(`im-qqbot: 面板更新群 ${gid}（prompt ${(patch.prompt ?? '').length} 字）`);
                sendJson(res, 200, { ok: true, groups: knownGroups() });
            },
        }),
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
                        sendJson(res, 200, { ok: true, started: background('表情包打标签', async () => lib.tagPending(ctx, await maintenance.visionRoute(), 20, logger)) });
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
                            background(`重新打标签 ${id}`, async () => lib.tagOne(ctx, await maintenance.visionRoute(), id));
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
