/**
 * 表情包库 — 自动收集群友发的表情包 + 网上搜集，打标签后供水群 / agent 使用。
 *
 * 存储：~/.dsh-qqbot/stickers/<ID>.<ext> + index.json
 * ID：QQ 表情包附件 filename 本身就是内容 MD5（同一张图不同人发 filename 相同），网上图片用字节 MD5。
 * 识别：content 含 <faceType=6 …> 的图片附件 = 表情包；无文字的单张小图 = 疑似表情包（打标签时由视觉模型确认）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callLite, parseJsonLoose, sniffImage } from "./llm-lite.js";
export const STICKER_DIR = join(homedir(), '.dsh-qqbot', 'stickers');
const INDEX_PATH = join(STICKER_DIR, 'index.json');
export const STICKER_MAX_DEFAULT = 500;
const MAX_BYTES = 3 * 1024 * 1024;
const MIN_BYTES = 1024;
export const EMOTIONS = ['开心', '大笑', '喜欢', '得意', '赞同', '疑惑', '无语', '震惊', '害怕', '难过', '哭', '生气', '嫌弃', '委屈', '害羞', '困', '摸鱼', '打招呼', '晚安', '加油', '谢谢', '嘲讽', '其他'];
const TAG_PROMPT = `这是一张图片，可能是聊天用的表情包。只输出一个 JSON 对象，不要其他文字：
{"isSticker": true/false（是否是表情包/梗图/反应图；普通照片、截图、文档、风景则为 false）,
 "desc": "一句话描述画面（角色、动作、表情）",
 "text": "图中文字原文，没有就空字符串",
 "emotion": "从 [${EMOTIONS.join(',')}] 中选一个最贴切的",
 "tags": ["3~6 个中文标签，例如角色/系列名（甘城猫猫、熊猫头、Claude、柴犬…）、用途（斗图、阴阳怪气、晚安、摸鱼）、情绪"]}`;
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
function now() {
    return Date.now();
}
function attIsImage(a) {
    return String(a?.content_type ?? '').startsWith('image/');
}
/** 从 QQ 附件 filename 取 ID（32 位十六进制），否则用 URL 的 hash */
function idOfAttachment(a) {
    const m = String(a.filename ?? '').match(/([0-9A-Fa-f]{32})/);
    if (m)
        return m[1].toUpperCase();
    return createHash('md5').update(String(a.url ?? a.filename ?? Math.random())).digest('hex').toUpperCase();
}
/** 识别消息里的表情包附件 */
export function stickerAttachments(msg) {
    const atts = (msg.attachments ?? []).filter(attIsImage);
    if (atts.length === 0)
        return [];
    const content = String(msg.content ?? '');
    if (/<faceType=6\b/.test(content))
        return atts.map((a) => ({ att: a, probable: false }));
    const text = content.replace(/<[^>]+>/g, '').trim();
    if (text === '' && atts.length === 1) {
        const a = atts[0];
        const w = Number(a.width) || 0;
        const h = Number(a.height) || 0;
        const small = (w > 0 && h > 0 && Math.max(w, h) <= 480) || String(a.content_type) === 'image/gif';
        if (small && (Number(a.size) || 0) <= MAX_BYTES)
            return [{ att: a, probable: true }];
    }
    return [];
}
async function download(url, maxBytes) {
    const headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' };
    if (/baidu\.com/i.test(url))
        headers.referer = 'https://image.baidu.com/';
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000), headers });
    if (!resp.ok)
        throw new Error(`HTTP ${resp.status}`);
    const len = Number(resp.headers.get('content-length') ?? 0);
    if (len > maxBytes)
        throw new Error(`too large (${len})`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > maxBytes)
        throw new Error(`too large (${buf.length})`);
    return buf;
}
let shared = null;
export class StickerLibrary {
    entries = new Map();
    max = STICKER_MAX_DEFAULT;
    lastRefreshAt = 0;
    saveTimer;
    downloading = new Map();
    static shared() {
        if (shared === null)
            shared = new StickerLibrary();
        return shared;
    }
    constructor() {
        mkdirSync(STICKER_DIR, { recursive: true });
        try {
            if (existsSync(INDEX_PATH)) {
                const data = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
                for (const e of data.entries ?? [])
                    this.entries.set(e.id, e);
                this.lastRefreshAt = Number(data.lastRefreshAt) || 0;
            }
        }
        catch { /* 损坏则重建 */ }
    }
    save() {
        if (this.saveTimer)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.flush();
        }, 1500);
        this.saveTimer.unref?.();
    }
    flush() {
        try {
            const tmp = `${INDEX_PATH}.tmp`;
            writeFileSync(tmp, JSON.stringify({ version: 1, lastRefreshAt: this.lastRefreshAt, entries: [...this.entries.values()] }, null, 1), 'utf8');
            renameSync(tmp, INDEX_PATH);
        }
        catch { /* ignore */ }
    }
    get(id) {
        return this.entries.get(id);
    }
    filePath(id) {
        const e = this.entries.get(id);
        return e?.file ? join(STICKER_DIR, e.file) : undefined;
    }
    hasFile(id) {
        const p = this.filePath(id);
        return p !== undefined && existsSync(p);
    }
    /** 收到群消息：登记表情包（后台下载），返回识别到的 ID 列表 */
    observe(msg, logger) {
        const found = stickerAttachments(msg);
        const ids = [];
        for (const { att, probable } of found) {
            const id = idOfAttachment(att);
            ids.push(id);
            let e = this.entries.get(id);
            const t = now();
            if (e === undefined) {
                if (this.isFull())
                    continue; // 库已满：不再收新表情包（等两周一次的 LRU 换血腾位置）
                e = {
                    id, file: '', mime: att.content_type ?? '', size: Number(att.size) || 0,
                    width: Number(att.width) || 0, height: Number(att.height) || 0,
                    source: 'group', probable, groups: {}, senders: [], firstSeen: t, lastSeen: t, seenCount: 0,
                    tagged: false, enabled: true, sentCount: 0, lastSentAt: 0,
                };
                this.entries.set(id, e);
            }
            if (!probable)
                e.probable = false;
            e.lastSeen = t;
            e.seenCount += 1;
            if (msg.groupOpenid)
                e.groups[msg.groupOpenid] = (e.groups[msg.groupOpenid] ?? 0) + 1;
            const name = msg.senderName ?? msg.raw?.author?.username;
            if (name && !e.senders.includes(name)) {
                e.senders.push(name);
                if (e.senders.length > 8)
                    e.senders.shift();
            }
            if (!this.hasFile(id) && att.url)
                void this.fetchInto(id, att.url, logger);
        }
        if (ids.length > 0) {
            this.save();
        }
        return ids;
    }
    /** 下载到库（同 ID 并发去重） */
    fetchInto(id, url, logger) {
        if (this.downloading.has(id))
            return this.downloading.get(id);
        const job = (async () => {
            try {
                const buf = await download(url, MAX_BYTES);
                const mime = sniffImage(buf);
                if (!mime)
                    throw new Error('not an image');
                const e = this.entries.get(id);
                if (!e)
                    return false;
                const file = `${id}.${EXT_BY_MIME[mime]}`;
                await writeFile(join(STICKER_DIR, file), buf);
                e.file = file;
                e.mime = mime;
                e.size = buf.length;
                this.save();
                return true;
            }
            catch (err) {
                logger?.debug?.(`im-qqbot: 表情包下载失败 ${id}: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
            finally {
                this.downloading.delete(id);
            }
        })();
        this.downloading.set(id, job);
        return job;
    }
    /** 用视觉模型给一张图打标签；返回解析结果 */
    async tagOne(ctx, route, id) {
        const e = this.entries.get(id);
        const path = this.filePath(id);
        if (!e || !path || !existsSync(path))
            throw new Error('文件不存在');
        const text = await callLite(ctx, route, TAG_PROMPT, { imagePath: path, maxTokens: 400, timeoutMs: 60_000 });
        const j = parseJsonLoose(text);
        if (!j)
            throw new Error(`无法解析标签: ${text.slice(0, 80)}`);
        e.isSticker = j.isSticker !== false;
        e.desc = String(j.desc ?? '').slice(0, 120);
        e.text = String(j.text ?? '').slice(0, 80);
        e.emotion = EMOTIONS.includes(j.emotion) ? j.emotion : '其他';
        e.tags = Array.isArray(j.tags) ? j.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 8) : [];
        if (e.source === 'web' && e.keyword) {
            const series = String(e.keyword).replace(/表情包|表情|梗图|\s+/g, '').trim();
            if (series && !e.tags.includes(series))
                e.tags = [series, ...e.tags].slice(0, 8);
        }
        e.tagged = true;
        e.tagError = undefined;
        if (e.isSticker === false)
            e.enabled = false;
        this.save();
        return e;
    }
    /** 批量打标签（未打标签且已下载的） */
    async tagPending(ctx, route, limit, logger) {
        const pending = [...this.entries.values()]
            .filter((e) => !e.tagged && (e.tagFails ?? 0) < 3 && this.hasFile(e.id))
            .sort((a, b) => b.seenCount - a.seenCount)
            .slice(0, limit);
        let ok = 0;
        for (const e of pending) {
            try {
                await this.tagOne(ctx, route, e.id);
                ok += 1;
            }
            catch (err) {
                e.tagFails = (e.tagFails ?? 0) + 1;
                e.tagError = err instanceof Error ? err.message : String(err);
                logger?.warn?.(`im-qqbot: 表情包打标签失败 ${e.id}: ${e.tagError}`);
            }
        }
        if (pending.length > 0)
            this.save();
        return { tried: pending.length, ok };
    }
    /**
     * 从网址收录（网上搜集）：下载 → 去重 → 入库（未打标签）。
     * 为省 token 不当场调视觉模型：夜间统一打标签，判定不是表情包的会被清掉。
     */
    async addFromUrl(_ctx, _route, url, meta = {}, logger) {
        if (!/^https?:\/\//i.test(url))
            return { ok: false, error: '不是 http(s) 链接' };
        if (this.isFull())
            return { ok: false, error: `表情包库已满（${this.max} 张），不再新增` };
        let buf;
        try {
            buf = await download(url, MAX_BYTES);
        }
        catch (err) {
            return { ok: false, error: `下载失败: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (buf.length < MIN_BYTES)
            return { ok: false, error: '图片太小' };
        const mime = sniffImage(buf);
        if (!mime)
            return { ok: false, error: '不是图片' };
        const id = createHash('md5').update(buf).digest('hex').toUpperCase();
        if (this.entries.has(id))
            return { ok: false, error: '已在库中', id };
        const file = `${id}.${EXT_BY_MIME[mime]}`;
        writeFileSync(join(STICKER_DIR, file), buf);
        const t = now();
        this.entries.set(id, {
            id, file, mime, size: buf.length, width: 0, height: 0, source: 'web', origin: meta.page ?? url, url,
            keyword: meta.keyword, groups: {}, senders: [], firstSeen: t, lastSeen: t, seenCount: 0,
            tagged: false, enabled: true, sentCount: 0, lastSentAt: 0,
        });
        this.save();
        logger?.debug?.(`im-qqbot: 网上收录表情包 ${id}（待夜间打标签）`);
        return { ok: true, id, pendingTag: true };
    }
    isFull() {
        return this.entries.size >= this.max;
    }
    setMax(n) {
        const v = Math.floor(Number(n));
        if (Number.isFinite(v) && v >= 20)
            this.max = Math.min(5000, v);
    }
    /** 最近一次被使用的时间：小喵发过 / 群友发过 / 入库 */
    lastUsed(e) {
        return Math.max(e.lastSentAt || 0, e.lastSeen || 0, e.firstSeen || 0);
    }
    /** 按「最近最少使用」踢掉 n 张，返回实际删除数 */
    evictLRU(n) {
        const sorted = [...this.entries.values()].sort((a, b) => this.lastUsed(a) - this.lastUsed(b));
        let removed = 0;
        for (const e of sorted.slice(0, Math.max(0, n))) {
            if (this.remove(e.id))
                removed += 1;
        }
        return removed;
    }
    usable() {
        return [...this.entries.values()].filter((e) => e.enabled && e.tagged && e.isSticker !== false && this.hasFile(e.id));
    }
    /**
     * 按情绪 / 关键词挑一张；最近在该群发过的降权。返回 entry 或 undefined。
     */
    pick({ query = '', emotion = '', groupOpenid = '' } = {}) {
        const terms = String(query).split(/[\s,，、/]+/).map((s) => s.trim()).filter(Boolean);
        const t = now();
        const scored = [];
        for (const e of this.usable()) {
            let s = 0;
            if (emotion && e.emotion === emotion)
                s += 3;
            for (const term of terms) {
                if ((e.tags ?? []).some((tag) => tag === term))
                    s += 3;
                else if ((e.tags ?? []).some((tag) => tag.includes(term) || term.includes(tag)))
                    s += 2;
                if ((e.text ?? '').includes(term))
                    s += 2;
                if ((e.desc ?? '').includes(term))
                    s += 1;
                if (e.emotion === term)
                    s += 2;
            }
            if ((emotion || terms.length > 0) && s === 0)
                continue;
            // 群友常用的更「本地化」
            if (groupOpenid && e.groups?.[groupOpenid])
                s += Math.min(2, e.groups[groupOpenid] * 0.5);
            const recent = e.lastSentGroups?.[groupOpenid] ?? 0;
            if (recent && t - recent < 6 * 3_600_000)
                s -= 4;
            s += Math.random() * 1.5;
            scored.push({ e, s });
        }
        scored.sort((a, b) => b.s - a.s);
        const top = scored.slice(0, 4);
        if (top.length === 0)
            return undefined;
        return top[Math.floor(Math.random() * top.length)].e;
    }
/** 按标签 / 情绪精确挑：在所有匹配的里均匀随机（本群 6 小时内发过的尽量避开） */
    pickByTag(tag, groupOpenid = '') {
        const t0 = String(tag ?? '').trim();
        if (!t0)
            return undefined;
        const all = this.usable();
        let hits = all.filter((e) => e.emotion === t0 || (e.tags ?? []).includes(t0));
        if (!hits.length)
            hits = all.filter((e) => (e.tags ?? []).some((x) => x.includes(t0) || t0.includes(x)) || (e.text ?? '').includes(t0));
        if (!hits.length)
            return undefined;
        const t = now();
        const fresh = hits.filter((e) => !(groupOpenid && t - (e.lastSentGroups?.[groupOpenid] ?? 0) < 6 * 3_600_000));
        const pool = fresh.length ? fresh : hits;
        return pool[Math.floor(Math.random() * pool.length)];
    }
    /** 可用的标签 / 情绪及数量 */
    tagCounts(limit = 80) {
        const emo = new Map();
        const tags = new Map();
        for (const e of this.usable()) {
            emo.set(e.emotion, (emo.get(e.emotion) ?? 0) + 1);
            for (const x of e.tags ?? [])
                tags.set(x, (tags.get(x) ?? 0) + 1);
        }
        const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
        return { emotions: top(emo), tags: top(tags) };
    }
    markSent(id, groupOpenid) {
        const e = this.entries.get(id);
        if (!e)
            return;
        e.sentCount += 1;
        e.lastSentAt = now();
        if (groupOpenid) {
            e.lastSentGroups = e.lastSentGroups ?? {};
            e.lastSentGroups[groupOpenid] = e.lastSentAt;
        }
        this.save();
    }
    update(id, patch) {
        const e = this.entries.get(id);
        if (!e)
            return undefined;
        if (typeof patch.enabled === 'boolean')
            e.enabled = patch.enabled;
        if (Array.isArray(patch.tags))
            e.tags = patch.tags.map(String).filter(Boolean).slice(0, 8);
        if (typeof patch.emotion === 'string' && EMOTIONS.includes(patch.emotion))
            e.emotion = patch.emotion;
        if (patch.retag === true) {
            e.tagged = false;
            e.tagFails = 0;
        }
        this.save();
        return e;
    }
    remove(id) {
        const e = this.entries.get(id);
        if (!e)
            return false;
        this.entries.delete(id);
        if (e.file) {
            try {
                unlinkSync(join(STICKER_DIR, e.file));
            }
            catch { /* ignore */ }
        }
        this.save();
        return true;
    }
    /** 兜底：超过上限时按 LRU 删到上限 */
    prune() {
        if (this.entries.size > this.max)
            this.evictLRU(this.entries.size - this.max);
    }
    /** 清理：删除已判定非表情包的、下载失败超过 1 天的 */
    sweep() {
        const t = now();
        let removed = 0;
        for (const e of [...this.entries.values()]) {
            if (e.isSticker === false && (e.source === 'web' || e.probable !== false)) {
                this.remove(e.id);
                removed += 1;
            }
            else if (!e.file && t - e.firstSeen > 86_400_000) {
                this.remove(e.id);
                removed += 1;
            }
        }
        return removed;
    }
    /** 给判断模型看的库存摘要：常见情绪与标签 */
    summary(limit = 30) {
        const emo = new Map();
        const tags = new Map();
        for (const e of this.usable()) {
            emo.set(e.emotion, (emo.get(e.emotion) ?? 0) + 1);
            for (const tag of e.tags ?? [])
                tags.set(tag, (tags.get(tag) ?? 0) + 1);
        }
        const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);
        return { count: this.usable().length, emotions: top(emo), tags: top(tags) };
    }
    list() {
        return [...this.entries.values()].sort((a, b) => b.lastSeen - a.lastSeen).map((e) => ({
            ...e,
            hasFile: this.hasFile(e.id),
            bytes: (() => {
                try {
                    return e.file ? statSync(join(STICKER_DIR, e.file)).size : 0;
                }
                catch {
                    return 0;
                }
            })(),
        }));
    }
    stats() {
        const all = [...this.entries.values()];
        return {
            total: all.length,
            usable: this.usable().length,
            untagged: all.filter((e) => !e.tagged).length,
            web: all.filter((e) => e.source === 'web').length,
            group: all.filter((e) => e.source === 'group').length,
            sent: all.reduce((s, e) => s + e.sentCount, 0),
            max: this.max,
            full: this.isFull(),
            lastRefreshAt: this.lastRefreshAt || null,
        };
    }
}
//# sourceMappingURL=sticker-library.js.map
