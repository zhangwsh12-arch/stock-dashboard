#!/usr/bin/env node
/**
 * 可配置 LLM 客户端（OpenAI 兼容接口）
 * 供 fetch-news.mjs / generate-analysis.mjs 复用。
 *
 * 环境变量:
 *   OPENAI_API_KEY   - API Key（必填才走 LLM；缺省返回 null，调用方降级到免费翻译）
 *   OPENAI_BASE_URL  - OpenAI 兼容网关（默认 https://api.openai.com/v1，可指向 DeepSeek 等）
 *   OPENAI_MODEL     - 模型名（默认 gpt-4o-mini）
 *
 * callLLM(input) 入参兼容两种形态:
 *   1) { systemPrompt, userPrompt, temperature, maxTokens, timeoutMs, baseUrl, model }
 *   2) { messages: [{role,content}...] }
 * 返回: 模型输出的 content 字符串；失败时返回 null。
 */

export async function callLLM(input = {}, opts = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = input.baseUrl || process.env.OPENAI_BASE_URL || opts.baseUrl || 'https://api.openai.com/v1';
  const model = input.model || process.env.OPENAI_MODEL || opts.model || 'gpt-4o-mini';

  // 无 Key 时直接返回 null，由调用方（fetch-news 的 Level 2 免费翻译）兜底
  if (!apiKey) return null;

  let messages;
  if (Array.isArray(input.messages)) {
    messages = input.messages;
  } else if (input.systemPrompt !== undefined || input.userPrompt !== undefined) {
    messages = [
      ...(input.systemPrompt ? [{ role: 'system', content: input.systemPrompt }] : []),
      { role: 'user', content: input.userPrompt ?? '' },
    ];
  } else if (typeof input === 'string') {
    messages = [{ role: 'user', content: input }];
  } else {
    messages = [{ role: 'user', content: JSON.stringify(input) }];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs || opts.timeoutMs || 60000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: input.temperature ?? opts.temperature ?? 0.3,
        max_tokens: input.maxTokens ?? opts.maxTokens ?? 2000,
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.error('[callLLM] error:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 返回当前 LLM 配置（供 generate-analysis.mjs 使用） */
export function llmConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
}
