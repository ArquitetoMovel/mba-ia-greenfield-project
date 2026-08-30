import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { ChannelsService } from './channels.service';
import { Channel } from './entities/channel.entity';

function makeManager(
  overrides: Partial<Record<keyof EntityManager, jest.Mock>> = {},
): EntityManager {
  return {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    ...overrides,
  } as unknown as EntityManager;
}

function makeChannel(nickname: string): Channel {
  const c = new Channel();
  c.id = 'uuid';
  c.nickname = nickname;
  c.name = nickname;
  c.user_id = 'user-id';
  c.description = null;
  c.created_at = new Date();
  c.updated_at = new Date();
  return c;
}

function makeUniqueError(): QueryFailedError {
  const driverError = Object.assign(new Error('unique_violation'), {
    code: '23505',
    detail: 'Key (nickname)=(abc) already exists.',
  });
  return new QueryFailedError('INSERT', [], driverError);
}

function makeDataSource(manager: EntityManager): DataSource {
  return {
    transaction: jest.fn(
      async (cb: (m: EntityManager) => Promise<unknown>): Promise<unknown> =>
        cb(manager),
    ),
  } as unknown as DataSource;
}

describe('ChannelsService', () => {
  describe('createChannel', () => {
    it('derives nickname from email prefix and saves when no collision', async () => {
      const channel = makeChannel('test');
      const findOneSpy = jest.fn().mockResolvedValue(null);
      const createSpy = jest.fn().mockReturnValue(channel);
      const saveSpy = jest.fn().mockResolvedValue(channel);
      const manager = makeManager({
        findOne: findOneSpy,
        create: createSpy,
        save: saveSpy,
      });
      const service = new ChannelsService(makeDataSource(manager));

      const result = await service.createChannel('user-id', 'test@example.com');

      expect(findOneSpy).toHaveBeenCalledWith(Channel, {
        where: { nickname: 'test' },
      });
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(result.nickname).toBe('test');
    });

    it('retries with suffix when pre-check finds existing nickname', async () => {
      const colliding = makeChannel('john');
      const resolved = makeChannel('john_abc');
      const findOneSpy = jest
        .fn()
        .mockResolvedValueOnce(colliding)
        .mockResolvedValueOnce(null);
      const createSpy = jest.fn().mockReturnValue(resolved);
      const saveSpy = jest.fn().mockResolvedValue(resolved);
      const manager = makeManager({
        findOne: findOneSpy,
        create: createSpy,
        save: saveSpy,
      });
      const service = new ChannelsService(makeDataSource(manager));

      const result = await service.createChannel('user-id', 'john@example.com');

      expect(findOneSpy).toHaveBeenCalledTimes(2);
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(result.nickname).toMatch(/^john_[a-z0-9]{3}$/);
    });

    it('retries with suffix on concurrent unique constraint violation', async () => {
      const resolved = makeChannel('alice_abc');
      const findOneSpy = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      const createSpy = jest.fn().mockReturnValue(resolved);
      const saveSpy = jest
        .fn()
        .mockRejectedValueOnce(makeUniqueError())
        .mockResolvedValueOnce(resolved);
      const manager = makeManager({
        findOne: findOneSpy,
        create: createSpy,
        save: saveSpy,
      });
      const service = new ChannelsService(makeDataSource(manager));

      const result = await service.createChannel(
        'user-id',
        'alice@example.com',
      );

      expect(saveSpy).toHaveBeenCalledTimes(2);
      expect(result.nickname).toMatch(/^alice/);
    });

    it('throws after exhausting max retries', async () => {
      const existing = makeChannel('bob');
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
        save: jest.fn(),
      });
      const service = new ChannelsService(makeDataSource(manager));

      await expect(
        service.createChannel('user-id', 'bob@example.com'),
      ).rejects.toThrow(
        'Nickname conflict could not be resolved after max retries',
      );
    });

    it('re-throws non-unique-constraint errors immediately', async () => {
      const unexpectedError = new Error('Connection lost');
      const channel = makeChannel('carol');
      const saveSpy = jest.fn().mockRejectedValue(unexpectedError);
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(channel),
        save: saveSpy,
      });
      const service = new ChannelsService(makeDataSource(manager));

      await expect(
        service.createChannel('user-id', 'carol@example.com'),
      ).rejects.toThrow('Connection lost');
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });
  });
});
