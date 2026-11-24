import { useRef, useState } from 'react';
import { useT } from './i18n';
import { Lazy, lazyChunk } from './lazy';
import { phoneLayout } from './nav';

// The "new conversation" button of the list header; the panel (NewChat.tsx) is its own chunk.
const NewChatPanel = lazyChunk(() => import('./NewChat'), 'NewChatPanel');

const asSheet = () => phoneLayout() || window.matchMedia('(pointer: coarse)').matches;

export function NewChatButton() {
  const t = useT();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<{ sheet: boolean; anchor?: DOMRect } | null>(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="icon-btn"
        aria-label={t.newChat.open}
        title={t.newChat.open}
        aria-haspopup="dialog"
        aria-expanded={!!open}
        data-testid="new-chat"
        onPointerDown={NewChatPanel.preload}
        onClick={() => setOpen({ sheet: asSheet(), anchor: btn.current?.getBoundingClientRect() })}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M17.6 3.4a2 2 0 0 1 2.9 2.9L12 14.8l-3.8 1 1-3.8z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <Lazy failed={null} onError={() => setOpen(null)}>
          <NewChatPanel
            sheet={open.sheet}
            anchor={open.anchor}
            onClose={(opened) => {
              setOpen(null);
              if (!opened) btn.current?.focus();
            }}
          />
        </Lazy>
      )}
    </>
  );
}
