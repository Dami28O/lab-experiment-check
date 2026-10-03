/**
 * Runs the real pipeline (methodology extraction + video agent) on LabSuperVision samples and scores it
 * against the dataset's published step timestamps and error labels, which the agent never sees.
 *
 *   ANTHROPIC_API_KEY=… npm run eval:agent            # every sample
 *   ANTHROPIC_API_KEY=… npm run eval:agent -- DJI_16  # selected clips
 *
 * Writes data/fixtures/agent-runs.json (cached runs the app opens instantly) and data/fixtures/agent-eval.json.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { clock, runAgent, type Frame } from '../src/lib/agent';
import { agentTurn, extractMethod } from '../src/lib/claude';
import { verifyMethod } from '../src/lib/conformance';
import { samples } from '../src/lib/demo';
import type { Observation } from '../src/lib/types';

if (!process.env.ANTHROPIC_API_KEY && existsSync('.dev.vars')) {
  const match = readFileSync('.dev.vars', 'utf8').match(/^ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?/m);
  if (match) process.env.ANTHROPIC_API_KEY = match[1];
}
const client = new Anthropic();
const frame = (file: string, t: number, width: number): Frame => ({
  t, data: execFileSync('ffmpeg', ['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-']).toString('base64')
});
const spaced = (start: number, end: number, count: number) => Array.from({ length: count }, (_, i) => start + (end - start) / count * (i + 0.5));
const iou = (a: [number, number], b: [number, number]) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0])) / (Math.max(a[1], b[1]) - Math.min(a[0], b[0]));

const selected = process.argv.slice(2);
const runsPath = 'data/fixtures/agent-runs.json', evalPath = 'data/fixtures/agent-eval.json';
const cached = JSON.parse(readFileSync(runsPath, 'utf8')) as Record<string, unknown>;
const report = existsSync(evalPath) ? JSON.parse(readFileSync(evalPath, 'utf8')) as { clips: Record<string, unknown> } : { clips: {} };

for (const sample of samples.filter(s => !selected.length || selected.includes(s.id))) {
  console.log(`\n${sample.id} · ${sample.title} · ${clock(sample.duration)}`);
  const file = `public${sample.video}`;
  const method = await extractMethod(client, { kind: 'text', name: sample.protocolName, text: readFileSync(`public${sample.protocolText}`, 'utf8') });
  console.log(`  extracted ${method.requirements.length} steps`);
  const log: string[] = [];
  const overview = spaced(0, sample.duration, Math.max(8, Math.min(40, Math.round(sample.duration / 3)))).map(t => frame(file, t, 512));
  const observations: Observation[] = await runAgent({
    method, duration: sample.duration, overview,
    getFrames: async (start, end, count) => spaced(start, end, count).map(t => frame(file, t, 640)),
    call: messages => agentTurn(client, messages),
    onEvent: e => {
      const line = e.kind === 'overview' ? `Reviewed ${e.frames} overview frames` : e.kind === 'inspect' ? `Inspected ${clock(e.start)}–${clock(e.end)} (${e.count} frames)` : e.kind === 'thinking' ? e.text : e.kind === 'retry' ? e.message : `Submitted findings for ${e.steps} steps`;
      log.push(line); if (e.kind !== 'thinking') console.log(`  ${line}`);
    }
  });
  const results = verifyMethod(method, observations);

  // Localisation: extraction keeps the protocol's numbering, so step N maps to ground-truth step N.
  const aligned = method.requirements.length === sample.groundTruth.steps.length;
  const localisation = aligned ? sample.groundTruth.steps.filter(s => s.start !== null && s.end !== null).map(s => {
    const o = observations.find(o => o.stepId === method.requirements[s.order - 1]?.id);
    return { step: s.order, truth: [s.start, s.end], predicted: o ? [o.timestampStart, o.timestampEnd] : null, iou: o ? iou([o.timestampStart, o.timestampEnd], [s.start!, s.end!]) : 0, startError: o ? Math.abs(o.timestampStart - s.start!) : null };
  }) : [];
  const contradictions = method.requirements.filter(r => results[r.id].status === 'contradicted').map(r => {
    const result = results[r.id] as { expected: unknown; observed: unknown };
    return { step: r.order, title: r.title, expected: result.expected, observed: result.observed };
  });
  const counts = Object.fromEntries(['verified', 'contradicted', 'unverifiable'].map(s => [s, Object.values(results).filter(r => r.status === s).length]));
  const clip = {
    title: sample.title, duration: sample.duration, labelledError: sample.groundTruth.error || null, predictedError: contradictions.length > 0, contradictions, counts,
    localisation: aligned ? { steps: localisation.length, meanIoU: localisation.reduce((n, l) => n + l.iou, 0) / (localisation.length || 1), hitsAtIoU03: localisation.filter(l => l.iou >= 0.3).length, perStep: localisation } : 'extracted step count differs from the protocol; localisation not scored'
  };
  report.clips[sample.id] = clip;
  cached[sample.id] = { method, observations, log, generatedAt: new Date().toISOString() };
  console.log(`  ${JSON.stringify(counts)} · labelled error: ${clip.labelledError ?? 'none'} · flagged: ${contradictions.map(c => `step ${c.step}`).join(', ') || 'nothing'}`);
  if (typeof clip.localisation === 'object') console.log(`  localisation: mean IoU ${clip.localisation.meanIoU.toFixed(2)}, ${clip.localisation.hitsAtIoU03}/${clip.localisation.steps} steps at IoU ≥ 0.3`);
  writeFileSync(runsPath, JSON.stringify(cached, null, 2) + '\n');
  writeFileSync(evalPath, JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2) + '\n');
}

const clips = Object.values(report.clips) as { labelledError: string | null; predictedError: boolean }[];
console.log(`\nDeviation detection across ${clips.length} clips: ${clips.filter(c => c.labelledError && c.predictedError).length}/${clips.filter(c => c.labelledError).length} labelled errors flagged, ${clips.filter(c => !c.labelledError && c.predictedError).length}/${clips.filter(c => !c.labelledError).length} false alarms on clean clips.`);
console.log('Check that each flagged step matches the labelled error text in data/fixtures/agent-eval.json.');
