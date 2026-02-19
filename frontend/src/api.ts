import type { CalendarEvent, GroceryItem, GroceryList, NoteItem, TodoItem, TodoList } from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';
const API_KEY = import.meta.env.VITE_API_KEY ?? 'ILoveNihal';
const normalizedBase = API_BASE_URL.replace(/\/+$/, '');
const baseWithApiStripped = normalizedBase.endsWith('/api') ? normalizedBase.slice(0, -4) : normalizedBase;

const buildApiUrl = (path: string) => {
  const normalizedPath = normalizedBase.endsWith('/api') && path.startsWith('/api/') ? path.slice(4) : path;
  return `${normalizedBase}${normalizedPath}`;
};

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const headers: Record<string, string> = {
    'x-api-key': API_KEY,
  };
  const hasJsonBody = typeof init?.body === 'string' && init.body.length > 0;
  if (hasJsonBody) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(buildApiUrl(path), {
    ...init,
    credentials: 'include',
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
};

export const api = {
  baseUrl: normalizedBase,
  login: (username: string, password: string) =>
    json<{ id: number; username: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => json<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  me: () => json<{ authenticated: boolean; user?: { username: string } }>('/api/auth/me'),

  listGroceryLists: () => json<GroceryList[]>('/api/grocery/lists'),
  addGroceryList: (name: string) =>
    json<GroceryList>('/api/grocery/lists', { method: 'POST', body: JSON.stringify({ name }) }),
  renameGroceryList: (id: number, name: string) =>
    json<GroceryList>(`/api/grocery/lists/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteGroceryList: (id: number) => json<{ ok: true }>(`/api/grocery/lists/${id}`, { method: 'DELETE' }),

  listGrocery: (listId?: number) => json<GroceryItem[]>(listId ? `/api/grocery?listId=${listId}` : '/api/grocery'),
  addGrocery: (text: string, list_id?: number) =>
    json<GroceryItem>('/api/grocery', { method: 'POST', body: JSON.stringify({ text, ...(list_id ? { list_id } : {}) }) }),
  updateGrocery: (id: number, data: Partial<Pick<GroceryItem, 'text' | 'completed'>>) =>
    json<GroceryItem>(`/api/grocery/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteGrocery: (id: number) => json<{ ok: true }>(`/api/grocery/${id}`, { method: 'DELETE' }),

  listTodoLists: () => json<TodoList[]>('/api/todos/lists'),
  addTodoList: (name: string) =>
    json<TodoList>('/api/todos/lists', { method: 'POST', body: JSON.stringify({ name }) }),
  renameTodoList: (id: number, name: string) =>
    json<TodoList>(`/api/todos/lists/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteTodoList: (id: number) => json<{ ok: true }>(`/api/todos/lists/${id}`, { method: 'DELETE' }),

  listTodos: (listId?: number) => json<TodoItem[]>(listId ? `/api/todos?listId=${listId}` : '/api/todos'),
  addTodo: (text: string, list_id?: number) =>
    json<TodoItem>('/api/todos', { method: 'POST', body: JSON.stringify({ text, ...(list_id ? { list_id } : {}) }) }),
  updateTodo: (id: number, data: Partial<Pick<TodoItem, 'text' | 'completed' | 'due_date' | 'priority' | 'list_id'>>) =>
    json<TodoItem>(`/api/todos/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTodo: (id: number) => json<{ ok: true }>(`/api/todos/${id}`, { method: 'DELETE' }),

  listEvents: () => json<CalendarEvent[]>('/api/events'),
  addEvent: (payload: {
    title: string;
    start_time: string;
    location?: string;
    attendees?: string[];
    end_time?: string;
    notes?: string;
  }) => json<CalendarEvent>('/api/events', { method: 'POST', body: JSON.stringify(payload) }),
  deleteEvent: (id: number) => json<{ ok: true }>(`/api/events/${id}`, { method: 'DELETE' }),

  listNotes: () => json<NoteItem[]>('/api/notes'),
  addNote: (title: string, body: string) => json<NoteItem>('/api/notes', { method: 'POST', body: JSON.stringify({ title, body }) }),
  deleteNote: (id: number) => json<{ ok: true }>(`/api/notes/${id}`, { method: 'DELETE' }),
};

export const connectWs = (onEvent: (type: string) => void): WebSocket => {
  const wsUrl = baseWithApiStripped.startsWith('https://')
    ? baseWithApiStripped.replace('https://', 'wss://')
    : baseWithApiStripped.replace('http://', 'ws://');

  const ws = new WebSocket(`${wsUrl}/ws?apiKey=${encodeURIComponent(API_KEY)}`);
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as { type?: string };
      if (data.type) onEvent(data.type);
    } catch {
      // no-op
    }
  };

  return ws;
};
