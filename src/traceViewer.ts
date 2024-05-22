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
import { findNode } from './utils';
import * as vscodeTypes from './vscodeTypes';

function getPath(uriOrPath: string | vscodeTypes.Uri) {
  return typeof uriOrPath === 'string' ?
    uriOrPath :
    uriOrPath.scheme === 'file' ?
      uriOrPath.fsPath :
      uriOrPath;
}

class TraceViewerView implements vscodeTypes.Disposable {

  public static readonly viewType = 'playwright.traceviewer.view';

  private readonly _webviewPanel: vscodeTypes.WebviewPanel;
  private _disposables: vscodeTypes.Disposable[] = [];

  private readonly _onDidDispose: vscodeTypes.EventEmitter<void>;
  public readonly onDispose: vscodeTypes.Event<void>;

  constructor(
    vscode: vscodeTypes.VSCode,
    url: string
  ) {
    this._webviewPanel = this._register(vscode.window.createWebviewPanel(TraceViewerView.viewType, 'Trace Viewer', {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: true,
    }, {
      retainContextWhenHidden: true,
      enableScripts: true,
      enableForms: true,
    }));
    this._register(this._webviewPanel.onDidDispose(() => {
      this.dispose();
    }));
    this._onDidDispose = this._register(new vscode.EventEmitter<void>());
    this.onDispose = this._onDidDispose.event;

    this.show(url);
  }

  public dispose() {
    this._onDidDispose.fire();
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables.length = 0;
  }

  public show(url: string) {
    this._webviewPanel.webview.html = this.getHtml(url);
    this._webviewPanel.reveal(undefined, true);
  }

  private getHtml(url: string) {
    return /* html */ `<!DOCTYPE html>
			<html>
			<head>
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
        <style>
          html, body { height: 100%; min-height: 100%; padding: 0; margin: 0; }
          iframe { width: 100%; height: 100%; border: none; }
        </style>
			</head>
			<body>
        <iframe id="traceviewer" src="${url}"></iframe>
			</body>
			</html>`;
  }

  private _register<T extends vscodeTypes.Disposable>(value: T): T {
    this._disposables.push(value);
    return value;
  }
}

export class TraceViewer implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _disposables: vscodeTypes.Disposable[] = [];
  private _traceViewerProcess: ChildProcess | undefined;
  private _traceViewerUrl: string | undefined;
  private _traceViewerView: TraceViewerView | undefined;
  private _settingsModel: SettingsModel;

  constructor(vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._envProvider = envProvider;
    this._settingsModel = settingsModel;

    this._disposables.push(settingsModel.showTrace.onChange(value => {
      if (!value && this._traceViewerProcess)
        this.close().catch(() => {});
    }));
  }

  async willRunTests(config: TestConfig) {
    if (this._settingsModel.showTrace.get())
      await this._startIfNeeded(config);
  }

  async open(uri: string | vscodeTypes.Uri, config: TestConfig) {
    if (!this._settingsModel.showTrace.get())
      return;
    if (!this._checkVersion(config))
      return;
    if (!uri && !this._traceViewerProcess)
      return;
    await this._startIfNeeded(config);
    this._traceViewerProcess?.stdin?.write(getPath(uri) + '\n');
    this._maybeOpenEmbeddedTraceViewer();
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
    if (this._vscode.env.remoteName) {
      allArgs.push('--host', '0.0.0.0');
      allArgs.push('--port', '0');
    } else {
      allArgs.push('--server-only');
      const themeKind = this._vscode.window.activeColorTheme.kind;
      allArgs.push('--theme', themeKind === 2 || themeKind === 3  ? 'dark' : 'ligth');
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

    traceViewerProcess.stdout?.on('data', data => {
      if (!this._vscode.env.remoteName && !this._traceViewerUrl) {
        const url = data.toString().split('\n')[0];
        if (!url) return;
        this._traceViewerUrl = url;
        this._maybeOpenEmbeddedTraceViewer();
      }
      console.log(data.toString());
    });
    traceViewerProcess.stderr?.on('data', data => console.log(data.toString()));
    traceViewerProcess.on('exit', () => {
      this._traceViewerProcess = undefined;
      this._traceViewerUrl = undefined;
    });
    traceViewerProcess.on('error', error => {
      this._vscode.window.showErrorMessage(error.message);
      this.close().catch(() => {});
    });
  }

  private _maybeOpenEmbeddedTraceViewer() {
    if (this._traceViewerView || !this._traceViewerUrl) return;
    this._traceViewerView = new TraceViewerView(this._vscode, this._traceViewerUrl);
    this._traceViewerView.onDispose(() => {
      this._traceViewerView = undefined;
    });
    this._disposables.push(this._traceViewerView);
  }

  private _checkVersion(
    config: TestConfig,
    message: string = this._vscode.l10n.t('this feature')
  ): boolean {
    if (config.version < 1.35) {
      this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Playwright v1.35+ is required for {0} to work, v{1} found', message, config.version)
      );
      return false;
    }
    return true;
  }

  async close() {
    this._traceViewerProcess?.stdin?.end();
    this._traceViewerProcess = undefined;
  }
}
