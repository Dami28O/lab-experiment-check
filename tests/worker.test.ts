import { describe, expect, it } from 'vitest';
import worker from '../worker/index';
import { createRecord } from '../src/lib/record';
import { cachedAnalysis, samples } from '../src/lib/demo';
const request = (path: string, body?: unknown) => new Request(`http://lens.test/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
describe('Worker API', () => {
  it('reports whether Claude is configured', async () => {
    expect(await (await worker.fetch(request('health'), {})).json()).toMatchObject({ claudeConfigured: false });
    expect(await (await worker.fetch(request('health'), { ANTHROPIC_API_KEY: 'x' })).json()).toMatchObject({ claudeConfigured: true });
  });
  it('explains a missing key instead of failing silently', async () => {
    const response = await worker.fetch(request('method/extract', { name: 'p.txt', document: { kind: 'text', text: '1. Add reagent.' } }), {});
    expect(response.status).toBe(503); expect((await response.json() as { error: string }).error).toContain('ANTHROPIC_API_KEY');
  });
  it('validates request bodies before calling the model', async () => expect((await worker.fetch(request('method/extract', { name: 'p.pdf', document: { kind: 'pdf', data: 'not base64!' } }), { ANTHROPIC_API_KEY: 'x' })).status).toBe(400));
  it('returns 404 for unknown endpoints', async () => expect((await worker.fetch(request('observe', {}), {})).status).toBe(404));
  it('publishes hash-consistent records and serves them by short id', async () => {
    const store = new Map<string, string>();
    const RECORDS = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); } };
    const a = samples.map(cachedAnalysis).find(Boolean)!;
    const record = await createRecord(a.run, a.method);
    const created = await worker.fetch(request('records', record), { RECORDS });
    expect(created.status).toBe(201);
    const { path } = await created.json() as { path: string };
    expect(path).toBe(`/r/${record.recordHash.slice(0, 16)}`);
    expect(await (await worker.fetch(request(`records/${record.recordHash.slice(0, 16)}`), { RECORDS })).json()).toEqual(record);
    expect((await worker.fetch(request('records', { ...record, method: { ...record.method, title: 'Tampered' } }), { RECORDS })).status).toBe(400);
  });
});
