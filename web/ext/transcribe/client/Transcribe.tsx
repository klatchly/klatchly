import './transcribe.css';

// The transcribe chunk: its message slots, its per-chat mount and its Settings page (index.tsx names them), with
// their strings and styles. Loaded when a conversation or the Settings page first needs one of them.
export { TranscribeBelow, TranscribeConversation, TranscribeMenu } from './Messages';
export { TranscriptionSettings } from './Settings';
