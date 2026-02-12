import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

const env = {
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 8787),
  dbPath: process.env.DB_PATH ?? './ourhome.sqlite',
  apiKey: process.env.API_KEY ?? 'ILoveNihal',
  jwtSecret: process.env.JWT_SECRET ?? 'replace-me',
  adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'admin',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','),
  cookieSecure: (process.env.COOKIE_SECURE ?? 'false') === 'true',
};

const db = new Database(env.dbPath);
db.pragma('journal_mode = WAL');

const app = Fastify({ logger: true });

type WsClient = { send: (message: string) => void; readyState: number };
const wsClients = new Set<WsClient>();

const now = () => new Date().toISOString();

const initDb = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS grocery_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL DEFAULT 1,
      text TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (list_id) REFERENCES grocery_lists(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS grocery_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS todo_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL DEFAULT 1,
      text TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      due_date TEXT,
      priority INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (list_id) REFERENCES todo_lists(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS todo_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      location TEXT,
      attendees_json TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dashboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dashboard_widgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dashboard_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      layout_json TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
    );
  `);

  const existingUser = db
    .prepare('SELECT id FROM users WHERE username = ?')
    .get(env.adminUsername) as { id: number } | undefined;

  if (!existingUser) {
    const ts = now();
    const hash = bcrypt.hashSync(env.adminPassword, 12);
    db.prepare(
      'INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(env.adminUsername, hash, ts, ts);
    app.log.warn('No admin user found. Created default admin from environment variables.');
  }

  const activeDashboard = db
    .prepare('SELECT id FROM dashboards WHERE is_active = 1 LIMIT 1')
    .get() as { id: number } | undefined;

  if (!activeDashboard) {
    const ts = now();
    db.prepare(
      'INSERT INTO dashboards (name, is_active, created_at, updated_at) VALUES (?, 1, ?, ?)'
    ).run('Main', ts, ts);
  }

  const calendarColumns = db
    .prepare('PRAGMA table_info(calendar_events)')
    .all() as Array<{ name: string }>;
  const hasLocation = calendarColumns.some((column) => column.name === 'location');
  const hasAttendees = calendarColumns.some((column) => column.name === 'attendees_json');
  if (!hasLocation) {
    db.exec('ALTER TABLE calendar_events ADD COLUMN location TEXT');
  }
  if (!hasAttendees) {
    db.exec('ALTER TABLE calendar_events ADD COLUMN attendees_json TEXT');
  }

  const groceryColumns = db
    .prepare('PRAGMA table_info(grocery_items)')
    .all() as Array<{ name: string }>;
  const hasListId = groceryColumns.some((column) => column.name === 'list_id');
  if (!hasListId) {
    db.exec('ALTER TABLE grocery_items ADD COLUMN list_id INTEGER NOT NULL DEFAULT 1');
  }

  const defaultGroceryList = db.prepare('SELECT id FROM grocery_lists WHERE id = 1').get() as { id: number } | undefined;
  if (!defaultGroceryList) {
    const ts = now();
    db.prepare('INSERT INTO grocery_lists (id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('General', ts, ts);
  }

  const todoColumns = db
    .prepare('PRAGMA table_info(todo_items)')
    .all() as Array<{ name: string }>;
  const hasTodoListId = todoColumns.some((column) => column.name === 'list_id');
  if (!hasTodoListId) {
    db.exec('ALTER TABLE todo_items ADD COLUMN list_id INTEGER NOT NULL DEFAULT 1');
  }

  const defaultTodoList = db.prepare('SELECT id FROM todo_lists WHERE id = 1').get() as { id: number } | undefined;
  if (!defaultTodoList) {
    const ts = now();
    db.prepare('INSERT INTO todo_lists (id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('General', ts, ts);
  }
};

const toBool = (v: unknown) => Number(v) === 1;
const parseAttendees = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

const broadcast = (type: string) => {
  const payload = JSON.stringify({ type, sentAt: now() });
  for (const client of wsClients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
};

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; username: string };
    user: { sub: string; username: string };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    requireAuth: () => Promise<void>;
  }
}

initDb();

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin || env.corsOrigins.includes(origin)) {
      cb(null, true);
      return;
    }
    cb(new Error('Origin not allowed'), false);
  },
  credentials: true,
});

await app.register(cookie);
await app.register(jwt, {
  secret: env.jwtSecret,
  cookie: {
    cookieName: 'ourhome_token',
    signed: false,
  },
});

await app.register(rateLimit, {
  global: false,
  max: 20,
  timeWindow: '1 minute',
});

await app.register(websocket);

app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/api/')) return;
  const key = request.headers['x-api-key'];
  const apiKey = Array.isArray(key) ? key[0] : key;
  if (apiKey !== env.apiKey) {
    return reply.code(401).send({ error: 'Invalid API key' });
  }
});

app.decorateRequest('requireAuth', async function requireAuth() {
  await this.jwtVerify();
});

app.get('/health', async () => ({ ok: true }));

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid payload' });
  }

  const user = db
    .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
    .get(parsed.data.username) as
    | { id: number; username: string; password_hash: string }
    | undefined;

  if (!user || !bcrypt.compareSync(parsed.data.password, user.password_hash)) {
    return reply.code(401).send({ error: 'Invalid credentials' });
  }

  const token = await reply.jwtSign({ sub: String(user.id), username: user.username }, { expiresIn: '7d' });

  reply.setCookie('ourhome_token', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.cookieSecure,
    maxAge: 60 * 60 * 24 * 7,
  });

  return { id: user.id, username: user.username };
});

app.post('/api/auth/logout', async (_request, reply) => {
  reply.clearCookie('ourhome_token', {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.cookieSecure,
  });

  return { ok: true };
});

app.get('/api/auth/me', async (request, reply) => {
  try {
    await request.jwtVerify();
    return { authenticated: true, user: request.user };
  } catch {
    return reply.code(401).send({ authenticated: false });
  }
});

app.get('/ws', { websocket: true }, (socket, request) => {
  const queryKey = (request.query as { apiKey?: string }).apiKey;
  const headerKey = request.headers['x-api-key'];
  const apiKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;
  if (queryKey !== env.apiKey && apiKey !== env.apiKey) {
    socket.close();
    return;
  }
  wsClients.add(socket as unknown as WsClient);
  socket.on('close', () => wsClients.delete(socket as unknown as WsClient));
});

const groceryCreateSchema = z.object({ text: z.string().min(1).max(300), list_id: z.number().int().positive().optional() });
const groceryUpdateSchema = z.object({ text: z.string().min(1).max(300).optional(), completed: z.boolean().optional(), list_id: z.number().int().positive().optional() });

app.get('/api/grocery/lists', async () => {
  return db
    .prepare('SELECT id, name, created_at, updated_at FROM grocery_lists ORDER BY id ASC')
    .all();
});

app.post('/api/grocery/lists', async (request, reply) => {
  const parsed = z.object({ name: z.string().min(1).max(120) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid payload' });
  const ts = now();
  try {
    const result = db.prepare('INSERT INTO grocery_lists (name, created_at, updated_at) VALUES (?, ?, ?)').run(parsed.data.name.trim(), ts, ts);
    broadcast('grocery.updated');
    return reply.code(201).send({ id: result.lastInsertRowid, name: parsed.data.name.trim(), created_at: ts, updated_at: ts });
  } catch {
    return reply.code(409).send({ error: 'List name already exists' });
  }
});

app.put('/api/grocery/lists/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const parsed = z.object({ name: z.string().min(1).max(120) }).safeParse(request.body);
  if (!parsed.success || Number.isNaN(id)) return reply.code(400).send({ error: 'Invalid payload' });
  const ts = now();
  try {
    const result = db.prepare('UPDATE grocery_lists SET name = ?, updated_at = ? WHERE id = ?').run(parsed.data.name.trim(), ts, id);
    if (!result.changes) return reply.code(404).send({ error: 'Not found' });
    broadcast('grocery.updated');
    return { id, name: parsed.data.name.trim(), updated_at: ts };
  } catch {
    return reply.code(409).send({ error: 'List name already exists' });
  }
});

app.delete('/api/grocery/lists/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  if (Number.isNaN(id)) return reply.code(400).send({ error: 'Invalid id' });
  if (id === 1) return reply.code(400).send({ error: 'Default list cannot be deleted' });

  const listCount = db.prepare('SELECT COUNT(*) AS total FROM grocery_lists').get() as { total: number };
  if (listCount.total <= 1) return reply.code(400).send({ error: 'Cannot delete the only list' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE grocery_items SET list_id = 1 WHERE list_id = ?').run(id);
    return db.prepare('DELETE FROM grocery_lists WHERE id = ?').run(id);
  });

  const result = tx();
  if (!result.changes) return reply.code(404).send({ error: 'Not found' });
  broadcast('grocery.updated');
  return { ok: true };
});

app.get('/api/grocery', async (request) => {
  const query = z.object({ listId: z.string().optional() }).safeParse(request.query ?? {});
  const listId = query.success && query.data.listId ? Number(query.data.listId) : null;
  const rows = (listId && !Number.isNaN(listId)
    ? db.prepare('SELECT id, list_id, text, completed, created_at, updated_at FROM grocery_items WHERE list_id = ? ORDER BY created_at DESC').all(listId)
    : db.prepare('SELECT id, list_id, text, completed, created_at, updated_at FROM grocery_items ORDER BY created_at DESC').all()) as Array<{
      id: number;
      list_id: number;
      text: string;
      completed: number;
      created_at: string;
      updated_at: string;
    }>;

  return rows.map((r) => ({ ...r, completed: toBool(r.completed) }));
});

app.post('/api/grocery', async (request, reply) => {
  const parsed = groceryCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid payload' });
  const listId = parsed.data.list_id ?? 1;
  const list = db.prepare('SELECT id FROM grocery_lists WHERE id = ?').get(listId) as { id: number } | undefined;
  if (!list) return reply.code(404).send({ error: 'List not found' });
  const ts = now();
  const result = db
    .prepare('INSERT INTO grocery_items (list_id, text, completed, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
    .run(listId, parsed.data.text, ts, ts);
  broadcast('grocery.updated');
  return reply.code(201).send({ id: result.lastInsertRowid, list_id: listId, text: parsed.data.text, completed: false, created_at: ts, updated_at: ts });
});

app.put('/api/grocery/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const parsed = groceryUpdateSchema.safeParse(request.body);
  if (!parsed.success || Number.isNaN(id)) return reply.code(400).send({ error: 'Invalid payload' });

  const existing = db.prepare('SELECT id, list_id, text, completed FROM grocery_items WHERE id = ?').get(id) as
    | { id: number; list_id: number; text: string; completed: number }
    | undefined;
  if (!existing) return reply.code(404).send({ error: 'Not found' });

  const nextText = parsed.data.text ?? existing.text;
  const nextCompleted = parsed.data.completed ?? toBool(existing.completed);
  const nextListId = parsed.data.list_id ?? existing.list_id;
  const list = db.prepare('SELECT id FROM grocery_lists WHERE id = ?').get(nextListId) as { id: number } | undefined;
  if (!list) return reply.code(404).send({ error: 'List not found' });
  const ts = now();

  db.prepare('UPDATE grocery_items SET text = ?, completed = ?, list_id = ?, updated_at = ? WHERE id = ?').run(nextText, nextCompleted ? 1 : 0, nextListId, ts, id);
  broadcast('grocery.updated');
  return { id, list_id: nextListId, text: nextText, completed: nextCompleted, updated_at: ts };
});

app.delete('/api/grocery/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  if (Number.isNaN(id)) return reply.code(400).send({ error: 'Invalid id' });
  const result = db.prepare('DELETE FROM grocery_items WHERE id = ?').run(id);
  if (!result.changes) return reply.code(404).send({ error: 'Not found' });
  broadcast('grocery.updated');
  return { ok: true };
});

const todoCreateSchema = z.object({
  text: z.string().min(1).max(300),
  list_id: z.number().int().positive().optional(),
  due_date: z.string().datetime().optional().or(z.literal('')),
  priority: z.number().int().min(1).max(5).optional(),
});
const todoUpdateSchema = z.object({
  text: z.string().min(1).max(300).optional(),
  completed: z.boolean().optional(),
  list_id: z.number().int().positive().optional(),
  due_date: z.string().datetime().optional().or(z.literal('')),
  priority: z.number().int().min(1).max(5).optional().nullable(),
});

app.get('/api/todos/lists', async () => {
  return db
    .prepare('SELECT id, name, created_at, updated_at FROM todo_lists ORDER BY id ASC')
    .all();
});

app.post('/api/todos/lists', async (request, reply) => {
  const parsed = z.object({ name: z.string().min(1).max(120) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid payload' });
  const ts = now();
  try {
    const result = db.prepare('INSERT INTO todo_lists (name, created_at, updated_at) VALUES (?, ?, ?)').run(parsed.data.name.trim(), ts, ts);
    broadcast('todos.updated');
    return reply.code(201).send({ id: result.lastInsertRowid, name: parsed.data.name.trim(), created_at: ts, updated_at: ts });
  } catch {
    return reply.code(409).send({ error: 'List name already exists' });
  }
});

app.put('/api/todos/lists/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const parsed = z.object({ name: z.string().min(1).max(120) }).safeParse(request.body);
  if (!parsed.success || Number.isNaN(id)) return reply.code(400).send({ error: 'Invalid payload' });
  const ts = now();
  try {
    const result = db.prepare('UPDATE todo_lists SET name = ?, updated_at = ? WHERE id = ?').run(parsed.data.name.trim(), ts, id);
    if (!result.changes) return reply.code(404).send({ error: 'Not found' });
    broadcast('todos.updated');
    return { id, name: parsed.data.name.trim(), updated_at: ts };
  } catch {
    return reply.code(409).send({ error: 'List name already exists' });
  }
});

app.delete('/api/todos/lists/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  if (Number.isNaN(id)) return reply.code(400).send({ error: 'Invalid id' });
  if (id === 1) return reply.code(400).send({ error: 'Default list cannot be deleted' });

  const listCount = db.prepare('SELECT COUNT(*) AS total FROM todo_lists').get() as { total: number };
  if (listCount.total <= 1) return reply.code(400).send({ error: 'Cannot delete the only list' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE todo_items SET list_id = 1 WHERE list_id = ?').run(id);
    return db.prepare('DELETE FROM todo_lists WHERE id = ?').run(id);
  });
  const result = tx();
  if (!result.changes) return reply.code(404).send({ error: 'Not found' });
  broadcast('todos.updated');
  return { ok: true };
});

app.get('/api/todos', async (request) => {
  const query = z.object({ listId: z.string().optional() }).safeParse(request.query ?? {});
  const listId = query.success && query.data.listId ? Number(query.data.listId) : null;
  const rows = (listId && !Number.isNaN(listId)
    ? db.prepare('SELECT id, list_id, text, completed, due_date, priority, created_at, updated_at FROM todo_items WHERE list_id = ? ORDER BY created_at DESC').all(listId)
    : db.prepare('SELECT id, list_id, text, completed, due_date, priority, created_at, updated_at FROM todo_items ORDER BY created_at DESC').all()) as Array<{
      id: number;
      list_id: number;
      text: string;
      completed: number;
      due_date: string | null;
      priority: number | null;
      created_at: string;
      updated_at: string;
    }>;
  return rows.map((r) => ({ ...r, completed: toBool(r.completed) }));
});

app.post('/api/todos', async (request, reply) => {
  const parsed = todoCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid payload' });
  const listId = parsed.data.list_id ?? 1;
  const list = db.prepare('SELECT id FROM todo_lists WHERE id = ?').get(listId) as { id: number } | undefined;
  if (!list) return reply.code(404).send({ error: 'List not found' });
  const ts = now();
  const dueDate = parsed.data.due_date || null;
  const priority = parsed.data.priority ?? null;
  const result = db
    .prepare('INSERT INTO todo_items (list_id, text, completed, due_date, priority, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
    .run(listId, parsed.data.text, dueDate, priority, ts, ts);
  broadcast('todos.updated');
  return reply.code(201).send({ id: result.lastInsertRowid, list_id: listId, text: parsed.data.text, completed: false, due_date: dueDate, priority, created_at: ts, updated_at: ts });
});

app.put('/api/todos/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const parsed = todoUpdateSchema.safeParse(request.body);
  if (!parsed.success || Number.isNaN(id)) return reply.code(400).send({ error: 'Invalid payload' });

  const existing = db
    .prepare('SELECT id, list_id, text, completed, due_date, priority FROM todo_items WHERE id = ?')
    .get(id) as
    | { id: number; list_id: number; text: string; completed: number; due_date: string | null; priority: number | null }
    | undefined;

  if (!existing) return reply.code(404).send({ error: 'Not found' });

  const next = {
    list_id: parsed.data.list_id ?? existing.list_id,
    text: parsed.data.text ?? existing.text,
    completed: parsed.data.completed ?? toBool(existing.completed),
    due_date:
      parsed.data.due_date === undefined ? existing.due_date : parsed.data.due_date === '' ? null : parsed.data.due_date,
    priority: parsed.data.priority === undefined ? existing.priority : parsed.data.priority,
  };

  const list = db.prepare('SELECT id FROM todo_lists WHERE id = ?').get(next.list_id) as { id: number } | undefined;
  if (!list) return reply.code(404).send({ error: 'List not found' });

  const ts = now();
  db.prepare('UPDATE todo_items SET list_id = ?, text = ?, completed = ?, due_date = ?, priority = ?, updated_at = ? WHERE id = ?').run(
    next.list_id,
    next.text,
    next.completed ? 1 : 0,
    next.due_date,
    next.priority,
    ts,
    id
  );
  broadcast('todos.updated');
  return { id, ...next, updated_at: ts };
});

app.delete('/api/todos/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  if (Number.isNaN(id)) return reply.code(400).send({ error: 'Invalid id' });
  const result = db.prepare('DELETE FROM todo_items WHERE id = ?').run(id);
  if (!result.changes) return reply.code(404).send({ error: 'Not found' });
  broadcast('todos.updated');
  return { ok: true };
});

const eventCreateSchema = z.object({
  title: z.string().min(1).max(300),
  start_time: z.string().datetime(),
  end_time: z.string().datetime().optional().or(z.literal('')),
  notes: z.string().optional(),
  location: z.string().max(300).optional(),
  attendees: z.array(z.string().min(1).max(80)).optional(),
});

const eventUpdateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional().or(z.literal('')),
  notes: z.string().optional(),
  location: z.string().max(300).optional(),
  attendees: z.array(z.string().min(1).max(80)).optional(),
});

app.get('/api/events', async () => {
  const rows = db
    .prepare(
      'SELECT id, title, start_time, end_time, notes, location, attendees_json, created_at, updated_at FROM calendar_events ORDER BY start_time ASC'
    )
    .all() as Array<{
      id: number;
      title: string;
      start_time: string;
      end_time: string | null;
      notes: string | null;
      location: string | null;
      attendees_json: string | null;
      created_at: string;
      updated_at: string;
    }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    start_time: row.start_time,
    end_time: row.end_time,
    notes: row.notes,
    location: row.location,
    attendees: parseAttendees(row.attendees_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
});

app.post('/api/events', async (request, reply) => {
  const parsed = eventCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid payload' });

  const ts = now();
  const endTime = parsed.data.end_time || null;
  const location = parsed.data.location?.trim() ? parsed.data.location.trim() : null;
  const attendees = parsed.data.attendees ?? [];
  const attendeesJson = JSON.stringify(attendees);
  const result = db
    .prepare(
      'INSERT INTO calendar_events (title, start_time, end_time, notes, location, attendees_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(parsed.data.title, parsed.data.start_time, endTime, parsed.data.notes ?? null, location, attendeesJson, ts, ts);
  broadcast('events.updated');
  return reply.code(201).send({
    id: result.lastInsertRowid,
    title: parsed.data.title,
    start_time: parsed.data.start_time,
    end_time: endTime,
    notes: parsed.data.notes ?? null,
    location,
    attendees,
    created_at: ts,
    updated_at: ts,
  });
});

app.put('/api/events/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const parsed = eventUpdateSchema.safeParse(request.body);
  if (!parsed.success || Number.isNaN(id)) return reply.code(400).send({ error: 'Invalid payload' });

  const existing = db
    .prepare('SELECT id, title, start_time, end_time, notes, location, attendees_json FROM calendar_events WHERE id = ?')
    .get(id) as
    | {
        id: number;
        title: string;
        start_time: string;
        end_time: string | null;
        notes: string | null;
        location: string | null;
        attendees_json: string | null;
      }
    | undefined;

  if (!existing) return reply.code(404).send({ error: 'Not found' });

  const next = {
    title: parsed.data.title ?? existing.title,
    start_time: parsed.data.start_time ?? existing.start_time,
    end_time:
      parsed.data.end_time === undefined ? existing.end_time : parsed.data.end_time === '' ? null : parsed.data.end_time,
    notes: parsed.data.notes ?? existing.notes,
    location: parsed.data.location === undefined ? existing.location : parsed.data.location,
    attendees:
      parsed.data.attendees === undefined
        ? parseAttendees(existing.attendees_json)
        : parsed.data.attendees,
  };

  const ts = now();
  db.prepare(
    'UPDATE calendar_events SET title = ?, start_time = ?, end_time = ?, notes = ?, location = ?, attendees_json = ?, updated_at = ? WHERE id = ?'
  ).run(
    next.title,
    next.start_time,
    next.end_time,
    next.notes,
    next.location,
    JSON.stringify(next.attendees),
    ts,
    id
  );
  broadcast('events.updated');
  return { id, ...next, updated_at: ts };
});

app.delete('/api/events/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  if (Number.isNaN(id)) return reply.code(400).send({ error: 'Invalid id' });
  const result = db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
  if (!result.changes) return reply.code(404).send({ error: 'Not found' });
  broadcast('events.updated');
  return { ok: true };
});

const noteCreateSchema = z.object({ title: z.string().min(1).max(300), body: z.string().min(1), pinned: z.boolean().optional() });
const noteUpdateSchema = z.object({ title: z.string().min(1).max(300).optional(), body: z.string().min(1).optional(), pinned: z.boolean().optional() });

app.get('/api/notes', async () => {
  const rows = db
    .prepare('SELECT id, title, body, pinned, created_at, updated_at FROM notes ORDER BY pinned DESC, updated_at DESC')
    .all() as Array<{ id: number; title: string; body: string; pinned: number; created_at: string; updated_at: string }>;
  return rows.map((r) => ({ ...r, pinned: toBool(r.pinned) }));
});

app.post('/api/notes', async (request, reply) => {
  const parsed = noteCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid payload' });
  const ts = now();
  const pinned = parsed.data.pinned ?? false;
  const result = db
    .prepare('INSERT INTO notes (title, body, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(parsed.data.title, parsed.data.body, pinned ? 1 : 0, ts, ts);
  broadcast('notes.updated');
  return reply.code(201).send({ id: result.lastInsertRowid, ...parsed.data, pinned, created_at: ts, updated_at: ts });
});

app.put('/api/notes/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const parsed = noteUpdateSchema.safeParse(request.body);
  if (!parsed.success || Number.isNaN(id)) return reply.code(400).send({ error: 'Invalid payload' });

  const existing = db
    .prepare('SELECT id, title, body, pinned FROM notes WHERE id = ?')
    .get(id) as { id: number; title: string; body: string; pinned: number } | undefined;

  if (!existing) return reply.code(404).send({ error: 'Not found' });

  const next = {
    title: parsed.data.title ?? existing.title,
    body: parsed.data.body ?? existing.body,
    pinned: parsed.data.pinned ?? toBool(existing.pinned),
  };
  const ts = now();

  db.prepare('UPDATE notes SET title = ?, body = ?, pinned = ?, updated_at = ? WHERE id = ?').run(
    next.title,
    next.body,
    next.pinned ? 1 : 0,
    ts,
    id
  );
  broadcast('notes.updated');
  return { id, ...next, updated_at: ts };
});

app.delete('/api/notes/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  if (Number.isNaN(id)) return reply.code(400).send({ error: 'Invalid id' });
  const result = db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  if (!result.changes) return reply.code(404).send({ error: 'Not found' });
  broadcast('notes.updated');
  return { ok: true };
});

const widgetSchema = z.object({
  id: z.string(),
  type: z.string(),
  layout: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  settings: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

app.get('/api/dashboard/active', async () => {
  const active = db
    .prepare('SELECT id, name, is_active, created_at, updated_at FROM dashboards WHERE is_active = 1 LIMIT 1')
    .get() as { id: number; name: string; is_active: number; created_at: string; updated_at: string } | undefined;

  if (!active) return null;
  return { ...active, is_active: toBool(active.is_active) };
});

app.put('/api/dashboard/active', async (request, reply) => {
  const body = z.object({ id: z.number().int().positive() }).safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error: 'Invalid payload' });

  const existing = db.prepare('SELECT id FROM dashboards WHERE id = ?').get(body.data.id) as { id: number } | undefined;
  if (!existing) return reply.code(404).send({ error: 'Not found' });

  db.transaction(() => {
    db.prepare('UPDATE dashboards SET is_active = 0, updated_at = ?').run(now());
    db.prepare('UPDATE dashboards SET is_active = 1, updated_at = ? WHERE id = ?').run(now(), body.data.id);
  })();

  broadcast('dashboard.updated');
  return { ok: true };
});

app.get('/api/dashboard/layout', async () => {
  const active = db
    .prepare('SELECT id, name FROM dashboards WHERE is_active = 1 LIMIT 1')
    .get() as { id: number; name: string } | undefined;

  if (!active) return { dashboard: null, widgets: [] };

  const widgets = db
    .prepare('SELECT id, type, layout_json, settings_json FROM dashboard_widgets WHERE dashboard_id = ?')
    .all(active.id) as Array<{ id: number; type: string; layout_json: string; settings_json: string }>;

  return {
    dashboard: active,
    widgets: widgets.map((w) => ({
      id: w.id,
      type: w.type,
      layout: JSON.parse(w.layout_json),
      settings: JSON.parse(w.settings_json),
    })),
  };
});

app.put('/api/dashboard/layout', async (request, reply) => {

  const parsed = z.object({ widgets: z.array(widgetSchema) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid payload' });

  const active = db
    .prepare('SELECT id FROM dashboards WHERE is_active = 1 LIMIT 1')
    .get() as { id: number } | undefined;

  if (!active) return reply.code(500).send({ error: 'No active dashboard' });

  db.transaction(() => {
    db.prepare('DELETE FROM dashboard_widgets WHERE dashboard_id = ?').run(active.id);
    const insert = db.prepare(
      'INSERT INTO dashboard_widgets (dashboard_id, type, layout_json, settings_json) VALUES (?, ?, ?, ?)'
    );

    for (const widget of parsed.data.widgets) {
      insert.run(active.id, widget.type, JSON.stringify(widget.layout), JSON.stringify(widget.settings));
    }
  })();

  broadcast('dashboard.updated');
  return { ok: true };
});

app.setErrorHandler((error, _request, reply) => {
  const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ? ((error as { statusCode: number }).statusCode)
    : undefined;
  const message = error instanceof Error ? error.message : 'Request failed';

  if (statusCode === 401) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  if (statusCode && statusCode < 500) {
    reply.code(statusCode).send({ error: message });
    return;
  }

  app.log.error(error);
  reply.code(500).send({ error: 'Internal server error' });
});

const start = async () => {
  if (env.jwtSecret === 'replace-me') {
    app.log.warn('JWT_SECRET is using default value. Set a secure value before deployment.');
  }

  await app.listen({ host: env.host, port: env.port });
  app.log.info(`OurHome backend listening on http://${env.host}:${env.port}`);
};

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
