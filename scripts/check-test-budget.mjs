import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SUITES_DIR = path.join(ROOT, 'test', 'suites');
const CASES_DIR = path.join(ROOT, 'test', 'cases');
const MAX_TEST_SUITES = 40;

const suiteFiles = fs.readdirSync(SUITES_DIR).filter((name) => name.endsWith('.test.ts')).sort();
const suiteSource = suiteFiles.map((name) => fs.readFileSync(path.join(SUITES_DIR, name), 'utf8')).join('\n');
const suiteCount = (suiteSource.match(/\bregisterSuite\(/g) || []).length;
if (suiteCount > MAX_TEST_SUITES) throw new Error(`Test budget exceeded: ${suiteCount}/${MAX_TEST_SUITES} registered suites.`);

const caseFiles = fs.readdirSync(CASES_DIR).filter((name) => name.endsWith('.cases.ts')).sort();
const importedCases = [...suiteSource.matchAll(/cases\/([^'"`]+)\.cases\.ts/g)].map((match) => `${match[1]}.cases.ts`);
const duplicates = importedCases.filter((name, index) => importedCases.indexOf(name) !== index);
const missing = caseFiles.filter((name) => !importedCases.includes(name));
const unknown = importedCases.filter((name) => !caseFiles.includes(name));
if (duplicates.length || missing.length || unknown.length) {
  throw new Error(`Test suite inventory mismatch. Duplicate: ${duplicates.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}.`);
}

console.log(`Test budget: ${suiteCount}/${MAX_TEST_SUITES} registered suites; ${caseFiles.length} consolidated case files.`);
