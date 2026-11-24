import './writing.css';

// Writing's chunk: every component it plugs into the core's slots (index.tsx names them), its strings and its
// styles. Loaded when a conversation or Settings first shows one of them.
export { WritingHeader, WritingMenu, WritingTools } from './AssistMenu';
export { WritingActions, WritingBelow, WritingConversation, WritingMenuEntries } from './Messages';
export { LangSettings } from './LangSettings';
