/**
 * 回复后自动配表情包（纯代码，不经过模型）
 *
 * 旧做法是在消息里提示模型「补发一张表情包」，模型要多走一轮工具调用——
 * 每多一轮都要把整段上下文再喂一次，非常费 token。现在由插件：
 *   1. 收到消息时按 pulse.stickerChance 掷骰，记到 record.turnOut.autoSticker；
 *   2. 本轮文字发完后，按回复文字用关键词判断情绪，从库里挑一张，单独一条消息发出。
 * 模型本轮自己发过表情包（qqbot_sticker）就不再补。
 */
import { StickerLibrary } from './sticker-library.js';
import { getActivePulse } from './group-pulse.js';
let imageSender = null;
export function setAutoStickerSender(fn) {
    imageSender = fn;
}
/** 本轮开始：重置出站跟踪；roll=true 表示要配图，或传 { id } 指定某张 */
export function beginTurn(record, autoSticker = null) {
    record.turnOut = { text: '', pending: [], stickerSent: false, autoSticker };
}
export function rollSticker(config) {
    try {
        if (config?.pulse?.stickers === false)
            return false;
        const p = Number(config?.pulse?.stickerChance ?? 0.2);
        if (!(p > 0) || Math.random() >= p)
            return false;
        return StickerLibrary.shared().usable().length > 0;
    }
    catch {
        return false;
    }
}
const RULES = [
    [/哈哈|hhh|233|笑死|xswl|笑不活|乐死|绷不住/i, '大笑'],
    [/晚安|睡觉|睡了|好梦|困了/, '晚安'],
    [/早安|早上好|你好|嗨|hello|hi[~～!！]|来啦|在呢/i, '打招呼'],
    [/谢谢|感谢|多谢|辛苦/, '谢谢'],
    [/加油|冲鸭|冲呀|你可以的|稳了/, '加油'],
    [/呜呜|哭哭|泪目|呜哇/, '哭'],
    [/难过|伤心|心疼|可怜|抱抱/, '难过'],
    [/生气|气死|可恶|哼[！!]|过分/, '生气'],
    [/委屈|欺负/, '委屈'],
    [/害羞|脸红|才不是|讨厌啦|羞/, '害羞'],
    [/贴贴|喜欢|爱你|好可爱|可爱|❤|♡|蹭蹭/, '喜欢'],
    [/无语|服了|离谱|6{3,}|。。。|\.\.\.\.|……$/, '无语'],
    [/嫌弃|好恶心|噫/, '嫌弃'],
    [/震惊|卧槽|我靠|天哪|居然|竟然|！{2,}|!{2,}/, '震惊'],
    [/害怕|好可怕|吓/, '害怕'],
    [/困|好累|摸鱼|躺平|划水/, '摸鱼'],
    [/嘿嘿|厉害吧|得意|小意思|简单|搞定|那当然/, '得意'],
    [/[?？]\s*$|为什么|为啥|怎么回事|是吗/, '疑惑'],
    [/好的|没问题|对的|确实|是的|同意|赞|OK|ok|可以/, '赞同'],
];
export function detectEmotion(text) {
    const t = String(text ?? '').slice(-200);
    for (const [re, emo] of RULES)
        if (re.test(t))
            return emo;
    return '开心';
}
/** 本轮结束：等文字发完，再按需补一张表情包 */
export async function finishTurn(record, logger) {
    const out = record.turnOut;
    if (!out)
        return;
    record.turnOut = undefined;
    try {
        await Promise.allSettled(out.pending);
    }
    catch { /* ignore */ }
    if (!out.autoSticker || out.stickerSent || !out.text.trim() || !imageSender)
        return;
    try {
        const lib = StickerLibrary.shared();
        const gid = record.scope === 'group' ? record.peerId : '';
        let e = out.autoSticker.id ? lib.get(out.autoSticker.id) : undefined;
        if (!e || !lib.hasFile(e.id)) {
            const emotion = detectEmotion(out.text);
            e = lib.pickByTag(emotion, gid) ?? lib.pick({ groupOpenid: gid });
        }
        if (!e || !lib.hasFile(e.id))
            return;
        await new Promise((r) => setTimeout(r, 600 + Math.random() * 1400));
        await imageSender({ scope: record.replyTarget.scope, targetId: record.replyTarget.targetId, msgId: record.replyTarget.msgId }, { localPath: (await lib.sendPath(e.id)) ?? lib.filePath(e.id) });
        lib.markSent(e.id, gid);
        if (gid)
            getActivePulse()?.push(gid, { at: Date.now(), bot: true, name: '小喵', text: '', stickerIds: [e.id] });
        logger?.info?.(`im-qqbot: 自动配表情包 ${e.id}（${e.emotion}）→ ${record.scope}:${record.peerId.slice(0, 8)}`);
    }
    catch (err) {
        logger?.warn?.(`im-qqbot: 自动配表情包失败: ${err instanceof Error ? err.message : String(err)}`);
    }
}
//# sourceMappingURL=auto-sticker.js.map
