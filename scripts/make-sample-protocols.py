"""Write each sample's published LSV protocol as a plain document (text + PDF) for the upload flow.
Only the protocol wording is included: no step timestamps or error labels, so the agent never sees ground truth."""
import json, pathlib, re, subprocess
source = json.loads(pathlib.Path('data/fixtures/source.json').read_text())
out = pathlib.Path('public/demo/protocols'); out.mkdir(parents=True, exist_ok=True)
for example in source['examples']:
    p = json.loads(example['protocol_json'])
    slug = re.sub(r'[^A-Za-z0-9]+', '-', example['protocol'].removesuffix('.txt')).strip('-')
    lines = [p['title'], '', p.get('summary', ''), '', 'Equipment']
    lines += [f"- {e['name']}" + (f" ({e['notes']})" if e.get('notes') else '') for e in p.get('equipment', [])]
    lines += ['', 'Reagents'] + [f"- {r['name']}" + (f" ({r['notes']})" if r.get('notes') else '') for r in p.get('reagents', [])]
    lines += ['', 'Procedure'] + [f"{s['order']}. {s['text']}" for s in sorted(p['steps'], key=lambda s: s['order'])]
    text = out / f'{slug}.txt'; text.write_text('\n'.join(lines) + '\n')
    pdf = subprocess.run(['cupsfilter', str(text)], capture_output=True)
    if pdf.returncode == 0: (out / f'{slug}.pdf').write_bytes(pdf.stdout)
    print(example['clip_id'], text, 'pdf' if pdf.returncode == 0 else 'no pdf')
