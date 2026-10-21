/**
 * qqbot_sticker 工具 — agent 在 QQ 会话中发表情包 / 查库 / 收录网上表情包。
 */
import { EMOTIONS, StickerLibrary } from "./sticker-library.js";
import { getActivePulse } from "./group-pulse.js";
import { pickCheapRoute } from "./llm-lite.js";
export const STICKER_TOOL_NAME = 'qqbot_sticker';
const DESCRIPTION = 'Use the sticker (表情包) library collected from group members and the web. '
    + 'action=send posts one sticker to the current QQ chat: pass `id`, or `emotion` and/or `query` keywords to pick a matching one. '
    + 'Use it sparingly, like a real group member — a sticker can replace a reply when a reaction says enough. '
    + 'action=search lists matching stickers (id, emotion, description). '
    + 'action=add_url saves a sticker image from an http(s) URL you found on the web (it is checked by a vision model; non-stickers are rejected). '
    + 'action=harvest (owner only) searches the web for `query` and saves a few stickers. Never draw or generate stickers yourself.';
export function registerStickerTool(ctx, manager, mediaSender, config, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，qqbot_sticker 工具未注册');
        return;
    }
    const lib = StickerLibrary.shared();
    tools.register({
        name: STICKER_TOOL_NAME,
        description: DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['send', 'search', 'add_url', 'harvest'] },
                id: { type: 'string', description: 'Sticker id (from search results) for action=send.' },
                emotion: { type: 'string', enum: EMOTIONS, description: 'Emotion to match for send/search.' },
                query: { type: 'string', description: 'Keywords (space separated) for send/search, or the web search query for harvest.' },
                url: { type: 'string', description: 'Image URL for action=add_url.' },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    error: { type: 'string' },
                    sent: { type: 'string' },
                    stickers: { type: 'array', items: { type: 'string' } },
                    added: { type: 'number' },
                    note: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                const text = v.error ? `表情包: ${v.error}` : v.sent ? `已发送表情包 ${v.sent}` : v.stickers ? `表情包:\n${v.stickers.join('\n')}` : `表情包库: ${v.note ?? ''}`;
                return [{ type: 'text', text }];
            },
        },
        async execute(args, exec) {
            const record = exec.agent !== undefined ? manager.findByAgent(exec.agent) : undefined;
            const fmt = (e) => `${e.id} · ${e.emotion} · ${(e.tags ?? []).join('/')} · ${(e.text ? `「${e.text}」` : '')}${(e.desc ?? '').slice(0, 40)}`;
            switch (args.action) {
                case 'search': {
                    const hits = [];
                    const seen = new Set();
                    for (let i = 0; i < 12 && hits.length < 8; i += 1) {
                        const e = lib.pick({ query: args.query, emotion: args.emotion, groupOpenid: record?.scope === 'group' ? record.peerId : '' });
                        if (!e)
                            break;
                        if (!seen.has(e.id)) {
                            seen.add(e.id);
                            hits.push(fmt(e));
                        }
                    }
                    return hits.length ? { ok: true, stickers: hits } : { ok: false, error: `库里没有匹配的（共 ${lib.usable().length} 张可用）` };
                }
                case 'send': {
                    if (record === undefined)
                        throw new Error('qqbot_sticker send 只能在 QQ 会话中使用');
                    const gid = record.scope === 'group' ? record.peerId : '';
                    const e = args.id ? lib.get(String(args.id).toUpperCase()) : lib.pick({ query: args.query, emotion: args.emotion, groupOpenid: gid });
                    if (!e || !lib.hasFile(e.id))
                        return { ok: false, error: '没有找到合适的表情包，那就不发了' };
                    await mediaSender.sendImage(record.replyTarget, { localPath: lib.filePath(e.id) });
                    lib.markSent(e.id, gid);
                    if (gid)
                        getActivePulse()?.push(gid, { at: Date.now(), bot: true, name: '小喵', text: '', stickerIds: [e.id] });
                    logger.info(`im-qqbot: qqbot_sticker 发送 ${e.id} → ${record.scope}:${record.peerId}`);
                    return { ok: true, sent: `${e.id}（${e.emotion}）`, note: '已经发出去了，不要再在文字里描述这张图。' };
                }
                case 'add_url': {
                    if (!args.url)
                        return { ok: false, error: '缺少 url' };
                    const route = await pickCheapRoute(manager, config.pulse?.judgeModel);
                    const r = await lib.addFromUrl(ctx, route, String(args.url), { keyword: args.query }, logger);
                    return r.ok ? { ok: true, added: 1, note: `已收录 ${r.id}：${r.emotion} ${r.tags.join('/')}` } : { ok: false, error: r.error };
                }
                case 'harvest': {
                    if (record !== undefined && record.lastSenderOwner !== true)
                        return { ok: false, error: '只有主人可以让我批量搜集表情包' };
                    const m = getActivePulse()?.maintenance;
                    if (!m)
                        return { ok: false, error: '水群模块未启用' };
                    const route = await pickCheapRoute(manager, config.pulse?.judgeModel);
                    const r = await m.harvest(route, { keywords: [String(args.query || '表情包')], perKeyword: 6 });
                    return { ok: true, added: r.added, note: `尝试 ${r.tried} 张，收录 ${r.added} 张${r.errors.length ? `；错误：${r.errors.join('; ')}` : ''}` };
                }
                default:
                    throw new Error(`未知 action: ${String(args.action)}`);
            }
        },
    });
    logger.info('im-qqbot: qqbot_sticker 工具已注册');
}
//# sourceMappingURL=sticker-tool.js.map
