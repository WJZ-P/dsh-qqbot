/**
 * QQ 消息持久化（SQLite，自建表）
 *
 * 为什么不用 ctx.storageDomain：它是「key → 一份 JSON 文档」的 KV 存储，
 * 无法按群/按人/按时间段建索引；消息持久化需要关系型查询，故自建表。
 *
 * 驱动：node:sqlite（Node 内置、同步）。同步调用会在单语句期间阻塞 JS 线程，
 * QQ 消息量级（每群每天上限 ~1000 条）下可以忽略。
 *
 * 设计要点：
 * 1. raw 存完整原始事件 JSON——先存原文，再抽字段；列只为查询加速。
 * 2. msg_id UNIQUE + ON CONFLICT DO NOTHING——重复投递天然幂等。
 * 3. 时间存 INTEGER（unix 毫秒），显示时再转。
 * 4. 存的是 openid（每机器人独立），不是 QQ 号。
 */
import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
/** 默认数据库路径（与 model-prefs.json / media 同目录） */
export const DEFAULT_MESSAGE_DB_PATH = resolve(homedir(), '.dsh-qqbot', 'messages.db');
const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,
  msg_id       TEXT    NOT NULL UNIQUE,
  received_at  INTEGER NOT NULL,
  scene        TEXT    NOT NULL,
  group_openid TEXT,
  user_openid  TEXT    NOT NULL,
  content      TEXT,
  raw          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_group_time ON messages(group_openid, received_at);
CREATE INDEX IF NOT EXISTS idx_msg_user_time  ON messages(user_openid,  received_at);
CREATE INDEX IF NOT EXISTS idx_msg_time       ON messages(received_at);
`;
/** 加载内置 sqlite 驱动（同步；不可用时返回 null，而不是让插件整体加载失败） */
function loadSqlite() {
    try {
        const mod = process.getBuiltinModule?.('node:sqlite');
        return mod?.DatabaseSync ?? null;
    }
    catch {
        return null;
    }
}
function expandHome(path) {
    if (path === '~')
        return homedir();
    if (path.startsWith('~/') || path.startsWith('~\\'))
        return resolve(homedir(), path.slice(2));
    return resolve(path);
}
export class MessageStore {
    path;
    db;
    stmts;
    constructor(path) {
        const DatabaseSync = loadSqlite();
        if (DatabaseSync === null)
            throw new Error('当前 Node 运行时不支持 node:sqlite（需要 Node 22.5+）');
        this.path = path;
        mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        // 建连接后立刻执行：WAL 读写并发 / NORMAL 配合 WAL / 并发时等待而非立即 BUSY / 打开外键
        this.db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
`);
        this.db.exec(SCHEMA);
        const db = this.db;
        this.stmts = {
            insert: db.prepare(`INSERT INTO messages (msg_id, received_at, scene, group_openid, user_openid, content, raw)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(msg_id) DO NOTHING`),
            totals: db.prepare(`SELECT COUNT(*) AS total, MIN(received_at) AS firstAt, MAX(received_at) AS lastAt FROM messages`),
            groups: db.prepare(`SELECT group_openid AS groupOpenid, COUNT(*) AS count, COUNT(DISTINCT user_openid) AS users,
       MIN(received_at) AS firstAt, MAX(received_at) AS lastAt
FROM messages WHERE scene = 'group' AND group_openid IS NOT NULL
GROUP BY group_openid ORDER BY count DESC`),
            c2c: db.prepare(`SELECT user_openid AS userOpenid, COUNT(*) AS count, MIN(received_at) AS firstAt, MAX(received_at) AS lastAt
FROM messages WHERE scene = 'c2c'
GROUP BY user_openid ORDER BY count DESC`),
            others: db.prepare(`SELECT scene, COUNT(*) AS count FROM messages WHERE scene NOT IN ('group', 'c2c') GROUP BY scene`),
            recentGroup: db.prepare(`SELECT msg_id AS msgId, received_at AS receivedAt, user_openid AS userOpenid, content
FROM messages WHERE group_openid = ? ORDER BY received_at DESC LIMIT ?`),
            recentC2c: db.prepare(`SELECT msg_id AS msgId, received_at AS receivedAt, user_openid AS userOpenid, content
FROM messages WHERE scene = 'c2c' AND user_openid = ? ORDER BY received_at DESC LIMIT ?`),
            // SQLite 裸列语义：content/scene/group_openid 取自 MAX(received_at) 那一行
            senders: db.prepare(`SELECT user_openid AS userOpenid, scene, group_openid AS groupOpenid, MAX(received_at) AS lastAt, content, COUNT(*) AS count
FROM messages GROUP BY user_openid ORDER BY lastAt DESC LIMIT ?`),
            groupSince: db.prepare(`SELECT received_at AS receivedAt, user_openid AS userOpenid, content,
       json_extract(raw, '$.author.username') AS name, json_array_length(raw, '$.attachments') AS atts
FROM messages WHERE group_openid = ? AND received_at >= ? ORDER BY received_at ASC LIMIT ?`),
            activeGroups: db.prepare(`SELECT group_openid AS groupOpenid, COUNT(*) AS count FROM messages
WHERE scene = 'group' AND group_openid IS NOT NULL AND received_at >= ? GROUP BY group_openid`),
            deleteGroup: db.prepare(`DELETE FROM messages WHERE group_openid = ?`),
            deleteC2c: db.prepare(`DELETE FROM messages WHERE scene = 'c2c' AND user_openid = ?`),
            deleteOlder: db.prepare(`DELETE FROM messages WHERE received_at < ?`),
            deleteAll: db.prepare(`DELETE FROM messages`),
        };
    }
    /** 由插件 Config 打开存储；disabled 返回 null */
    static open(options) {
        if (options?.enabled === false)
            return null;
        const path = options?.path ? expandHome(options.path) : DEFAULT_MESSAGE_DB_PATH;
        return new MessageStore(path);
    }
    /** 将 SDK 入站消息归一为一行记录 */
    static recordOf(msg, receivedAt = Date.now()) {
        const msgId = typeof msg?.messageId === 'string' && msg.messageId.length > 0 ? msg.messageId : null;
        const userOpenid = typeof msg?.senderId === 'string' ? msg.senderId : '';
        if (msgId === null || userOpenid === '')
            return null;
        let raw;
        try {
            raw = JSON.stringify(msg.raw ?? msg);
        }
        catch {
            raw = '{}';
        }
        return {
            msgId,
            receivedAt,
            scene: String(msg.kind ?? 'unknown'),
            groupOpenid: msg.kind === 'group' ? (msg.groupOpenid ?? null) : null,
            userOpenid,
            content: typeof msg.content === 'string' ? msg.content : null,
            raw,
        };
    }
    /** 写入一条（重复 msg_id 为 no-op）；返回是否新增 */
    insert(r) {
        const result = this.stmts.insert.run(r.msgId, r.receivedAt, r.scene, r.groupOpenid, r.userOpenid, r.content, r.raw);
        return Number(result.changes) > 0;
    }
    /** 批量写入：必须包事务（每条 INSERT 默认各自一个事务、各自 fsync） */
    insertMany(records) {
        let added = 0;
        this.db.exec('BEGIN');
        try {
            for (const r of records)
                if (this.insert(r))
                    added += 1;
            this.db.exec('COMMIT');
        }
        catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
        return added;
    }
    sizeBytes() {
        let size = 0;
        for (const suffix of ['', '-wal', '-shm']) {
            try {
                size += statSync(this.path + suffix).size;
            }
            catch { /* 文件不存在 */ }
        }
        return size;
    }
    stats() {
        const totals = this.stmts.totals.get();
        return {
            path: this.path,
            sizeBytes: this.sizeBytes(),
            total: Number(totals?.total ?? 0),
            firstAt: totals?.firstAt ?? null,
            lastAt: totals?.lastAt ?? null,
            groups: this.stmts.groups.all().map(normalizeRow),
            c2c: this.stmts.c2c.all().map(normalizeRow),
            others: this.stmts.others.all().map(normalizeRow),
        };
    }
    /** 最近发言人（面板选择「主人」用） */
    senders(limit = 30) {
        const n = Math.max(1, Math.min(200, Math.floor(limit) || 30));
        return this.stmts.senders.all(n).map(normalizeRow);
    }
    /** 某群某时刻之后的消息（群档案总结用） */
    groupSince(groupOpenid, sinceMs, limit = 1500) {
        return this.stmts.groupSince.all(groupOpenid, sinceMs, limit).map(normalizeRow);
    }
    activeGroupsSince(sinceMs) {
        return this.stmts.activeGroups.all(sinceMs).map(normalizeRow);
    }
    recent(scene, id, limit = 20) {
        const n = Math.max(1, Math.min(200, Math.floor(limit) || 20));
        const stmt = scene === 'group' ? this.stmts.recentGroup : this.stmts.recentC2c;
        return stmt.all(id, n).map(normalizeRow);
    }
    /**
     * 清理消息。
     * @param target group / c2c 按会话；older 按时间；all 全部
     */
    clear(target) {
        let result;
        switch (target.kind) {
            case 'group':
                result = this.stmts.deleteGroup.run(target.id);
                break;
            case 'c2c':
                result = this.stmts.deleteC2c.run(target.id);
                break;
            case 'older':
                result = this.stmts.deleteOlder.run(Date.now() - target.days * 86_400_000);
                break;
            case 'all':
                result = this.stmts.deleteAll.run();
                break;
            default:
                throw new TypeError('unknown clear target');
        }
        const deleted = Number(result.changes);
        if (deleted > 0)
            this.compact();
        return deleted;
    }
    /** 回收空间：截断 WAL 并 VACUUM（删除后文件不会自动变小） */
    compact() {
        try {
            this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
            this.db.exec('VACUUM;');
        }
        catch { /* 并发读时 VACUUM 可能失败，下次再试即可 */ }
    }
    close() {
        try {
            this.db.close();
        }
        catch { /* 已关闭 */ }
    }
}
/** node:sqlite 的 INTEGER 可能是 number/bigint；统一为 number，且去掉 null 原型 */
function normalizeRow(row) {
    const out = {};
    for (const [k, v] of Object.entries(row))
        out[k] = typeof v === 'bigint' ? Number(v) : v;
    return out;
}
/**
 * 入站消息落库中间件：放在去重之后、访问控制/门控之前，
 * 保证所有收到的消息（含未 @bot、被限流的）都被记录。
 * 存储失败只记日志，绝不阻断消息链。
 */
export function messageRecorder(store, logger) {
    return async (mCtx, next) => {
        try {
            const record = MessageStore.recordOf(mCtx.message, mCtx.receivedAt ?? Date.now());
            if (record !== null)
                store.insert(record);
        }
        catch (err) {
            logger.warn?.(`消息落库失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        await next();
    };
}
