import { describe, expect, it } from 'vitest';
import { runAgent, toContract, type AgentCall } from '../src/lib/agent';
import { verifyMethod } from '../src/lib/conformance';
const method = toContract({ title: 'Mock', summary: '', steps: [
  { title: 'Add reagent', description: 'Add reagent 1 to the tube.', checks: ['Tip enters the tube'], caveats: ['Sterility'], criticality: 'critical', category: 'action' },
  { title: 'Incubate', description: 'Incubate 20 min.', checks: ['Tube left for 20 minutes'], caveats: [], criticality: 'important', category: 'timing' }
] }, 'mock.pdf');
const findings = (steps: string[]) => ({ steps: steps.map(id => ({ step_id: id, found: id === 'step-01', start_seconds: id === 'step-01' ? 2 : 0, end_seconds: id === 'step-01' ? 6 : 0, summary: 'Tip enters the tube.', check_results: [{ check_index: 0, result: 'confirmed', note: 'Visible at 4 s' }], evidence: [{ seconds: 4, description: 'Tip in tube' }], uncertainties: [], confidence: .9 })) });
function scripted(turns: unknown[][]): { call: AgentCall; requests: unknown[][] } {
  const requests: unknown[][] = []; let i = 0;
  return { requests, call: async messages => { requests.push(structuredClone(messages)); const content = turns[i++] as never; return { content, stop_reason: 'tool_use' }; } };
}
describe('Video agent loop', () => {
  it('supplies requested frames, then turns findings into observations the rules can judge', async () => {
    const { call, requests } = scripted([
      [{ type: 'tool_use', id: 't1', name: 'view_frames', input: { start_seconds: 1, end_seconds: 7, count: 3 } }],
      [{ type: 'tool_use', id: 't2', name: 'submit_findings', input: findings(['step-01', 'step-02']) }]
    ]);
    const asked: number[][] = [];
    const observations = await runAgent({ method, duration: 30, overview: [{ t: 1, data: 'AAAA' }], call, getFrames: async (s, e, c) => { asked.push([s, e, c]); return [{ t: s, data: 'BBBB' }]; } });
    expect(asked).toEqual([[1, 7, 3]]);
    expect(JSON.stringify(requests[1])).toContain('BBBB');
    expect(observations).toHaveLength(1);
    const results = verifyMethod(method, observations);
    expect(results['step-01'].status).toBe('verified');
    expect(results['step-02'].status).toBe('unverifiable');
  });
  it('rejects findings that skip a step and asks again', async () => {
    const { call } = scripted([
      [{ type: 'tool_use', id: 't1', name: 'submit_findings', input: findings(['step-01']) }],
      [{ type: 'tool_use', id: 't2', name: 'submit_findings', input: findings(['step-01', 'step-02']) }]
    ]);
    const events: string[] = [];
    await runAgent({ method, duration: 30, overview: [], call, getFrames: async () => [], onEvent: e => events.push(e.kind) });
    expect(events).toContain('retry');
  });
  it('enforces the frame budget', async () => {
    const { call } = scripted([
      [{ type: 'tool_use', id: 't1', name: 'view_frames', input: { start_seconds: 0, end_seconds: 10, count: 8 } }],
      [{ type: 'tool_use', id: 't2', name: 'submit_findings', input: findings(['step-01', 'step-02']) }]
    ]);
    const counts: number[] = [];
    await runAgent({ method, duration: 30, overview: [], call, frameBudget: 5, getFrames: async (_s, _e, c) => { counts.push(c); return []; } });
    expect(counts).toEqual([5]);
  });
});
