#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { gradeRun, loadSuite, summaryMarkdown } from './traffic-eval-lib.mjs';

function value(flag, fallback) { const index = process.argv.indexOf(flag); return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback; }
const suitePath = path.resolve(value('--suite', 'evals/traffic-agent/shanghai-v1.json'));
const runPath = value('--run', process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '');
if (!runPath) throw new Error('Usage: node scripts/eval/grade-traffic-agent-eval.mjs --run <run.json> [--suite <suite.json>]');
const run = JSON.parse(fs.readFileSync(path.resolve(runPath), 'utf8'));
const summary = gradeRun(loadSuite(suitePath), run);
const outputDir = path.dirname(path.resolve(runPath));
fs.writeFileSync(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
fs.writeFileSync(path.join(outputDir, 'summary.md'), summaryMarkdown(summary));
process.stdout.write(`${summary.totals.passed}/${summary.totals.cases} cases passed\n`);
if (!summary.passed) process.exitCode = 1;
