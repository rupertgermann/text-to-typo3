"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "text-to-typo3-theme";
type Theme = "light" | "dark";
const themeListeners = new Set<() => void>();

function getStoredTheme(): Theme | null {
  if (typeof window === "undefined") {
    return null;
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : null;
}

function getPreferredTheme(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }

  const stored = getStoredTheme();
  if (stored) {
    return stored;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function syncDocumentTheme(theme = getPreferredTheme()) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

function notifyThemeListeners() {
  for (const listener of themeListeners) {
    listener();
  }
}

function applyTheme(theme: Theme) {
  syncDocumentTheme(theme);
  window.localStorage.setItem(STORAGE_KEY, theme);
  notifyThemeListeners();
}

function subscribeToTheme(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  themeListeners.add(onStoreChange);

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleThemeChange = () => {
    syncDocumentTheme();
    onStoreChange();
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      handleThemeChange();
    }
  };

  window.addEventListener("storage", handleStorage);
  mediaQuery.addEventListener("change", handleThemeChange);

  return () => {
    themeListeners.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
    mediaQuery.removeEventListener("change", handleThemeChange);
  };
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(
    subscribeToTheme,
    getPreferredTheme,
    () => "light",
  );

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-9 gap-2"
      onClick={() => {
        const nextTheme = theme === "dark" ? "light" : "dark";
        applyTheme(nextTheme);
      }}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      <span className="hidden md:inline">{theme === "dark" ? "Light" : "Dark"}</span>
    </Button>
  );
}
