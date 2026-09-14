"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { resilientBrowserStorage, safeLocalStorage } from "./dashboard/helpers";

const PreferenceStorage = createContext<Storage>(safeLocalStorage);
export function BrowserPreferences({ persistent, namespace, children }: { persistent: boolean; namespace?: string; children: ReactNode }) {
  const storage = useMemo(() => resilientBrowserStorage(persistent ? "localStorage" : "memory", namespace ? `kabutora:${namespace}:` : ""), [namespace, persistent]);
  return <PreferenceStorage.Provider value={storage}>{children}</PreferenceStorage.Provider>;
}
export const useBrowserPreferences = () => useContext(PreferenceStorage);
