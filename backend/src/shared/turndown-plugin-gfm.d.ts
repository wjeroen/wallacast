// turndown-plugin-gfm has no bundled type declarations. It exports turndown plugins
// (functions that take a TurndownService). We only use `gfm`.
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  type Plugin = (service: TurndownService) => void;
  export const gfm: Plugin;
  export const tables: Plugin;
  export const strikethrough: Plugin;
  export const taskListItems: Plugin;
}
