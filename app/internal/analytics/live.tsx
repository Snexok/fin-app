"use client";
// Интерактивный слой графиков (ECharts) поверх серверного SVG-фолбэка.
// Код ECharts грузится динамически, только когда график попал в экран, и только на этом маршруте.
// Без JS, до загрузки и при ошибке виден серверный SVG; высоту задаёт он же — без сдвига вёрстки.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChartSpec } from "./live-spec";

export function LiveChart({ spec, children }: { spec: ChartSpec; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();
  // Пересоздаём график только при изменении данных, а не при каждом серверном перерендере (например, открытии шторки).
  const key = JSON.stringify(spec);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => spec, [key]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    setReady(false);
    const start = async () => {
      try {
        const { mount } = await import("./live-echarts");
        if (cancelled) return;
        dispose = mount(el, stable, () => setReady(true), (href) => router.push(href, { scroll: false }));
      } catch {
        /* остаётся серверный SVG */
      }
    };
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { io.disconnect(); void start(); }
    }, { rootMargin: "120px 0px" });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); dispose?.(); };
  }, [stable, router]);
  return (
    <div className={"ia-live" + (ready ? " ready" : "")}>
      {/* Фолбэк остаётся в дереве доступности (таблица/подписи для скринридера); при фокусе с клавиатуры он снова виден. */}
      <div className="fb">{children}</div>
      <div className="cv" ref={box} aria-hidden="true" />
    </div>
  );
}
