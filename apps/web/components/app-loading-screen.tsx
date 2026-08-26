"use client";

import { useEffect, useRef, useState } from "react";

type AppLoadingScreenProps = {
  label?: string;
  detail?: string;
  exiting?: boolean;
};

export default function AppLoadingScreen({
  label = "アプリを準備中",
  detail = "必要なデータを安全に読み込んでいます",
  exiting = false,
}: AppLoadingScreenProps) {
  const [displayedCopy, setDisplayedCopy] = useState({ label, detail });
  const [copyUpdating, setCopyUpdating] = useState(false);
  const copyRef = useRef(displayedCopy);

  useEffect(() => {
    if (copyRef.current.label === label && copyRef.current.detail === detail) return;
    setCopyUpdating(true);
    let frame = 0;
    const timer = window.setTimeout(() => {
      const nextCopy = { label, detail };
      copyRef.current = nextCopy;
      setDisplayedCopy(nextCopy);
      frame = window.requestAnimationFrame(() => setCopyUpdating(false));
    }, 90);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
  }, [detail, label]);

  return <main className="app-loading-screen" data-exiting={exiting} role="status" aria-live="polite" aria-atomic="true">
    <div className="app-loading-content">
      <span className="app-loading-logo" aria-hidden="true" />
      <header className="app-loading-brand" aria-label="株トラ">
        <strong>株トラ</strong>
      </header>
      <div className="app-loading-copy" data-updating={copyUpdating}>
        <p>{displayedCopy.label}</p>
        <small>{displayedCopy.detail}</small>
      </div>
    </div>
  </main>;
}
