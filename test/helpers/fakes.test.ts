import { describe, expect, it } from 'vitest';
import { FakeChannel, fakeButton, fakeChatInput } from './discord.js';

describe('the table fakes', () => {
  it('give a command the channel it sends the table message to', async () => {
    const channel = new FakeChannel();
    const { interaction } = fakeChatInput('roulette', { channel });
    const message = await (interaction.channel as unknown as FakeChannel).send({
      content: 'table',
    });
    await message.edit({ content: 'betting closed' });
    expect(channel.messages).toEqual([message]);
    expect(message.sent).toEqual({ content: 'table' });
    expect(message.latest).toEqual({ content: 'betting closed' });
    expect(message.url).toMatch(/^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/);
  });

  it('let a test press a button on a collector', async () => {
    const channel = new FakeChannel();
    const message = await channel.send({ content: 'table' });
    const collector = message.createMessageComponentCollector();
    const handled: string[] = [];
    collector.on('collect', (pressed: { customId: string }) => {
      handled.push(pressed.customId);
    });
    const ended: string[] = [];
    collector.on('end', (_collected: unknown, reason: string) => {
      ended.push(reason);
    });
    const { interaction } = fakeButton('bj:1:hit:1', { message });
    collector.collect(interaction);
    expect(handled).toEqual(['bj:1:hit:1']);
    collector.stop('closed');
    collector.stop('again');
    expect(ended).toEqual(['closed']);
    expect(() => {
      collector.collect(interaction);
    }).toThrow(/ended/);
  });

  it('let update() on a button edit the message it is on', async () => {
    const message = await new FakeChannel().send({ content: 'your turn' });
    const { interaction, calls } = fakeButton('bj:1:stand:2', { message });
    await interaction.update({ content: 'stood' });
    expect(calls).toEqual([{ method: 'update', options: { content: 'stood' } }]);
    expect(message.latest).toEqual({ content: 'stood' });
  });
});
