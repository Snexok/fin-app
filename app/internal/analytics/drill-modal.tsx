"use client";
// Прогрессивное улучшение drill-down: без JS это обычный раздел страницы (#drill) со ссылкой «Закрыть».
// С JS — модальная шторка: фон inert, фокус внутри (Tab по кругу), Escape и тап по подложке закрывают,
// после закрытия фокус возвращается на этап воронки.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Последний способ ввода (клавиатура/указатель) — чтобы вернуть фокус клавиатурным пользователям и на планшете с клавиатурой. */
let modality: "key" | "pointer" | null = null;
let tracking = false;
function trackModality() {
  if (tracking) return; tracking = true;
  document.addEventListener("keydown", (e) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) modality = "key"; }, true);
  document.addEventListener("pointerdown", () => { modality = "pointer"; }, true);
}

export function DrillModal({ closeHref, stepKey, labelledBy, children }: { closeHref: string; stepKey: string; labelledBy: string; children: ReactNode }) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [modal, setModal] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    trackModality();
    setModal(true);
    const main = document.querySelector<HTMLElement>("main.ia");
    if (main) main.inert = true;
    document.documentElement.classList.add("ia-lock");
    const panel = el.querySelector<HTMLElement>(".ia-sheet");
    panel?.focus({ preventScroll: true });
    const close = () => router.replace(closeHref, { scroll: false });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab" || !panel) return;
      const f = [...panel.querySelectorAll<HTMLElement>("a[href], button, [tabindex='0'], summary")].filter((x) => !x.closest("[inert]"));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (main) main.inert = false;
      document.documentElement.classList.remove("ia-lock");
      // Фокус возвращаем на этап воронки при работе с клавиатуры (в т.ч. планшет с клавиатурой) и на десктопе;
      // после тапа на телефоне — нет: фокус на ссылке включил бы SVG-фолбэк поверх графика.
      if (modality === "key" || !window.matchMedia("(pointer: coarse)").matches) document.querySelector<HTMLElement>(`[data-step="${CSS.escape(stepKey)}"]`)?.focus({ preventScroll: true });
    };
  }, [closeHref, stepKey, router]);
  return (
    <div ref={ref} className={"ia-drillwrap" + (modal ? " modal" : "")} role={modal ? "dialog" : undefined} aria-modal={modal || undefined} aria-labelledby={labelledBy}>
      {children}
    </div>
  );
}
