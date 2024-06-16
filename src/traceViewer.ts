/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ChildProcess, spawn } from 'child_process';
import type { TestConfig } from './playwrightTestTypes';
import { SettingsModel } from './settingsModel';
import { escapeAttribute, findNode, getNonce } from './utils';
import * as vscodeTypes from './vscodeTypes';
import { DisposableBase } from './disposableBase';

// TODO match with playwright version that includes this feature
export const kEmbeddedMinVersion = 1.45;

function getPath(uriOrPath: string | vscodeTypes.Uri) {
  return typeof uriOrPath === 'string' ?
    uriOrPath :
    uriOrPath.scheme === 'file' ?
      uriOrPath.fsPath :
      uriOrPath;
}

function getThemeMode(vscode: vscodeTypes.VSCode) {
  const themeKind = vscode.window.activeColorTheme.kind;
  return themeKind === 2 || themeKind === 3  ? 'dark-mode' : 'light-mode';
}

class TraceViewerView extends DisposableBase {

  public static readonly viewType = 'playwright.traceviewer.view';

  private readonly _vscode: vscodeTypes.VSCode;
  private readonly _extensionUri: vscodeTypes.Uri;
  private readonly _webviewPanel: vscodeTypes.WebviewPanel;

  private readonly _onDidDispose: vscodeTypes.EventEmitter<void>;
  public readonly onDispose: vscodeTypes.Event<void>;

  constructor(
    vscode: vscodeTypes.VSCode,
    extensionUri: vscodeTypes.Uri,
    url?: string
  ) {
    super();
    this._vscode = vscode;
    this._extensionUri = extensionUri;
    this._webviewPanel = this._register(vscode.window.createWebviewPanel(TraceViewerView.viewType, 'Trace Viewer', {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: true,
    }, {
      retainContextWhenHidden: true,
      enableScripts: true,
      enableForms: true,
    }));
    this._webviewPanel.iconPath = vscode.Uri.joinPath(extensionUri, 'images', 'playwright-logo.svg');
    this._register(this._webviewPanel.onDidDispose(() => {
      this.dispose();
    }));
    this._register(this._webviewPanel.webview.onDidReceiveMessage(message  => {
      if (message.command === 'openExternal' && message.url)
        // should be a Uri, but due to https://github.com/microsoft/vscode/issues/85930
        // we pass a string instead
        vscode.env.openExternal(message.url);
    }));
    this._register(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('workbench.colorTheme'))
        this._webviewPanel.webview.postMessage({ theme: getThemeMode(vscode) });
    }));
    this._onDidDispose = this._register(new vscode.EventEmitter<void>());
    this.onDispose = this._onDidDispose.event;

    this.show(url);
  }

  public dispose() {
    this._onDidDispose.fire();
    super.dispose();
  }

  public show(url?: string) {
    this._webviewPanel.webview.html = this.getHtml(url);
    this._webviewPanel.reveal(undefined, true);
  }

  private getHtml(url?: string) {
    const nonce = getNonce();
    const cspSource = this._webviewPanel.webview.cspSource;
    const theme = getThemeMode(this._vscode);
    const origin = url ? new URL(url).origin : undefined;

    const loadingBody = /* html */ `<body class="loading" data-vscode-context='{ "preventDefaultContextMenuItems": true }'>
        <div class="loading-indicator"></div>
      </body>`;

    const iframeBody = /* html */ `<body data-vscode-context='{ "preventDefaultContextMenuItems": true }'>
        <iframe id="traceviewer" src="${url}"></iframe>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          const iframe = document.getElementById('traceviewer');
          function postMessageToVSCode(data) {
            vscode.postMessage(data);
          }
          function postMessageToFrame(data) {
            iframe.contentWindow.postMessage(data, '*');
          }
          iframe.addEventListener('load', () => postMessageToFrame({ theme: '${theme}' }));
          window.addEventListener('message', ({ data, origin }) => {
            if (origin === '${origin}') {
              // propagate key events to vscode
              if (data.type === 'keyup' || data.type === 'keydown') {
                const emulatedKeyboardEvent = new KeyboardEvent(data.type, data);
                Object.defineProperty(emulatedKeyboardEvent, 'target', {
                  get: () => window,
                });
                window.dispatchEvent(emulatedKeyboardEvent);
              } else {
                postMessageToVSCode(data);
              }
            } else {
              postMessageToFrame(data);
            }
          });
        </script>
      </body>`;

    return /* html */ `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta
          http-equiv="Content-Security-Policy"
          content="default-src 'none'; img-src data: ${cspSource}; media-src ${cspSource}; script-src 'nonce-${nonce}'; style-src ${cspSource}; frame-src ${url ?? ''} ${cspSource} https:">
        <!-- Disable pinch zooming -->
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">

        <title>Playwright Trace Viewer</title>

        <link rel="stylesheet" href="${escapeAttribute(this.extensionResource('media', 'traceViewer.css'))}" type="text/css" media="screen">
      </head>
      ${url ? iframeBody : loadingBody}
			</html>`;
  }

  private _register<T extends vscodeTypes.Disposable>(value: T): T {
    this._disposables.push(value);
    return value;
  }

  private extensionResource(...parts: string[]) {
    return this._webviewPanel.webview.asWebviewUri(this._vscode.Uri.joinPath(this._extensionUri, ...parts));
  }
}

export class TraceViewer implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  private _extensionUri: vscodeTypes.Uri;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _disposables: vscodeTypes.Disposable[] = [];
  private _traceViewerProcess: ChildProcess | undefined;
  private _embedded: boolean = false;
  private _traceViewerUrl: string | undefined;
  private _traceViewerView: TraceViewerView | undefined;
  private _settingsModel: SettingsModel;
  private _restart: boolean = false;
  private _currentFile?: string | vscodeTypes.Uri;

  constructor(vscode: vscodeTypes.VSCode, extensionUri: vscodeTypes.Uri, settingsModel: SettingsModel, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._extensionUri = extensionUri;
    this._envProvider = envProvider;
    this._settingsModel = settingsModel;

    this._disposables.push(settingsModel.showTrace.onChange(value => {
      if (!value && this._traceViewerProcess)
        this.close().catch(() => {});
    }));
    this._disposables.push(settingsModel.embedTraceViewer.onChange(value => {
      if (this._embedded !== value) {
        this._restart = !!this._traceViewerProcess;
        this._traceViewerProcess?.kill();
        this._traceViewerView?.dispose();
        this._traceViewerView = undefined;
      }
    }));
  }

  async willRunTests(config: TestConfig) {
    if (this._settingsModel.showTrace.get())
      await this._startIfNeeded(config);
  }

  async open(file: string | vscodeTypes.Uri, config: TestConfig) {
    if (!this._settingsModel.showTrace.get())
      return;
    if (!this._checkVersion(config))
      return;
    if (!file && !this._traceViewerProcess)
      return;
    await this._startIfNeeded(config);
    this._currentFile = file;
    this._traceViewerProcess?.stdin?.write(getPath(file) + '\n');
    this._maybeOpenEmbeddedTraceViewer(config);
  }

  dispose() {
    this.close().catch(() => {});
    for (const d of this._disposables)
      d.dispose();
    this._disposables = [];
  }

  private async _startIfNeeded(config: TestConfig) {
    const node = await findNode(this._vscode, config.workspaceFolder);
    if (this._traceViewerProcess)
      return;
    const allArgs = [config.cli, 'show-trace', `--stdin`];
    const embedded = this._settingsModel.embedTraceViewer.get() && this._checkEmbeddedVersion(config);
    if (embedded) {
      allArgs.push('--server-only');
      this._maybeOpenEmbeddedTraceViewer(config);
    } else if (this._vscode.env.remoteName) {
      allArgs.push('--host', '0.0.0.0');
      allArgs.push('--port', '0');
    }

    const traceViewerProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: 'pipe',
      detached: true,
      env: {
        ...process.env,
        ...this._envProvider(),
      },
    });
    this._traceViewerProcess = traceViewerProcess;
    this._embedded = embedded;

    traceViewerProcess.stdout?.on('data', async data => {
      if (!this._traceViewerUrl && this._settingsModel.embedTraceViewer.get()) {
        const [url] = data.toString().split('\n') ?? [];
        if (!url) return;
        const uri = await this._vscode.env.asExternalUri(this._vscode.Uri.parse(url));
        this._traceViewerUrl = uri.toString();
        this._traceViewerView?.show(this._traceViewerUrl);
      }
      console.log(data.toString());
    });
    traceViewerProcess.stderr?.on('data', data => console.log(data.toString()));
    traceViewerProcess.on('exit', () => {
      this._traceViewerProcess = undefined;
      this._traceViewerUrl = undefined;
      if (this._restart) {
        this._restart = false;
        this.open(this._currentFile ?? '', config);
      }
    });
    traceViewerProcess.on('error', error => {
      this._vscode.window.showErrorMessage(error.message);
      this.close().catch(() => {});
    });
  }

  private _maybeOpenEmbeddedTraceViewer(config: TestConfig) {
    if (this._traceViewerView || !this._settingsModel.embedTraceViewer.get() || !this._checkEmbeddedVersion(config)) return;
    this._traceViewerView = new TraceViewerView(this._vscode, this._extensionUri, this._traceViewerUrl);
    this._traceViewerView.onDispose(() => {
      this._traceViewerView = undefined;
    });
    this._disposables.push(this._traceViewerView);
  }

  private _checkVersion(
    config: TestConfig,
    message: string = this._vscode.l10n.t('this feature')
  ): boolean {
    const version = 1.35;
    if (config.version < 1.35) {
      this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Playwright v{0}+ is required for {1} to work, v{2} found', version, message, config.version)
      );
      return false;
    }
    return true;
  }

  private _checkEmbeddedVersion(config: TestConfig): boolean {
    return config.version >= kEmbeddedMinVersion;
  }

  async close() {
    this._traceViewerProcess?.stdin?.end();
    this._traceViewerProcess = undefined;
  }
}
