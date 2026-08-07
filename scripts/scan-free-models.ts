#!/usr/bin/env node
// scan-free-models.ts — 半自动免费模型扫描器
//
// 探测各免费 LLM provider 的 OpenAI 兼容 /v1/models 端点,输出候选模型清单,
// 供人工对照 freellmapi catalog 决定要添加哪些模型(代替 #767 这类手写请求)。
//
// 用法:
//   SCAN_GROQ_KEY=... SCAN_OPENROUTER_KEY=... node scripts/scan-free-models.ts
//
// 设计:半自动——只负责"发现 + 输出候选",是否上线由人决定。免费模型
// 可用性波动大(#722:Cloudflare Kimi 变付费;OpenRouter :free 轮换),全自动
// 写入 catalog 会引入不可靠模型,所以扫描结果必须人工 review 后合并。

type Provider = {
  name: string;
  baseUrl: string;
  keyEnv?: string;
};

// OpenAI 兼容 /v1/models 端点的免费 provider。有 key 的用 key 探测;
// 无 key 的(如 ollama.com/v1 匿名)可不配置。
const PROVIDERS: Provider[] = [
  { name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'SCAN_GROQ_KEY' },
  { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'SCAN_OPENROUTER_KEY' },
  { name: 'ollama-cloud', baseUrl: 'https://ollama.com/v1', keyEnv: 'SCAN_OLLAMA_KEY' },
  { name: 'nvidia-nim', baseUrl: 'https://integrate.api.nvidia.com/v1', keyEnv: 'SCAN_NVIDIA_KEY' },
  { name: 'mistral', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'SCAN_MISTRAL_KEY' },
];

async function scanProvider(p: Provider): Promise<string[]> {
  const key = p.keyEnv ? process.env[p.keyEnv] : undefined;
  if (p.keyEnv && !key) {
    return [];
  }
  const res = await fetch(`${p.baseUrl}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    return [];
  }
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return (data.data ?? []).map(m => m.id).sort();
}

async function main(): Promise<void> {
  for (const p of PROVIDERS) {
    const models = await scanProvider(p);
    if (models.length === 0) {
      console.log(`[${p.name}] 跳过(未配置 ${p.keyEnv ?? 'key'} 或探测失败)`);
      continue;
    }
    console.log(`\n=== ${p.name} (${models.length} models) ===`);
    for (const id of models) {
      const freeHint = id.includes(':free') || id.includes('-free');
      console.log(`  ${id}${freeHint ? '  ← free' : ''}`);
    }
  }
  console.log('\n扫描完成。对照 server/src/db/migrations/20260101_000000_legacy_baseline.ts 的 catalog,人工确认要添加的模型。');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
