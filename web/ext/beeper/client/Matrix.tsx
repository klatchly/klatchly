import { useEffect, useRef, useState, type FormEvent } from 'react';
import { HttpError, request, useCatalog, useT } from '../../../client/src/sdk';
import type { ConnectorChatActionProps, ConnectorLinkProps, ConnectorNewChatProps } from '../../../client/src/sdk';
import { beeperMatrix, type BeeperMatrix } from '../locales/index';
import { parseRoomTarget } from '../matrix';

// Joining and leaving Matrix rooms with the Beeper account (its own chunk, loaded on first use): the entry of New chat,
// the dialog of a room's matrix.to link clicked in a message, the confirmation of "Leave room" in the chat menu. The
// server half does the work (server/matrix.ts: /api/beeper/matrix/join and /leave).

type JoinResult = { chatID: string; joined: boolean; ready: boolean; muted: boolean };

const join = (target: string) => request<JoinResult>('POST', '/beeper/matrix/join', { target });

/** false once the component is gone: a join that answers after New chat or the dialog closed opens nothing. */
function useLive() {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return live;
}

function joinError(m: BeeperMatrix, e: unknown): string {
  if (!(e instanceof HttpError)) return m.errGeneric;
  switch (e.code) {
    case 'bad_target':
      return m.badTarget;
    case 'room_forbidden':
      return m.errForbidden;
    case 'room_not_found':
      return m.errNotFound;
    case 'rate_limited':
      return m.errRate;
    case 'join_unavailable':
      return m.errUnavailable;
    case 'room_refused':
      return m.errRefused;
    default:
      return e.status === 429 ? m.errRate : m.errGeneric;
  }
}

/** New chat, on the Beeper account: "Join a Matrix room", then an address field and Join. */
export function JoinEntry({ open }: ConnectorNewChatProps) {
  const m = useCatalog(beeperMatrix);
  const [shown, setShown] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const live = useLive();

  if (!shown) {
    return (
      <button type="button" className="text-btn newchat-more" aria-expanded={false} data-testid="matrix-join-open" onClick={() => setShown(true)}>
        {m.joinOpen}
      </button>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setPending(false);
    if (!parseRoomTarget(input)) return setError(m.badTarget);
    setBusy(true);
    setError(undefined);
    try {
      const r = await join(input.trim());
      // New chat closed meanwhile: the room is joined (it shows in the chats, muted), nothing opens.
      if (!live.current) return;
      if (r.ready) return open(r.chatID);
      setPending(true);
    } catch (err) {
      if (!live.current) return;
      setError(joinError(m, err));
    }
    setBusy(false);
  };

  return (
    <form className="newchat-group" data-testid="matrix-join" onSubmit={(e) => void submit(e)}>
      <div className="newchat-join-row">
        <input
          type="text"
          value={input}
          placeholder={m.joinPlaceholder}
          aria-label={m.joinField}
          aria-invalid={!!error}
          data-testid="matrix-join-input"
          enterKeyHint="go"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={2048}
          autoFocus
          onChange={(e) => {
            setInput(e.target.value);
            setError(undefined);
          }}
        />
        <button type="submit" className="text-btn primary" data-testid="matrix-join-go" disabled={busy || !input.trim()}>
          {busy ? m.joining : m.join}
        </button>
      </div>
      <p className="newchat-hint">{m.joinHint}</p>
      {error && (
        <p className="newchat-error" role="alert" data-testid="matrix-join-error">
          {error}
        </p>
      )}
      {pending && (
        <p className="newchat-note" role="status" data-testid="matrix-join-pending">
          {m.notReady}
        </p>
      )}
    </form>
  );
}

/** A modal <dialog> shown at mount, Escape and the backdrop's cancel closing it. */
function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return ref;
}

/**
 * A matrix.to link to a room, clicked in a message: a room the account is already in opens at once; otherwise the
 * dialog offers to join it (or to open the link in the browser, as before).
 */
export function RoomLinkDialog({ href, open, close }: ConnectorLinkProps) {
  const m = useCatalog(beeperMatrix);
  const t = useT();
  const target = parseRoomTarget(href);
  const ref = useModal();
  // A room id: known to the chat list already? (An alias cannot be told before joining; the server says so then.)
  const [checking, setChecking] = useState(target?.kind === 'id');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const live = useLive();

  useEffect(() => {
    if (!target) return close();
    if (target.kind !== 'id') return;
    let live = true;
    request<{ id?: string }>('GET', `/chats/${encodeURIComponent(target.room)}`).then(
      () => live && open(target.room),
      () => live && setChecking(false),
    );
    return () => {
      live = false;
    };
    // Once, for the link it was opened with.
  }, []);

  if (!target) return null;

  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await join(href);
      // Closed meanwhile (the conversation left behind it): nothing opens.
      if (!live.current) return;
      if (r.ready) return open(r.chatID);
      setPending(true);
    } catch (e) {
      if (!live.current) return;
      setError(joinError(m, e));
    }
    setBusy(false);
  };

  // A bare room id says nothing to a reader: "this Matrix room", the id below it, small.
  const body = checking ? m.linkChecking : pending ? m.notReady : target.kind === 'id' ? m.linkBodyId : m.linkBody(target.room);

  return (
    <dialog
      ref={ref}
      className="confirm"
      aria-label={m.linkTitle}
      data-testid="matrix-link-dialog"
      // A join once sent cannot be called back: no Escape while it runs (Cancel is disabled too).
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      onClose={close}
    >
      <p>{body}</p>
      {!checking && !pending && target.kind === 'id' && (
        <p className="confirm-sub" data-testid="matrix-link-id">
          {target.room}
        </p>
      )}
      {error && (
        <p className="newchat-error" role="alert" data-testid="matrix-link-error">
          {error}
        </p>
      )}
      <div className="confirm-actions">
        <button type="button" className="text-btn" data-testid="matrix-link-cancel" disabled={busy} autoFocus onClick={close}>
          {pending ? t.common.close : t.common.cancel}
        </button>
        {!pending && (
          <button type="button" className="text-btn primary" data-testid="matrix-link-join" disabled={checking || busy} onClick={() => void go()}>
            {busy ? m.joining : m.join}
          </button>
        )}
        <a className="text-btn" href={href} target="_blank" rel="noopener noreferrer nofollow" data-testid="matrix-link-browser" onClick={() => window.setTimeout(close, 0)}>
          {m.linkBrowser}
        </a>
      </div>
    </dialog>
  );
}

/** "Leave room" from the chat menu of a room of the Beeper account: confirmed first. */
export function LeaveDialog({ chat, close, gone, notify }: ConnectorChatActionProps) {
  const m = useCatalog(beeperMatrix);
  const t = useT();
  const ref = useModal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const title = chat.title || chat.id;

  const leave = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await request('POST', '/beeper/matrix/leave', { chatID: chat.id });
      notify(m.left);
      gone();
      close();
    } catch (e) {
      setError(e instanceof HttpError && e.code === 'leave_unavailable' ? m.errLeaveUnavailable : e instanceof HttpError && e.status === 429 ? m.errRate : m.errLeave);
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="confirm" aria-label={m.leaveTitle(title)} data-testid="matrix-leave-dialog" onCancel={close} onClose={close}>
      <p>
        <strong>{m.leaveTitle(title)}</strong>
      </p>
      <p>{m.leaveBody}</p>
      {error && (
        <p className="newchat-error" role="alert" data-testid="matrix-leave-error">
          {error}
        </p>
      )}
      <div className="confirm-actions">
        <button type="button" className="text-btn" data-testid="matrix-leave-cancel" onClick={close}>
          {t.common.cancel}
        </button>
        <button type="button" className="text-btn danger" data-testid="matrix-leave-go" disabled={busy} onClick={() => void leave()}>
          {busy ? m.leaving : m.leave}
        </button>
      </div>
    </dialog>
  );
}
