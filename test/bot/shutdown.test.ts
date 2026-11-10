import { describe, expect, it } from 'vitest';
import { shutDown } from '../../src/bot/shutdown.js';
import { captureLogs } from '../helpers/context.js';

function bot(options: { tablesFail?: boolean; clientFails?: boolean; poolFails?: boolean } = {}) {
  const order: string[] = [];
  const { logger, lines } = captureLogs();
  const step = (name: string, fails: boolean | undefined) => (): Promise<void> => {
    order.push(name);
    return fails === true ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve();
  };
  return {
    order,
    lines,
    running: {
      tables: {
        closeAll: () => {
          order.push('tables');
          return Promise.resolve(options.tablesFail === true ? [new Error('table 3 failed')] : []);
        },
      },
      refunds: {
        stop: () => {
          order.push('refunds');
        },
      },
      client: { destroy: step('client', options.clientFails) },
      pool: { end: step('pool', options.poolFails) },
      logger,
    },
  };
}

describe('shutdown', () => {
  it('closes the tables first, while the client can still edit their messages', async () => {
    const { order, running, lines } = bot();
    await shutDown(running);
    expect(order).toEqual(['tables', 'refunds', 'client', 'pool']);
    expect(lines.filter((line) => Number(line.level) >= 50)).toEqual([]);
  });

  it('logs every failure and still runs the remaining steps', async () => {
    const { order, running, lines } = bot({ tablesFail: true, clientFails: true, poolFails: true });
    await expect(shutDown(running)).resolves.toBeUndefined();
    expect(order).toEqual(['tables', 'refunds', 'client', 'pool']);
    expect(lines.map((line) => line.msg)).toEqual([
      'closing a table failed',
      'closing the Discord client failed',
      'closing the database pool failed',
    ]);
  });
});
