import { describe, it, expect } from 'vitest';
import { parseModelCatalog, readCappedBody, MAX_CATALOG_BYTES, MAX_DISCOVERED_MODELS, ModelDiscoveryError } from '../../services/model-discovery.js';

// #488: relays that speak "OpenAI-compatible" agree on the chat route and then
// each invent their own /models envelope. Parsing has to be tolerant or the
// Fetch-models button reads as broken against half the endpoints people use.

describe('parseModelCatalog tolerance (#488)', () => {
  it('reads the canonical OpenAI envelope', () => {
    expect(parseModelCatalog({
      object: 'list',
      data: [
        { id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' },
        { id: 'sonnet-5', object: 'model', owned_by: 'anthropic' },
      ],
    })).toEqual([
      { id: 'gpt-4o-mini', ownedBy: 'openai' },
      { id: 'sonnet-5', ownedBy: 'anthropic' },
    ]);
  });

  it('reads a bare array of objects', () => {
    expect(parseModelCatalog([{ id: 'a' }, { id: 'b' }]).map(m => m.id)).toEqual(['a', 'b']);
  });

  it('reads a bare array of strings', () => {
    expect(parseModelCatalog(['b', 'a']).map(m => m.id)).toEqual(['a', 'b']);
  });

  it('reads an array of strings under data', () => {
    expect(parseModelCatalog({ data: ['a', 'b'] }).map(m => m.id)).toEqual(['a', 'b']);
  });

  it('reads the Ollama-style models/name envelope', () => {
    expect(parseModelCatalog({
      models: [{ name: 'qwen3:4b', model: 'qwen3:4b' }, { name: 'llama3:8b' }],
    }).map(m => m.id)).toEqual(['llama3:8b', 'qwen3:4b']);
  });

  it('reads a nested data.models envelope', () => {
    expect(parseModelCatalog({ data: { models: [{ id: 'nested' }] } }).map(m => m.id)).toEqual(['nested']);
  });

  it('falls back through the id aliases relays use', () => {
    expect(parseModelCatalog({
      data: [{ model_id: 'via-model-id' }, { slug: 'via-slug' }, { modelId: 'via-model-id-camel' }],
    }).map(m => m.id).sort()).toEqual(['via-model-id', 'via-model-id-camel', 'via-slug']);
  });

  it('picks up owner aliases and defaults to null', () => {
    const byId = new Map(parseModelCatalog({
      data: [
        { id: 'a', organization: 'org-a' },
        { id: 'b', provider: 'prov-b' },
        { id: 'c', publisher: 'pub-c' },
        { id: 'd' },
      ],
    }).map(m => [m.id, m.ownedBy]));
    expect(byId.get('a')).toBe('org-a');
    expect(byId.get('b')).toBe('prov-b');
    expect(byId.get('c')).toBe('pub-c');
    expect(byId.get('d')).toBeNull();
  });

  it('reads optional detail fields when the upstream advertises them (#685)', () => {
    const [m] = parseModelCatalog({
      data: [
        {
          id: 'rich',
          owned_by: 'openai',
          context_length: 128000,
          pricing: { prompt: 0.15, completion: 0.6 },
          modalities: ['text', 'image'],
        },
      ],
    });
    expect(m).toEqual({
      id: 'rich',
      ownedBy: 'openai',
      contextWindow: 128000,
      priceNote: '$0.15/M in $0.6/M out',
      vision: true,
    });
  });

  it('keeps a minimal envelope shape when details are absent (#685)', () => {
    const [m] = parseModelCatalog({ data: [{ id: 'bare' }] });
    expect(m).toEqual({ id: 'bare', ownedBy: null });
    expect('contextWindow' in m).toBe(false);
    expect('priceNote' in m).toBe(false);
    expect('vision' in m).toBe(false);
  });

  it('accepts the plain-string price and Ollama ctx_len spellings (#685)', () => {
    const [m] = parseModelCatalog({
      models: [{ name: 'qwen3:4b', ctx_len: 32768, price: 'free' }],
    });
    expect(m).toEqual({ id: 'qwen3:4b', ownedBy: null, contextWindow: 32768, priceNote: 'free' });
  });

  it('drops blanks, non-strings and duplicates', () => {
    expect(parseModelCatalog({
      data: ['dup', { id: 'dup' }, { id: '   ' }, { id: 42 }, null, 'kept'],
    }).map(m => m.id)).toEqual(['dup', 'kept']);
  });

  it('drops absurdly long ids instead of storing them', () => {
    expect(parseModelCatalog({ data: [{ id: 'x'.repeat(400) }, { id: 'ok' }] }).map(m => m.id)).toEqual(['ok']);
  });

  it('returns nothing for a payload with no recognizable list', () => {
    expect(parseModelCatalog({ error: 'nope' })).toEqual([]);
    expect(parseModelCatalog('plain text')).toEqual([]);
    expect(parseModelCatalog(null)).toEqual([]);
  });

  it('caps the list so a hostile relay cannot flood the picker', () => {
    const huge = Array.from({ length: MAX_DISCOVERED_MODELS + 50 }, (_, i) => ({ id: `m${String(i).padStart(4, '0')}` }));
    expect(parseModelCatalog({ data: huge })).toHaveLength(MAX_DISCOVERED_MODELS);
  });
});

describe('readCappedBody (#488)', () => {
  it('reads a normal body', async () => {
    const res = new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } });
    expect(await readCappedBody(res)).toBe('{"data":[]}');
  });

  it('rejects a declared content-length over the cap without reading it', async () => {
    const res = new Response('{}', {
      headers: { 'content-length': String(MAX_CATALOG_BYTES + 1) },
    });
    await expect(readCappedBody(res)).rejects.toBeInstanceOf(ModelDiscoveryError);
  });

  it('rejects a body that runs past the cap while streaming', async () => {
    const chunk = 'x'.repeat(64 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_CATALOG_BYTES + chunk.length) {
          controller.close();
          return;
        }
        sent += chunk.length;
        controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    await expect(readCappedBody(new Response(body))).rejects.toBeInstanceOf(ModelDiscoveryError);
  });
});
