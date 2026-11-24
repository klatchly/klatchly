import { Fragment, useEffect, useLayoutEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Lazy } from './lazy';
import { allowedReactions, canReact, canReply } from './caps';
import { useConv, type MenuMode } from './convctx';
import { ALL_EMOJI, CATEGORIES, searchEmoji } from './emoji';
import { groupKey, groupReactions, quickReactions, recentReactions, sendableKey } from './reactions';
import { ReactionGlyph } from './MessageItem';
import type { Message } from './types';
import { useT } from './i18n';
import { toPlainText } from '../../server/richtext';
import { snippet } from './format';
import { useSheetDrag } from './sheet';
import { mediaTarget } from './attach';
import { menuActions, type MenuActionID } from './menuactions';
import { canCopyImage, copyImage, prefetchFile, saveFile, shareMode } from './save';
import { canForward, forwardJobOf, startForward } from './forward';

export interface MenuState {
  m: Message;
  /** corner: right-click, the menu's corner sits at the pointer (centred under a button otherwise). */
  at: { x: number; y: number; corner?: boolean } | null;
  mode: MenuMode;
  key?: string;
  /** Link under the pointer (right-click on a link). */
  link?: string;
  /** Index of the attachment under the pointer / finger. */
  att?: number;
}

/** Arrow keys move between the emoji buttons of a grid (rows computed from the layout). */
function gridKeys(e: ReactKeyboardEvent<HTMLDivElement>) {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const btns = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button.emoji-btn')];
  const i = btns.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0 || !btns.length) return;
  e.preventDefault();
  const top0 = btns[0]!.offsetTop;
  const cols = Math.max(1, btns.findIndex((b) => b.offsetTop !== top0) === -1 ? btns.length : btns.findIndex((b) => b.offsetTop !== top0));
  const j =
    e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowUp' ? i - cols : e.key === 'ArrowDown' ? i + cols : e.key === 'Home' ? 0 : btns.length - 1;
  btns[Math.max(0, Math.min(btns.length - 1, j))]!.focus();
}

function EmojiGrid({ list, label, mine, onPick, testid }: { list: string[]; label: string; mine: (e: string) => boolean; onPick: (e: string) => void; testid?: string }) {
  const t = useT();
  return (
    <div className="picker-grid" role="group" aria-label={label} onKeyDown={gridKeys} data-testid={testid}>
      {list.map((e) => (
        <button key={e} type="button" className={`emoji-btn ${mine(e) ? 'mine' : ''}`} aria-label={t.menu.reactWith(e)} aria-pressed={mine(e)} data-testid="picker-emoji" onClick={() => onPick(e)}>
          {e}
        </button>
      ))}
    </div>
  );
}

function EmojiPicker({ allowed, recent, mine, onPick, single }: { allowed?: string[]; recent: string[]; mine: (e: string) => boolean; onPick: (e: string) => void; single: boolean }) {
  const t = useT();
  const [cat, setCat] = useState(0);
  const [q, setQ] = useState('');
  const pool = allowed ?? ALL_EMOJI;
  const results = q.trim() ? searchEmoji(q, pool) : null;
  const category = CATEGORIES[cat]!;
  return (
    <div className="picker" data-testid="emoji-picker">
      <input
        type="search"
        className="picker-search"
        placeholder={t.reactions.search}
        aria-label={t.reactions.search}
        data-testid="picker-search"
        value={q}
        autoFocus={window.matchMedia('(hover: hover) and (pointer: fine)').matches}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.currentTarget.parentElement?.querySelector<HTMLButtonElement>('.picker-grid button')?.focus();
          }
        }}
      />
      {single && <p className="picker-hint">{t.reactions.oneOnly}</p>}
      {results ? (
        results.length ? (
          <EmojiGrid list={results.slice(0, 160)} label={t.reactions.search} mine={mine} onPick={onPick} testid="picker-results" />
        ) : (
          <p className="picker-empty" data-testid="picker-empty">{t.reactions.noResults}</p>
        )
      ) : (
        <div className="picker-scroll">
          {recent.length > 0 && (
            <>
              <h3 className="picker-title">{t.reactions.recent}</h3>
              <EmojiGrid list={recent} label={t.reactions.recent} mine={mine} onPick={onPick} testid="picker-recent" />
            </>
          )}
          {allowed ? (
            <>
              <h3 className="picker-title">{t.reactions.available}</h3>
              <EmojiGrid list={allowed} label={t.reactions.available} mine={mine} onPick={onPick} testid="picker-allowed" />
            </>
          ) : (
            <>
              <div className="picker-tabs" role="tablist" aria-label={t.menu.moreReactions}>
                {CATEGORIES.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    role="tab"
                    aria-selected={i === cat}
                    aria-label={t.reactions.categories[c.id]}
                    title={t.reactions.categories[c.id]}
                    className={i === cat ? 'on' : ''}
                    onClick={() => setCat(i)}
                  >
                    {c.icon}
                  </button>
                ))}
              </div>
              <EmojiGrid list={category.emoji} label={t.reactions.categories[category.id]} mine={mine} onPick={onPick} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Who reacted with what: every pill, or one (groupID), our own reaction first. */
export function Reactors({ m, groupID }: { m: Message; groupID?: string }) {
  const conv = useConv();
  const t = useT();
  const groups = groupReactions(m.reactions, conv.selfIDs).filter((g) => !groupID || g.id === groupID);
  return (
    <div className="reactors-wrap">
      <h3 className="picker-title">{t.reactions.who}</h3>
      <ul className="reactors" data-testid="reactors">
        {groups.map((g) => (
          <li key={g.id}>
            <span className="reactors-key">
              <ReactionGlyph view={g.view} size={22} />
            </span>
            <span className="reactors-names">{g.who.map((id) => conv.nameOf(id)).join(', ')}</span>
            {g.count > 1 && <span className="reaction-n">{g.count}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Message actions: quick reactions + picker, reply, copy (and edit/delete when allowed). */
export function MessageMenu({ state, onClose, extra }: { state: MenuState; onClose: () => void; extra?: (m: Message) => { id: string; label: string; danger?: boolean; run: () => void }[] }) {
  const conv = useConv();
  const t = useT();
  const { m, at, mode } = state;
  const [picker, setPicker] = useState(false);
  // Bottom sheet when there is no anchor (touch): drag down to close.
  const ref = useSheetDrag(!at, onClose);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const reactOk = canReact(conv.chat) && !m.isDeleted;
  // The augmentations' entries (extension.ts MessageMenuSlotProps).
  const menuAugs = conv.augmentations.filter((a) => a.message?.Menu);
  const allowed = allowedReactions(conv.chat);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Anchored popover on desktop (clamped to the viewport); bottom sheet when there is no anchor.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!at || !el) return setPos(null);
    const place = () => {
      const r = el.getBoundingClientRect();
      const gap = at.corner ? 2 : 8;
      // Right-click near the right edge: the menu opens to the left of the pointer, like the browser's.
      const x = at.corner ? (at.x + r.width > window.innerWidth - 8 ? at.x - r.width : at.x) : at.x - r.width / 2;
      const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
      const below = at.y + gap;
      const top = below + r.height > window.innerHeight - 8 ? Math.max(8, at.y - r.height - gap) : below;
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    // Placed again when its size changes after the first paint: the augmentations' entries (lazy) render later.
    if (!('ResizeObserver' in window)) return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [at, picker]);

  const recent = useMemo(() => recentReactions().map((k) => sendableKey(k, conv.chat?.capabilities)).filter((k): k is string => !!k).slice(0, 16), [conv.chat]);
  const quick = useMemo(() => quickReactions(allowed, recent), [allowed, recent]);
  const pick = (key: string) => {
    conv.toggleReaction(m, key);
    onClose();
  };
  const mineGroups = new Set((m.reactions ?? []).filter((r) => conv.selfIDs.has(r.participantID)).map(groupKey));
  const mine = (key: string) => mineGroups.has(groupKey({ reactionKey: key, emoji: true }));

  const target = useMemo(() => (mode === 'full' ? mediaTarget(m, state.att) : undefined), [m, state.att, mode]);
  // iOS: the share sheet needs the file in memory at the tap; fetch it while the menu is open.
  useEffect(() => prefetchFile(target), [target]);

  const actions: ({ id: string; label: string; danger?: boolean; run: () => void } | { id: string; place: 'top' | 'text' })[] = [];
  if (mode === 'full') {
    const ids = menuActions({
      deleted: !!m.isDeleted,
      canReply: canReply(conv.chat),
      hasText: !!m.text?.trim(),
      link: !!state.link,
      anchored: !!at,
      augmented: menuAugs.length > 0,
      augmentedAudio: menuAugs.some((a) => a.audioMenu),
      hasReactions: !!m.reactions?.length,
      media: target && { kind: target.kind, openable: target.openable },
      canCopyImage: canCopyImage(),
      canForward: canForward(m),
    });
    const run: Record<Exclude<MenuActionID, 'augment-top' | 'augment'>, [string, () => void]> = {
      open: [
        t.media.open,
        () => {
          if (!target) return;
          // The bubble's picture, or an album's tile (its link: where the viewer flies from and gives the focus back).
          const el =
            document.querySelector<HTMLElement>(`[data-media-key="${CSS.escape(target.key)}"]`) ??
            document.querySelector<HTMLElement>(`[data-mid="${CSS.escape(m.id)}"] [data-att="${target.index}"]`);
          if (target.kind === 'file') conv.openFile(target, el);
          else conv.openMedia(target.key, el);
        },
      ],
      save: [shareMode() ? t.media.saveShare : t.media.download, () => target && saveFile(target, 'conv')],
      'copy-image': [t.media.copyImage, () => target && copyImage(target, 'conv')],
      reply: [t.menu.reply, () => conv.reply(m)],
      // A message with several attachments forwards the one pressed (and its caption); otherwise the whole message.
      forward: [t.menu.forward, () => startForward(forwardJobOf([{ m, att: state.att !== undefined && (m.attachments?.length ?? 0) > 1 ? state.att : undefined }]))],
      'copy-link': [t.menu.copyLink, () => void navigator.clipboard?.writeText(state.link!).catch(() => {})],
      copy: [t.menu.copy, () => void navigator.clipboard?.writeText(toPlainText(m.text)).catch(() => {})],
      select: [t.menu.selectText, () => conv.openMenu(m, null, 'select')],
      reactions: [t.menu.reactions, () => conv.openMenu(m, at, 'reactors')],
    };
    for (const id of ids) actions.push(id === 'augment-top' || id === 'augment' ? { id, place: id === 'augment' ? 'text' : 'top' } : { id, label: run[id][0], run: run[id][1] });
    actions.push(...(extra?.(m) ?? []));
  }

  return (
    <div className={`menu-backdrop ${at ? '' : 'sheet-backdrop'}`} onClick={onClose} onContextMenu={(e) => mode !== 'select' && e.preventDefault()}>
      <div
        ref={ref}
        className={`msg-menu ${at ? 'popover' : 'sheet'}`}
        role="dialog"
        aria-label={t.menu.label}
        data-testid="message-menu"
        data-menu-mid={m.id}
        data-menu-att={state.att}
        style={at ? { left: pos?.left ?? -9999, top: pos?.top ?? -9999 } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {!at && <div className="sheet-grab" aria-hidden="true" />}
        {!at && mode !== 'select' && (
          <div className="sheet-preview" data-testid="sheet-preview">
            {snippet(m, 140)}
          </div>
        )}
        {mode === 'reactors' ? (
          <Reactors m={m} groupID={state.key} />
        ) : mode === 'select' ? (
          <div className="select-text" data-testid="select-text">
            {toPlainText(m.text)}
          </div>
        ) : (
          <>
            {reactOk && (
              <div className="quick-row">
                {quick.map((e) => (
                  <button key={e} type="button" className={`emoji-btn ${mine(e) ? 'mine' : ''}`} aria-label={t.menu.reactWith(e)} aria-pressed={mine(e)} data-testid="quick-reaction" onClick={() => pick(e)}>
                    {e}
                  </button>
                ))}
                <button type="button" className="emoji-btn more" aria-label={t.menu.moreReactions} data-testid="more-reactions" aria-expanded={picker} onClick={() => setPicker((v) => !v)}>
                  ＋
                </button>
              </div>
            )}
            {picker && <EmojiPicker allowed={allowed} recent={recent} mine={mine} onPick={pick} single={conv.chat?.capabilities?.reactionCount === 1} />}
            {!picker && actions.length > 0 && (
              <ul className="menu-list">
                {actions.map((a) =>
                  'place' in a ? (
                    <Fragment key={a.id}>
                      {menuAugs.map((x) => {
                        const Menu = x.message!.Menu!;
                        const audio = target?.kind === 'audio' && !m.isDeleted;
                        // The menu of an audio attachment without text: only the augmentations that take it (1.23.0).
                        if (audio && !m.text?.trim() && !x.audioMenu) return null;
                        return (
                          <Lazy key={x.id} failed={null}>
                            <Menu
                              chatID={conv.chatID}
                              m={m}
                              place={a.place}
                              anchored={!!at}
                              media={!!target}
                              {...(target?.kind === 'image' || target?.kind === 'gif' ? { image: target.index } : {})}
                              {...(audio && x.audioMenu ? { audio: target.index } : {})}
                              close={onClose}
                            />
                          </Lazy>
                        );
                      })}
                    </Fragment>
                  ) : (
                    <li key={a.id}>
                      <button
                        type="button"
                        data-testid={`menu-${a.id}`}
                        className={a.danger ? 'danger' : ''}
                        onClick={() => {
                          onClose();
                          a.run();
                        }}
                      >
                        {a.label}
                      </button>
                    </li>
                  ),
                )}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
