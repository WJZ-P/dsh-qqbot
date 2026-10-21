/**
 * 群目录 — group_openid → { name, number, note } 的 KV 记录。
 *
 * QQ 官方机器人 API 不下发群名和群号，只给 group_openid；由主人在聊天中告诉机器人
 * （qqbot_group_directory 工具）或在面板中录入。存储：~/.dsh-qqbot/group-directory.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
const PATH = resolve(homedir(), '.dsh-qqbot', 'group-directory.json');
let cache = null;
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
function sanitize(v) {
    const out = {};
    for (const k of ['name', 'number', 'note']) {
        const s = typeof v[k] === 'string' || typeof v[k] === 'number' ? String(v[k]).trim().slice(0, 200) : '';
        if (s)
            out[k] = s;
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
export const GroupDirectory = {
    path: PATH,
    get(openid) {
        return load().get(openid);
    },
    list() {
        return [...load().entries()].map(([openid, v]) => ({ openid, ...v }));
    },
    /** 合并更新；字段传空字符串表示删除该字段 */
    set(openid, patch) {
        const map = load();
        const merged = { ...(map.get(openid) ?? {}) };
        for (const k of ['name', 'number', 'note']) {
            if (patch[k] === undefined)
                continue;
            const s = String(patch[k]).trim().slice(0, 200);
            if (s)
                merged[k] = s;
            else
                delete merged[k];
        }
        merged.updatedAt = Date.now();
        map.set(openid, merged);
        save();
        return merged;
    },
    remove(openid) {
        const ok = load().delete(openid);
        if (ok)
            save();
        return ok;
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
        if (!g)
            return `未登记群(${openid.slice(0, 8)}…)`;
        return [g.name, g.number ? `群号 ${g.number}` : ''].filter(Boolean).join(' · ') || `群(${openid.slice(0, 8)}…)`;
    },
};
//# sourceMappingURL=group-directory.js.map
