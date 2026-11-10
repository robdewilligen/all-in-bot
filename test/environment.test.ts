import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('runtime', () => {
  const nvmrcMajor = Number(readRepoFile('.nvmrc').trim());

  it('runs on at least the Node major version in .nvmrc', () => {
    const runningMajor = Number(process.versions.node.split('.')[0]);
    expect(nvmrcMajor).toBe(26);
    expect(runningMajor).toBeGreaterThanOrEqual(nvmrcMajor);
  });

  it('declares the same minimum Node version in package.json', () => {
    const pkg = JSON.parse(readRepoFile('package.json')) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${nvmrcMajor}`);
  });
});
