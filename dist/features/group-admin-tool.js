/**
 * qqbot_group_admin 工具 — 群管理（官方接口）+ 群调控（插件），只作用于当前群。
 *
 * 权限：
 * - 查询类（capabilities / status / group_info / bot_state / members / member / mute_status / blacklist list / join_requests）任何人触发都可。
 * - quiet（安静模式）任何人触发都可（只会让机器人少说话）。
 * - 其余写操作：config.groupAdmin.permission = 'owner'（默认）时只在主人触发的回合可用；
 *   = 'model' 时机器人可按本群职责自行判断（如刷屏自动禁言）。
 * - 永远不对主人执行禁言 / 移除 / 拉黑。
 */
import { GroupDirectory } from './group-directory.js';
import { CAPABILITIES, GroupAdminApi, PROACTIVE_MODES, PROACTIVE_TEXT, QUIET_MAX_MIN, RATE_LIMIT_MAX, describeBotState, explainApiError, pluginControls, resolveMember } from './group-admin.js';
export const GROUP_ADMIN_TOOL_NAME = 'qqbot_group_admin';
const READ_ACTIONS = new Set(['capabilities', 'status', 'group_info', 'bot_state', 'members', 'member', 'mute_status', 'join_requests']);
const DESCRIPTION = 'Manage and tune the CURRENT QQ group. Load the `qqbot-capabilities` skill first for details. '
    + 'Official QQ APIs (most need the bot to be a group admin; some are invite-only and fail with 11253): '
    + 'group_info, bot_state (bot role in group), members, member, mute (member + minutes), unmute, mute_status, '
    + 'recall (message_id or member="quoted"; only within 2 minutes), kick (members, optional blacklist), '
    + 'blacklist (op=list|add|del), join_requests, review_join (member, request_id, approve). '
    + 'Plugin controls: set_rate (per_minute replies cap, -1 = default), set_proactive (mode normal|less|more|off), '
    + 'quiet (minutes of no proactive chatting; 0 to end), status (current group settings), capabilities (full ability list). '
    + 'member may be a nickname seen in this group, an openid, "quoted" (sender of the quoted message) or "sender" (sender of the current message). '
    + 'Write actions other than quiet require an owner-triggered turn unless the owner enabled autonomous moderation.';
export function registerGroupAdminTool(ctx, { manager, bot, store, config, logger }) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，qqbot_group_admin 未注册');
        return null;
    }
    const api = new GroupAdminApi(bot);
    const owners = new Set(config.sleep?.ownerIds ?? []);
    const isOwner = (uid) => owners.has(uid);
    const autonomous = config.groupAdmin?.permission === 'model';
    tools.register({
        name: GROUP_ADMIN_TOOL_NAME,
        description: DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['capabilities', 'status', 'group_info', 'bot_state', 'members', 'member', 'mute', 'unmute', 'mute_status',
                        'recall', 'kick', 'blacklist', 'join_requests', 'review_join', 'set_rate', 'set_proactive', 'quiet'],
                },
                member: { type: 'string', description: 'Target member: nickname, openid, "quoted" or "sender".' },
                members: { type: 'array', items: { type: 'string' }, description: 'For kick / blacklist add|del: up to 20 members (same forms as member).' },
                minutes: { type: 'number', description: 'mute: duration in minutes (1–43200, max 30 days). quiet: minutes (0 ends quiet mode).' },
                message_id: { type: 'string', description: 'recall: message id. Omit and use member="quoted" to recall the quoted message, or member=<name> to recall that member\'s messages from the last 2 minutes.' },
                op: { type: 'string', enum: ['list', 'add', 'del'], description: 'blacklist operation.' },
                blacklist: { type: 'boolean', description: 'kick / review_join(decline): also add to group blacklist.' },
                request_id: { type: 'string', description: 'review_join: join_request_id from join_requests.' },
                approve: { type: 'boolean', description: 'review_join: true approve, false decline.' },
                reason: { type: 'string', description: 'review_join decline reason / why you act (logged).' },
                per_minute: { type: 'number', description: 'set_rate: max replies per minute in this group (0 = unlimited, -1 = back to the default).' },
                mode: { type: 'string', enum: ['normal', 'less', 'more', 'off'], description: 'set_proactive mode.' },
                cursor: { type: 'string', description: 'Paging cursor for members / blacklist / join_requests.' },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
                required: ['ok', 'message'],
                additionalProperties: false,
            },
            render: (_args, v) => [{ type: 'text', text: v.message }],
        },
        async execute(args, exec) {
            const record = exec.agent !== undefined ? manager.findByAgent(exec.agent) : undefined;
            if (record === undefined)
                throw new Error('qqbot_group_admin 只能在 QQ 会话中使用');
            const action = String(args.action);
            if (action === 'capabilities') {
                const lines = CAPABILITIES.map((c) => `- [${c.source === 'official' ? '官方' : '插件'}·${c.category}] ${c.name} — ${c.how}（权限：${c.requires}${c.note ? `；${c.note}` : ''}）`);
                return { ok: true, message: `我的能力清单：\n${lines.join('\n')}` };
            }
            if (record.scope !== 'group')
                return { ok: false, message: '群管理只能在群聊里使用' };
            const gid = record.peerId;
            const owner = record.lastSenderOwner === true;
            if (!READ_ACTIONS.has(action) && action !== 'quiet' && !(action === 'blacklist' && (args.op ?? 'list') === 'list')) {
                if (!owner && !autonomous)
                    return { ok: false, message: '这个操作只有主人能让我做（群管操作默认仅主人可用），请委婉拒绝。' };
            }
            const ctxMember = { gid, store, record, ownerCheck: isOwner };
            const resolveMany = (list) => {
                const ids = [];
                const names = [];
                for (const q of (Array.isArray(list) ? list : []).slice(0, 20)) {
                    const r = resolveMember(q, ctxMember);
                    if (r.error)
                        return { error: r.error };
                    if (r.member.isOwner)
                        return { error: '不能对主人做这个操作' };
                    ids.push(r.member.userOpenid);
                    names.push(r.member.name || r.member.userOpenid.slice(0, 8));
                }
                if (!ids.length)
                    return { error: '缺少 members' };
                return { ids, names };
            };
            const audit = (text) => logger.info(`im-qqbot: [群管] ${GroupDirectory.label(gid)} ${text}${args.reason ? `（理由：${String(args.reason).slice(0, 100)}）` : ''}${owner ? '（主人触发）' : ''}`);
            try {
                switch (action) {
                    case 'status': {
                        const c = pluginControls(gid, config);
                        let role = '';
                        try {
                            role = describeBotState(await api.botState(gid));
                        }
                        catch (err) {
                            role = `（机器人身份查询失败：${explainApiError(err)}）`;
                        }
                        return {
                            ok: true,
                            message: [
                                `群：${GroupDirectory.label(gid)}`,
                                `每分钟回复上限：${c.rateLimit === 0 ? '不限' : `${c.rateLimit} 次`}${c.rateCustom ? '' : '（默认）'}`,
                                `主动插话：${PROACTIVE_TEXT[c.proactive]}${c.quietUntil ? `；安静模式到 ${new Date(c.quietUntil).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}`,
                                `群记忆：${GroupDirectory.memories(gid).length} 条；专属职责：${GroupDirectory.get(gid)?.prompt ? '有' : '无'}`,
                                `群管操作权限：${autonomous ? '主人 + 我可自行判断' : '仅主人'}`,
                                role,
                            ].filter(Boolean).join('\n'),
                        };
                    }
                    case 'group_info': {
                        const i = await api.info(gid);
                        return { ok: true, message: `群名：${i.group_name}\n简介：${i.group_finger_memo || '（无）'}\n分类：${i.group_class_text || '（无）'}\n标签：${(i.group_tags ?? []).join('、') || '（无）'}\n人数：${i.group_member_num}` };
                    }
                    case 'bot_state':
                        return { ok: true, message: describeBotState(await api.botState(gid, true)) };
                    case 'members': {
                        const r = await api.members(gid, args.cursor ?? '');
                        const list = (r.members ?? []).map((m) => `- ${m.username}（${({ owner: '群主', admin: '管理员' })[m.member_role] ?? '成员'}${m.bot ? '·机器人' : ''}）`);
                        return { ok: true, message: `${list.join('\n') || '（空）'}${r.next_cursor ? `\n还有更多，cursor=${r.next_cursor}` : ''}` };
                    }
                    case 'member': {
                        const m = resolveMember(args.member, ctxMember);
                        if (m.error)
                            return { ok: false, message: m.error };
                        const i = await api.member(gid, m.member.userOpenid);
                        return { ok: true, message: `${i.username}：${({ owner: '群主', admin: '管理员' })[i.member_role] ?? '普通成员'}${i.bot ? '（机器人）' : ''}，入群于 ${new Date(i.joined_at).toLocaleDateString('zh-CN')}` };
                    }
                    case 'mute_status': {
                        const r = await api.muteStatus(gid);
                        const g = r.global_rule ?? {};
                        const mode = { none: '未开启全员禁言', always: '全员禁言中', schedule: '有定时/周期全员禁言' }[g.mode] ?? g.mode;
                        const ms = (r.members ?? []).map((m) => `- ${m.username || m.member_openid.slice(0, 8)} 到 ${new Date(m.mute_expire_at).toLocaleString('zh-CN', { hour12: false })}`);
                        return { ok: true, message: `${mode}\n被禁言：${ms.length ? `\n${ms.join('\n')}` : '无'}` };
                    }
                    case 'mute':
                    case 'unmute': {
                        const m = resolveMember(args.member, ctxMember);
                        if (m.error)
                            return { ok: false, message: m.error };
                        if (m.member.isOwner)
                            return { ok: false, message: '不能禁言主人' };
                        const who = m.member.name || m.member.userOpenid.slice(0, 8);
                        if (action === 'unmute') {
                            await api.setMute(gid, [{ op: 'del', member_openid: m.member.userOpenid, mute_expire_at: '' }]);
                            audit(`解除禁言 ${who}`);
                            return { ok: true, message: `已解除 ${who} 的禁言` };
                        }
                        const minutes = Math.round(Number(args.minutes ?? 10));
                        if (!(minutes >= 1 && minutes <= 43200))
                            return { ok: false, message: '禁言时长需在 1–43200 分钟（30 天）之间' };
                        const expire = new Date(Date.now() + minutes * 60_000).toISOString();
                        try {
                            await api.setMute(gid, [{ op: 'add', member_openid: m.member.userOpenid, mute_expire_at: expire }]);
                        }
                        catch (err) {
                            // 已在禁言中时 add 可能失败，改用 update 覆盖到期时间
                            await api.setMute(gid, [{ op: 'update', member_openid: m.member.userOpenid, mute_expire_at: expire }]).catch(() => { throw err; });
                        }
                        audit(`禁言 ${who} ${minutes} 分钟`);
                        return { ok: true, message: `已禁言 ${who} ${minutes} 分钟` };
                    }
                    case 'recall': {
                        let ids = [];
                        if (args.message_id)
                            ids = [String(args.message_id)];
                        else if (args.member === 'quoted') {
                            if (!record.lastQuote?.messageId)
                                return { ok: false, message: '本条消息没有引用要撤回的消息' };
                            ids = [record.lastQuote.messageId];
                        }
                        else if (args.member) {
                            const m = resolveMember(args.member, ctxMember);
                            if (m.error)
                                return { ok: false, message: m.error };
                            ids = (store?.recentFrom?.(gid, m.member.userOpenid, Date.now() - 120_000, 10) ?? []).map((x) => x.msgId);
                            if (!ids.length)
                                return { ok: false, message: '这个人 2 分钟内没有发过消息（超过 2 分钟的消息无法撤回）' };
                        }
                        else
                            return { ok: false, message: '要撤回哪条？给 message_id，或 member="quoted"（被引用的消息），或 member=昵称（撤回他 2 分钟内的消息）' };
                        let okN = 0;
                        const errs = [];
                        for (const id of ids) {
                            try {
                                await api.recall(gid, id);
                                okN++;
                            }
                            catch (err) {
                                errs.push(explainApiError(err));
                            }
                        }
                        audit(`撤回 ${okN}/${ids.length} 条消息`);
                        return { ok: okN > 0, message: okN ? `已撤回 ${okN} 条${errs.length ? `，${errs.length} 条失败：${errs[0]}` : ''}` : `撤回失败：${errs[0]}` };
                    }
                    case 'kick': {
                        const r = resolveMany(args.members ?? (args.member ? [args.member] : []));
                        if (r.error)
                            return { ok: false, message: r.error };
                        const res = await api.kick(gid, r.ids, args.blacklist === true);
                        audit(`移出 ${r.names.join('、')}${args.blacklist ? ' 并拉黑' : ''}`);
                        const fail = res?.add_to_member_blacklist_fail_openids ?? [];
                        return { ok: true, message: `已移出 ${r.names.join('、')}${args.blacklist ? (fail.length ? `，其中 ${fail.length} 人拉黑失败` : '，并已拉黑') : ''}` };
                    }
                    case 'blacklist': {
                        const op = args.op ?? 'list';
                        if (op === 'list') {
                            const r = await api.blacklist(gid, args.cursor ?? '');
                            const list = (r.users ?? []).map((u) => `- ${u.username}（${new Date(u.banned_at).toLocaleDateString('zh-CN')} 拉黑）`);
                            return { ok: true, message: `群黑名单：${list.length ? `\n${list.join('\n')}` : '空'}${r.next_cursor ? `\ncursor=${r.next_cursor}` : ''}` };
                        }
                        const r = resolveMany(args.members ?? (args.member ? [args.member] : []));
                        if (r.error)
                            return { ok: false, message: r.error };
                        const res = await api.setBlacklist(gid, op, r.ids);
                        audit(`${op === 'add' ? '拉黑' : '解除拉黑'} ${r.names.join('、')}`);
                        const fail = res?.fail_openids ?? [];
                        return { ok: fail.length < r.ids.length, message: `${op === 'add' ? '拉黑' : '解除拉黑'}：成功 ${r.ids.length - fail.length} 人${fail.length ? `，失败 ${fail.length} 人（拉黑只能针对已不在群里的人）` : ''}` };
                    }
                    case 'join_requests': {
                        const r = await api.joinRequests(gid, args.cursor ?? '');
                        const list = (r.list ?? []).map((j) => `- ${j.username}（member=${j.member_openid}，request_id=${j.join_request_id}）${j.apply_source === 'invited' ? '被邀请' : '主动申请'}；验证：${j.verify_info?.verify_message || (j.verify_info?.review_qa_list ?? []).map((x) => `${x.question}→${x.answer}`).join('；') || '无'}${j.risk_tips ? `；⚠️${j.risk_tips}` : ''}`);
                        return { ok: true, message: `入群申请：${list.length ? `\n${list.join('\n')}` : '没有待处理的申请'}${r.next_cursor ? `\ncursor=${r.next_cursor}` : ''}` };
                    }
                    case 'review_join': {
                        const uid = String(args.member ?? '').trim();
                        if (!/^[0-9A-F]{24,64}$/i.test(uid) || !args.request_id)
                            return { ok: false, message: '审批需要 member（申请人 openid）和 request_id，先用 join_requests 查' };
                        const body = { op: args.approve === false ? 'decline' : 'approve', join_request_id: String(args.request_id) };
                        if (body.op === 'decline') {
                            if (args.reason)
                                body.reject_reason = String(args.reason).slice(0, 100);
                            if (args.blacklist)
                                body.add_to_member_blacklist = true;
                        }
                        await api.reviewJoin(gid, uid, body);
                        audit(`${body.op === 'approve' ? '通过' : '拒绝'}入群申请 ${uid.slice(0, 8)}`);
                        return { ok: true, message: body.op === 'approve' ? '已通过入群申请' : `已拒绝入群申请${body.add_to_member_blacklist ? '并拉黑' : ''}` };
                    }
                    case 'set_rate': {
                        const v = args.per_minute;
                        if (!(Number.isInteger(v) && v >= -1 && v <= RATE_LIMIT_MAX))
                            return { ok: false, message: `per_minute 需为 0–${RATE_LIMIT_MAX} 的整数，或 -1 恢复默认` };
                        GroupDirectory.set(gid, { rateLimit: v === -1 ? null : v });
                        const c = pluginControls(gid, config);
                        audit(`每分钟回复上限 → ${c.rateLimit}`);
                        return { ok: true, message: `本群每分钟回复上限：${c.rateLimit === 0 ? '不限' : `${c.rateLimit} 次`}${c.rateCustom ? '' : '（默认）'}` };
                    }
                    case 'set_proactive': {
                        if (!PROACTIVE_MODES.includes(args.mode))
                            return { ok: false, message: 'mode 需为 normal / less / more / off' };
                        GroupDirectory.set(gid, { proactive: args.mode });
                        audit(`主动插话 → ${args.mode}`);
                        return { ok: true, message: `本群主动插话：${PROACTIVE_TEXT[args.mode]}（@ 和唤起前缀照常回复）` };
                    }
                    case 'quiet': {
                        const minutes = Math.round(Number(args.minutes ?? 30));
                        if (!(minutes >= 0 && minutes <= QUIET_MAX_MIN))
                            return { ok: false, message: `minutes 需在 0–${QUIET_MAX_MIN} 之间` };
                        GroupDirectory.set(gid, { quietUntil: minutes === 0 ? null : Date.now() + minutes * 60_000 });
                        audit(minutes ? `安静 ${minutes} 分钟` : '结束安静模式');
                        return { ok: true, message: minutes ? `好的，接下来 ${minutes} 分钟不主动插话（被 @ 还是会回）` : '安静模式已结束' };
                    }
                    default:
                        return { ok: false, message: `未知 action: ${action}` };
                }
            }
            catch (err) {
                logger.warn(`im-qqbot: [群管] ${action} 失败: ${err instanceof Error ? err.message : String(err)}`);
                return { ok: false, message: `${action} 失败：${explainApiError(err)}` };
            }
        },
    });
    logger.info('im-qqbot: qqbot_group_admin 工具已注册');
    return api;
}
//# sourceMappingURL=group-admin-tool.js.map
