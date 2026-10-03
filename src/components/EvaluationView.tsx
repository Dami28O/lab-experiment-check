import { Empty, Link, Table } from '@cloudflare/kumo';
import { ShieldCheckIcon } from '@phosphor-icons/react';
import evaluation from '../../data/fixtures/agent-eval.json';
import { demoSource, samples, time } from '../lib/demo';
type Clip = { title: string; duration: number; labelledError: string | null; predictedError: boolean; counts: Record<string, number>; contradictions: { step: number; title: string; observed: unknown }[]; localisation: string | { steps: number; meanIoU: number; hitsAtIoU03: number } };
export function EvaluationView() {
  const clips = Object.entries((evaluation as { clips: Record<string, Clip> }).clips);
  const labelled = clips.filter(([, c]) => c.labelledError), clean = clips.filter(([, c]) => !c.labelledError);
  const located = clips.map(([, c]) => c.localisation).filter((l): l is Exclude<Clip['localisation'], string> => typeof l === 'object');
  return <div className="evaluation-page">
    <div className="page-intro"><h1>Does it work?</h1><p>The samples come from LabSuperVision, which publishes when each protocol step happens and what went wrong. The agent never sees those labels, so they are an answer key.</p></div>
    {clips.length ? <>
      <div className="metrics">
        <div><span>Labelled errors flagged</span><strong>{labelled.filter(([, c]) => c.predictedError).length}<small> / {labelled.length}</small></strong></div>
        <div><span>False alarms on clean clips</span><strong>{clean.filter(([, c]) => c.predictedError).length}<small> / {clean.length}</small></strong></div>
        <div><span>Steps located (IoU ≥ 0.3)</span><strong>{located.reduce((n, l) => n + l.hitsAtIoU03, 0)}<small> / {located.reduce((n, l) => n + l.steps, 0)}</small></strong></div>
        <div><span>Mean timing overlap</span><strong>{located.length ? (located.reduce((n, l) => n + l.meanIoU * l.steps, 0) / Math.max(1, located.reduce((n, l) => n + l.steps, 0))).toFixed(2) : '—'}<small> IoU</small></strong></div>
      </div>
      <Table className="eval-table"><Table.Header><Table.Row><Table.Head>Clip</Table.Head><Table.Head>Labelled error</Table.Head><Table.Head>Agent flagged</Table.Head><Table.Head>Timing</Table.Head></Table.Row></Table.Header><Table.Body>{clips.map(([id, c]) => <Table.Row key={id}>
        <Table.Cell><strong>{c.title}</strong><span className="mono muted">{id} · {time(c.duration)}</span></Table.Cell>
        <Table.Cell>{c.labelledError ?? <span className="muted">None</span>}</Table.Cell>
        <Table.Cell>{c.contradictions.length ? c.contradictions.map(x => <div key={x.step}>Step {x.step} · {x.title}<span className="muted"> — {String(x.observed)}</span></div>) : <span className="muted">Nothing</span>}</Table.Cell>
        <Table.Cell className="mono">{typeof c.localisation === 'object' ? `${c.localisation.hitsAtIoU03}/${c.localisation.steps} · IoU ${c.localisation.meanIoU.toFixed(2)}` : '—'}</Table.Cell>
      </Table.Row>)}</Table.Body></Table>
      <p className="muted small">Read the flagged step against the labelled error: a contradiction on the wrong step is not a detection. {clips.length} clips is a smoke test, not a benchmark.</p>
    </> : <Empty icon={<ShieldCheckIcon size={28}/>} title="No agent runs yet" description="Add your key to .dev.vars, then run the pipeline on every sample and score it against the published labels. Results appear here and the samples open with the agent’s real output." commandLine="npm run eval:agent"/>}
    <section className="dataset"><h2>Dataset</h2><p>LabSuperVision / LabOS LSV · CC BY-NC 4.0 · {samples.length} clips used · pinned revision <code>{demoSource.revision.slice(0, 8)}</code></p><Link href={demoSource.source} target="_blank">Dataset on Hugging Face</Link></section>
  </div>;
}
