/**
 * 群管理能力 — QQ 开放平台官方群接口 + 插件自带的群调控，统一封装。
 *
 * 官方接口（https://bot.q.qq.com/wiki/develop/api-v2/autogen/）：
 *   群信息 / 机器人群内状态 / 群成员 / 禁言 / 撤回 / 移除成员 / 黑名单 / 入群申请
 *   多数需要机器人是群管理员；部分接口仍在「内邀」阶段，未开通时返回 11253。
 * 插件能力：每分钟回复上限、主动插话档位、安静模式。
 *
 * 供 qqbot_group_admin 工具与面板路由共用。
 */
import { GroupDirectory, PROACTIVE_MODES, QUIET_MAX_MIN, RATE_LIMIT_MAX } from './group-directory.js';
import { rateStatus } from './group-rate-limit.js';
/** 能力目录：面板「能力」页与 skill 共用的事实来源 */
export const CAPABILITIES = [
    // ── 官方：消息 ──
    { id: 'reply', source: 'official', category: '消息', name: '收发文字 / Markdown', how: '直接回复', requires: '无', note: '被动回复需在用户消息后 5 分钟内；群主动消息每月有额度' },
    { id: 'media', source: 'official', category: '消息', name: '发送图片 / 视频 / 语音 / 文件', how: 'qqbot_send_file', requires: '无', note: '图片 20MB、视频 30MB 软上限，文件最大 200MB' },
    { id: 'recall', source: 'official', category: '消息', name: '撤回消息', how: 'qqbot_group_admin recall', requires: '撤回别人的消息需机器人是管理员', note: '只能撤回 2 分钟内的消息' },
    // ── 官方：群信息 ──
    { id: 'group_info', source: 'official', category: '群信息', name: '查询群名称 / 简介 / 人数', how: 'qqbot_group_admin group_info', requires: '无（个别账号需开通）', note: '未开通返回 11253' },
    { id: 'bot_state', source: 'official', category: '群信息', name: '查询机器人在群里的身份', how: 'qqbot_group_admin bot_state', requires: '无（个别账号需开通）', note: '返回 群主/管理员/成员、是否接收主动推送、消息接收模式' },
    { id: 'members', source: 'official', category: '群成员', name: '群成员列表 / 成员信息', how: 'qqbot_group_admin members / member', requires: '白名单（内邀）', note: '每页 30 人' },
    // ── 官方：群管 ──
    { id: 'mute', source: 'official', category: '群管', name: '禁言 / 解除禁言成员', how: 'qqbot_group_admin mute / unmute', requires: '机器人是管理员', note: '最长 30 天；不能禁言群主、管理员、机器人' },
    { id: 'mute_status', source: 'official', category: '群管', name: '查询禁言状态', how: 'qqbot_group_admin mute_status', requires: '机器人是管理员', note: '含全员禁言规则与被禁言名单' },
    { id: 'kick', source: 'official', category: '群管', name: '移出群成员（可同时拉黑）', how: 'qqbot_group_admin kick', requires: '管理员 + 白名单（内邀）', note: '单次最多 20 人' },
    { id: 'blacklist', source: 'official', category: '群管', name: '群黑名单查询 / 拉黑 / 解除', how: 'qqbot_group_admin blacklist', requires: '管理员 + 白名单（内邀）', note: '只能拉黑已不在群里的人' },
    { id: 'join_requests', source: 'official', category: '群管', name: '查看 / 审批入群申请', how: 'qqbot_group_admin join_requests / review_join', requires: '机器人是管理员', note: '可附带拒绝理由、同时拉黑' },
    // ── 插件 ──
    { id: 'rate', source: 'plugin', category: '调控', name: '回复额度（每分钟 / 每小时 / 每天）', how: 'qqbot_group_admin set_rate · 面板「群聊管理」', requires: '主人', note: '默认 10 / 100 / 200 次，超限进入 CD 并提示剩余时间，省 token；主人不受限' },
    { id: 'proactive', source: 'plugin', category: '调控', name: '主动插话档位（正常 / 少说 / 多说 / 关闭）', how: 'qqbot_group_admin set_proactive · 面板', requires: '主人', note: '只影响主动插话；@ 和唤起前缀照常回复' },
    { id: 'quiet', source: 'plugin', category: '调控', name: '安静模式（暂停主动插话 N 分钟）', how: 'qqbot_group_admin quiet', requires: '任何人', note: '群友说「小喵安静会儿」时用；最长 7 天' },
    { id: 'memory', source: 'plugin', category: '记忆', name: '群记忆', how: 'qqbot_group_memory', requires: '增改任何人；删主人条目/清空仅主人', note: '每群 60 条，每轮注入' },
    { id: 'global_prompt', source: 'plugin', category: '记忆', name: '修改总 prompt（全部群 / 全部私聊的人设与规则）', how: 'qqbot_global_prompt', requires: '仅主人', note: '查看 / 追加 / 替换 / 整段覆盖；下一条起生效，本轮后永久保存' },
    { id: 'duty', source: 'plugin', category: '记忆', name: '群登记与专属职责', how: 'qqbot_group_directory · 面板', requires: '主人', note: '群名 / 群号 / 本群 prompt' },
    { id: 'sticker', source: 'plugin', category: '互动', name: '表情包', how: 'qqbot_sticker', requires: '无', note: '收集群友表情包、按情绪发送' },
    { id: 'pulse', source: 'plugin', category: '互动', name: '水群引擎（主动插话 / 复读 / 群档案）', how: '自动', requires: '无', note: '按活跃度自适应频率' },
    { id: 'reminder', source: 'plugin', category: '工具', name: '定时提醒 / 定时任务', how: 'qqbot_reminder', requires: '一次性任何人（每人 ≤5 个）；重复任务仅主人', note: 'N 分钟后 / 某时刻 / 每天 / 每周 / 每 N 分钟；到点在原会话提醒或执行任务，重启不丢' },
    { id: 'search', source: 'plugin', category: '工具', name: '联网搜索', how: 'qqbot_web_search', requires: '无', note: 'DuckDuckGo → 搜狗，免费' },
    { id: 'model', source: 'plugin', category: '工具', name: '切换模型', how: 'qqbot_switch_model', requires: '主人', note: '按群 / 全部群 / 私聊' },
    { id: 'ask', source: 'plugin', category: '工具', name: '向用户提问（按钮）', how: 'ask', requires: '无', note: '' },
    { id: 'sleep', source: 'plugin', category: '作息', name: '夜间睡眠 / 主人叫醒', how: '自动', requires: '无', note: '默认 00:00–08:00' },
];
const ERR_HINTS = {
    11253: '该接口官方仍在内邀阶段，本机器人没有开通权限（需联系 QQ 开放平台申请白名单）',
    11703: '机器人不是这个群的管理员，需要群主把机器人设为管理员',
    40062003: '没有操作权限：机器人可能不是群管理员，或目标是群主/管理员',
    40064004: '消息已超过 2 分钟，无法撤回',
    40061001: '请求参数无效',
};
export function explainApiError(err) {
    const code = err?.bizCode;
    const hint = code !== undefined ? ERR_HINTS[Number(code)] : undefined;
    const base = err?.bizMessage || (err instanceof Error ? err.message : String(err));
    if (hint)
        return `${hint}（错误码 ${code}）`;
    if (err?.httpStatus === 403 || err?.httpStatus === 401)
        return `无权限（HTTP ${err.httpStatus}${code ? `，错误码 ${code}` : ''}）：${base}`;
    return `${base}${code ? `（错误码 ${code}）` : ''}`;
}
const enc = encodeURIComponent;
const isOpenid = (s) => /^[0-9A-F]{24,64}$/i.test(String(s ?? '').trim());
/** 官方接口封装（bot = QQBot 实例） */
export class GroupAdminApi {
    constructor(bot) {
        this.bot = bot;
        this.cache = new Map(); // `${kind}:${gid}` → { at, data }
    }
    get api() {
        return this.bot.api;
    }
    async cached(key, ttlMs, fn) {
        const hit = this.cache.get(key);
        if (hit && Date.now() - hit.at < ttlMs)
            return hit.data;
        const data = await fn();
        this.cache.set(key, { at: Date.now(), data });
        return data;
    }
    info(gid) { return this.cached(`info:${gid}`, 10 * 60_000, () => this.api.get(`/v2/groups/${enc(gid)}/info`)); }
    botState(gid, fresh = false) {
        if (fresh)
            this.cache.delete(`state:${gid}`);
        return this.cached(`state:${gid}`, 10 * 60_000, () => this.api.get(`/v2/groups/${enc(gid)}/bot_state`));
    }
    members(gid, cursor = '') { return this.api.get(`/v2/groups/${enc(gid)}/members`, { cursor }); }
    member(gid, uid) { return this.api.get(`/v2/groups/${enc(gid)}/members/${enc(uid)}`); }
    muteStatus(gid) { return this.api.get(`/v2/groups/${enc(gid)}/restrict_chat_setting`); }
    setMute(gid, items) { return this.api.post(`/v2/groups/${enc(gid)}/restrict_chat_setting`, { members: items }); }
    recall(gid, msgId) { return this.api.delete(`/v2/groups/${enc(gid)}/messages/${enc(msgId)}`); }
    kick(gid, uids, blacklist = false) { return this.api.post(`/v2/groups/${enc(gid)}/batch_remove_members`, { member_openids: uids, add_to_member_blacklist: blacklist }); }
    blacklist(gid, cursor = '') { return this.api.get(`/v2/groups/${enc(gid)}/member_blacklist`, { cursor, limit: 50 }); }
    setBlacklist(gid, op, uids) { return this.api.post(`/v2/groups/${enc(gid)}/member_blacklist`, { op, member_openids: uids }); }
    joinRequests(gid, cursor = '') { return this.api.get(`/v2/groups/${enc(gid)}/join_request_list`, { cursor, limit: 20 }); }
    reviewJoin(gid, uid, body) { return this.api.post(`/v2/groups/${enc(gid)}/approval_join_request/${enc(uid)}`, body); }
}
/** 把「昵称 / openid / quoted / sender」解析成成员 openid */
export function resolveMember(query, { gid, store, record, ownerCheck }) {
    const q = String(query ?? '').trim();
    if (!q)
        return { error: '缺少 member（可填昵称、openid、"quoted"=被引用消息的发送者、"sender"=本条消息的发送者）' };
    let found = null;
    if (q === 'quoted') {
        if (!record?.lastQuote?.senderId)
            return { error: '本条消息没有引用别人的消息' };
        found = { userOpenid: record.lastQuote.senderId, name: record.lastQuote.name || '' };
    }
    else if (q === 'sender') {
        if (!record?.lastSenderId)
            return { error: '不知道本条消息的发送者' };
        found = { userOpenid: record.lastSenderId, name: record.lastSenderName || '' };
    }
    else if (isOpenid(q)) {
        found = { userOpenid: q.toUpperCase(), name: '' };
    }
    else {
        let list = [];
        try {
            list = store?.groupMembers?.(gid) ?? [];
        }
        catch { /* ignore */ }
        const name = q.replace(/^@/, '').toLowerCase();
        const exact = list.filter((m) => String(m.name ?? '').toLowerCase() === name);
        const fuzzy = exact.length ? exact : list.filter((m) => String(m.name ?? '').toLowerCase().includes(name));
        if (fuzzy.length === 0)
            return { error: `本群消息记录里找不到昵称「${q}」（只认得在群里说过话的人；也可以让主人引用那个人的消息再说）` };
        if (fuzzy.length > 1)
            return { error: `「${q}」匹配到多个人：${fuzzy.slice(0, 8).map((m) => m.name).join('、')}，请说得更准确些` };
        found = { userOpenid: fuzzy[0].userOpenid, name: fuzzy[0].name ?? '' };
    }
    if (ownerCheck?.(found.userOpenid))
        found.isOwner = true;
    return { member: found };
}
const fmtTime = (iso) => {
    try {
        return new Date(iso).toLocaleString('zh-CN', { hour12: false });
    }
    catch {
        return String(iso);
    }
};
const roleText = { owner: '群主', admin: '管理员', member: '普通成员' };
const recvText = { all: '接收全部消息', only_mention: '只接收 @ 消息', mention_and_context: '接收 @ 及上下文' };
export function describeBotState(s) {
    if (!s)
        return '';
    return `身份：${roleText[s.member_role] ?? s.member_role}；${recvText[s.recv_msg_setting] ?? s.recv_msg_setting ?? ''}；主动推送：${s.allow_proactive_msg ? '允许' : '不允许'}；入群时间：${fmtTime(s.joined_at)}`;
}
/** 插件侧调控状态（给工具与面板） */
export function pluginControls(gid, config) {
    const d = GroupDirectory.get(gid) ?? {};
    const rs = rateStatus(gid, config);
    return {
        rateLimit: rs.limits.minute,
        rateCustom: rs.customs.minute,
        limits: rs.limits,
        customs: rs.customs,
        used: rs.used,
        cooldown: rs.cooldown,
        proactive: d.proactive ?? 'normal',
        quietUntil: d.quietUntil && d.quietUntil > Date.now() ? d.quietUntil : null,
    };
}
export const PROACTIVE_TEXT = { normal: '正常', less: '少说（频率减半）', more: '多说（频率加倍）', off: '关闭主动插话' };
export { PROACTIVE_MODES, QUIET_MAX_MIN, RATE_LIMIT_MAX };
//# sourceMappingURL=group-admin.js.map
