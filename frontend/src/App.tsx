import { PointerEvent, ReactNode, TouchEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import GridLayout, { WidthProvider } from 'react-grid-layout';
import { api, connectWs } from './api';
import type { CalendarEvent, GroceryItem, GroceryList, NoteItem, TodoItem, TodoList } from './types';

const ResponsiveGridLayout = WidthProvider(GridLayout);
const OVERVIEW_LAYOUT_STORAGE_KEY = 'ourhome.overview.layout.v1';
const ACTIVE_WIDGETS_KEY = 'ourhome.overview.widgets.v1';
const SHOW_TIME_THEME_TOGGLES = (import.meta.env.VITE_SHOW_TIME_THEME_TOGGLES ?? '').toLowerCase() === 'true';
type GridLayoutItem = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
};
const HOUSEHOLD_MEMBERS = [
  { id: 'nihal', name: 'Nihal', avatar: '🧑🏽' },
  { id: 'max', name: 'Max', avatar: '🧔🏻' },
];
const HOUSEHOLD_AVATARS = Object.fromEntries(HOUSEHOLD_MEMBERS.map((member) => [member.name, member.avatar])) as Record<string, string>;
type WidgetMeta = {
  id: string;
  label: string;
  icon: string;
  navPage: number;
  defaultLayout: GridLayoutItem;
};

const WIDGET_REGISTRY: WidgetMeta[] = [
  { id: 'grocery', label: 'Grocery Summary', icon: '🛒', navPage: 1, defaultLayout: { i: 'grocery', x: 0, y: 0, w: 2, h: 2, minW: 1, minH: 1 } },
  { id: 'todos',   label: 'Todo Summary',    icon: '✅', navPage: 2, defaultLayout: { i: 'todos',   x: 2, y: 0, w: 2, h: 2, minW: 1, minH: 1 } },
  { id: 'events',  label: 'Event Summary',   icon: '📅', navPage: 3, defaultLayout: { i: 'events',  x: 0, y: 2, w: 2, h: 2, minW: 1, minH: 1 } },
  { id: 'notes',   label: 'Latest Note',     icon: '📝', navPage: 4, defaultLayout: { i: 'notes',   x: 2, y: 2, w: 2, h: 2, minW: 1, minH: 1 } },
];

const DEFAULT_WIDGET_IDS = WIDGET_REGISTRY.map((w) => w.id);

const defaultOverviewLayout: GridLayoutItem[] = WIDGET_REGISTRY.map((w) => w.defaultLayout);

const getInitialActiveWidgets = (): string[] => {
  try {
    const raw = window.localStorage.getItem(ACTIVE_WIDGETS_KEY);
    if (!raw) return DEFAULT_WIDGET_IDS;
    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_WIDGET_IDS;
    return parsed.filter((id) => WIDGET_REGISTRY.some((w) => w.id === id));
  } catch {
    return DEFAULT_WIDGET_IDS;
  }
};

const getInitialOverviewLayout = (): GridLayoutItem[] => {
  try {
    const raw = window.localStorage.getItem(OVERVIEW_LAYOUT_STORAGE_KEY);
    if (!raw) return defaultOverviewLayout;
    const parsed = JSON.parse(raw) as GridLayoutItem[];
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultOverviewLayout;
    return parsed;
  } catch {
    return defaultOverviewLayout;
  }
};

const toInputDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getNextSaturday = (from: Date) => {
  const next = new Date(from);
  const day = next.getDay();
  const distance = (6 - day + 7) % 7 || 7;
  next.setDate(next.getDate() + distance);
  return next;
};

const startOfWeek = (date: Date) => {
  const value = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  value.setDate(value.getDate() - value.getDay());
  return value;
};

const addDays = (date: Date, days: number) => {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
};

const getTimeTheme = (date: Date, sunsetTime: Date | null): 'dawn' | 'morning' | 'afternoon' | 'evening' | 'night' => {
  const hour = date.getHours();
  if (hour >= 5 && hour < 8) return 'dawn';
  if (hour >= 8 && hour < 12) return 'morning';
  const minutesNow = hour * 60 + date.getMinutes();
  const sunsetMinutes = sunsetTime ? sunsetTime.getHours() * 60 + sunsetTime.getMinutes() : 18 * 60;
  if (minutesNow >= 12 * 60 && minutesNow < sunsetMinutes) return 'afternoon';
  if (minutesNow >= sunsetMinutes && minutesNow < 21 * 60) return 'evening';
  return 'night';
};

export function App() {
  return (
    <Routes>
      <Route path="/kiosk" element={<KioskPage />} />
      <Route path="*" element={<Navigate to="/kiosk" replace />} />
    </Routes>
  );
}

function KioskPage() {
  const INACTIVE_MS = 15 * 60 * 1000;
  const weatherLat = Number(import.meta.env.VITE_WEATHER_LAT ?? 47.6376);
  const weatherLon = Number(import.meta.env.VITE_WEATHER_LON ?? -122.3561);

  const swipeStartX = useRef<number | null>(null);
  const swipeStartY = useRef<number | null>(null);
  const swipePointerId = useRef<number | null>(null);
  const swipeHandled = useRef(false);
  const inactivityTimerRef = useRef<number | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [isCustomizingOverview, setIsCustomizingOverview] = useState(false);
  const [overviewLayout, setOverviewLayout] = useState<GridLayoutItem[]>(getInitialOverviewLayout);
  const [activeWidgetIds, setActiveWidgetIds] = useState<string[]>(getInitialActiveWidgets);
  const [clock, setClock] = useState(new Date());
  const [grocery, setGrocery] = useState<GroceryItem[]>([]);
  const [groceryLists, setGroceryLists] = useState<GroceryList[]>([]);
  const [activeGroceryListId, setActiveGroceryListId] = useState<number | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todoLists, setTodoLists] = useState<TodoList[]>([]);
  const [activeTodoListId, setActiveTodoListId] = useState<number | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  const [showFullCalendar, setShowFullCalendar] = useState(false);
  const [eventModalMonthCursor, setEventModalMonthCursor] = useState(new Date());
  const [eventWeekStart, setEventWeekStart] = useState(startOfWeek(new Date()));
  const [kioskEventTitle, setKioskEventTitle] = useState('');
  const [kioskEventDate, setKioskEventDate] = useState('');
  const [kioskEventTime, setKioskEventTime] = useState('');
  const [kioskEventLocation, setKioskEventLocation] = useState('');
  const [kioskEventAttendees, setKioskEventAttendees] = useState<string[]>([]);
  const [newGroceryText, setNewGroceryText] = useState('');
  const [newTodoText, setNewTodoText] = useState('');
  const [newNoteTitle, setNewNoteTitle] = useState('');
  const [newNoteBody, setNewNoteBody] = useState('');
  const [eventHour, setEventHour] = useState('08');
  const [eventMinute, setEventMinute] = useState('00');
  const [isInactive, setIsInactive] = useState(false);
  const [sunriseAt, setSunriseAt] = useState<Date | null>(null);
  const [sunsetAt, setSunsetAt] = useState<Date | null>(null);
  const [forcedTimeTheme, setForcedTimeTheme] = useState<'dawn' | 'morning' | 'afternoon' | 'evening' | 'night' | null>(null);
  const [isDesktopKeyboardMode, setIsDesktopKeyboardMode] = useState(() => window.innerWidth >= 900);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [isKeyboardShifted, setIsKeyboardShifted] = useState(false);
  const activeTextFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const isLowPerformanceDevice = useMemo(() => {
    const coreCount = navigator.hardwareConcurrency ?? 4;
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
    return coreCount <= 4 || memory <= 4;
  }, []);
  const [weather, setWeather] = useState<{
    temperature: number;
    apparentTemperature: number;
    windSpeed: number;
    weatherCode: number;
    updatedAt: string;
  } | null>(null);
  const timeTheme = getTimeTheme(clock, sunsetAt);
  const effectiveTimeTheme = forcedTimeTheme ?? timeTheme;
  const isNightTheme = effectiveTimeTheme === 'night';
  const shouldShowInactiveOverlay = isInactive && isNightTheme;

  const refresh = useCallback(async () => {
    const [groceryResult, todosResult, eventsResult, notesResult] = await Promise.allSettled([
      api.listGrocery(activeGroceryListId ?? undefined),
      api.listTodos(activeTodoListId ?? undefined),
      api.listEvents(),
      api.listNotes(),
    ]);

    if (groceryResult.status === 'fulfilled') setGrocery(groceryResult.value);
    if (todosResult.status === 'fulfilled') setTodos(todosResult.value);
    if (eventsResult.status === 'fulfilled') setEvents(eventsResult.value);
    if (notesResult.status === 'fulfilled') setNotes(notesResult.value);
  }, [activeGroceryListId, activeTodoListId]);

  useEffect(() => {
    const loadLists = async () => {
      const [groceryData, todoData] = await Promise.all([api.listGroceryLists(), api.listTodoLists()]);
      setGroceryLists(groceryData);
      if (!activeGroceryListId && groceryData.length > 0) {
        setActiveGroceryListId(groceryData[0].id);
      }
      setTodoLists(todoData);
      if (!activeTodoListId && todoData.length > 0) {
        setActiveTodoListId(todoData[0].id);
      }
    };

    void loadLists();
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => setClock(new Date()), 30 * 1000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const onResize = () => setIsDesktopKeyboardMode(window.innerWidth >= 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-time-theme', effectiveTimeTheme);
  }, [effectiveTimeTheme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-performance-mode', isLowPerformanceDevice ? 'on' : 'off');
  }, [isLowPerformanceDevice]);

  useEffect(() => {
    const refreshWeather = async () => {
      try {
        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${weatherLat}&longitude=${weatherLon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=sunrise,sunset&forecast_days=1&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`
        );

        if (!response.ok) return;
        const payload = (await response.json()) as {
          current?: {
            temperature_2m: number;
            apparent_temperature: number;
            weather_code: number;
            wind_speed_10m: number;
            time: string;
          };
          daily?: {
            sunrise?: string[];
            sunset?: string[];
          };
        };

        if (!payload.current) return;
        setWeather({
          temperature: payload.current.temperature_2m,
          apparentTemperature: payload.current.apparent_temperature,
          weatherCode: payload.current.weather_code,
          windSpeed: payload.current.wind_speed_10m,
          updatedAt: payload.current.time,
        });
        const sunsetRaw = payload.daily?.sunset?.[0];
        const sunriseRaw = payload.daily?.sunrise?.[0];
        if (sunriseRaw) {
          const parsedSunrise = new Date(sunriseRaw);
          if (!Number.isNaN(parsedSunrise.getTime())) setSunriseAt(parsedSunrise);
        }
        if (sunsetRaw) {
          const parsedSunset = new Date(sunsetRaw);
          if (!Number.isNaN(parsedSunset.getTime())) setSunsetAt(parsedSunset);
        }
      } catch {
        // no-op
      }
    };

    void refreshWeather();
    const weatherTimer = window.setInterval(() => void refreshWeather(), 15 * 60 * 1000);
    return () => window.clearInterval(weatherTimer);
  }, [weatherLat, weatherLon]);

  useEffect(() => {
    const ws = connectWs(() => {
      void refresh();
    });

    return () => ws.close();
  }, [refresh]);

  useEffect(() => {
    if (!isEventModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsEventModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isEventModalOpen]);

  useEffect(() => {
    const root = document.body;
    let hideTimer: number | null = null;

    const scheduleHide = () => {
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        root.classList.add('cursor-hidden');
      }, 5000);
    };

    const showCursor = () => {
      root.classList.remove('cursor-hidden');
      scheduleHide();
    };

    const events: Array<keyof WindowEventMap> = ['pointermove', 'pointerdown', 'mousemove', 'mousedown', 'touchstart'];
    showCursor();
    events.forEach((eventName) => window.addEventListener(eventName, showCursor, { passive: true }));

    return () => {
      events.forEach((eventName) => window.removeEventListener(eventName, showCursor));
      if (hideTimer) window.clearTimeout(hideTimer);
      root.classList.remove('cursor-hidden');
    };
  }, []);

  useEffect(() => {
    if (!isDesktopKeyboardMode) {
      setIsKeyboardVisible(false);
      activeTextFieldRef.current = null;
      return;
    }

    const isSupportedTextField = (node: EventTarget | null): node is HTMLInputElement | HTMLTextAreaElement => {
      if (!(node instanceof HTMLElement)) return false;
      if (node instanceof HTMLTextAreaElement) return true;
      if (node instanceof HTMLInputElement) {
        const supportedTypes = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password']);
        return supportedTypes.has(node.type);
      }
      return false;
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!isSupportedTextField(event.target)) return;
      activeTextFieldRef.current = event.target;
      setIsKeyboardVisible(true);
    };

    const onFocusOut = () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
        setIsKeyboardVisible(false);
        activeTextFieldRef.current = null;
      }, 0);
    };

    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [isDesktopKeyboardMode]);

  const applyKeyboardInput = useCallback(
    (action: string) => {
      const field = activeTextFieldRef.current;
      if (!field) return;

      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      const emitInput = () => field.dispatchEvent(new Event('input', { bubbles: true }));

      if (action === 'close') {
        field.blur();
        setIsKeyboardVisible(false);
        return;
      }

      if (action === 'backspace') {
        if (start !== end) {
          field.setRangeText('', start, end, 'end');
        } else if (start > 0) {
          field.setRangeText('', start - 1, start, 'end');
        }
        emitInput();
        field.focus();
        return;
      }

      if (action === 'space') {
        field.setRangeText(' ', start, end, 'end');
        emitInput();
        field.focus();
        if (isKeyboardShifted) setIsKeyboardShifted(false);
        return;
      }

      if (action === 'enter') {
        if (field instanceof HTMLTextAreaElement) {
          field.setRangeText('\n', start, end, 'end');
          emitInput();
          field.focus();
        }
        return;
      }

      if (action === 'shift') {
        setIsKeyboardShifted((value) => !value);
        return;
      }

      const nextChar = isKeyboardShifted ? action.toUpperCase() : action;
      field.setRangeText(nextChar, start, end, 'end');
      emitInput();
      field.focus();
      if (isKeyboardShifted) setIsKeyboardShifted(false);
    },
    [isKeyboardShifted]
  );

  const openGrocery = grocery.filter((item) => !item.completed);
  const sortedGrocery = useMemo(
    () => [...grocery].sort((a, b) => Number(a.completed) - Number(b.completed)),
    [grocery]
  );
  const sortedTodos = useMemo(
    () => [...todos].sort((a, b) => Number(a.completed) - Number(b.completed)),
    [todos]
  );
  const openTodos = sortedTodos.filter((item) => !item.completed);
  const nextEvent = events.find((e) => new Date(e.start_time) >= new Date());
  const latestNote = notes[0];
  const nowTime = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const oneWeekMs = 7 * oneDayMs;
  const upcomingDayEvents = events.filter((event) => {
    const start = new Date(event.start_time).getTime();
    return start >= nowTime && start <= nowTime + oneDayMs;
  });
  const upcomingWeekEvents = events.filter((event) => {
    const start = new Date(event.start_time).getTime();
    return start >= nowTime && start <= nowTime + oneWeekMs;
  });
  const upcomingTopEvents = useMemo(() => {
    const seen = new Set<number>();
    const merged: Array<CalendarEvent & { windowLabel: '24h' | '7d' }> = [];
    upcomingDayEvents.forEach((event) => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      merged.push({ ...event, windowLabel: '24h' });
    });
    upcomingWeekEvents.forEach((event) => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      merged.push({ ...event, windowLabel: '7d' });
    });
    return merged.slice(0, 14);
  }, [upcomingDayEvents, upcomingWeekEvents]);
  const monthStart = new Date(clock.getFullYear(), clock.getMonth(), 1);
  const monthEnd = new Date(clock.getFullYear(), clock.getMonth() + 1, 0);
  const firstWeekday = monthStart.getDay();
  const totalDays = monthEnd.getDate();
  const eventsByDayKey = useMemo(() => {
    const byDay = new Map<string, CalendarEvent[]>();
    events.forEach((event) => {
      const key = dateKey(new Date(event.start_time));
      const current = byDay.get(key) ?? [];
      current.push(event);
      byDay.set(key, current);
    });
    return byDay;
  }, [events]);
  const eventDayKeys = useMemo(() => new Set(eventsByDayKey.keys()), [eventsByDayKey]);
  const pageLabels = ['Overview', 'Grocery', 'Todos', 'Events', 'Notes'];
  const pageCount = pageLabels.length;
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(eventWeekStart, index)), [eventWeekStart]);
  const modalMonthStart = new Date(eventModalMonthCursor.getFullYear(), eventModalMonthCursor.getMonth(), 1);
  const modalMonthEnd = new Date(eventModalMonthCursor.getFullYear(), eventModalMonthCursor.getMonth() + 1, 0);
  const modalFirstWeekday = modalMonthStart.getDay();
  const modalDaysInMonth = modalMonthEnd.getDate();

  useEffect(() => {
    setKioskEventTime(`${eventHour}:${eventMinute}`);
  }, [eventHour, eventMinute]);

  const resetInactivityTimer = useCallback(() => {
    setIsInactive(false);
    if (inactivityTimerRef.current) {
      window.clearTimeout(inactivityTimerRef.current);
    }
    inactivityTimerRef.current = window.setTimeout(() => {
      setIsInactive(true);
    }, INACTIVE_MS);
  }, [INACTIVE_MS]);

  useEffect(() => {
    const onTouchActivity = () => resetInactivityTimer();
    resetInactivityTimer();
    window.addEventListener('touchstart', onTouchActivity, { passive: true });
    window.addEventListener('pointerdown', onTouchActivity);

    return () => {
      window.removeEventListener('touchstart', onTouchActivity);
      window.removeEventListener('pointerdown', onTouchActivity);
      if (inactivityTimerRef.current) {
        window.clearTimeout(inactivityTimerRef.current);
      }
    };
  }, [resetInactivityTimer]);

  const completeSwipe = useCallback(
    (endX: number, endY: number) => {
      if (swipeStartX.current === null || swipeStartY.current === null) return;
      if (swipeHandled.current) return;

      const deltaX = endX - swipeStartX.current;
      const deltaY = endY - swipeStartY.current;
      const horizontalThreshold = 22;
      const maxVerticalDrift = 100;
      const isHorizontalSwipe = Math.abs(deltaX) >= horizontalThreshold && Math.abs(deltaX) > Math.abs(deltaY);

      if (isHorizontalSwipe && Math.abs(deltaY) <= maxVerticalDrift) {
        if (deltaX < 0) setPageIndex((current) => Math.min(current + 1, pageCount - 1));
        if (deltaX > 0) setPageIndex((current) => Math.max(current - 1, 0));
        swipeHandled.current = true;
      }
    },
    [pageCount]
  );

  const clearSwipeState = () => {
    swipeStartX.current = null;
    swipeStartY.current = null;
    swipePointerId.current = null;
    swipeHandled.current = false;
  };

  const isInteractiveTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest(
        'input, textarea, select, button, [contenteditable="true"], [role="button"], .react-resizable-handle'
      )
    );
  };

  const onSwipePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (pageIndex === 0 && isCustomizingOverview) return;
    if (isInteractiveTarget(event.target)) return;
    if (!event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    swipeStartX.current = event.clientX;
    swipeStartY.current = event.clientY;
    swipePointerId.current = event.pointerId;
    swipeHandled.current = false;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId) === false) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const onSwipePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (swipePointerId.current !== event.pointerId) return;
    if (swipeStartX.current === null || swipeStartY.current === null) return;

    const deltaX = event.clientX - swipeStartX.current;
    const deltaY = event.clientY - swipeStartY.current;
    if (Math.abs(deltaX) > 10 && Math.abs(deltaX) > Math.abs(deltaY)) {
      event.preventDefault();
    }

    if (!swipeHandled.current) {
      completeSwipe(event.clientX, event.clientY);
    }
  };

  const onSwipePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (pageIndex === 0 && isCustomizingOverview) return;
    if (swipePointerId.current !== event.pointerId) return;
    completeSwipe(event.clientX, event.clientY);
    clearSwipeState();
  };

  const onSwipePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (swipePointerId.current !== event.pointerId) return;
    clearSwipeState();
  };

  const onSwipeTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (pageIndex === 0 && isCustomizingOverview) return;
    if (isInteractiveTarget(event.target)) return;
    const touch = event.touches[0];
    if (!touch) return;
    swipeStartX.current = touch.clientX;
    swipeStartY.current = touch.clientY;
    swipeHandled.current = false;
  };

  const onSwipeTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (pageIndex === 0 && isCustomizingOverview) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    completeSwipe(touch.clientX, touch.clientY);
    clearSwipeState();
  };

  const openEventModalForDate = useCallback(
    (date: Date) => {
      const existingTime = kioskEventTime || `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      const [hour, minute] = existingTime.split(':');
      setEventHour(hour ?? '08');
      setEventMinute(minute ?? '00');
      setEventModalMonthCursor(new Date(date.getFullYear(), date.getMonth(), 1));
      setEventWeekStart(startOfWeek(date));
      setShowFullCalendar(false);
      setKioskEventDate(toInputDate(date));
      setIsEventModalOpen(true);
    },
    [kioskEventTime]
  );

  const shiftEventMinutes = useCallback(
    (delta: number) => {
      const base = new Date(`1970-01-01T${eventHour}:${eventMinute}:00`);
      if (Number.isNaN(base.getTime())) return;
      base.setMinutes(base.getMinutes() + delta);
      setEventHour(String(base.getHours()).padStart(2, '0'));
      setEventMinute(String(base.getMinutes()).padStart(2, '0'));
    },
    [eventHour, eventMinute]
  );

  return (
    <main className="kiosk-shell">
      <header className="kiosk-header" onClick={() => setPageIndex(0)} style={{ cursor: pageIndex !== 0 ? 'pointer' : 'default' }}>
        <div className="title-block">
          <p>{clock.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        </div>
        <div className="time-stack">
          <span className="clock">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <div className="header-mini-actions">
            {pageIndex === 0 ? (
              <button
                className="btn btn-muted compact header-mini-btn"
                type="button"
                onClick={(e) => { e.stopPropagation(); setIsCustomizingOverview((current) => !current); }}
              >
                {isCustomizingOverview ? 'Done' : 'Customize layout'}
              </button>
            ) : null}
          </div>
        </div>
        <div className="weather-inline">
          <div className="weather-main">
            <span className="icon">🌤️</span>
            {weather ? `${Math.round(weather.temperature)}°F` : '--°F'} {weather ? weatherCodeLabel(weather.weatherCode) : 'Loading'}
          </div>
          <div className="sun-times">
            <span>☀️ {sunriseAt ? sunriseAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '--:--'}</span>
            <span>🌙 {sunsetAt ? sunsetAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '--:--'}</span>
          </div>
        </div>
      </header>

      <div className="kiosk-content">
        <section
          className="swipe-shell"
          onPointerDownCapture={onSwipePointerDown}
          onPointerMoveCapture={onSwipePointerMove}
          onPointerUpCapture={onSwipePointerUp}
          onPointerCancelCapture={onSwipePointerCancel}
          onTouchStartCapture={onSwipeTouchStart}
          onTouchEndCapture={onSwipeTouchEnd}
        >
          <div className="swipe-track" style={{ transform: `translateX(-${pageIndex * 100}%)` }}>
          <section className="swipe-page">
            <ResponsiveGridLayout
              className={`overview-grid ${isCustomizingOverview ? 'editing' : ''}`}
              layout={overviewLayout.filter((item) => activeWidgetIds.includes(item.i))}
              cols={4}
              rowHeight={118}
              margin={[10, 10]}
              containerPadding={[0, 0]}
              isDraggable={isCustomizingOverview}
              isResizable={isCustomizingOverview}
              onLayoutChange={(layout: GridLayoutItem[]) => {
                setOverviewLayout((prev) => {
                  const inactive = prev.filter((item) => !activeWidgetIds.includes(item.i));
                  const merged = [...inactive, ...layout];
                  window.localStorage.setItem(OVERVIEW_LAYOUT_STORAGE_KEY, JSON.stringify(merged));
                  return merged;
                });
              }}
            >
              {activeWidgetIds.map((id) => {
                const meta = WIDGET_REGISTRY.find((w) => w.id === id)!;
                return (
                  <div key={id} className="overview-grid-item" onClick={() => { if (!isCustomizingOverview) setPageIndex(meta.navPage); }}>
                    {id === 'grocery' && (
                      <Panel title="Grocery Summary" icon="🛒">
                        <div className="overview-tabs">
                          {groceryLists.map((list) => (
                            <button
                              key={`overview-grocery-tab-${list.id}`}
                              className={`tab-btn ${activeGroceryListId === list.id ? 'active' : ''}`}
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setActiveGroceryListId(list.id); }}
                            >
                              {list.name}
                            </button>
                          ))}
                        </div>
                        {sortedGrocery.length === 0 ? (
                          <p className="muted">Nothing pending</p>
                        ) : (
                          sortedGrocery.slice(0, 4).map((item) => (
                            <p key={`overview-grocery-${item.id}`} className="line-item">
                              <span className={item.completed ? 'done' : ''}>- {item.text}</span>
                            </p>
                          ))
                        )}
                      </Panel>
                    )}
                    {id === 'todos' && (
                      <Panel title="Todo Summary" icon="✅">
                        <div className="overview-tabs">
                          {todoLists.map((list) => (
                            <button
                              key={`overview-todo-tab-${list.id}`}
                              className={`tab-btn ${activeTodoListId === list.id ? 'active' : ''}`}
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setActiveTodoListId(list.id); }}
                            >
                              {list.name}
                            </button>
                          ))}
                        </div>
                        {sortedTodos.length === 0 ? (
                          <p className="muted">Nothing pending</p>
                        ) : (
                          sortedTodos.slice(0, 4).map((item) => (
                            <p key={`overview-todo-${item.id}`} className="line-item">
                              <span className={item.completed ? 'done' : ''}>- {item.text}</span>
                            </p>
                          ))
                        )}
                      </Panel>
                    )}
                    {id === 'events' && (
                      <Panel title="Event Summary" icon="📅">
                        {nextEvent ? (
                          <>
                            <p className="line-item">
                              <span>Next event</span>
                              <strong>{nextEvent.title}</strong>
                            </p>
                            <p className="line-item">
                              <span>{new Date(nextEvent.start_time).toLocaleString()}</span>
                            </p>
                          </>
                        ) : (
                          <p className="muted">No upcoming events</p>
                        )}
                      </Panel>
                    )}
                    {id === 'notes' && (
                      <Panel title="Latest Note" icon="📝">
                        {latestNote ? (
                          <p className="line-item">
                            <strong>{latestNote.title}</strong>
                            <span>{latestNote.body}</span>
                          </p>
                        ) : (
                          <p className="muted">No notes yet</p>
                        )}
                      </Panel>
                    )}
                  </div>
                );
              })}
            </ResponsiveGridLayout>
            {isCustomizingOverview && (
              <div className="widget-picker">
                <p className="muted layout-help">Drag cards and use corner handles to resize.</p>
                <div className="widget-picker-list">
                  {WIDGET_REGISTRY.map((meta) => {
                    const isActive = activeWidgetIds.includes(meta.id);
                    return (
                      <button
                        key={meta.id}
                        type="button"
                        className={`tab-btn ${isActive ? 'active' : 'add'}`}
                        onClick={() => {
                          if (isActive) {
                            const next = activeWidgetIds.filter((id) => id !== meta.id);
                            setActiveWidgetIds(next);
                            window.localStorage.setItem(ACTIVE_WIDGETS_KEY, JSON.stringify(next));
                            const nextLayout = overviewLayout.filter((item) => item.i !== meta.id);
                            setOverviewLayout(nextLayout);
                            window.localStorage.setItem(OVERVIEW_LAYOUT_STORAGE_KEY, JSON.stringify(nextLayout));
                          } else {
                            const next = [...activeWidgetIds, meta.id];
                            setActiveWidgetIds(next);
                            window.localStorage.setItem(ACTIVE_WIDGETS_KEY, JSON.stringify(next));
                            const maxY = overviewLayout.reduce((m, item) => Math.max(m, item.y + item.h), 0);
                            const existing = overviewLayout.find((item) => item.i === meta.id);
                            const entry = existing ?? { ...meta.defaultLayout, y: maxY };
                            const nextLayout = [...overviewLayout, entry];
                            setOverviewLayout(nextLayout);
                            window.localStorage.setItem(OVERVIEW_LAYOUT_STORAGE_KEY, JSON.stringify(nextLayout));
                          }
                        }}
                      >
                        {meta.icon} {meta.label} {isActive ? '×' : '+'}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          <section className="swipe-page">
            <div className="widget-page">
              <Panel title="Grocery" icon="🛒">
                <form
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (!newGroceryText.trim()) return;
                    await api.addGrocery(newGroceryText.trim(), activeGroceryListId ?? undefined);
                    setNewGroceryText('');
                    await refresh();
                  }}
                >
                  <div className="tabs-row">
                    {groceryLists.map((list) => (
                      <button
                        key={`grocery-tab-${list.id}`}
                        className={`tab-btn ${activeGroceryListId === list.id ? 'active' : ''}`}
                        type="button"
                        onClick={() => setActiveGroceryListId(list.id)}
                      >
                        {list.name}
                      </button>
                    ))}
                    <button
                      className="tab-btn add"
                      type="button"
                      onClick={async () => {
                        const name = window.prompt('Name for new grocery list (store):');
                        if (!name?.trim()) return;
                        const created = await api.addGroceryList(name.trim());
                        const nextLists = await api.listGroceryLists();
                        setGroceryLists(nextLists);
                        setActiveGroceryListId(created.id);
                        await refresh();
                      }}
                    >
                      + List
                    </button>
                    {activeGroceryListId && activeGroceryListId !== 1 ? (
                      <>
                        <button
                          className="tab-btn subtle"
                          type="button"
                          onClick={async () => {
                            const current = groceryLists.find((list) => list.id === activeGroceryListId);
                            const renamed = window.prompt('Rename list:', current?.name ?? '');
                            if (!renamed?.trim()) return;
                            await api.renameGroceryList(activeGroceryListId, renamed.trim());
                            setGroceryLists(await api.listGroceryLists());
                          }}
                        >
                          Rename
                        </button>
                        <button
                          className="tab-btn subtle danger"
                          type="button"
                          onClick={async () => {
                            if (!window.confirm('Delete this list? Items will move to General.')) return;
                            await api.deleteGroceryList(activeGroceryListId);
                            const nextLists = await api.listGroceryLists();
                            setGroceryLists(nextLists);
                            setActiveGroceryListId(1);
                            await refresh();
                          }}
                        >
                          Delete List
                        </button>
                      </>
                    ) : null}
                  </div>
                  <input
                    placeholder="Add grocery item"
                    value={newGroceryText}
                    onChange={(event) => setNewGroceryText(event.target.value)}
                  />
                  <button className="btn" type="submit">Add</button>
                </form>
                {sortedGrocery.length === 0 ? (
                  <p className="muted">No items</p>
                ) : (
                  <>
                    <div className="items-grid">
                      {sortedGrocery.map((item) => (
                        <div key={item.id} className="row">
                          <label className="checkbox-row grow">
                            <input
                              type="checkbox"
                              checked={item.completed}
                              onChange={() => api.updateGrocery(item.id, { completed: !item.completed }).then(() => refresh())}
                            />
                            <span className={item.completed ? 'done' : ''}>{item.text}</span>
                          </label>
                          <div className="action-buttons">
                            <button
                              className="btn btn-danger icon-delete-btn"
                              type="button"
                              aria-label="Delete item"
                              title="Delete item"
                              onClick={() => api.deleteGrocery(item.id).then(() => refresh())}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="list-footer-action">
                      <button
                        className="btn btn-muted compact"
                        type="button"
                        onClick={async () => {
                          const completedItems = sortedGrocery.filter((item) => item.completed);
                          await Promise.all(completedItems.map((item) => api.updateGrocery(item.id, { completed: false })));
                          await refresh();
                        }}
                      >
                        Uncheck all
                      </button>
                    </div>
                  </>
                )}
              </Panel>
            </div>
          </section>

          <section className="swipe-page">
            <div className="widget-page">
              <Panel title="Todos" icon="✅">
                <form
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (!newTodoText.trim()) return;
                    await api.addTodo(newTodoText.trim(), activeTodoListId ?? undefined);
                    setNewTodoText('');
                    await refresh();
                  }}
                >
                  <div className="tabs-row">
                    {todoLists.map((list) => (
                      <button
                        key={`todo-tab-${list.id}`}
                        className={`tab-btn ${activeTodoListId === list.id ? 'active' : ''}`}
                        type="button"
                        onClick={() => setActiveTodoListId(list.id)}
                      >
                        {list.name}
                      </button>
                    ))}
                    <button
                      className="tab-btn add"
                      type="button"
                      onClick={async () => {
                        const name = window.prompt('Name for new todo list:');
                        if (!name?.trim()) return;
                        const created = await api.addTodoList(name.trim());
                        const nextLists = await api.listTodoLists();
                        setTodoLists(nextLists);
                        setActiveTodoListId(created.id);
                        await refresh();
                      }}
                    >
                      + List
                    </button>
                    {activeTodoListId && activeTodoListId !== 1 ? (
                      <>
                        <button
                          className="tab-btn subtle"
                          type="button"
                          onClick={async () => {
                            const current = todoLists.find((list) => list.id === activeTodoListId);
                            const renamed = window.prompt('Rename list:', current?.name ?? '');
                            if (!renamed?.trim()) return;
                            await api.renameTodoList(activeTodoListId, renamed.trim());
                            setTodoLists(await api.listTodoLists());
                          }}
                        >
                          Rename
                        </button>
                        <button
                          className="tab-btn subtle danger"
                          type="button"
                          onClick={async () => {
                            if (!window.confirm('Delete this list? Items will move to General.')) return;
                            await api.deleteTodoList(activeTodoListId);
                            const nextLists = await api.listTodoLists();
                            setTodoLists(nextLists);
                            setActiveTodoListId(1);
                            await refresh();
                          }}
                        >
                          Delete List
                        </button>
                      </>
                    ) : null}
                  </div>
                  <input
                    placeholder="Add todo"
                    value={newTodoText}
                    onChange={(event) => setNewTodoText(event.target.value)}
                  />
                  <button className="btn" type="submit">Add</button>
                </form>
                {sortedTodos.length === 0 ? (
                  <p className="muted">No todos</p>
                ) : (
                  <>
                    <div className="items-grid">
                      {sortedTodos.map((item) => (
                        <div key={item.id} className="row">
                          <label className="checkbox-row grow">
                            <input
                              type="checkbox"
                              checked={item.completed}
                              onChange={() => api.updateTodo(item.id, { completed: !item.completed }).then(() => refresh())}
                            />
                            <span className={item.completed ? 'done' : ''}>{item.text}</span>
                          </label>
                          <div className="action-buttons">
                            <button
                              className="btn btn-danger icon-delete-btn"
                              type="button"
                              aria-label="Delete item"
                              title="Delete item"
                              onClick={() => api.deleteTodo(item.id).then(() => refresh())}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="list-footer-action">
                      <button
                        className="btn btn-muted compact"
                        type="button"
                        onClick={async () => {
                          const completedItems = sortedTodos.filter((item) => item.completed);
                          await Promise.all(completedItems.map((item) => api.updateTodo(item.id, { completed: false })));
                          await refresh();
                        }}
                      >
                        Uncheck all
                      </button>
                    </div>
                  </>
                )}
              </Panel>
            </div>
          </section>

          <section className="swipe-page">
            <div className="widget-page">
              <Panel title="Events" icon="📅">
                <div className="calendar-events-layout">
                  <section className="events-top-strip">
                    <div className="events-top-header">
                      <h3>Upcoming</h3>
                      <span className="muted">Next 7 days</span>
                    </div>
                    {upcomingTopEvents.length === 0 ? (
                      <p className="muted">No events in the next week.</p>
                    ) : (
                      <div className="events-top-scroll">
                        {upcomingTopEvents.map((event) => (
                          <article key={`top-${event.id}`} className="events-top-card">
                            <div className="events-top-meta">
                              <span className="events-window-pill">{event.windowLabel}</span>
                              <button
                                className="btn btn-danger icon-delete-btn"
                                type="button"
                                aria-label="Delete event"
                                title="Delete event"
                                onClick={() => api.deleteEvent(event.id).then(() => refresh())}
                              >
                                ×
                              </button>
                            </div>
                            <p className="events-top-title">{event.title}</p>
                            <p className="muted events-top-time">{new Date(event.start_time).toLocaleString()}</p>
                            {event.location ? <p className="muted events-top-location">📍 {event.location}</p> : null}
                            {event.attendees?.length ? (
                              <span className="attendee-avatars">
                                {event.attendees.map((name) => (
                                  <span key={`top-attendee-${event.id}-${name}`} className="tiny-avatar" title={name} aria-label={name}>
                                    {HOUSEHOLD_AVATARS[name] ?? '👤'}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="calendar-shell calendar-shell-large">
                    <header className="calendar-header">
                      <strong>{monthStart.toLocaleDateString([], { month: 'long', year: 'numeric' })}</strong>
                      <button
                        className="btn"
                        type="button"
                        onClick={() => openEventModalForDate(kioskEventDate ? new Date(`${kioskEventDate}T00:00:00`) : new Date())}
                      >
                        Add Event
                      </button>
                    </header>
                    <div className="calendar-weekdays">
                      {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
                        <span key={`${day}-${index}`}>{day}</span>
                      ))}
                    </div>
                    <div className="calendar-grid">
                      {Array.from({ length: firstWeekday }).map((_, index) => (
                        <span key={`empty-${index}`} className="calendar-cell empty" />
                      ))}
                      {Array.from({ length: totalDays }).map((_, index) => {
                        const day = index + 1;
                        const dayDate = new Date(clock.getFullYear(), clock.getMonth(), day);
                        const key = dateKey(dayDate);
                        const hasEvent = eventDayKeys.has(key);
                        const dayEvents = eventsByDayKey.get(key) ?? [];
                        const isToday = day === clock.getDate();
                        return (
                          <button
                            key={key}
                            type="button"
                            className={`calendar-cell button-day ${hasEvent ? 'has-event' : ''} ${isToday ? 'today' : ''}`}
                            onClick={() => openEventModalForDate(dayDate)}
                            aria-label={`Add event for ${dayDate.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`}
                            title={`Add event on ${dayDate.toLocaleDateString([], { month: 'short', day: 'numeric' })}`}
                          >
                            <span className="calendar-day-content">
                              <strong className="calendar-day-number">{day}</strong>
                              {dayEvents.length ? (
                                <span className="calendar-day-events">
                                  {dayEvents.slice(0, 2).map((event) => (
                                    <span key={`calendar-day-${key}-${event.id}`} className="calendar-day-chip">
                                      {event.title}
                                    </span>
                                  ))}
                                  {dayEvents.length > 2 ? (
                                    <span className="calendar-day-more">+{dayEvents.length - 2} more</span>
                                  ) : null}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                </div>
              </Panel>
            </div>
          </section>

          <section className="swipe-page">
            <div className="widget-page">
              <Panel title="Notes" icon="📝">
                <form
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (!newNoteTitle.trim() || !newNoteBody.trim()) return;
                    await api.addNote(newNoteTitle.trim(), newNoteBody.trim());
                    setNewNoteTitle('');
                    setNewNoteBody('');
                    await refresh();
                  }}
                >
                  <input
                    placeholder="Note title"
                    value={newNoteTitle}
                    onChange={(event) => setNewNoteTitle(event.target.value)}
                  />
                  <textarea
                    placeholder="Note body"
                    value={newNoteBody}
                    onChange={(event) => setNewNoteBody(event.target.value)}
                  />
                  <button className="btn" type="submit">Add</button>
                </form>
                {notes.length === 0 ? (
                  <p className="muted">No notes</p>
                ) : (
                  notes.map((note) => (
                    <div key={note.id} className="row">
                      <p className="line-item">
                        <strong>{note.title}</strong>
                        <span>{note.body}</span>
                      </p>
                      <div className="action-buttons">
                        <button className="btn btn-danger" type="button" onClick={() => api.deleteNote(note.id).then(() => refresh())}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </Panel>
            </div>
          </section>
          </div>
        </section>

        <div className={`swipe-indicators ${pageIndex === 0 ? 'overview-gap' : 'detail-gap'}`} aria-label="Kiosk pages">
          {pageLabels.map((label, index) => (
            <button
              key={label}
              className={`dot ${pageIndex === index ? 'active' : ''}`}
              type="button"
              onClick={() => setPageIndex(index)}
              aria-label={`${label} page`}
              title={label}
            />
          ))}
        </div>

        <footer className="kiosk-footer">
          {SHOW_TIME_THEME_TOGGLES ? (
            <div className="theme-debug-control">
              <span className="muted">Preview theme</span>
              <div className="theme-debug-chips">
                <button
                  type="button"
                  className={`quick-chip ${forcedTimeTheme === null ? 'selected' : ''}`}
                  onClick={() => setForcedTimeTheme(null)}
                >
                  Auto
                </button>
                {(['dawn', 'morning', 'afternoon', 'evening', 'night'] as const).map((theme) => (
                  <button
                    key={`theme-preview-${theme}`}
                    type="button"
                    className={`quick-chip ${forcedTimeTheme === theme ? 'selected' : ''}`}
                    onClick={() => setForcedTimeTheme(theme)}
                  >
                    {theme[0].toUpperCase() + theme.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </footer>
      </div>

      {isEventModalOpen ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Add calendar event"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsEventModalOpen(false);
            }
          }}
        >
          <div className="modal-card">
            <h2><span className="icon">📅</span>Add Event</h2>
            <form
              className="modal-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!kioskEventTitle.trim() || !kioskEventDate || !kioskEventTime) return;
                const startTimeIso = new Date(`${kioskEventDate}T${kioskEventTime}`).toISOString();
                await api.addEvent({
                  title: kioskEventTitle.trim(),
                  start_time: startTimeIso,
                  location: kioskEventLocation.trim() || undefined,
                  attendees: kioskEventAttendees,
                });
                setKioskEventTitle('');
                setKioskEventDate('');
                setKioskEventTime('');
                setKioskEventLocation('');
                setKioskEventAttendees([]);
                setIsEventModalOpen(false);
                await refresh();
              }}
            >
              <label>
                Event Title
                <input value={kioskEventTitle} onChange={(event) => setKioskEventTitle(event.target.value)} placeholder="Dinner reservation" />
              </label>
              <div className="modal-stack">
                <div className="datetime-field">
                  <span className="field-head"><span className="icon">📆</span>Date</span>
                  <div className="week-nav">
                    <button type="button" className="mini-btn" onClick={() => setEventWeekStart((current) => addDays(current, -7))}>
                      ◀
                    </button>
                    <strong>
                      {eventWeekStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} -{' '}
                      {addDays(eventWeekStart, 6).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </strong>
                    <button type="button" className="mini-btn" onClick={() => setEventWeekStart((current) => addDays(current, 7))}>
                      ▶
                    </button>
                  </div>
                  <div className="week-strip">
                    {weekDays.map((day) => {
                      const value = toInputDate(day);
                      const selected = kioskEventDate === value;
                      const hasEvent = eventDayKeys.has(value);
                      return (
                        <button
                          key={`week-day-${value}`}
                          type="button"
                          className={`week-day-pill ${selected ? 'selected' : ''} ${hasEvent ? 'has-event' : ''}`}
                          onClick={() => setKioskEventDate(value)}
                        >
                          <span>{day.toLocaleDateString([], { weekday: 'short' })}</span>
                          <strong>{day.getDate()}</strong>
                        </button>
                      );
                    })}
                  </div>
                  <div className="quick-chip-row">
                    <button type="button" className="quick-chip" onClick={() => setShowFullCalendar((value) => !value)}>
                      {showFullCalendar ? 'Hide full calendar' : 'Open full calendar'}
                    </button>
                    <button type="button" className="quick-chip" onClick={() => setKioskEventDate(toInputDate(new Date()))}>
                      Today
                    </button>
                    <button type="button" className="quick-chip" onClick={() => setKioskEventDate(toInputDate(new Date(Date.now() + 24 * 60 * 60 * 1000)))}>
                      Tomorrow
                    </button>
                    <button type="button" className="quick-chip" onClick={() => setKioskEventDate(toInputDate(getNextSaturday(new Date())))}>
                      Saturday
                    </button>
                  </div>
                  {showFullCalendar ? (
                    <div className="picker-shell">
                      <div className="month-nav">
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() =>
                            setEventModalMonthCursor(
                              new Date(eventModalMonthCursor.getFullYear(), eventModalMonthCursor.getMonth() - 1, 1)
                            )
                          }
                        >
                          ◀
                        </button>
                        <strong>{modalMonthStart.toLocaleDateString([], { month: 'long', year: 'numeric' })}</strong>
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() =>
                            setEventModalMonthCursor(
                              new Date(eventModalMonthCursor.getFullYear(), eventModalMonthCursor.getMonth() + 1, 1)
                            )
                          }
                        >
                          ▶
                        </button>
                      </div>
                      <div className="calendar-weekdays">
                        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
                          <span key={`${day}-${index}`}>{day}</span>
                        ))}
                      </div>
                      <div className="calendar-grid">
                        {Array.from({ length: modalFirstWeekday }).map((_, index) => (
                          <span key={`modal-empty-${index}`} className="calendar-cell empty" />
                        ))}
                        {Array.from({ length: modalDaysInMonth }).map((_, index) => {
                          const day = index + 1;
                          const dayDate = new Date(eventModalMonthCursor.getFullYear(), eventModalMonthCursor.getMonth(), day);
                          const value = toInputDate(dayDate);
                          const selected = kioskEventDate === value;
                          return (
                            <button
                              key={`modal-day-${value}`}
                              type="button"
                              className={`calendar-cell button-day ${selected ? 'selected' : ''}`}
                              onClick={() => {
                                setKioskEventDate(value);
                                setEventWeekStart(startOfWeek(dayDate));
                              }}
                            >
                              {day}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="datetime-field">
                  <span className="field-head"><span className="icon">🕒</span>Time</span>
                  <div className="time-touch-controls">
                    <button type="button" className="btn btn-muted compact" onClick={() => shiftEventMinutes(-15)}>
                      -15 min
                    </button>
                    <button type="button" className="btn btn-muted compact" onClick={() => shiftEventMinutes(15)}>
                      +15 min
                    </button>
                  </div>
                  <label className="time-input-label">
                    <span className="muted">Tap to set time</span>
                    <input
                      className="touch-time-input"
                      type="time"
                      step={300}
                      value={`${eventHour}:${eventMinute}`}
                      onChange={(event) => {
                        const [hour, minute] = event.target.value.split(':');
                        if (!hour || !minute) return;
                        setEventHour(hour);
                        setEventMinute(minute);
                      }}
                    />
                  </label>
                  <p className="time-preview">Selected: {formatTimeLabel(`${eventHour}:${eventMinute}`)}</p>
                  <div className="quick-chip-row">
                    {[
                      { label: '8:00 AM', value: '08:00' },
                      { label: '12:00 PM', value: '12:00' },
                      { label: '3:00 PM', value: '15:00' },
                      { label: '6:00 PM', value: '18:00' },
                      { label: '8:00 PM', value: '20:00' },
                    ].map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`quick-chip ${kioskEventTime === option.value ? 'selected' : ''}`}
                        onClick={() => {
                          const [hour, minute] = option.value.split(':');
                          setEventHour(hour);
                          setEventMinute(minute);
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <label>
                Location
                <input
                  value={kioskEventLocation}
                  onChange={(event) => setKioskEventLocation(event.target.value)}
                  placeholder="Queen Anne Library"
                />
              </label>
              <div>
                <p className="muted modal-label">Who is this for?</p>
                <div className="avatar-grid">
                  {HOUSEHOLD_MEMBERS.map((member) => {
                    const selected = kioskEventAttendees.includes(member.name);
                    return (
                      <button
                        key={member.id}
                        type="button"
                        className={`avatar-pill ${selected ? 'selected' : ''}`}
                        onClick={() =>
                          setKioskEventAttendees((current) =>
                            current.includes(member.name)
                              ? current.filter((name) => name !== member.name)
                              : [...current, member.name]
                          )
                        }
                      >
                        <span className="avatar">{member.avatar}</span>
                        <span>{member.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn btn-muted" type="button" onClick={() => setIsEventModalOpen(false)}>Cancel</button>
                <button className="btn" type="submit">Save Event</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      {isDesktopKeyboardMode && isKeyboardVisible ? (
        <div className="onscreen-keyboard" role="toolbar" aria-label="On-screen keyboard">
          {[
            ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'backspace'],
            ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
            ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'enter'],
            ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'space', 'close'],
          ].map((row, rowIndex) => (
            <div key={`keyboard-row-${rowIndex}`} className={`keyboard-row keyboard-row-${rowIndex}`}>
              {row.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`keyboard-key ${key === 'space' ? 'space' : ''} ${key === 'shift' && isKeyboardShifted ? 'active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyKeyboardInput(key)}
                >
                  {key === 'backspace'
                    ? '⌫'
                    : key === 'enter'
                      ? '⏎'
                      : key === 'shift'
                        ? '⇧'
                        : key === 'close'
                          ? 'Done'
                          : key === 'space'
                            ? 'Space'
                            : isKeyboardShifted
                              ? key.toUpperCase()
                              : key}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {shouldShowInactiveOverlay ? <div className="inactive-dim-overlay" aria-hidden="true" /> : null}
    </main>
  );
}

function weatherCodeLabel(code: number) {
  if (code === 0) return 'Clear';
  if ([1, 2, 3].includes(code)) return 'Cloudy';
  if ([45, 48].includes(code)) return 'Foggy';
  if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
  if ([95, 96, 99].includes(code)) return 'Stormy';
  return 'Unknown';
}

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimeLabel(time: string) {
  return new Date(`1970-01-01T${time}`).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function Panel({ title, icon, children }: { title: string; icon?: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2>{icon ? <span className="icon">{icon}</span> : null} {title}</h2>
      {children}
    </section>
  );
}
