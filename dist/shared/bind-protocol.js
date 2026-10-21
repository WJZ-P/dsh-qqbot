/**
 * 端内绑定协议 —— 宿主路由与客户端面板的共享契约
 *
 * 类型与路径常量的唯一事实源：宿主（setup/bind-routes.ts）与浏览器
 * （client/bind-page.ts）各自 import，杜绝两端协议漂移。
 * 本模块必须保持纯类型 + 纯常量（零 node 依赖、零副作用），
 * 客户端 tsdown 构建会将其内联进 bundle。
 */
/** 状态查询（绑定页轮询） */
export const BIND_STATE_PATH = '/qqbot/im-qqbot/bind';
/** 刷新二维码（绑定页按钮） */
export const BIND_REFRESH_PATH = '/qqbot/im-qqbot/bind/refresh';
/** 手动填写/编辑凭据（绑定页表单） */
export const BIND_MANUAL_PATH = '/qqbot/im-qqbot/bind/manual';
/** 解绑：移除已保存凭据，回到绑定流程 */
export const BIND_UNBIND_PATH = '/qqbot/im-qqbot/bind/unbind';
/** 配置读写（设置面板表单） */
export const BIND_CONFIG_PATH = '/qqbot/im-qqbot/config';
/** 消息存储：统计（GET） */
export const MESSAGES_STATS_PATH = '/qqbot/im-qqbot/messages/stats';
/** 消息存储：会话最近消息预览（POST {scene,id,limit}） */
export const MESSAGES_RECENT_PATH = '/qqbot/im-qqbot/messages/recent';
/** 消息存储：清理（POST {kind:'group'|'c2c'|'older'|'all', id?, days?}） */
export const MESSAGES_CLEAR_PATH = '/qqbot/im-qqbot/messages/clear';
/** 最近发言人（GET） */
export const MESSAGES_SENDERS_PATH = '/qqbot/im-qqbot/messages/senders';
/** 睡眠状态（GET） */
export const SLEEP_STATUS_PATH = '/qqbot/im-qqbot/sleep/status';
/** 水群状态（GET） */
export const PULSE_STATUS_PATH = '/qqbot/im-qqbot/pulse/status';
/** 水群操作（POST {action:'reset'|'nightly'|'harvest'|'tag', groupOpenid?, query?}） */
export const PULSE_ACTION_PATH = '/qqbot/im-qqbot/pulse/action';
/** 表情包列表（GET） */
export const STICKERS_LIST_PATH = '/qqbot/im-qqbot/stickers/list';
/** 表情包图片（GET ?id=） */
export const STICKERS_FILE_PATH = '/qqbot/im-qqbot/stickers/file';
/** 表情包修改（POST {id, action:'enable'|'disable'|'delete'|'retag'}） */
export const STICKERS_UPDATE_PATH = '/qqbot/im-qqbot/stickers/update';
/** 群列表 + 群专属 prompt（GET 列表 / POST {groupOpenid, name?, number?, prompt?}） */
export const GROUPS_PATH = '/qqbot/im-qqbot/groups';
export const CAPABILITIES_PATH = '/qqbot/im-qqbot/capabilities';
export const MODELS_PATH = '/qqbot/im-qqbot/models';
//# sourceMappingURL=bind-protocol.js.map
