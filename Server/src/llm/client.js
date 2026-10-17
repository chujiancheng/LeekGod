/**
 * OpenAI 兼容 Chat Completions 客户端。
 * 只负责「一次请求 → 文本」；人设组装与 schema 解析在 prompt/schema 层。
 * 失败一律返回 {ok:false, error}，绝不抛到主循环。
 *
 * 2026-10-17 修订：
 * - `provider` 真正参与判定：只实现 OpenAI 兼容协议，配了别的 provider 直接关闭
 *   （此前注释说"未实现的 provider 走关闭"，代码里却照发请求）。
 * - `maxInputChars` 真正生效：超限**丢弃本次**并打 warn（此前只是配置里的空话，
 *   snapshot 一旦变大就会静默烧 token）。
 * - 429 / 5xx / 超时做一次短重试（`retry`，默认 1 次），减少"一轮决策白白空过"。
 * - 把 `finish_reason` 一并带回：推理模型的 reasoning 会先吃 max_tokens，
 *   content 被截断/掏空时上层需要据此判断是"超预算"还是"模型乱写"。
 */
const { logger } = require('../logger');

const PROVIDERS = new Set(['openai', 'openai-compatible']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 只有瞬时故障值得重试：429 / 5xx / 超时；4xx 参数错、鉴权错重试也没用 */
function retriable(error) {
  const s = String(error || '');
  return s === 'timeout' || /^http_(429|5\d\d)/.test(s);
}

async function once(cfg, url, apiKey, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) return { ok: false, error: `http_${res.status}:${raw.slice(0, 200)}` };
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'bad_json_body' };
    }
    const choice = data && data.choices && data.choices[0];
    const text = choice && choice.message ? String(choice.message.content || '') : '';
    const finish = (choice && choice.finish_reason) || '';
    // 推理模型把 max_tokens 先花在 reasoning 上：扣光了 content 就是空的。
    // 这种"成功但没内容"必须当成失败上报（带 usage），否则上层只能看到 no_json。
    if (!text.trim()) {
      return {
        ok: false,
        error: `empty_content:${finish || '-'}`,
        usage: data.usage || null,
        finish,
      };
    }
    return { ok: true, text, usage: data.usage || null, finish };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} cfg config.npc.llm
 * @param {{system: string, messages?: Array<{role:string,content:string}>, user?: string}} payload
 * @returns {Promise<{ok:boolean, text?:string, error?:string, usage?:object}>}
 */
async function chat(cfg, payload) {
  if (!cfg || !cfg.enabled) return { ok: false, error: 'llm.disabled' };

  const provider = String(cfg.provider || 'openai').toLowerCase();
  if (!PROVIDERS.has(provider)) {
    logger.warn(`[LLM] 不支持的 provider=${provider}（只实现了 OpenAI 兼容协议），本轮跳过`);
    return { ok: false, error: `provider_unsupported:${provider}` };
  }

  const keyEnv = cfg.apiKeyEnv || 'NPC_LLM_KEY';
  const apiKey = process.env[keyEnv] || process.env.NPC_LLM_KEY || cfg.apiKey || '';
  if (!apiKey) return { ok: false, error: `missing_env:${keyEnv}` };

  const baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;

  const system = String(payload.system || '');
  const extra = Array.isArray(payload.messages) ? payload.messages : [];
  const user = payload.user != null ? String(payload.user) : '';
  const chars =
    system.length +
    user.length +
    extra.reduce((s, m) => s + String((m && m.content) || '').length, 0);
  const limit = Number(cfg.maxInputChars);
  if (Number.isFinite(limit) && limit > 0 && chars > limit) {
    // 宁可这一轮不决策，也不要把一次超长请求（= 真金白银）发出去
    logger.warn(`[LLM] 输入 ${chars} 字超过 maxInputChars=${limit}，本轮丢弃`);
    return { ok: false, error: `input_too_long:${chars}>${limit}` };
  }

  const messages = [{ role: 'system', content: system }, ...extra];
  if (payload.user) messages.push({ role: 'user', content: user });

  const body = JSON.stringify({
    model: cfg.model,
    temperature: cfg.temperature != null ? cfg.temperature : 0.6,
    max_tokens: cfg.maxOutputTokens || 800,
    messages,
  });

  const timeoutMs = cfg.timeoutMs || 8000;
  const retries = Math.max(0, Math.min(2, Number.isFinite(cfg.retry) ? cfg.retry : 1));

  let last = { ok: false, error: 'unknown' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(250);
    last = await once(cfg, url, apiKey, body, timeoutMs);
    if (last.ok) return last;
    if (!retriable(last.error)) break;
    logger.warn(`[LLM] 请求失败（${last.error}），${attempt < retries ? '重试一次' : '放弃本轮'}`);
  }
  return last;
}

module.exports = { chat, retriable };
