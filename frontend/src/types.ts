export type GroceryItem = {
  id: number;
  list_id: number;
  text: string;
  completed: boolean;
  created_at: string;
  updated_at: string;
};

export type GroceryList = {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
};

export type TodoItem = {
  id: number;
  list_id: number;
  text: string;
  completed: boolean;
  due_date: string | null;
  priority: number | null;
  created_at: string;
  updated_at: string;
};

export type TodoList = {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
};

export type CalendarEvent = {
  id: number;
  title: string;
  start_time: string;
  end_time: string | null;
  notes: string | null;
  location?: string | null;
  attendees?: string[];
  created_at: string;
  updated_at: string;
};

export type NoteItem = {
  id: number;
  title: string;
  body: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
};
