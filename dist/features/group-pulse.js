/**
 * 群聊「水群」引擎（替代关键词 + 随机冷却）
 *
 * 三层：
 *   1. 时机（零 token）：每条群消息重置该群的「间隙计时器」，聊天停顿 35~60s 后才考虑插话；
 *      再过一系列闸门：没睡觉、不在回复中、最近够热闹、距上次发言够久、配额未满、有足够新消息。
 *   2. 判断（便宜模型）：最近 ~30 条 + 群档案 + 表情包库存 → JSON {action, confidence, …}
 *   3. 行动：只发表情包（不调用主模型）/ 文字接话（注入群会话，由人设模型说）/ 复读（零 token）
 *
 * 活跃度（每群独立，0~1，默认 0.15「安静」）自动调节：
 *   - 有人 @ 机器人：上升（新面孔加得更多）；主动发言后 5 分钟内有人接话 / 叫它名字：上升；
 *   - 主动发言没人理：下降；随时间向基线衰减（约 9 小时半衰）。
 *   活跃度决定每小时/每天配额、最小间隔、判断门槛和复读概率。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { callLite, parseJsonLoose, pickCheapRoute } from "./llm-lite.js";
import { EMOTIONS, StickerLibrary } from "./sticker-library.js";
import { getActiveSleepClock } from "./sleep-clock.js";
import { GroupDirectory } from "./group-directory.js";
import { quotaBlocked, recordReply } from "./group-rate-limit.js";
import { beginTurn } from "./auto-sticker.js";
import { clearGroupHistory } from "./history-store.js";
import { NO_REPLY_TOKEN } from "./group-engage.js";
const STATE_PATH = join(homedir(), '.dsh-qqbot', 'group-pulse.json');
export const BASELINE = 0.15;
const MSG_TTL_MS = 4 * 60_000; // 群 msg_id 被动回复有效期约 5 分钟，留余量
const BUFFER_SIZE = 40;
export const DEFAULT_PULSE = {
    enabled: true,
    judgeModel: '',
    stickers: true,
    repeat: true,
    botNames: ['小喵'],
    harvestKeywords: ['甘城猫猫表情包', '猫猫表情包', 'Claude 表情包', '熊猫头表情包', '小猫咪表情包'],
    nightly: true,
    stickerMax: 500,
    stickerSize: 180,
    stickerRefreshDays: 14,
    stickerRefreshCount: 100,
};
export function normalizePulse(raw) {
    const p = { ...DEFAULT_PULSE, ...(raw ?? {}) };
    const arr = (v, d) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : d);
    return {
        enabled: p.enabled !== false,
        judgeModel: String(p.judgeModel ?? ''),
        stickers: p.stickers !== false,
        repeat: p.repeat !== false,
        botNames: arr(p.botNames, DEFAULT_PULSE.botNames),
        harvestKeywords: arr(p.harvestKeywords, DEFAULT_PULSE.harvestKeywords),
        nightly: p.nightly !== false,
        stickerSize: Math.max(0, Math.min(1024, Math.floor(Number(p.stickerSize ?? 180)) || 0)),
        stickerMax: Math.max(20, Math.min(5000, Math.floor(Number(p.stickerMax)) || 500)),
        stickerRefreshDays: Math.max(1, Math.min(90, Math.floor(Number(p.stickerRefreshDays)) || 14)),
        stickerRefreshCount: Math.max(0, Math.min(1000, Math.floor(Number(p.stickerRefreshCount ?? 100)))),
    };
}
export function levelOf(a) {
    return a < 0.3 ? '安静' : a < 0.6 ? '适中' : '活跃';
}
/** 活跃度 → 行为参数 */
export function paramsOf(a) {
    return {
        perHour: 1 + Math.floor(a * 5),
        perDay: 4 + Math.round(a * 36),
        minGapMin: Math.round(25 - 20 * a),
        minRecentMsgs: Math.max(2, 5 - Math.round(a * 3)),
        threshold: Number((0.75 - 0.35 * a).toFixed(2)),
        repeatProb: Number((0.25 + 0.45 * a).toFixed(2)),
    };
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const today = () => new Date().toLocaleDateString('sv-SE');
/** 唤起前缀（构造 GroupPulse 时从 config.triggerPrefixes 设置）；以前缀开头的消息视同 @ */
let triggerPrefixes = [];
function isAtBot(msg) {
    const head = String(msg.content ?? '').replace(/^(\s|<@!?[^>]*>)+/, '');
    if (triggerPrefixes.some((p) => p && head.startsWith(p)))
        return true;
    return msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
        || (Array.isArray(msg.mentions) && msg.mentions.some((m) => m?.is_you === true))
        || /<@!?[0-9A-F]{32}>/.test(String(msg.content ?? '')) && msg.raw?.mentions?.some?.((m) => m?.is_you === true);
}
/** 群消息 → 可读文本（去掉 @ 标记、QQ 表情转文字） */
export function readableText(content) {
    return String(content ?? '')
        .replace(/<@!?[0-9A-Za-z]+>/g, '')
        .replace(/<faceType=6[^>]*>/g, '')
        .replace(/<faceType=\d+,faceId="?\d+"?,ext="([^"]*)">/g, (_m, ext) => {
        try {
            const t = JSON.parse(Buffer.from(ext, 'base64').toString('utf8')).text;
            return t ? `[${t}]` : '[表情]';
        }
        catch {
            return '[表情]';
        }
    })
        .replace(/\s+/g, ' ')
        .trim();
}
let active = null;
export function getActivePulse() {
    return active;
}
export class GroupPulse {
    config;
    pulseCfg;
    manager;
    sender;
    ctx;
    logger;
    profiles;
    library = StickerLibrary.shared();
    state = { groups: {} };
    buffers = new Map();
    timers = new Map();
    pending = new Map();
    inflight = new Set();
    repeatDecided = new Map();
    saveTimer;
    decayTimer;
    judgeRoute;
    constructor({ ctx, config, manager, sender, logger, profiles }) {
        triggerPrefixes = Array.isArray(config.triggerPrefixes) ? config.triggerPrefixes : [];
        this.ctx = ctx;
        this.config = config;
        this.pulseCfg = normalizePulse(config.pulse);
        this.manager = manager;
        this.sender = sender;
        this.logger = logger;
        this.profiles = profiles;
        this.load();
        active = this;
    }
    get enabled() {
        return this.pulseCfg.enabled && !this.config.requireMention && this.config.groupEngage?.mode !== 'all';
    }
    // ── 持久化 ──
    load() {
        try {
            if (existsSync(STATE_PATH))
                this.state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
        }
        catch { /* ignore */ }
        this.state.groups = this.state.groups ?? {};
    }
    save() {
        if (this.saveTimer)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            try {
                mkdirSync(join(homedir(), '.dsh-qqbot'), { recursive: true });
                writeFileSync(`${STATE_PATH}.tmp`, JSON.stringify(this.state), 'utf8');
                renameSync(`${STATE_PATH}.tmp`, STATE_PATH);
            }
            catch { /* ignore */ }
        }, 2000);
        this.saveTimer.unref?.();
    }
    group(gid) {
        let g = this.state.groups[gid];
        if (!g) {
            g = this.state.groups[gid] = {
                activity: BASELINE, lastDecayAt: Date.now(), lastProactiveAt: 0, lastBotAt: 0, lastRepeatAt: 0,
                day: today(), dayCount: 0, hourHits: [], atUsers: {}, bumpHour: { at: 0, sum: 0 },
                stats: { proactive: 0, stickers: 0, texts: 0, repeats: 0, positive: 0, ignored: 0, judged: 0 },
                log: [], lastJudgeSeq: 0, seq: 0,
            };
        }
        if (g.day !== today()) {
            g.day = today();
            g.dayCount = 0;
        }
        return g;
    }
    adjust(gid, delta, why) {
        const g = this.group(gid);
        if (delta > 0) {
            const t = Date.now();
            if (t - g.bumpHour.at > 3_600_000)
                g.bumpHour = { at: t, sum: 0 };
            delta = Math.min(delta, Math.max(0, 0.25 - g.bumpHour.sum));
            g.bumpHour.sum += delta;
        }
        if (delta === 0)
            return;
        const before = g.activity;
        g.activity = clamp(g.activity + delta, 0.05, 1);
        if (levelOf(before) !== levelOf(g.activity))
            this.log(gid, 'level', `活跃度 ${levelOf(before)} → ${levelOf(g.activity)}（${why}）`);
        this.save();
    }
    decayAll() {
        const t = Date.now();
        for (const [gid, g] of Object.entries(this.state.groups)) {
            const hours = (t - (g.lastDecayAt ?? t)) / 3_600_000;
            if (hours < 0.25)
                continue;
            g.activity = BASELINE + (g.activity - BASELINE) * Math.pow(0.926, hours);
            g.lastDecayAt = t;
            void gid;
        }
        this.save();
    }
    log(gid, kind, text, extra) {
        const g = this.group(gid);
        const last = g.log[g.log.length - 1];
        if (kind === 'skip' && last?.kind === 'skip' && last.text === text) {
            last.at = Date.now();
            last.times = (last.times ?? 1) + 1;
        }
        else {
            g.log.push({ at: Date.now(), kind, text, ...(extra ?? {}) });
            if (g.log.length > 80)
                g.log.splice(0, g.log.length - 80);
        }
        this.save();
    }
    buffer(gid) {
        let b = this.buffers.get(gid);
        if (!b) {
            b = [];
            this.buffers.set(gid, b);
        }
        return b;
    }
    push(gid, entry) {
        const b = this.buffer(gid);
        const g = this.group(gid);
        g.seq += 1;
        b.push({ ...entry, seq: g.seq });
        if (b.length > BUFFER_SIZE)
            b.splice(0, b.length - BUFFER_SIZE);
    }
    // ── 生命周期 ──
    start() {
        this.decayAll();
        this.decayTimer = setInterval(() => this.decayAll(), 15 * 60_000);
        this.decayTimer.unref?.();
    }
    stop() {
        if (this.decayTimer)
            clearInterval(this.decayTimer);
        for (const t of this.timers.values())
            clearTimeout(t);
        this.timers.clear();
        if (active === this)
            active = null;
    }
    // ── 观察每条群消息（中间件，mentionGate 之前） ──
    middleware() {
        return async (mctx, next) => {
            try {
                this.observe(mctx.message);
            }
            catch (err) {
                this.logger.warn(`im-qqbot: pulse observe failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            await next();
        };
    }
    observe(msg) {
        if (msg.kind !== 'group' || !msg.groupOpenid)
            return;
        if (msg.author?.bot === true || msg.raw?.author?.bot === true)
            return;
        const gid = msg.groupOpenid;
        const g = this.group(gid);
        const stickerIds = this.pulseCfg.stickers ? this.library.observe(msg, this.logger) : [];
        const text = readableText(msg.content);
        const atBot = isAtBot(msg);
        const name = msg.senderName ?? msg.raw?.author?.username ?? msg.senderId.slice(0, 6);
        const otherImages = (msg.attachments ?? []).filter((a) => String(a.content_type ?? '').startsWith('image/')).length - stickerIds.length;
        this.push(gid, {
            at: Date.now(), msgId: msg.messageId, senderId: msg.senderId, name, text, stickerIds,
            images: Math.max(0, otherImages), atBot,
        });
        const lower = text.toLowerCase();
        const calledName = this.pulseCfg.botNames.some((n) => n && lower.includes(n.toLowerCase()));
        // 活跃度：@ 机器人（新面孔加得多）
        if (atBot) {
            const prev = g.atUsers[msg.senderId] ?? 0;
            this.adjust(gid, Date.now() - prev > 86_400_000 ? 0.06 : 0.025, `${name} @了小喵`);
            g.atUsers[msg.senderId] = Date.now();
            g.lastBotAt = Math.max(g.lastBotAt, Date.now()); // 即将回复，视为刚互动
        }
        else if (calledName) {
            this.adjust(gid, 0.01, `${name} 提到了小喵`);
        }
        // 主动发言后的反馈
        const p = this.pending.get(gid);
        if (p) {
            p.humanAfter += 1;
            const repeatedOurSticker = p.stickerId && stickerIds.includes(p.stickerId);
            if (atBot || calledName || repeatedOurSticker) {
                this.closeFeedback(gid, true, atBot ? `${name} @了小喵` : calledName ? `${name} 接了话` : `${name} 跟了表情包`);
            }
        }
        // 复读
        if (this.enabled && this.pulseCfg.repeat && !atBot)
            this.maybeRepeat(gid);
        // 间隙计时
        if (this.enabled)
            this.armGap(gid);
    }
    /** 机器人发出的文字（被 @ 回复 / 主动插话）记入缓冲，供判断参考 */
    onBotSent(gid, text) {
        const g = this.group(gid);
        g.lastBotAt = Date.now();
        const t = readableText(text).slice(0, 200);
        if (t)
            this.push(gid, { at: Date.now(), bot: true, name: this.pulseCfg.botNames[0] ?? '小喵', text: t, stickerIds: [] });
    }
    // ── 反馈 ──
    openFeedback(gid, kind, stickerId) {
        this.closeFeedback(gid, null);
        const timer = setTimeout(() => this.closeFeedback(gid, false), 5 * 60_000);
        timer.unref?.();
        this.pending.set(gid, { kind, at: Date.now(), humanAfter: 0, stickerId, timer });
    }
    closeFeedback(gid, positive, why = '') {
        const p = this.pending.get(gid);
        if (!p)
            return;
        clearTimeout(p.timer);
        this.pending.delete(gid);
        if (positive === null)
            return;
        const g = this.group(gid);
        if (positive) {
            g.stats.positive += 1;
            this.adjust(gid, 0.05, why || '有人接话');
            this.log(gid, 'feedback', `👍 ${why || '有人接话'}`);
        }
        else {
            g.stats.ignored += 1;
            const d = p.humanAfter > 0 ? -0.04 : -0.02;
            this.adjust(gid, d, '没人理');
            this.log(gid, 'feedback', p.humanAfter > 0 ? `没人理（群友继续聊了 ${p.humanAfter} 条）` : '发完后冷场了');
        }
    }
    // ── 复读 ──
    keyOf(e) {
        if (e.bot)
            return null;
        if (e.stickerIds.length === 1 && !e.text)
            return `S:${e.stickerIds[0]}`;
        if (e.stickerIds.length === 0 && e.images === 0 && e.text && e.text.length <= 30 && !e.text.startsWith('/') && !/\[表情\]|^\[.*\]$/.test(e.text))
            return `T:${e.text}`;
        return null;
    }
    maybeRepeat(gid) {
        if (quotaBlocked(gid, this.config))
            return;
        const b = this.buffer(gid);
        const last = b[b.length - 1];
        const key = last ? this.keyOf(last) : null;
        if (!key)
            return;
        let chain = 0;
        const senders = new Set();
        for (let i = b.length - 1; i >= 0; i -= 1) {
            const e = b[i];
            if (e.bot) {
                if (this.keyOf({ ...e, bot: false }) === key)
                    return; // 已经复读过
                break;
            }
            if (this.keyOf(e) !== key)
                break;
            chain += 1;
            senders.add(e.senderId);
        }
        if (chain < 2 || senders.size < 2)
            return;
        const decidedKey = `${gid}|${key}`;
        const decided = this.repeatDecided.get(decidedKey);
        if (decided && (decided.done || decided.chain >= chain))
            return;
        this.repeatDecided.set(decidedKey, { chain, done: false, at: Date.now() });
        if (this.repeatDecided.size > 200)
            this.repeatDecided.delete(this.repeatDecided.keys().next().value);
        const g = this.group(gid);
        if (this.isAsleep())
            return;
        if (Date.now() - g.lastRepeatAt < 10 * 60_000)
            return;
        const p = paramsOf(g.activity).repeatProb;
        const prob = chain >= 3 ? Math.min(0.9, p + 0.3) : p;
        if (Math.random() >= prob) {
            this.log(gid, 'skip', `复读机犹豫了一下（${Math.round(prob * 100)}%）`);
            return;
        }
        this.repeatDecided.set(decidedKey, { chain, done: true, at: Date.now() });
        g.lastRepeatAt = Date.now();
        recordReply(gid);
        const delay = 1500 + Math.random() * 3500;
        const target = { scope: 'group', targetId: gid, msgId: last.msgId };
        setTimeout(() => {
            void (async () => {
                try {
                    if (key.startsWith('S:')) {
                        const id = key.slice(2);
                        if (!this.library.hasFile(id)) {
                            await this.library.downloading.get(id);
                        }
                        const path = this.library.filePath(id);
                        if (!path || !existsSync(path))
                            throw new Error('表情包还没下载好');
                        await this.sender.sendImage(target, { localPath: (await this.library.sendPath(id)) ?? path });
                        this.library.markSent(id, gid);
                        this.push(gid, { at: Date.now(), bot: true, name: '小喵', text: '', stickerIds: [id] });
                    }
                    else {
                        const text = key.slice(2);
                        await this.sender.sendText(target, text);
                        this.push(gid, { at: Date.now(), bot: true, name: '小喵', text, stickerIds: [] });
                    }
                    g.stats.repeats += 1;
                    g.lastBotAt = Date.now();
                    this.log(gid, 'repeat', `复读了${key.startsWith('S:') ? '表情包' : `「${key.slice(2)}」`}（${chain} 连）`);
                }
                catch (err) {
                    this.log(gid, 'error', `复读失败: ${err instanceof Error ? err.message : String(err)}`);
                }
            })();
        }, delay).unref?.();
    }
    // ── 时机 ──
    armGap(gid) {
        const old = this.timers.get(gid);
        if (old)
            clearTimeout(old);
        const delay = 35_000 + Math.random() * 25_000;
        const t = setTimeout(() => {
            this.timers.delete(gid);
            void this.onGap(gid).catch((err) => this.log(gid, 'error', `判断失败: ${err instanceof Error ? err.message : String(err)}`));
        }, delay);
        t.unref?.();
        this.timers.set(gid, t);
    }
    isAsleep() {
        try {
            return getActiveSleepClock()?.isAsleep() === true;
        }
        catch {
            return false;
        }
    }
    gate(gid) {
        const g = this.group(gid);
        const prm = paramsOf(g.activity);
        const t = Date.now();
        const b = this.buffer(gid);
        const humans = b.filter((e) => !e.bot);
        const lastHuman = humans[humans.length - 1];
        if (!this.enabled)
            return 'disabled';
        if (this.isAsleep())
            return '睡觉中';
        const dir = GroupDirectory.get(gid);
        if (dir?.proactive === 'off')
            return null; // 本群关闭主动插话：静默跳过
        if (dir?.quietUntil && dir.quietUntil > t)
            return null; // 安静模式
        const mode = dir?.proactive ?? 'normal';
        const k = mode === 'less' ? 0.5 : mode === 'more' ? 2 : 1;
        const lim = { perHour: Math.max(1, Math.round(prm.perHour * k)), perDay: Math.max(1, Math.round(prm.perDay * k)), minGapMin: prm.minGapMin / k };
        if (quotaBlocked(gid, this.config))
            return null; // 回复额度已满：静默跳过（面板「群聊管理」可见 CD）
        if (this.inflight.has(gid))
            return '正在处理';
        const rec = this.manager.getSessionRecord?.('group', gid);
        if (rec?.busy)
            return '正在回复别人';
        if (!lastHuman || t - lastHuman.at > MSG_TTL_MS)
            return '消息太旧';
        const recent = humans.filter((e) => t - e.at < 10 * 60_000);
        if (recent.length < prm.minRecentMsgs)
            return null; // 不够热闹：静默跳过，不记日志
        const freshMsgs = humans.filter((e) => e.seq > g.lastJudgeSeq);
        if (freshMsgs.length < 3)
            return null;
        // 代码预筛（省判断模型 token）：新消息全是表情包 / 零碎短句、没人提问也没提到小喵 → 不值得判断
        const names = this.pulseCfg.botNames.map((n) => n.toLowerCase()).filter(Boolean);
        const worth = freshMsgs.some((e) => {
            const t = String(e.text ?? '');
            return e.atBot || /[?？]/.test(t) || t.replace(/\s/g, '').length >= 8 || names.some((n) => t.toLowerCase().includes(n));
        });
        if (!worth) {
            g.lastJudgeSeq = freshMsgs[freshMsgs.length - 1].seq;
            return null;
        }
        if (t - g.lastBotAt < 90_000)
            return '刚说过话';
        if (t - g.lastProactiveAt < lim.minGapMin * 60_000)
            return `冷却中（间隔 ${Math.round(lim.minGapMin)} 分钟）`;
        g.hourHits = g.hourHits.filter((x) => t - x < 3_600_000);
        if (g.hourHits.length >= lim.perHour)
            return `本小时已达上限 ${lim.perHour}`;
        if (g.dayCount >= lim.perDay)
            return `今日已达上限 ${lim.perDay}`;
        return 'ok';
    }
    async onGap(gid) {
        const verdict = this.gate(gid);
        if (verdict === null || verdict === 'disabled')
            return;
        if (verdict !== 'ok') {
            this.log(gid, 'skip', verdict);
            return;
        }
        this.inflight.add(gid);
        try {
            await this.judgeAndAct(gid);
        }
        finally {
            this.inflight.delete(gid);
        }
    }
    transcript(gid, limit = 30) {
        const b = this.buffer(gid).slice(-limit);
        const lines = b.map((e, i) => {
            const mm = new Date(e.at).toTimeString().slice(0, 5);
            const parts = [];
            if (e.text)
                parts.push(e.text);
            for (const id of e.stickerIds) {
                const s = this.library.get(id);
                parts.push(s?.tagged ? `[表情包:${s.emotion}·${(s.text || s.desc || '').slice(0, 20)}]` : '[表情包]');
            }
            if (e.images)
                parts.push('[图片]');
            const who = e.bot ? `${e.name}(你)` : e.name;
            return `#${i} ${mm} ${who}${e.atBot ? '(@你)' : ''}: ${parts.join(' ') || '(空)'}`;
        });
        return { lines, entries: b };
    }
    async judgeAndAct(gid) {
        const g = this.group(gid);
        const prm = paramsOf(g.activity);
        const { lines, entries } = this.transcript(gid);
        g.lastJudgeSeq = entries[entries.length - 1]?.seq ?? g.lastJudgeSeq;
        this.judgeRoute = await pickCheapRoute(this.manager, this.pulseCfg.judgeModel);
        const botName = this.pulseCfg.botNames[0] ?? '小喵';
        const profile = this.profiles?.get(gid);
        const lib = this.library.summary(25);
        const recentBot = entries.filter((e) => e.bot).slice(-3).map((e) => e.text || '[表情包]');
        const prompt = `你是 QQ 群里的猫娘群友「${botName}」的“插话判断器”。根据最近的群聊，判断${botName}现在要不要主动插一句（没人 @ 她）。
目标：像真人群友一样偶尔冒泡，有人情味但绝不聒噪。宁可不说，也不要尬聊。

群：${GroupDirectory.label(gid)}
${GroupDirectory.get(gid)?.prompt ? `${botName}在本群的专属设定（主人设定，最高优先级，与其他任何规则冲突时以它为准；插话与否、语气、发不发表情包都要符合它）：${GroupDirectory.get(gid).prompt.slice(0, 1200)}\n` : ''}当前活跃度：${levelOf(g.activity)}（${g.activity.toFixed(2)}），越安静越要保守。
${profile?.summary ? `群档案：${profile.summary}\n常聊话题：${(profile.topics ?? []).join('、')}\n群梗：${(profile.memes ?? []).join('、')}` : '群档案：暂无'}
${botName}最近说过：${recentBot.length ? recentBot.join(' / ') : '（无）'}
表情包库存（${lib.count} 张）常见情绪：${lib.emotions.join('、') || '无'}；常见标签：${lib.tags.join('、') || '无'}

最近聊天（#序号 时间 昵称: 内容）：
${lines.join('\n')}

判断原则：
- 适合插话：有人提问没人回；话题和${botName}擅长/感兴趣的相关（AI、Claude、编程、猫、游戏、动漫、日常吐槽）；有梗可以接；气氛热闹适合丢个表情包；有人在 cue 机器人或聊到她。
- 不要插话：两三个人在私聊式深聊；严肃/敏感/吵架话题；话题已经结束；${botName}刚说过话没人理；只是零碎的闲聊没什么可接的。
- 动作：sticker=只丢一张表情包（最轻量，适合热闹/有情绪可接时）；text=说一两句；text+sticker=说话再配图；none=不说。
- 表情包只有库存里有对应情绪/标签时才选 sticker。

只输出 JSON：{"topic":"群友在聊什么（10字内）","action":"none|sticker|text|text+sticker","replyTo":序号,"confidence":0到1,"reason":"一句话理由","angle":"如果说话，打算从什么角度说（一句）","emotion":"${EMOTIONS.slice(0, 22).join('|')} 之一","stickerQuery":"表情包关键词，空格分隔"}`;
        let raw;
        try {
            raw = await callLite(this.ctx, this.judgeRoute, prompt, { maxTokens: 400, timeoutMs: 60_000 });
        }
        catch (err) {
            this.log(gid, 'error', `判断模型调用失败: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        g.stats.judged += 1;
        const j = parseJsonLoose(raw);
        if (!j) {
            this.log(gid, 'error', `判断结果无法解析: ${raw.slice(0, 80)}`);
            return;
        }
        const conf = Number(j.confidence) || 0;
        const action = ['sticker', 'text', 'text+sticker'].includes(j.action) ? j.action : 'none';
        const head = `「${String(j.topic ?? '').slice(0, 20)}」${action} ${conf.toFixed(2)}/${prm.threshold}`;
        if (action === 'none' || conf < prm.threshold) {
            this.log(gid, 'pass', `不插话 ${head}：${String(j.reason ?? '').slice(0, 80)}`);
            return;
        }
        // 回复目标：replyTo 指向的人类消息，过期则用最新一条
        const idx = Number(j.replyTo);
        let target = Number.isInteger(idx) ? entries[idx] : undefined;
        if (!target || target.bot || !target.msgId || Date.now() - target.at > MSG_TTL_MS)
            target = [...entries].reverse().find((e) => !e.bot && e.msgId);
        if (!target || Date.now() - target.at > MSG_TTL_MS) {
            this.log(gid, 'skip', '可回复的消息已过期');
            return;
        }
        const replyTarget = { scope: 'group', targetId: gid, msgId: target.msgId };
        let sticker;
        if (action !== 'text' && this.pulseCfg.stickers) {
            sticker = this.library.pick({ query: j.stickerQuery, emotion: j.emotion, groupOpenid: gid });
        }
        const doText = action === 'text' || action === 'text+sticker' || (action === 'sticker' && !sticker && conf >= prm.threshold + 0.1);
        if (!doText && !sticker) {
            this.log(gid, 'pass', `想丢表情包但库里没有合适的 ${head}`);
            return;
        }
        g.lastProactiveAt = Date.now();
        g.hourHits.push(Date.now());
        recordReply(gid);
        g.dayCount += 1;
        g.stats.proactive += 1;
        this.log(gid, 'act', `${doText ? '插话' : '丢表情包'} ${head}：${String(j.reason ?? '').slice(0, 80)}`, { sticker: sticker?.id });
        if (doText) {
            g.stats.texts += 1;
            this.openFeedback(gid, 'text', sticker?.id);
            await this.proactiveTurn(gid, replyTarget, j, sticker, lines);
        }
        else if (sticker) {
            g.stats.stickers += 1;
            this.openFeedback(gid, 'sticker', sticker.id);
            await this.sendSticker(gid, replyTarget, sticker);
        }
        this.save();
    }
    async sendSticker(gid, target, sticker) {
        const path = this.library.filePath(sticker.id);
        if (!path)
            throw new Error('表情包文件不存在');
        await this.sender.sendImage(target, { localPath: (await this.library.sendPath(sticker.id)) ?? path });
        this.library.markSent(sticker.id, gid);
        this.group(gid).lastBotAt = Date.now();
        this.push(gid, { at: Date.now(), bot: true, name: this.pulseCfg.botNames[0] ?? '小喵', text: '', stickerIds: [sticker.id] });
    }
    /** 文字插话：注入群会话，由人设主模型说 */
    async proactiveTurn(gid, replyTarget, j, sticker, lines) {
        const senderId = this.buffer(gid).filter((e) => !e.bot).pop()?.senderId ?? gid;
        const record = await this.manager.getOrCreate('group', gid, senderId, replyTarget);
        record.lastSenderOwner = false;
        record.busy = true;
        // 配图由插件在文字发出后自动发送（不让模型再走一轮工具调用）
        beginTurn(record, sticker ? { id: sticker.id } : null);
        const body = ['[Chat history begins]', ...lines, '[Chat history ends]', '',
            `[Proactive turn] 你没有被 @。群友正在聊「${j.topic ?? ''}」，你决定自然地插一句（角度参考：${j.angle ?? '随意'}；可以针对 #${j.replyTo} 那条）。`,
            '要求：像群友一样口语化、简短（一两句），可以接梗、吐槽、补充信息；不要自我介绍、不要总结大家在聊什么、不要说“我注意到…”、不要用列表或标题。',
            '闲聊时可以用单独一行的 [SPLIT] 把话拆成两三条短消息连着发，更像真人（不必每次都拆）。',
            `仔细看完如果觉得插话不合适，只输出 ${NO_REPLY_TOKEN}。`].join('\n');
        try {
            record.agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }));
            clearGroupHistory(this.config.appId, gid);
            await record.agent.whenIdle();
        }
        finally {
            record.busy = false;
        }
    }
    // ── 面板 ──
    status() {
        const out = [];
        for (const [gid, g] of Object.entries(this.state.groups)) {
            const prm = paramsOf(g.activity);
            out.push({
                groupOpenid: gid,
                label: GroupDirectory.label(gid),
                activity: Number(g.activity.toFixed(3)),
                level: levelOf(g.activity),
                params: prm,
                todayCount: g.day === today() ? g.dayCount : 0,
                hourCount: g.hourHits.filter((x) => Date.now() - x < 3_600_000).length,
                lastProactiveAt: g.lastProactiveAt,
                stats: g.stats,
                profile: this.profiles?.get(gid) ?? null,
                log: g.log.slice(-40).reverse(),
                buffered: this.buffer(gid).length,
            });
        }
        out.sort((a, b) => b.activity - a.activity);
        return {
            enabled: this.enabled,
            reason: !this.pulseCfg.enabled ? '水群已关闭' : this.config.requireMention ? '需开启「接收所有群消息」' : this.config.groupEngage?.mode === 'all' ? '回复策略为「每条都回」' : '',
            judgeRoute: this.judgeRoute ?? null,
            asleep: this.isAsleep(),
            groups: out,
        };
    }
    resetGroup(gid) {
        const g = this.group(gid);
        g.activity = BASELINE;
        this.log(gid, 'level', '活跃度已手动重置为安静');
        this.save();
    }
}
//# sourceMappingURL=group-pulse.js.map
