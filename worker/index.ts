import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { MODEL } from '../src/lib/agent';
import { agentTurn, extractMethod } from '../src/lib/claude';
import { validateRecord } from '../src/lib/record';
import type { ExperimentRecord } from '../src/lib/types';
type Env = {
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  ANTHROPIC_API_KEY?: string;
  /** Published records, keyed by the first 16 hex characters of the record hash. */
  RECORDS?: { get: (key: string) => Promise<string | null>; put: (key: string, value: string) => Promise<void> };
};
const MAX_BODY = 40_000_000;
const MAX_RECORD = 2_000_000;
/** Short, content-addressed id for a published record. */
const recordId = (record: Pick<ExperimentRecord, 'recordHash'>) => record.recordHash.slice(0, 16);
const extractRequest = z.object({
  name: z.string().min(1).max(300),
  document: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pdf'), data: z.string().min(1).regex(/^[A-Za-z0-9+/=]+$/) }),
    z.object({ kind: z.literal('text'), text: z.string().min(1).max(500_000) })
  ])
});
// Message history is produced by the shared agent loop and passed straight back to the API, which validates it.
const turnRequest = z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.unknown() })).min(1).max(60) });
async function jsonBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new Error('Request body is too large.');
  return JSON.parse(await request.text());
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Build Lens first with npm run build.', { status: 404 });
    const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    try {
      if (path === '/api/health') return response({ name: 'Lens', claudeConfigured: !!env.ANTHROPIC_API_KEY, model: MODEL });
      if (path.startsWith('/api/records')) return await records(request, env, path, response);
      if (request.method !== 'POST' || (path !== '/api/method/extract' && path !== '/api/agent/turn')) return response({ error: 'Endpoint not found.' }, 404);
      if (!env.ANTHROPIC_API_KEY) return response({ error: 'ANTHROPIC_API_KEY is not set. Add it to .dev.vars and restart the Worker.' }, 503);
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      try {
        if (path === '/api/method/extract') {
          const input = extractRequest.parse(await jsonBody(request));
          return response({ method: await extractMethod(client, { name: input.name, ...input.document }) });
        }
        const input = turnRequest.parse(await jsonBody(request));
        return response(await agentTurn(client, input.messages as Anthropic.Beta.Messages.BetaMessageParam[]));
      } catch (e) {
        if (e instanceof Anthropic.RateLimitError) return response({ error: 'Claude rate limit reached. Wait a moment and retry.' }, 429);
        if (e instanceof Anthropic.AuthenticationError) return response({ error: 'The Anthropic API key was rejected.' }, 502);
        if (e instanceof Anthropic.APIError) return response({ error: `Claude API error ${e.status ?? ''}: ${e.message}` }, 502);
        throw e;
      }
    } catch (e) { return response({ error: e instanceof Error ? e.message : 'Invalid request.' }, 400); }
  }
};

async function records(request: Request, env: Env, path: string, response: (body: unknown, status?: number) => Response): Promise<Response> {
  if (!env.RECORDS) return response({ error: 'Record storage is not configured on this Worker.' }, 503);
  const id = /^\/api\/records\/([0-9a-f]{16})$/.exec(path)?.[1];
  if (request.method === 'GET' && id) {
    const stored = await env.RECORDS.get(id);
    return stored ? new Response(stored, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=31536000, immutable' } }) : response({ error: 'Record not found.' }, 404);
  }
  if (request.method !== 'POST' || path !== '/api/records') return response({ error: 'Endpoint not found.' }, 404);
  if (Number(request.headers.get('content-length')) > MAX_RECORD) return response({ error: 'Record is too large to publish.' }, 413);
  const record = await jsonBody(request) as ExperimentRecord;
  // Only hash-consistent records are stored, so a link always resolves to exactly what was generated.
  if (!record || typeof record.recordHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.recordHash) || !await validateRecord(record).catch(() => false)) return response({ error: 'Record hashes do not match its contents.' }, 400);
  await env.RECORDS.put(recordId(record), JSON.stringify(record));
  return response({ id: recordId(record), path: `/r/${recordId(record)}` }, 201);
}
