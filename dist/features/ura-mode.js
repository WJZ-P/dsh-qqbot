/**
 * 表 / 里模式 — 主人说「切换到里模式」时，把 private/ura-prompt.txt 原样插到 system prompt 最开头；
 * 说「切换到表模式」时去掉。全局生效（所有群和私聊），状态存 private/ura-mode.json，重启后保留。
 *
 * private/ 目录已 gitignore：prompt 文本属于主人私有，不进仓库、不对外展示。
 * 切换指令不进 LLM，由中间件直接截获并回一句确认；只认已验证主人（ctx.state.owner）。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const PRIVATE_DIR = fileURLToPath(new URL('../../private/', import.meta.url));
const PROMPT_FILE = join(PRIVATE_DIR, 'ura-prompt.txt');
const STATE_FILE = join(PRIVATE_DIR, 'ura-mode.json');
const URA_RE = /^(切换?到|切换成|切成|进入|开启)?里模式[。.!！~～]*$/;
const OMOTE_RE = /^((切换?到|切换成|切成|回到|进入|开启)?表模式|关闭里模式)[。.!！~～]*$/;
let mode = 'omote';
try {
    if (existsSync(STATE_FILE))
        mode = JSON.parse(readFileSync(STATE_FILE, 'utf8')).mode === 'ura' ? 'ura' : 'omote';
}
catch { /* ignore */ }
let cache = { mtime: -1, text: '' };
function decode(buf) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
    }
    catch {
        try {
            return new TextDecoder('gbk').decode(buf);
        }
        catch {
            return buf.toString('utf8');
        }
    }
}
/** 读取里模式 prompt（按 mtime 缓存；文件不存在返回空串） */
export function loadUraPrompt() {
    try {
        const st = statSync(PROMPT_FILE);
        if (st.mtimeMs !== cache.mtime)
            cache = { mtime: st.mtimeMs, text: decode(readFileSync(PROMPT_FILE)) };
        return cache.text;
    }
    catch {
        return '';
    }
}
export function getUraMode() {
    return mode;
}
export function setUraMode(next) {
    mode = next === 'ura' ? 'ura' : 'omote';
    try {
        mkdirSync(PRIVATE_DIR, { recursive: true });
        writeFileSync(STATE_FILE, JSON.stringify({ mode }), 'utf8');
    }
    catch { /* ignore */ }
    return mode;
}
/** 里模式开启时返回要插到最前面的 section，否则 undefined */
export function uraSection() {
    if (mode !== 'ura')
        return undefined;
    const text = loadUraPrompt();
    return text.trim() ? { name: 'qqbot:ura-prompt', order: -1000, text } : undefined;
}
/** 截获主人的「切换到里模式 / 表模式」指令（放在 contentSanitizer 之后） */
export function uraModeSwitch(bot, logger) {
    return async (ctx, next) => {
        const raw = typeof ctx.message.content === 'string' ? ctx.message.content : '';
        const text = raw.replace(/^(\s|<@!?[^>]*>)+/, '').trim();
        const wantUra = URA_RE.test(text);
        const wantOmote = !wantUra && OMOTE_RE.test(text);
        if ((!wantUra && !wantOmote) || ctx.state.owner !== true) {
            await next();
            return;
        }
        const msg = ctx.message;
        const isGroup = msg.kind === 'group';
        let reply;
        if (wantUra && !loadUraPrompt().trim()) {
            reply = '里模式的 prompt 文件不存在或为空，没法切换。';
        }
        else {
            const before = mode;
            setUraMode(wantUra ? 'ura' : 'omote');
            const label = mode === 'ura' ? '里模式' : '表模式';
            reply = before === mode ? `已经是${label}了。` : `已切换到${label}，下一条消息起生效。`;
            logger.info(`im-qqbot: 主人切换 ${before} → ${mode}`);
        }
        try {
            await bot.sendMarkdown({
                scope: isGroup ? 'group' : 'c2c',
                targetId: isGroup ? (msg.groupOpenid ?? msg.senderId) : msg.senderId,
                msgId: msg.messageId,
            }, reply);
        }
        catch (err) {
            logger.warn(`im-qqbot: 模式切换回复发送失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        ctx.stop('ura-mode');
    };
}
//# sourceMappingURL=ura-mode.js.map
