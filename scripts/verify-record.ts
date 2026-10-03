import { readFileSync } from 'node:fs';
import { validateRecord } from '../src/lib/record';
import type { ExperimentRecord } from '../src/lib/types';
const file = process.argv[2];
if (!file) throw new Error('Usage: npm run verify-record -- path/to/record.json');
const valid = await validateRecord(JSON.parse(readFileSync(file, 'utf8')) as ExperimentRecord);
console.log(valid ? 'Integrity verified: method, observations and record hash.' : 'Integrity check failed.');
if (!valid) process.exitCode = 1;
