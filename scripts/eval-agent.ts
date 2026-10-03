/**
 * Runs the real pipeline (methodology extraction + video agent) on LabSuperVision clips and scores it per step
 * against curated labels (data/fixtures/labels.json) derived from the dataset's published error text and step
 * timestamps, which the agent never sees.
 *
 *   npm run eval:agent                          # dev clips (the app's samples)
 *   npm run eval:agent -- DJI_17                # selected dev clips
 *   npm run eval:agent -- --split heldout       # held-out clips: run once, after the design lock
 *   npm run eval:agent -- --rescore             # re-judge saved runs with the current rules: no API calls
 *
 * Dev runs are cached in data/fixtures/agent-runs.json (the app opens them instantly); held-out runs in
 * heldout-runs.json. Scores go to agent-eval.json. Held-out videos come from `python3 scripts/fetch-demo-data.py --heldout`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { clock, runAgent, type Frame } from '../src/lib/agent';
import { agentTurn, extractMethod } from '../src/lib/claude';
import { GAP_SECONDS, MIN_CONFIDENCE, ORDER_TOLERANCE_SECONDS, verifyRun } from '../src/lib/conformance';
import { samples, toSample, type Sample } from '../src/lib/demo';
import type { Absence, MethodContract, Observation } from '../src/lib/types';
import heldoutManifest from '../data/fixtures/heldout.json';
import labelFile from '../data/fixtures/labels.json';

if (!process.env.ANTHROPIC_API_KEY && existsSync('.dev.vars')) {
  const match = readFileSync('.dev.vars', 'utf8').match(/^ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?/m);
  if (match) process.env.ANTHROPIC_API_KEY = match[1];
}
type Label = { split: 'dev' | 'heldout'; trueSkips: number[]; errorSteps: number[]; eitherSteps: number[]; note: string };
type CachedRun = { method: MethodContract; observations: Observation[]; absences?: Absence[]; log: string[]; generatedAt: string; usage?: Usage };
type Usage = { input: number; cacheWrite: number; cacheRead: number; output: number };
const labels = labelFile.clips as Record<string, Label>;

const args = process.argv.slice(2);
const split = args.includes('--split') ? args[args.indexOf('--split') + 1] : 'dev';
if (split !== 'dev' && split !== 'heldout') throw new Error('--split must be dev or heldout');
const rescore = args.includes('--rescore');
const selected = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--split');

const pool: Sample[] = split === 'dev' ? samples : heldoutManifest.examples.map(e => toSample(e as never, heldoutManifest.revision, existsSync('data/fixtures/heldout-assets.json') ? JSON.parse(readFileSync('data/fixtures/heldout-assets.json', 'utf8')) : []));
const runsPath = split === 'dev' ? 'data/fixtures/agent-runs.json' : 'data/fixtures/heldout-runs.json', evalPath = 'data/fixtures/agent-eval.json';
const cached = (existsSync(runsPath) ? JSON.parse(readFileSync(runsPath, 'utf8')) : {}) as Record<string, CachedRun>;
const report = (existsSync(evalPath) ? JSON.parse(readFileSync(evalPath, 'utf8')) : { clips: {} }) as { clips: Record<string, Clip> };
const client = rescore ? undefined : new Anthropic();

const videoFile = (s: Sample) => s.video.startsWith('/') ? `public${s.video}` : s.video;
const frame = (file: string, t: number, width: number): Frame => ({
  t, data: execFileSync('ffmpeg', ['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-']).toString('base64')
});
const spaced = (start: number, end: number, count: number) => Array.from({ length: count }, (_, i) => start + (end - start) / count * (i + 0.5));
const iou = (a: [number, number], b: [number, number]) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0])) / Math.max(1e-9, Math.max(a[1], b[1]) - Math.min(a[0], b[0]));
/** Estimate at the list price quoted in LogicCritic/vision (USD per million tokens: $4 in, $20 out; cache write 1.25x, read 0.1x). */
const dollars = (u: Usage) => (u.input * 4 + u.cacheWrite * 5 + u.cacheRead * 0.4 + u.output * 20) / 1e6;

async function analyse(sample: Sample): Promise<CachedRun> {
  const file = videoFile(sample);
  if (!existsSync(file)) throw new Error(`${file} is missing. Run python3 scripts/fetch-demo-data.py${split === 'heldout' ? ' --heldout' : ''}.`);
  const method = await extractMethod(client!, { kind: 'text', name: sample.protocolName, text: readFileSync(`public${sample.protocolText}`, 'utf8') });
  console.log(`  extracted ${method.requirements.length} steps`);
  const log: string[] = [], usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const overview = spaced(0, sample.duration, Math.max(8, Math.min(40, Math.round(sample.duration / 3)))).map(t => frame(file, t, 512));
  const { observations, absences } = await runAgent({
    method, duration: sample.duration, overview,
    getFrames: async (start, end, count) => spaced(start, end, count).map(t => frame(file, t, 640)),
    call: async messages => {
      const turn = await agentTurn(client!, messages);
      usage.input += turn.usage.input_tokens; usage.output += turn.usage.output_tokens;
      usage.cacheWrite += turn.usage.cache_creation_input_tokens ?? 0; usage.cacheRead += turn.usage.cache_read_input_tokens ?? 0;
      return turn;
    },
    onEvent: e => {
      const line = e.kind === 'overview' ? `Reviewed ${e.frames} overview frames` : e.kind === 'inspect' ? `Inspected ${clock(e.start)}–${clock(e.end)} (${e.count} frames)` : e.kind === 'thinking' ? e.text : e.kind === 'retry' ? e.message : `Submitted findings for ${e.steps} steps`;
      log.push(line); if (e.kind !== 'thinking') console.log(`  ${line}`);
    }
  });
  return { method, observations, absences, log, usage, generatedAt: new Date().toISOString() };
}

type Clip = ReturnType<typeof score>;
function score(sample: Sample, label: Label, run: CachedRun) {
  const results = verifyRun(run.method, { observations: run.observations, absences: run.absences, duration: sample.duration });
  const byOrder = (status: string) => run.method.requirements.filter(r => results[r.id].status === status).map(r => r.order);
  const skipped = byOrder('skipped'), contradicted = byOrder('contradicted');
  const flagged = [...skipped, ...contradicted];
  const expected = new Set([...label.trueSkips, ...label.errorSteps, ...label.eitherSteps]);
  const skipTargets = [...label.trueSkips, ...label.eitherSteps];
  const skipsCaught = skipTargets.filter(s => (label.trueSkips.includes(s) ? skipped : flagged).includes(s));
  const falseAlarms = flagged.filter(s => !expected.has(s));
  // Localisation: extraction keeps the protocol's numbering, so step N maps to ground-truth step N.
  // Labelled-skipped steps carry placeholder windows in the manifest, so they are not scored.
  const aligned = run.method.requirements.length === sample.groundTruth.steps.length;
  const perStep = aligned ? sample.groundTruth.steps.filter(s => s.start !== null && s.end !== null && !label.trueSkips.includes(s.order)).map(s => {
    const o = run.observations.find(o => o.stepId === run.method.requirements[s.order - 1]?.id);
    return { step: s.order, truth: [s.start, s.end], predicted: o ? [o.timestampStart, o.timestampEnd] : null, iou: o ? iou([o.timestampStart, o.timestampEnd], [s.start!, s.end!]) : 0, startError: o ? Math.abs(o.timestampStart - s.start!) : null };
  }) : [];
  return {
    title: sample.title, duration: sample.duration, split: label.split, note: label.note,
    labelledError: sample.groundTruth.error || null, trueSkips: label.trueSkips, errorSteps: label.errorSteps, eitherSteps: label.eitherSteps,
    skipped, contradicted, skipsCaught, skipsFlagged: skipTargets.filter(s => flagged.includes(s)), errorsCaught: label.errorSteps.filter(s => contradicted.includes(s)), falseAlarms,
    exact: falseAlarms.length === 0 && skipsCaught.length === skipTargets.length,
    predictedError: flagged.length > 0,
    contradictions: run.method.requirements.filter(r => results[r.id].status !== 'verified' && results[r.id].status !== 'unverifiable').map(r => {
      const x = results[r.id] as { status: string; expected?: unknown; observed?: unknown; reason?: string };
      return { step: r.order, title: r.title, status: x.status, observed: x.status === 'skipped' ? x.reason : x.observed };
    }),
    counts: Object.fromEntries(['verified', 'contradicted', 'skipped', 'unverifiable'].map(s => [s, Object.values(results).filter(r => r.status === s).length])),
    localisation: aligned ? { steps: perStep.length, meanIoU: perStep.reduce((n, l) => n + l.iou, 0) / (perStep.length || 1), hitsAtIoU03: perStep.filter(l => l.iou >= 0.3).length, perStep } : 'extracted step count differs from the protocol; localisation not scored',
    usage: run.usage, costUSD: run.usage ? Number(dollars(run.usage).toFixed(2)) : null,
    rules: { MIN_CONFIDENCE, GAP_SECONDS, ORDER_TOLERANCE_SECONDS }
  };
}

for (const sample of pool.filter(s => !selected.length || selected.includes(s.id))) {
  const label = labels[sample.id];
  if (!label || label.split !== split) throw new Error(`${sample.id} has no ${split} label in labels.json`);
  console.log(`\n${sample.id} · ${sample.title} · ${clock(sample.duration)} · ${split}`);
  if (rescore && !cached[sample.id]) { console.log('  no saved run; skipped'); continue; }
  const run = rescore ? cached[sample.id] : await analyse(sample);
  if (!rescore) { cached[sample.id] = run; writeFileSync(runsPath, JSON.stringify(cached, null, 2) + '\n'); }
  const clip = score(sample, label, run);
  report.clips[sample.id] = clip;
  writeFileSync(evalPath, JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`  ${JSON.stringify(clip.counts)}${clip.costUSD !== null ? ` · ~$${clip.costUSD}` : ''}`);
  console.log(`  skipped: [${clip.skipped}] contradicted: [${clip.contradicted}] · truth skips [${label.trueSkips}] errors [${label.errorSteps}] either [${label.eitherSteps}] · false alarms [${clip.falseAlarms}]`);
  if (typeof clip.localisation === 'object') console.log(`  localisation: mean IoU ${clip.localisation.meanIoU.toFixed(2)}, ${clip.localisation.hitsAtIoU03}/${clip.localisation.steps} steps at IoU ≥ 0.3`);
}

const clips = Object.entries(report.clips).filter(([, c]) => c.split === split);
const sum = (f: (c: Clip) => number) => clips.reduce((n, [, c]) => n + f(c), 0);
console.log(`\n${split}: ${clips.length} clips · exactly right ${clips.filter(([, c]) => c.exact).length}/${clips.length} · skips caught ${sum(c => c.skipsCaught.length)}/${sum(c => c.trueSkips.length + c.eitherSteps.length)} (skipped or contradicted on that step: ${sum(c => c.skipsFlagged.length)}) · non-skip errors flagged on the right step ${sum(c => c.errorsCaught.length)}/${sum(c => c.errorSteps.length)} · false alarms ${sum(c => c.falseAlarms.length)}`);
for (const [id, c] of clips) console.log(`  ${id.padEnd(7)} ${c.exact ? 'exact' : '     '}  skipped [${c.skipped}]  contradicted [${c.contradicted}]  false alarms [${c.falseAlarms}]  ${c.costUSD !== null ? `~$${c.costUSD}` : ''}`);
