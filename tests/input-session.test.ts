import assert from 'node:assert/strict';
import test from 'node:test';
import { interactionContext } from '../src/main/interaction-context';
import { InputSessionController } from '../src/main/input-session';

test('only one preparation owns a turn and cancellation leaves the next turn free', async () => {
  const sessions = new InputSessionController();
  const started = sessions.prepare('chat', signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await assert.rejects(sessions.prepare(null, async () => 'duplicate'), /等待/);
  assert.equal(sessions.conversationId, 'chat');
  sessions.cancel('窗口切换');
  await assert.rejects(started, /窗口切换/);
  assert.equal(await sessions.prepare(null, async () => 'next'), 'next');
});

test('a screenshot cannot silently follow input into a different target window', () => {
  const older = { id: '1:2:3', executable: 'app.exe', title: 'Old' };
  const newer = { ...older, id: '1:2:4' };
  const shot = { id: 'shot', target: older, image: 'data:', capturedAt: 1 };
  assert.throws(() => interactionContext('typed', 'turn', newer, 'question', shot), /窗口已变更/);
  assert.throws(() => interactionContext('typed', 'turn', null, 'question', shot), /窗口已变更/);
  assert.equal(interactionContext('typed', 'turn', older, 'question', shot).screenshotId, 'shot');
});
