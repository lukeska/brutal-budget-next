import { type ComponentType, createElement, useSyncExternalStore } from "react";

export type EntryKind = "expense" | "income" | "transfer";

export type DrawerState =
  | { open: false; mode: "create"; kind: EntryKind; entryId?: undefined }
  | { open: true; mode: "create"; kind: EntryKind; entryId?: undefined }
  | { open: true; mode: "edit"; kind: EntryKind; entryId: string };

const CLOSED: DrawerState = { open: false, mode: "create", kind: "expense" };

let state: DrawerState = CLOSED;
let registered: ComponentType | null = null;
const listeners = new Set<() => void>();

function set(next: DrawerState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const drawerStore = {
  get: (): DrawerState => state,
  subscribe,
  openCreate(kind: EntryKind = "expense") {
    set({ open: true, mode: "create", kind });
  },
  /** The drawer loads the entry and corrects `kind` once it knows it. */
  openEdit(entryId: string, kind: EntryKind = "expense") {
    set({ open: true, mode: "edit", kind, entryId });
  },
  close() {
    set({ ...CLOSED, kind: state.kind });
  },
};

export const { openCreate, openEdit, close: closeDrawer } = drawerStore;

export function useDrawer(): DrawerState {
  return useSyncExternalStore(subscribe, drawerStore.get, drawerStore.get);
}

/** Plugs the entry drawer into the shell. The component reads `useDrawer()` itself. */
export function registerDrawer(component: ComponentType): void {
  registered = component;
  for (const listener of listeners) listener();
}

const getRegistered = () => registered;

/** Mounted once by the root layout; renders the registered drawer, or nothing. */
export function DrawerHost() {
  const Component = useSyncExternalStore(subscribe, getRegistered, getRegistered);
  return Component ? createElement(Component) : null;
}
