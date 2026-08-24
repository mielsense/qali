import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import { useQaliSettings } from "@/components/settings/settings-provider";

type Theme = "system" | "light" | "dark";

type ThemeContextValue = Readonly<{
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setTheme(theme: string): void;
}>;

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { snapshot, patch } = useQaliSettings();
  const theme = snapshot.settings.appearance.theme;
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const resolvedTheme =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useLayoutEffect(() => {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(resolvedTheme);
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolvedTheme,
      setTheme(nextTheme) {
        if (
          nextTheme !== "system" &&
          nextTheme !== "light" &&
          nextTheme !== "dark"
        ) {
          return;
        }
        void patch({ appearance: { theme: nextTheme } }).catch(() => {});
      },
    }),
    [patch, resolvedTheme, theme],
  );
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("Theme requires ThemeProvider");
  return context;
}
