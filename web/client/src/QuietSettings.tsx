import { useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { chatsQuery } from './cache';
import { useT } from './i18n';
import { NetworkBadge, networkName } from './networks';
import { MoonIcon, resetChatQuiet, RuleEditor, ruleText, setAccountQuiet, setChatQuiet, useQuiet } from './quiet';
import type { QuietRule } from '../../server/quiethours';
import { Note } from './Settings';
// The rows and the lead are Discreet reading's (the same layout: a network per row, its switch on the right).
import './reading.css';

// Settings → Quiet hours (quiet.tsx, server/quiet.ts): per network a switch and, on, its hours (from, to, days);
// then the chats that have their own setting (set from a chat's menu), each back to its network's in one tap.

export function QuietSettings() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuiet();
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();
  // An account whose switch was just turned on: its editor shows before it has a rule.
  const [opening, setOpening] = useState<string>();
  const data = q.data;
  const chatTitles = useChatTitles();

  const change = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    setNote(undefined);
    try {
      await run();
    } catch {
      setNote(t.quiet.failed);
    } finally {
      setBusy(undefined);
    }
  };

  const ownChats = Object.entries(data?.chats ?? {});
  return (
    <>
      <div className="reading-lead" data-testid="quiet-lead">
        <span className="reading-lead-mark quiet-mark">
          <MoonIcon size={22} />
        </span>
        <div className="reading-lead-text">
          <p>{t.quiet.intro}</p>
          <p className="settings-hint">{t.quiet.levels}</p>
          <p className="settings-hint">{t.quiet.phone}</p>
        </div>
      </div>

      <h2 className="set-group-title" id="quiet-accounts-title">
        {t.quiet.perAccount}
      </h2>
      <div className="set-group" data-testid="quiet-accounts" role="group" aria-labelledby="quiet-accounts-title">
        {data && !data.list.length && <p className="settings-hint reading-empty-line">{t.quiet.none}</p>}
        {data?.list.map((a, i) => {
          const block = `quiet-${i}`;
          const rule = data.accounts[a.accountID];
          const network = a.network ? networkName(a.network) : a.accountID;
          const label = a.name ? `${network} · ${a.name}` : network;
          const on = !!rule || opening === a.accountID;
          return (
            <div key={a.accountID} className="set-row reading-account" data-block={block} data-testid={`settings-${block}`} role="group" aria-labelledby={`set-l-${block}`}>
              <span className="reading-net" aria-hidden="true">
                {a.network ? <NetworkBadge network={a.network} size={20} /> : <MoonIcon size={18} />}
              </span>
              <div className="set-text">
                <h3 className="set-label" id={`set-l-${block}`}>
                  {network}
                  {a.name && <span className="reading-who"> {a.name}</span>}
                </h3>
                <p className="settings-hint" data-testid={`quiet-state-${a.accountID}`}>
                  {rule ? ruleText(t, rule) : ' '}
                </p>
              </div>
              <div className="set-control">
                <button
                  type="button"
                  role="switch"
                  className="ext-switch"
                  aria-checked={on}
                  aria-label={t.quiet.on(label)}
                  data-testid={`quiet-toggle-${a.accountID}`}
                  disabled={busy !== undefined}
                  onClick={() => {
                    if (on) {
                      setOpening(undefined);
                      if (rule) void change(a.accountID, () => setAccountQuiet(qc, a.accountID, null));
                    } else setOpening(a.accountID);
                  }}
                >
                  <span aria-hidden="true" />
                </button>
              </div>
              {on && (
                <div className="set-detail">
                  <RuleEditor
                    key={rule ? JSON.stringify(rule) : 'new'}
                    rule={rule}
                    busy={busy !== undefined}
                    testid={`quiet-rule-${a.accountID}`}
                    onSave={(r: QuietRule) =>
                      void change(a.accountID, async () => {
                        await setAccountQuiet(qc, a.accountID, r);
                        setOpening(undefined);
                      })
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Note text={note} />

      <h2 className="set-group-title" id="quiet-chats-title">
        {t.quiet.chats}
      </h2>
      <div className="set-group" data-testid="quiet-chats" role="group" aria-labelledby="quiet-chats-title">
        {!ownChats.length && <p className="settings-hint reading-empty-line">{t.quiet.noChats}</p>}
        {ownChats.map(([id, r], i) => (
          <div key={id} className="set-row" data-testid={`quiet-chat-${i}`}>
            <div className="set-text">
              <h3 className="set-label">{chatTitles.get(id) ?? id}</h3>
              <p className="settings-hint">{r === false ? t.quiet.never : ruleText(t, r)}</p>
            </div>
            <div className="set-control">
              <button type="button" className="text-btn" disabled={busy !== undefined} data-testid={`quiet-chat-reset-${i}`} onClick={() => void change(id, () => setChatQuiet(qc, id, null))}>
                {t.quiet.resetChats}
              </button>
            </div>
          </div>
        ))}
        {ownChats.length > 1 && (
          <div className="set-row">
            <div className="set-control">
              <button type="button" className="text-btn" disabled={busy !== undefined} data-testid="quiet-chats-reset" onClick={() => void change('chats', () => resetChatQuiet(qc))}>
                {t.quiet.resetChats}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** Chat titles from the loaded inbox pages (a chat with its own setting is named when it is there). */
function useChatTitles(): Map<string, string> {
  const inbox = useInfiniteQuery(chatsQuery()).data;
  const m = new Map<string, string>();
  for (const p of inbox?.pages ?? []) for (const c of p.items) if (c.title) m.set(c.id, c.title);
  return m;
}
