/**
 * 群目录 — group_openid → { name, number, note, prompt, rateLimit, memories } 的 KV 记录。
 *
 * QQ 官方机器人 API 不下发群名和群号，只给 group_openid；由主人在聊天中告诉机器人
 * （qqbot_group_directory 工具）或在面板「群聊管理」中录入。存储：~/.dsh-qqbot/group-directory.json
 *
 * - prompt：群专属职责/人设（最长 4000 字）
 * - rateLimit：本群每分钟最多回复次数；undefined = 用全局默认，0 = 不限
 * - proactive：主动插话档位 normal | less | more | off（缺省 normal）
 * - quietUntil：安静模式截止时间戳（期间不主动插话，@ 仍回复）
 * - memories：群记忆 [{ id, text, at, by: 'owner'|'member'|'panel' }]，最多 MEMORY_MAX 条
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
const PATH = resolve(homedir(), '.dsh-qqbot', 'group-directory.json');
let cache = null;
const FIELDS = ['name', 'number', 'note', 'prompt'];
export const GROUP_PROMPT_MAX = 4000;
export const MEMORY_MAX = 60;
export const MEMORY_TEXT_MAX = 300;
export const RATE_LIMIT_MAX = 600;
export const PROACTIVE_MODES = ['normal', 'less', 'more', 'off'];
export const QUIET_MAX_MIN = 7 * 24 * 60;
const maxLen = (k) => (k === 'prompt' ? GROUP_PROMPT_MAX : 200);
function load() {
    if (cache !== null)
        return cache;
    cache = new Map();
    try {
        if (existsSync(PATH)) {
            const data = JSON.parse(readFileSync(PATH, 'utf8'));
            for (const [openid, v] of Object.entries(data.groups ?? {})) {
                if (v && typeof v === 'object')
                    cache.set(openid, sanitize(v));
            }
        }
    }
    catch { /* 损坏文件按空处理 */ }
    return cache;
}
function sanitizeMemory(m) {
    if (!m || typeof m !== 'object' || typeof m.text !== 'string' || !m.text.trim())
        return null;
    return {
        id: typeof m.id === 'string' && m.id ? m.id : randomUUID().slice(0, 8),
        text: m.text.trim().slice(0, MEMORY_TEXT_MAX),
        at: typeof m.at === 'number' ? m.at : Date.now(),
        by: m.by === 'owner' || m.by === 'panel' ? m.by : 'member',
    };
}
function normRate(v) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 ? Math.min(RATE_LIMIT_MAX, n) : undefined;
}
function sanitize(v) {
    const out = {};
    for (const k of FIELDS) {
        const s = typeof v[k] === 'string' || typeof v[k] === 'number' ? String(v[k]).trim().slice(0, maxLen(k)) : '';
        if (s)
            out[k] = s;
    }
    const rate = v.rateLimit === undefined || v.rateLimit === null ? undefined : normRate(v.rateLimit);
    if (rate !== undefined)
        out.rateLimit = rate;
    if (PROACTIVE_MODES.includes(v.proactive) && v.proactive !== 'normal')
        out.proactive = v.proactive;
    if (typeof v.quietUntil === 'number' && v.quietUntil > Date.now())
        out.quietUntil = v.quietUntil;
    if (Array.isArray(v.memories)) {
        const mems = v.memories.map(sanitizeMemory).filter(Boolean).slice(-MEMORY_MAX);
        if (mems.length)
            out.memories = mems;
    }
    if (typeof v.updatedAt === 'number')
        out.updatedAt = v.updatedAt;
    return out;
}
function save() {
    try {
        mkdirSync(dirname(PATH), { recursive: true });
        writeFileSync(PATH, JSON.stringify({ groups: Object.fromEntries(load()) }, null, 2), 'utf8');
    }
    catch { /* 写失败不影响机器人 */ }
}
function touch(openid) {
    const map = load();
    const entry = { ...(map.get(openid) ?? {}) };
    entry.updatedAt = Date.now();
    map.set(openid, entry);
    return entry;
}
export const GroupDirectory = {
    path: PATH,
    get(openid) {
        return load().get(openid);
    },
    list() {
        return [...load().entries()].map(([openid, v]) => ({ openid, ...v }));
    },
    /** 合并更新；字段传空字符串表示删除该字段；rateLimit 传 null 表示恢复默认 */
    set(openid, patch) {
        const merged = touch(openid);
        for (const k of FIELDS) {
            if (patch[k] === undefined)
                continue;
            const s = String(patch[k]).trim().slice(0, maxLen(k));
            if (s)
                merged[k] = s;
            else
                delete merged[k];
        }
        if (patch.rateLimit !== undefined) {
            const r = patch.rateLimit === null || patch.rateLimit === '' ? undefined : normRate(patch.rateLimit);
            if (r === undefined)
                delete merged.rateLimit;
            else
                merged.rateLimit = r;
        }
        if (patch.proactive !== undefined) {
            if (patch.proactive === null || patch.proactive === 'normal' || !PROACTIVE_MODES.includes(patch.proactive))
                delete merged.proactive;
            else
                merged.proactive = patch.proactive;
        }
        if (patch.quietUntil !== undefined) {
            const q = Number(patch.quietUntil);
            if (patch.quietUntil === null || !Number.isFinite(q) || q <= Date.now())
                delete merged.quietUntil;
            else
                merged.quietUntil = Math.min(q, Date.now() + QUIET_MAX_MIN * 60_000);
        }
        save();
        return merged;
    },
    remove(openid) {
        const ok = load().delete(openid);
        if (ok)
            save();
        return ok;
    },
    /** 群记忆：新增（与已有内容完全相同则不重复） */
    addMemory(openid, text, by = 'member') {
        const mem = sanitizeMemory({ text, by });
        if (!mem)
            return { error: '记忆内容不能为空' };
        const entry = touch(openid);
        const list = [...(entry.memories ?? [])];
        const dup = list.find((m) => m.text === mem.text);
        if (dup)
            return { memory: dup, duplicate: true };
        list.push(mem);
        const dropped = list.length > MEMORY_MAX ? list.splice(0, list.length - MEMORY_MAX) : [];
        entry.memories = list;
        save();
        return { memory: mem, dropped: dropped.length };
    },
    /** 群记忆：修改文字 */
    updateMemory(openid, id, text) {
        const entry = load().get(openid);
        const m = entry?.memories?.find((x) => x.id === id);
        if (!m)
            return { error: `没有 id 为 ${id} 的记忆` };
        const t = String(text ?? '').trim().slice(0, MEMORY_TEXT_MAX);
        if (!t)
            return { error: '记忆内容不能为空' };
        m.text = t;
        m.at = Date.now();
        entry.updatedAt = Date.now();
        save();
        return { memory: m };
    },
    removeMemory(openid, id) {
        const entry = load().get(openid);
        const list = entry?.memories ?? [];
        const idx = list.findIndex((m) => m.id === id);
        if (idx < 0)
            return { error: `没有 id 为 ${id} 的记忆` };
        const [removed] = list.splice(idx, 1);
        if (list.length === 0)
            delete entry.memories;
        entry.updatedAt = Date.now();
        save();
        return { memory: removed };
    },
    clearMemories(openid) {
        const entry = load().get(openid);
        const n = entry?.memories?.length ?? 0;
        if (entry && n) {
            delete entry.memories;
            entry.updatedAt = Date.now();
            save();
        }
        return n;
    },
    memories(openid) {
        return load().get(openid)?.memories ?? [];
    },
    /** 按 openid / 群号 / 群名（精确优先，其次唯一子串）查找 */
    resolve(query) {
        const q = String(query ?? '').trim().toLowerCase();
        if (!q)
            return { error: '请提供群名、群号或 openid' };
        const all = this.list();
        const exact = all.filter((g) => g.openid.toLowerCase() === q || g.number === q || (g.name ?? '').toLowerCase() === q);
        if (exact.length === 1)
            return { group: exact[0] };
        const fuzzy = exact.length > 1 ? exact : all.filter((g) => (g.name ?? '').toLowerCase().includes(q) || g.openid.toLowerCase().startsWith(q));
        if (fuzzy.length === 1)
            return { group: fuzzy[0] };
        if (fuzzy.length > 1)
            return { error: `「${query}」匹配到多个群`, candidates: fuzzy };
        return { error: `群目录里没有「${query}」（先在那个群里让机器人登记群名/群号）` };
    },
    label(openid) {
        const g = load().get(openid);
        if (!g || (!g.name && !g.number))
            return `未登记群(${openid.slice(0, 8)}…)`;
        return [g.name, g.number ? `群号 ${g.number}` : ''].filter(Boolean).join(' · ');
    },
};
//# sourceMappingURL=group-directory.js.map
