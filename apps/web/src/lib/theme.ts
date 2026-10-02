import { useEffect, useState } from "react";
import { storageGet, storageSet } from "./utils";

export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    const meta = document.querySelectorAll('meta[name="theme-color"]');
    for (const m of meta) m.setAttribute("content", dark ? "#0e0e10" : "#ffffff");
  }, [dark]);
  useEffect(() => {
    if (storageGet("pb-theme")) return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const toggle = () =>
    setDark((d) => {
      storageSet("pb-theme", d ? "light" : "dark");
      return !d;
    });
  return { dark, toggle };
}
