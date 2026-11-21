import { randomUUID } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Conversation, Message, Settings } from '../shared';

const defaults: Settings = {
  theme: 'system', pinned: true, autoCapture: true, denied: ['CredentialUIBroker.exe', 'LogonUI.exe', 'KeePass.exe', 'KeePassXC.exe', '1Password.exe'], models: {}, provider: 'chatgpt',
};

export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
        conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        text TEXT NOT NULL, imageLabel TEXT, status TEXT NOT NULL, error TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation, sequence);
      UPDATE messages SET status = 'stopped' WHERE status = 'streaming';
    `);
  }

  private query(sql: string): StatementSync { return this.db.prepare(sql); }

  read<T>(key: string): T | undefined {
    const row = this.query('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }

  write(key: string, value: unknown) {
    this.query('INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  clear(key: string) { this.query('DELETE FROM kv WHERE key = ?').run(key); }

  settings(): Settings { return { ...defaults, ...this.read<Partial<Settings>>('settings') }; }

  list(): Conversation[] {
    return this.query('SELECT id, title, updatedAt FROM conversations ORDER BY updatedAt DESC, rowid DESC').all() as unknown as Conversation[];
  }

  has(id: string): boolean { return !!this.query('SELECT 1 FROM conversations WHERE id = ?').get(id); }

  create(): Conversation {
    const conversation = { id: randomUUID(), title: '新对话', updatedAt: Date.now() };
    this.query('INSERT INTO conversations VALUES (?, ?, ?)').run(conversation.id, conversation.title, conversation.updatedAt);
    this.write('active', conversation.id);
    return conversation;
  }

  messages(id: string, recent?: number): Message[] {
    const columns = 'id, role, text, imageLabel, status, error';
    const sql = recent
      ? `SELECT ${columns} FROM (SELECT * FROM messages WHERE conversation = ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence`
      : `SELECT ${columns} FROM messages WHERE conversation = ? ORDER BY sequence`;
    const statement = this.query(sql);
    return (recent ? statement.all(id, recent) : statement.all(id)) as unknown as Message[];
  }

  lastTurn(id: string): [Message?, Message?] {
    const result = this.messages(id, 2);
    if (result[0]?.role !== 'user' || result[1]?.role !== 'assistant') return [];
    return [result[0], result[1]];
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  addTurn(id: string, text: string, imageLabel: string | null) {
    const userId = randomUUID();
    const replyId = randomUUID();
    this.transaction(() => {
      const exists = this.query('SELECT 1 FROM messages WHERE conversation = ? LIMIT 1').get(id);
      if (!exists) {
        const title = Array.from(text.trim().replace(/\s+/g, ' ') || '窗口截图').slice(0, 28).join('');
        this.query('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
      }
      const insert = this.query('INSERT INTO messages (id, conversation, role, text, imageLabel, status) VALUES (?, ?, ?, ?, ?, ?)');
      insert.run(userId, id, 'user', text, imageLabel, 'complete');
      insert.run(replyId, id, 'assistant', '', null, 'streaming');
      this.query('UPDATE conversations SET updatedAt = ? WHERE id = ?').run(Date.now(), id);
    });
    return { userId, replyId };
  }

  retry(id: string, userId: string, replyId: string, imageLabel: string | null) {
    this.transaction(() => {
      this.query('UPDATE messages SET imageLabel = ? WHERE id = ?').run(imageLabel, userId);
      this.query("UPDATE messages SET text = '', status = 'streaming', error = NULL WHERE id = ?").run(replyId);
      this.query('UPDATE conversations SET updatedAt = ? WHERE id = ?').run(Date.now(), id);
    });
  }

  patchReply(id: string, text: string, status: Message['status'], error: string | null = null) {
    this.query('UPDATE messages SET text = ?, status = ?, error = ? WHERE id = ?').run(text, status, error, id);
  }

  remove(id: string) {
    this.transaction(() => {
      this.query('DELETE FROM conversations WHERE id = ?').run(id);
      if (this.read('active') === id) this.clear('active');
    });
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close() { this.db.close(); }
}
