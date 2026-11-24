import { useEffect, useState } from 'react';
import { useLang } from '../../../client/src/sdk';
import { LANGS, MAX_DRAFT, MAX_READ, langName, type Lang, type LangPrefs } from '../langs';
import { loadLangPrefs, saveLangPrefs, useLoadedLangPrefs } from './assist';
import { useT } from './i18n';

// Settings → Translation languages: the languages offered to translate a draft into (the composer's ✨ menu and
// quick button) and received messages (message menu, one-tap action), app-wide (../server/langs.ts). Each list in
// order, the first one the default; a change is saved at once, as on llm's Default models page. Read and written through
// the store the composer and the messages use (assist.ts), fetched again on opening. Rows of the core's Settings
// (its .set-* classes), stacked on a narrow page by their container query.

type Key = keyof LangPrefs;

export function LangSettings() {
  const all = useT();
  const t = { ...all.writing.settings, failed: all.settings.failed };
  const ui = useLang();
  const prefs = useLoadedLangPrefs();
  const [note, setNote] = useState<string>();
  // The row whose "+ Add" list is open.
  const [adding, setAdding] = useState<Key>();

  useEffect(() => {
    loadLangPrefs().catch(() => setNote(t.failed));
  }, []);

  if (!prefs) return note ? <p className="settings-note">{note}</p> : null;

  const save = async (key: Key, list: Lang[]) => {
    setAdding(undefined);
    setNote(undefined);
    try {
      await saveLangPrefs({ [key]: list });
      setNote(t.langsSaved);
    } catch {
      setNote(t.failed);
    }
  };

  const row = (key: Key, id: string, label: string, max: number) => {
    const list = prefs[key];
    const rest = LANGS.filter((l) => !list.includes(l)).sort((a, b) => langName(a, ui).localeCompare(langName(b, ui), ui));
    return (
      <div className="set-row" role="group" aria-labelledby={`langs-l-${id}`} data-testid={`langs-${id}`}>
        <div className="set-text">
          <h3 className="set-label" id={`langs-l-${id}`}>
            {label}
          </h3>
          <p className="settings-hint">{t.langsMax(max)}</p>
        </div>
        <div className="set-control">
          <ol className="langs-list">
            {list.map((l, i) => {
              const name = langName(l, ui);
              return (
                <li key={l} className="langs-chip" data-testid={`langs-${id}-${l}`}>
                  <span className="langs-name">{name}</span>
                  {i === 0 && <span className="langs-default">{t.langsDefault}</span>}
                  {i > 0 && (
                    <button
                      type="button"
                      className="langs-btn"
                      aria-label={t.langsUp(name)}
                      title={t.langsUp(name)}
                      data-testid={`langs-${id}-up-${l}`}
                      onClick={() => void save(key, [...list.slice(0, i - 1), l, list[i - 1]!, ...list.slice(i + 1)])}
                    >
                      ↑
                    </button>
                  )}
                  <button
                    type="button"
                    className="langs-btn"
                    aria-label={t.langsRemove(name)}
                    title={t.langsRemove(name)}
                    disabled={list.length === 1}
                    data-testid={`langs-${id}-remove-${l}`}
                    onClick={() => void save(key, list.filter((x) => x !== l))}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ol>
          {list.length < max && (
            // A button and the languages left as buttons (not a select: its arrow keys would save each one passed).
            <button
              type="button"
              className="text-btn langs-add"
              aria-expanded={adding === key}
              data-testid={`langs-${id}-add`}
              onClick={() => setAdding(adding === key ? undefined : key)}
            >
              {t.langsAdd}
            </button>
          )}
          {adding === key && list.length < max && (
            <div className="langs-pick" role="group" aria-label={t.langsAddLabel} onKeyDown={(e) => e.key === 'Escape' && setAdding(undefined)}>
              {rest.map((l) => (
                <button key={l} type="button" className="text-btn" data-testid={`langs-${id}-add-${l}`} onClick={() => void save(key, [...list, l])}>
                  {langName(l, ui)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div data-testid="langs-settings">
      <p className="settings-hint settings-lead">{t.langsHint}</p>
      <div className="set-group">
        {row('draftLangs', 'draft', t.langsDraft, MAX_DRAFT)}
        {row('readLangs', 'read', t.langsRead, MAX_READ)}
      </div>
      {note && (
        <p className="settings-note" data-testid="langs-note">
          {note}
        </p>
      )}
    </div>
  );
}
