import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyContent } from '../../src/core/model/constructors';

const ROOT = resolve(process.cwd());

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'venv'].includes(entry.name)) {
        continue;
      }
      walk(full, ext, out);
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Regression fixtures are this repository's own files, because that is where the defect was
 * found: 46 of its 57 TypeScript sources classified as `html`, every markdown file as `html`
 * or `yaml`, and a 75-line file of pure log output as `text`.
 */
describe('content classification against the repository itself', () => {
  it('classifies every TypeScript source in src/ as code', () => {
    const files = walk(resolve(ROOT, 'src'), '.ts');
    expect(files.length).toBeGreaterThan(40);

    const misclassified = files
      .map((file) => {
        const rel = file
          .slice(ROOT.length + 1)
          .split('\\')
          .join('/');
        return { rel, got: classifyContent(readFileSync(file, 'utf8'), 'file', rel) };
      })
      .filter((entry) => entry.got !== 'code');

    expect(misclassified).toEqual([]);
  });

  it('classifies every markdown document in docs/ as markdown', () => {
    const files = walk(resolve(ROOT, 'docs'), '.md');
    expect(files.length).toBeGreaterThan(0);

    const misclassified = files
      .map((file) => {
        const rel = file
          .slice(ROOT.length + 1)
          .split('\\')
          .join('/');
        return { rel, got: classifyContent(readFileSync(file, 'utf8'), 'file', rel) };
      })
      .filter((entry) => entry.got !== 'markdown');

    expect(misclassified).toEqual([]);
  });

  it('classifies the benchmark log fixture as logs', () => {
    const rel = 'tokendamper-benchmark/test_data/sample_logs.txt';
    const content = readFileSync(resolve(ROOT, rel), 'utf8');

    // No `.log` extension, so this is decided entirely by the content probe.
    expect(classifyContent(content, 'file', rel)).toBe('logs');
  });
});

describe('looksLikeHtml is a tag probe, not a "< ... >" probe', () => {
  // `/<\/?[a-z][\s\S]*>/i` matched from the first `<letter` to the LAST `>` anywhere in the
  // input, so a single generic parameter plus any later `>` was enough. TypeScript
  // guarantees both.
  it('does not read a generic type parameter as an HTML tag', () => {
    const source =
      'export function alpha(items: Array<string>): number {\n  return items.length > 0 ? 1 : 0;\n}\n';
    expect(classifyContent(source, 'text')).not.toBe('html');
  });

  it('does not read a comparison chain as an HTML tag', () => {
    expect(classifyContent('if (a <b && c> d) { run(); }', 'text')).not.toBe('html');
  });

  it('still recognizes real markup by a matched open/close pair', () => {
    expect(classifyContent('<div class="x"><p>Hello</p></div>', 'text')).toBe('html');
    expect(classifyContent('<!DOCTYPE html>\n<html><body>hi</body></html>', 'text')).toBe('html');
  });

  it('does not treat a lone unmatched tag-shaped token as markup', () => {
    expect(classifyContent('the placeholder is <value> and nothing else here', 'text')).not.toBe(
      'html',
    );
  });
});

describe('the declared extension outranks any content probe', () => {
  // The probes used to run first, so a `.ts` file that mentioned markup, or a `.md` file with
  // one `key: value` line, was classified by the probe that fired first.
  it('classifies a .ts file that emits HTML as code', () => {
    const source =
      'export function render(): string {\n  return `<div><p>${escape(x)}</p></div>`;\n}\n';
    expect(classifyContent(source, 'file', 'src/cli/diff-html.ts')).toBe('code');
  });

  it('classifies a .md file containing a key/value line as markdown', () => {
    const doc = '# Title\n\nStatus: shipped\n\nSome prose follows.\n';
    expect(classifyContent(doc, 'file', 'docs/note.md')).toBe('markdown');
  });

  it('classifies a .py file that is a dict literal as code', () => {
    expect(classifyContent('{\n  "a": 1\n}\n', 'file', 'tool.py')).toBe('code');
  });
});

describe('looksLikeLogs recognizes ISO-8601 timestamps', () => {
  // Two independent misses. The level-before-date alternative could not match a line whose
  // date comes first, which is the ordering every ISO-8601 logger emits; and
  // `\b\d{2}:\d{2}:\d{2}\b` cannot match `T19:00:01` because `T` and `1` are both word
  // characters, so there is no word boundary before the hour.
  it('recognizes a date-first line with the level after it', () => {
    const line =
      '2026-07-30T19:00:01.012Z [DEBUG] com.service.worker.TaskWorker - Task-0001: cycle 1.\n';
    expect(classifyContent(line.repeat(4), 'text')).toBe('logs');
  });

  it('recognizes a space-separated ISO timestamp', () => {
    expect(classifyContent('2026-07-25 12:00:00 [INFO] Application started', 'text')).toBe('logs');
  });

  it('does not classify prose as logs because it mentions one time', () => {
    const prose = [
      'The incident began around 09:15:00 on Tuesday.',
      'We reviewed the deployment history and the on-call notes.',
      'No further action is required at this time.',
      'The runbook has been updated accordingly.',
    ].join('\n');
    expect(classifyContent(prose, 'text')).not.toBe('logs');
  });
});

describe('looksLikeYaml asks whether the input is predominantly YAML', () => {
  const ROOT = resolve(process.cwd());

  // `/^(---\s*$)?([\w.-]+:\s+.+)$/m` fired on any single line of the form `word: text`, which
  // is a shape ordinary English uses constantly. Measured pathless — the Gateway's shape —
  // it claimed `yaml` for 12 of this repository's 22 markdown documents.
  it('does not read a prose line with a colon as YAML', () => {
    const prose = [
      'Note: the AST validators run in CLI and MCP mode.',
      '',
      'The planner is stateless, and the engine executes stages in order.',
      'Where: each stage reports its own metrics.',
    ].join('\n');
    expect(classifyContent(prose, 'text')).not.toBe('yaml');
  });

  it('does not read any of this repository\'s markdown as YAML when there is no path', () => {
    const files = walk(resolve(ROOT, 'docs'), '.md').concat(
      ['README.md', 'ARCHITECTURE.md', 'DECISIONS.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md'].map(
        (name) => resolve(ROOT, name),
      ),
    );
    expect(files.length).toBeGreaterThan(10);

    const asYaml = files
      .map((file) => ({ file, got: classifyContent(readFileSync(file, 'utf8'), 'text') }))
      .filter((entry) => entry.got === 'yaml')
      .map((entry) => entry.file.slice(ROOT.length + 1));

    expect(asYaml).toEqual([]);
  });

  // Guards on the tightening rather than regression fixtures: these already passed before it,
  // and they are what stops "fix the false positives" from becoming "never say yaml".
  it('still recognizes real YAML with no path to go on', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(classifyContent(workflow, 'text')).toBe('yaml');

    const compose = [
      'version: "3.9"',
      'services:',
      '  api:',
      '    image: node:20-alpine',
      '    ports:',
      '      - "3000:3000"',
      '    environment:',
      '      NODE_ENV: production',
    ].join('\n');
    expect(classifyContent(compose, 'text')).toBe('yaml');

    const frontMatter = ['---', 'title: Release notes', 'date: 2026-08-04', 'tags:', '  - release', '---'].join('\n');
    expect(classifyContent(frontMatter, 'text')).toBe('yaml');
  });
});
