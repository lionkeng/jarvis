import type { RouteId } from "./interaction-contract.js";

export interface HashRouter {
  subscribe(onStoreChange: () => void): () => void;
  getSnapshot(): RouteId;
  navigate(route: RouteId): Promise<void>;
  dispose(): void;
}

export function parseRouteHash(hash: string): RouteId {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  switch (path) {
    case "/dashboard":
      return "dashboard";
    case "/library":
      return "library";
    case "/article":
      return "article";
    case "/settings":
      return "settings";
    default:
      return "dashboard";
  }
}

export function createHashRouter(target: Window = window): HashRouter {
  const listeners = new Set<() => void>();
  const onHashChange = () => {
    for (const listener of listeners) listener();
  };

  const subscribe = (onStoreChange: () => void): (() => void) => {
    listeners.add(onStoreChange);
    if (listeners.size === 1) target.addEventListener("hashchange", onHashChange);
    return () => {
      listeners.delete(onStoreChange);
      if (listeners.size === 0) target.removeEventListener("hashchange", onHashChange);
    };
  };

  const getSnapshot = (): RouteId => parseRouteHash(target.location.hash);

  const navigate = async (route: RouteId): Promise<void> => {
    target.location.hash = `#/${route}`;
    onHashChange();
    if (getSnapshot() === route) return;
    await new Promise<void>((resolve) => {
      const unsubscribe = subscribe(() => {
        if (getSnapshot() !== route) return;
        unsubscribe();
        resolve();
      });
    });
  };

  const dispose = (): void => {
    listeners.clear();
    target.removeEventListener("hashchange", onHashChange);
  };

  return { subscribe, getSnapshot, navigate, dispose };
}
