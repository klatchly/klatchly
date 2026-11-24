import { lazyChunk } from './lazy';

// Screens of the shell that are not the chat list: each in its own chunk, loaded when first shown (or ahead:
// the conversation right after launch, Settings when its button is pressed; the packages' spaces declare their
// own, client/src/extension.ts).
export const Conversation = lazyChunk(() => import('./Conversation'), 'Conversation');
// Settings: its menu (in the list column) and its pages (in the pane), one chunk.
const settings = () => import('./Settings');
export const SettingsMenu = lazyChunk(settings, 'SettingsMenu');
export const SettingsMain = lazyChunk(settings, 'SettingsMain');
