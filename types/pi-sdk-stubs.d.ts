declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = any;
  export type ExtensionContext = any;
  export function getSettingsListTheme(): any;
  export function initTheme(themeName?: string, enableWatcher?: boolean): void;
}

declare module "@earendil-works/pi-tui" {
  export const Container: any;
  export type SettingItem = {
    id: string;
    label: string;
    description?: string;
    currentValue: string;
    values?: string[];
  };
  export const SettingsList: any;
  export const Text: any;
  export function wrapTextWithAnsi(text: string, width: number): string[];
}

declare module "@earendil-works/pi-ai/compat" {
  export function completeSimple(model: any, context: any, options?: any): Promise<any>;
  export function registerFauxProvider(options?: any): any;
}
