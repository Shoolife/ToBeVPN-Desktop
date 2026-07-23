import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyText } from "../clipboard";
import "./CopyNotification.css";

type CopyNotice = {
  id: number;
  message: string;
};

const NOTICE_DURATION_MS = 2100;

export function useCopyNotification() {
  const [notice, setNotice] = useState<CopyNotice | null>(null);
  const noticeIdRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copyWithNotification = useCallback(
    async (value: string, message: string): Promise<boolean> => {
      const copied = await copyText(value);
      if (!copied) return false;

      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      const nextNotice = {
        id: ++noticeIdRef.current,
        message,
      };
      setNotice(nextNotice);
      timerRef.current = window.setTimeout(() => {
        setNotice((current) =>
          current?.id === nextNotice.id ? null : current,
        );
        timerRef.current = null;
      }, NOTICE_DURATION_MS);
      return true;
    },
    [],
  );

  return { notice, copyWithNotification };
}

export default function CopyNotification({
  notice,
}: {
  notice: CopyNotice | null;
}) {
  if (!notice) return null;

  const target = document.getElementById("overlay-root") ?? document.body;
  return createPortal(
    <div
      key={notice.id}
      className="copy-notification"
      role="status"
      aria-live="polite"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <span>{notice.message}</span>
    </div>,
    target,
  );
}
