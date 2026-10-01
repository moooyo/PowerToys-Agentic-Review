import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useColorMode } from "../theme";
import "./preferences.css";

type ConsoleLanguage = "zh" | "en";

interface ConsolePreferences {
  language: ConsoleLanguage;
  setLanguage: (language: ConsoleLanguage) => void;
  text: (zh: string, en: string) => string;
}

const PreferencesContext = createContext<ConsolePreferences>({
  language: "en",
  setLanguage: () => {},
  text: (_zh, en) => en,
});

export function ConsolePreferencesProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<ConsoleLanguage>(() => {
    try {
      return typeof window !== "undefined" &&
        window.localStorage.getItem("agentic-review-language") === "en"
        ? "en"
        : "zh";
    } catch {
      return "zh";
    }
  });
  const text = useCallback((zh: string, en: string) => (language === "zh" ? zh : en), [language]);
  const value = useMemo(() => ({ language, setLanguage, text }), [language, text]);
  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    try {
      window.localStorage.setItem("agentic-review-language", language);
    } catch {
      // Language switching remains available when browser storage is unavailable.
    }
  }, [language]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export const useConsolePreferences = () => useContext(PreferencesContext);

export function ConsoleIcon({
  name,
  size = 24,
  filled = false,
  className,
}: {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`console-icon${className ? ` ${className}` : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: size,
        fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' 24`,
      }}
    >
      {name}
    </span>
  );
}

export function LanguageToggle() {
  const { language, setLanguage, text } = useConsolePreferences();
  return (
    <fieldset className="console-language-toggle" aria-label={text("语言", "Language")}>
      <button type="button" aria-pressed={language === "zh"} onClick={() => setLanguage("zh")}>
        中文
      </button>
      <button type="button" aria-pressed={language === "en"} onClick={() => setLanguage("en")}>
        EN
      </button>
    </fieldset>
  );
}

export function ThemeToggle() {
  const { mode, toggle } = useColorMode();
  const { text } = useConsolePreferences();
  const label = mode === "light" ? text("深色模式", "Dark mode") : text("浅色模式", "Light mode");
  return (
    <button
      className="console-theme-toggle"
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
    >
      <ConsoleIcon name={mode === "light" ? "dark_mode" : "light_mode"} size={22} />
    </button>
  );
}
