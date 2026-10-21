/**
 * 轻量 LLM 调用（不建 agent 会话）：用于水群判断、表情包打标签、群档案总结。
 * 直接走 ctx.get('llm').stream，单条 user message，收集文本。
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
export function sniffImage(bytes) {
    if (bytes.length < 12)
        return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
        return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return 'image/jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38)
        return 'image/gif';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
        return 'image/webp';
    return null;
}
const CHEAP = [/haiku/i, /flash/i, /mini/i, /lite/i, /small/i];
/**
 * 选「判断用」的便宜模型：配置 provider/model 优先，否则从可用模型里按 haiku/flash/mini 挑，最后兜底默认模型。
 */
export async function pickCheapRoute(manager, configured) {
    const raw = String(configured ?? '').trim();
    if (raw.includes('/')) {
        const i = raw.indexOf('/');
        return { provider: raw.slice(0, i), model: raw.slice(i + 1) };
    }
    let models = [];
    try {
        models = await manager.listAvailableModels();
    }
    catch { /* ignore */ }
    if (raw) {
        const hit = models.find((m) => m.id === raw || m.name === raw);
        if (hit)
            return { provider: hit.provider, model: hit.id };
    }
    for (const re of CHEAP) {
        const hit = models.find((m) => re.test(m.id) || re.test(m.name ?? ''));
        if (hit)
            return { provider: hit.provider, model: hit.id };
    }
    return manager.modelResolver.resolveDefault();
}
async function saveImage(attachments, data, mediaType, name) {
    if (typeof attachments.saveImage === 'function')
        return attachments.saveImage({ data, mediaType, name });
    const refs = await attachments.saveImages([{ data, mediaType, name }]);
    return refs[0];
}
/**
 * 调一次模型，返回纯文本。
 * @param opts.imagePath 可选：附带一张本地图片（表情包打标签用）
 */
export async function callLite(ctx, route, prompt, opts = {}) {
    const llm = ctx.get('llm');
    if (!llm?.stream)
        throw new Error('llm 服务不可用');
    const content = [];
    if (opts.imagePath) {
        const attachments = ctx.get('attachments');
        if (!attachments)
            throw new Error('attachments 服务不可用');
        const data = new Uint8Array(await readFile(opts.imagePath));
        const mediaType = sniffImage(data);
        if (!mediaType)
            throw new Error('不支持的图片格式');
        const ref = await saveImage(attachments, data, mediaType, basename(opts.imagePath));
        content.push({ type: 'image', attachment: ref });
    }
    content.push({ type: 'text', text: prompt });
    const message = createUserMessage({ content, source: { kind: 'plugin', plugin: 'dsh-im-qqbot' } });
    const signal = AbortSignal.timeout(opts.timeoutMs ?? 90_000);
    const assembler = new BlockAssembler();
    for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [message],
        maxTokens: opts.maxTokens ?? 800,
        signal,
    })) {
        assembler.push(chunk);
    }
    const finish = assembler.finish;
    if (finish?.kind === 'error' || finish?.kind === 'aborted')
        throw new Error(finish.failure?.message ?? finish.kind);
    return assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
/** 从模型输出中宽松提取 JSON 对象 */
export function parseJsonLoose(text) {
    if (!text)
        return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start)
        return null;
    try {
        return JSON.parse(body.slice(start, end + 1));
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=llm-lite.js.map
