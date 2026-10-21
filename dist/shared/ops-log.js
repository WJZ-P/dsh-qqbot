/**
 * 操作日志（复盘用）：~/.dsh-qqbot/logs/YYYY-MM-DD.log，每行一条 JSON。
 * - wrapLogger：插件 logger 的 info/warn/error 全部同时落盘
 * - opsLog(kind, data)：结构化事件（收消息、发消息/重试/降级、工具调用、模型替补……）
 * - 按月清理：每天检查一次，删除 30 天前的日志文件
 */
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const LOG_DIR = join(homedir(), '.dsh-qqbot', 'logs');
const KEEP_DAYS = 30;
let queue = Promise.resolve();
let dirReady = false;
const pad = (n) => String(n).padStart(2, '0');
function localStamp(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function write(entry) {
    const d = new Date();
    const file = join(LOG_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`);
    let line;
    try {
        line = JSON.stringify({ t: localStamp(d), ...entry });
    }
    catch {
        line = JSON.stringify({ t: localStamp(d), kind: entry.kind, msg: String(entry.msg ?? '') });
    }
    queue = queue.then(async () => {
        if (!dirReady) {
            await mkdir(LOG_DIR, { recursive: true });
            dirReady = true;
        }
        await appendFile(file, `${line}\n`, 'utf8');
    }).catch(() => { });
}
const clip = (v, n = 2000) => {
    if (typeof v === 'string')
        return v.length > n ? `${v.slice(0, n)}…(${v.length})` : v;
    return v;
};
/** 记录一条结构化操作事件 */
export function opsLog(kind, data = {}) {
    const out = { kind };
    for (const [k, v] of Object.entries(data))
        out[k] = clip(v);
    write(out);
}
/** 包一层 logger：原样输出，同时把 info/warn/error 写进日志文件 */
export function wrapLogger(logger) {
    if (!logger || logger.__opsWrapped)
        return logger;
    const wrapped = Object.create(logger);
    for (const level of ['info', 'warn', 'error']) {
        const orig = typeof logger[level] === 'function' ? logger[level].bind(logger) : undefined;
        wrapped[level] = (...args) => {
            try {
                write({ kind: 'log', level, msg: clip(args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) });
            }
            catch { /* ignore */ }
            return orig?.(...args);
        };
    }
    wrapped.debug = typeof logger.debug === 'function' ? logger.debug.bind(logger) : () => { };
    wrapped.__opsWrapped = true;
    return wrapped;
}
/** 删除 30 天前的日志；启动时一次，之后每天一次 */
export function startLogCleanup() {
    const run = async () => {
        try {
            const cutoff = Date.now() - KEEP_DAYS * 86400_000;
            for (const f of await readdir(LOG_DIR)) {
                const m = f.match(/^(\d{4})-(\d{2})-(\d{2})\.log$/);
                if (m && new Date(+m[1], +m[2] - 1, +m[3]).getTime() < cutoff)
                    await unlink(join(LOG_DIR, f)).catch(() => { });
            }
        }
        catch { /* 目录不存在等 */ }
    };
    void run();
    const t = setInterval(run, 86400_000);
    t.unref?.();
    return () => clearInterval(t);
}
//# sourceMappingURL=ops-log.js.map
