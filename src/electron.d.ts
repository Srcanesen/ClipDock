// Minimal ambient type declarations for the Electron APIs ClipDock uses.
// Runtime comes from DaVinci Resolve's embedded Electron (v36.x, Node 22) —
// we never install or bundle Electron. Declared here so TypeScript can type-check
// without the `electron` npm package (which downloads a ~100 MB binary on install).
//
// ponytail: hand-typed subset of Electron; swap for the real `electron` devDependency
// when the plugin grows to need more Electron APIs.

declare module 'electron' {
  export interface WebPreferences {
    preload?: string;
    contextIsolation?: boolean;
    sandbox?: boolean;
    nodeIntegration?: boolean;
    partition?: string;
  }

  export interface Rectangle { x: number; y: number; width: number; height: number; }

  export class View {
    addChildView(view: View): void;
    removeChildView(view: View): void;
    setBounds(bounds: Rectangle): void;
  }

  export class NativeImage {
    isEmpty(): boolean;
  }

  export class WebFrameMain {
    readonly url: string;
  }

  export class WebContents {
    readonly mainFrame: WebFrameMain;
    readonly session: Session;
    send(channel: string, ...args: unknown[]): void;
    openDevTools(): void;
    loadURL(url: string, options?: { httpReferrer?: string }): Promise<void>;
    close(): void;
    isDestroyed(): boolean;
    on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
    /** Start an OS-native file drag (the Resolve Media Pool / timeline drop target). */
    startDrag(item: { file: string; icon: NativeImage | string } | { files: string[]; icon: NativeImage | string }): void;
  }

  export class WebContentsView extends View {
    constructor(options?: { webPreferences?: WebPreferences });
    readonly webContents: WebContents;
  }

  export class BrowserWindow {
    constructor(options: {
      width?: number;
      height?: number;
      useContentSize?: boolean;
      title?: string;
      webPreferences?: WebPreferences;
    });
    loadFile(filePath: string): Promise<void>;
    setMenuBarVisibility(visible: boolean): void;
    setAlwaysOnTop(flag: boolean): void;
    isAlwaysOnTop(): boolean;
    webContents: WebContents;
    contentView: View;
    getContentSize(): [number, number];
    on(event: string, listener: (...args: any[]) => void): this;
    static getAllWindows(): BrowserWindow[];
  }

  export const app: {
    whenReady(): Promise<void>;
    getPath(name: 'downloads' | 'userData'): string;
    on(event: 'before-quit', listener: (event: {preventDefault(): void}) => void): void;
    on(event: 'window-all-closed' | 'activate', listener: () => void): void;
    quit(): void;
  };

  export interface IpcMainEvent {
    sender: WebContents;
    senderFrame: WebFrameMain | null;
  }

  export interface IpcMainInvokeEvent {
    sender: WebContents;
    senderFrame: WebFrameMain | null;
  }

  export const ipcMain: {
    handle(
      channel: string,
      // Electron passes arbitrary args; handlers narrow them with their own casts.
      listener: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>,
    ): void;
    on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void;
  };

  export const dialog: {
    showOpenDialog(
      window: BrowserWindow,
      options: { title?: string; buttonLabel?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] },
    ): Promise<{ canceled: boolean; filePaths: string[] }>;
    showOpenDialog(
      options: { title?: string; buttonLabel?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] },
    ): Promise<{ canceled: boolean; filePaths: string[] }>;
  };

  export const shell: {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<string>;
    showItemInFolder(path: string): void;
  };

  export const clipboard: { writeText(text: string): void; };

  export const safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
  };

  export const nativeImage: {
    /** Decodes a base64 PNG/JPEG data URL into a NativeImage (never empty for a valid PNG). */
    createFromDataURL(dataURL: string): NativeImage;
  };

  export interface Session {
    setPermissionRequestHandler(handler: (_webContents: WebContents, permission: string, callback: (allowed: boolean) => void) => void): void;
    setPermissionCheckHandler(handler: (_webContents: WebContents | null, permission: string) => boolean): void;
  }
}

declare module 'electron/renderer' {
  export const contextBridge: {
    exposeInMainWorld(key: string, api: unknown): void;
  };
  export const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    send(channel: string, ...args: unknown[]): void;
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
    removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  };
}
