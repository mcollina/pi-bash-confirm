declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = any;
  export type ExtensionContext = any;
  export function getSettingsListTheme(): any;
  export function initTheme(themeName?: string, enableWatcher?: boolean): void;
  export class ModelRuntime {
    static create(options?: any): Promise<ModelRuntime>;
  }
  export class ModelRegistry {
    constructor(runtime: ModelRuntime);
    find(provider: string, modelId: string): any;
    getApiKeyAndHeaders(model: any): Promise<
      | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
      | { ok: false; error: string }
    >;
  }
}

declare module "@earendil-works/pi-tui" {
  export const Container: any;
  export function decodeKittyPrintable(data: string): string | undefined;
  export const Key: {
    down: string;
    enter: string;
    escape: string;
    up: string;
    ctrl(key: string): string;
  };
  export function matchesKey(data: string, keyId: string): boolean;
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
