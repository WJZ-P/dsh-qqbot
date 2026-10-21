/**
 * 水群后台维护（全部放在每晚睡眠时段，每天一次，白天不耗 token）：
 *   1. 用当天聊天记录生成 / 更新「群档案」（话题、群梗、群友特点）
 *   2. 表情包：每 stickerRefreshDays 天（默认 14）换一波——按最近最少使用踢掉最多 stickerRefreshCount 张
 *      （默认 100，只踢到能腾出空位为止），再去网上搜新的补上；其余夜晚库没满才少量补充；库满不新增
 *   3. 统一给未打标签的表情包打标签（视觉模型），判定不是表情包的清掉
 *   4. 清理下载失败的条目
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callLite, parseJsonLoose, pickCheapRoute, pickVisionRoute } from "./llm-lite.js";
import { StickerLibrary, setStickerSendSize } from "./sticker-library.js";
import { readableText } from "./group-pulse.js";
import { getActiveSleepClock } from "./sleep-clock.js";
import { GroupDirectory } from "./group-directory.js";
const PROFILE_PATH = join(homedir(), '.dsh-qqbot', 'group-profiles.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
export class GroupProfiles {
    data = {};
    constructor() {
        try {
            if (existsSync(PROFILE_PATH))
                this.data = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
        }
        catch { /* ignore */ }
    }
    get(gid) {
        return this.data[gid];
    }
    set(gid, profile) {
        this.data[gid] = profile;
        try {
            writeFileSync(`${PROFILE_PATH}.tmp`, JSON.stringify(this.data, null, 1), 'utf8');
            renameSync(`${PROFILE_PATH}.tmp`, PROFILE_PATH);
        }
        catch { /* ignore */ }
    }
}
/** Bing 图片搜索：返回原图 URL 列表（无需 key；解析页面里的 murl） */
export async function searchImages(query, limit = 12) {
    const out = [];
    // 1. 百度图片（中文表情包最全、接口稳定；middleURL 为百度缓存图，带 referer 可直接下载）
    try {
        const u = `https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&word=${encodeURIComponent(query)}&queryWord=${encodeURIComponent(query)}&pn=0&rn=30&ie=utf-8&oe=utf-8`;
        const resp = await fetch(u, { headers: { 'user-agent': UA, referer: 'https://image.baidu.com/' }, signal: AbortSignal.timeout(20_000) });
        if (resp.ok) {
            const text = await resp.text();
            let j;
            try {
                j = JSON.parse(text);
            }
            catch {
                j = JSON.parse(text.replace(/\\'/g, "'"));
            }
            for (const d of j.data ?? []) {
                const pic = d?.middleURL || d?.thumbURL;
                if (typeof pic === 'string' && /^https?:\/\//.test(pic) && !out.includes(pic))
                    out.push(pic);
            }
        }
    }
    catch { /* 回退 Bing */ }
    if (out.length >= limit)
        return out.slice(0, limit);
    // 2. Bing 对无 cookie 请求时常返回不含结果的精简页：换主机 / 重试几次
    const hosts = ['www.bing.com', 'cn.bing.com', 'www.bing.com'];
    let lastStatus = 0;
    for (const host of hosts) {
        const url = `https://${host}/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1&mkt=zh-CN`;
        let html = '';
        try {
            const resp = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(20_000) });
            lastStatus = resp.status;
            if (!resp.ok)
                continue;
            html = await resp.text();
        }
        catch {
            continue;
        }
        const add = (u) => {
            if (/^https?:\/\//.test(u) && !out.includes(u))
                out.push(u);
        };
        let m;
        const re1 = /murl&quot;:&quot;(.*?)&quot;/g;
        while ((m = re1.exec(html)) !== null)
            add(m[1].replace(/\\\//g, '/'));
        const re2 = /mediaurl=([^&"']+)/g;
        while ((m = re2.exec(html)) !== null) {
            try {
                add(decodeURIComponent(m[1]));
            }
            catch { /* ignore */ }
        }
        if (out.length > 0)
            break;
        await new Promise((r) => setTimeout(r, 1500));
    }
    if (out.length === 0 && lastStatus !== 200)
        throw new Error(`Bing HTTP ${lastStatus}`);
    // 偏好 gif/png/jpg 且来自常见表情包站点的放前面
    const score = (u) => (/\.(gif)(\?|$)/i.test(u) ? 2 : 0) + (/(doutula|fabiaoqing|soutula|sinaimg|hdslb|qpic|zhimg|biaoqing)/i.test(u) ? 2 : 0);
    return out.sort((a, b) => score(b) - score(a)).slice(0, limit);
}
export class PulseMaintenance {
    ctx;
    pulse;
    manager;
    store;
    logger;
    profiles;
    library = StickerLibrary.shared();
    timer;
    running = false;
    lastNightly = '';
    lastHarvest = null;
    constructor({ ctx, pulse, manager, store, logger, profiles }) {
        this.ctx = ctx;
        this.pulse = pulse;
        this.manager = manager;
        this.store = store;
        this.logger = logger;
        this.profiles = profiles;
        this.library.setMax(pulse.pulseCfg.stickerMax);
        setStickerSendSize(pulse.pulseCfg.stickerSize);
        try {
            this.lastNightly = readFileSync(join(homedir(), '.dsh-qqbot', 'pulse-nightly.txt'), 'utf8').trim();
        }
        catch { /* ignore */ }
    }
    async route() {
        return pickCheapRoute(this.manager, this.pulse.pulseCfg.judgeModel);
    }
    /** 打标签要看图：默认模型同组内能看图的模型 */
    async visionRoute() {
        return pickVisionRoute(this.manager, this.pulse.pulseCfg.judgeModel);
    }
    start() {
        const tick = () => {
            void this.tick().catch((err) => this.logger.warn(`im-qqbot: 水群维护失败: ${err instanceof Error ? err.message : String(err)}`));
        };
        const first = setTimeout(tick, 60_000);
        first.unref?.();
        this.timer = setInterval(tick, 10 * 60_000);
        this.timer.unref?.();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
    }
    async tick() {
        if (this.running)
            return;
        this.running = true;
        try {
            this.library.setMax(this.pulse.pulseCfg.stickerMax);
            const today = new Date().toLocaleDateString('sv-SE');
            const asleep = getActiveSleepClock()?.inWindow?.() === true;
            if (this.pulse.pulseCfg.nightly && asleep && this.lastNightly !== today) {
                this.lastNightly = today;
                try {
                    writeFileSync(join(homedir(), '.dsh-qqbot', 'pulse-nightly.txt'), today, 'utf8');
                }
                catch { /* ignore */ }
                await this.nightly();
            }
        }
        finally {
            this.running = false;
        }
    }
    async nightly() {
        this.logger.info('im-qqbot: 夜间维护开始');
        const route = await this.route();
        if (this.store) {
            const groups = this.store.activeGroupsSince(Date.now() - 36 * 3_600_000).filter((g) => g.count >= 15);
            for (const g of groups) {
                try {
                    await this.summarize(g.groupOpenid, route);
                }
                catch (err) {
                    this.logger.warn(`im-qqbot: 群档案生成失败 ${g.groupOpenid}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        if (this.pulse.pulseCfg.stickers) {
            try {
                await this.stickerRefresh(route);
            }
            catch (err) {
                this.logger.warn(`im-qqbot: 表情包换血/搜集失败: ${err instanceof Error ? err.message : String(err)}`);
            }
            try {
                const vroute = await this.visionRoute();
                this.logger.info(`im-qqbot: 夜间打标签使用模型 ${vroute.provider}/${vroute.model}`);
                const r = await this.library.tagPending(this.ctx, vroute, 400, this.logger);
                if (r.tried > 0)
                    this.logger.info(`im-qqbot: 夜间统一打标签 ${r.ok}/${r.tried}`);
            }
            catch (err) {
                this.logger.warn(`im-qqbot: 表情包打标签失败: ${err instanceof Error ? err.message : String(err)}`);
            }
            const removed = this.library.sweep();
            if (removed)
                this.logger.info(`im-qqbot: 表情包库清理 ${removed} 条`);
        }
        this.logger.info('im-qqbot: 夜间维护结束');
    }
    /** 用最近 36 小时聊天生成群档案（与旧档案合并） */
    async summarize(gid, route) {
        const rows = this.store.groupSince(gid, Date.now() - 36 * 3_600_000, 1500);
        const lines = rows.map((r) => {
            const t = readableText(r.content);
            const name = r.name || r.userOpenid.slice(0, 6);
            return `${name}: ${t || (r.atts ? '[图片/表情包]' : '')}`;
        }).filter((l) => !l.endsWith(': '));
        // 控制长度：保留最后 ~12000 字
        let text = lines.join('\n');
        if (text.length > 12000)
            text = text.slice(-12000);
        const old = this.profiles.get(gid);
        const prompt = `下面是 QQ 群「${GroupDirectory.label(gid)}」最近的聊天记录。请更新这个群的“群档案”，帮助群里的猫娘机器人“小喵”更像老群友。
${old ? `旧档案（合并更新，过时的去掉）：${JSON.stringify({ summary: old.summary, topics: old.topics, memes: old.memes, members: old.members })}` : ''}
聊天记录：
${text}

只输出 JSON：{"summary":"群的氛围和主要内容，2~3句","topics":["常聊话题，最多8个"],"memes":["群里的梗/口头禅/黑话，最多8个"],"members":{"昵称":"一句话特点（爱好/说话风格）"},"stickerKeywords":["适合这个群的表情包搜索词，3~5个，中文，如“甘城猫猫表情包”"]}
members 最多 10 人。不要编造记录里没有的东西。`;
        const raw = await callLite(this.ctx, route, prompt, { maxTokens: 1200, timeoutMs: 120_000 });
        const j = parseJsonLoose(raw);
        if (!j)
            throw new Error(`无法解析: ${raw.slice(0, 80)}`);
        const profile = {
            summary: String(j.summary ?? '').slice(0, 300),
            topics: (j.topics ?? []).map(String).slice(0, 8),
            memes: (j.memes ?? []).map(String).slice(0, 8),
            members: typeof j.members === 'object' && j.members ? Object.fromEntries(Object.entries(j.members).slice(0, 10).map(([k, v]) => [k, String(v).slice(0, 60)])) : {},
            stickerKeywords: (j.stickerKeywords ?? []).map(String).slice(0, 5),
            updatedAt: Date.now(),
            messages: rows.length,
        };
        this.profiles.set(gid, profile);
        this.logger.info(`im-qqbot: 群档案已更新 ${gid}: ${profile.summary.slice(0, 60)}`);
        return profile;
    }
    /** 表情包换血：到期则 LRU 踢旧 + 补新；未到期且库没满时少量补充 */
    async stickerRefresh(route) {
        const cfg = this.pulse.pulseCfg;
        const lib = this.library;
        lib.setMax(cfg.stickerMax);
        const now = Date.now();
        if (!lib.lastRefreshAt) {
            lib.lastRefreshAt = now; // 首次启用：从今天开始计时
            lib.save();
        }
        const due = now - lib.lastRefreshAt >= cfg.stickerRefreshDays * 86_400_000;
        if (due) {
            const n = cfg.stickerRefreshCount;
            // 只踢到能腾出 n 个空位为止（库还没满时不白踢）
            const evict = Math.min(n, Math.max(0, lib.entries.size + n - lib.max));
            const removed = evict ? lib.evictLRU(evict) : 0;
            lib.lastRefreshAt = now;
            lib.save();
            this.logger.info(`im-qqbot: 表情包换血：LRU 踢掉 ${removed} 张，准备补充最多 ${n} 张`);
            const room = Math.min(n, lib.max - lib.entries.size);
            if (room > 0)
                await this.harvest(route, { perKeyword: Math.ceil(room / 8), maxKeywords: 8, budget: room });
            return;
        }
        if (!lib.isFull())
            await this.harvest(route, { perKeyword: 4, maxKeywords: 4, budget: Math.min(16, lib.max - lib.entries.size) });
    }
    /** 网上搜集表情包（只下载入库，夜间统一打标签） */
    async harvest(route, { perKeyword = 4, maxKeywords = 4, keywords, budget = Infinity } = {}) {
        const pool = new Set(keywords ?? this.pulse.pulseCfg.harvestKeywords);
        if (!keywords) {
            for (const p of Object.values(this.profiles.data))
                for (const k of p.stickerKeywords ?? [])
                    pool.add(k);
        }
        // 轮换：每次挑 maxKeywords 个
        const all = [...pool];
        const start = (new Date().getDate() * 3) % Math.max(1, all.length);
        const chosen = keywords ? all : [...all.slice(start), ...all.slice(0, start)].slice(0, maxKeywords);
        const result = { at: Date.now(), keywords: chosen, added: 0, tried: 0, errors: [] };
        for (const kw of chosen) {
            if (result.added >= budget || this.library.isFull())
                break;
            let urls = [];
            try {
                urls = await searchImages(kw, perKeyword * 3);
            }
            catch (err) {
                result.errors.push(`${kw}: ${err instanceof Error ? err.message : String(err)}`);
                continue;
            }
            let added = 0;
            for (const u of urls) {
                if (added >= perKeyword || result.added >= budget || this.library.isFull())
                    break;
                result.tried += 1;
                const r = await this.library.addFromUrl(this.ctx, route, u, { keyword: kw }, this.logger);
                if (r.ok) {
                    added += 1;
                    result.added += 1;
                }
            }
        }
        this.lastHarvest = result;
        this.logger.info(`im-qqbot: 网上搜集表情包 ${result.added}/${result.tried}（${chosen.join('、')}）`);
        return result;
    }
}
//# sourceMappingURL=pulse-maintenance.js.map
