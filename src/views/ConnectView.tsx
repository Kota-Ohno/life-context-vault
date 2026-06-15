import { Plug, MessageSquare } from "lucide-react";
import type { ClaudeDesktopConfigInstallResult, LoginItemStatus } from "../nativeStorage";

export function ConnectView({
  nativePath,
  claudeInstallBusy,
  claudeInstallResult,
  claudeConfig,
  installClaudeConfig,
  loginItemStatus,
  loginItemBusy,
  enableLoginItem,
  disableLoginItem,
  goRequests
}: {
  nativePath: string | null;
  claudeInstallBusy: boolean;
  claudeInstallResult: ClaudeDesktopConfigInstallResult | null;
  claudeConfig: string;
  installClaudeConfig: () => void;
  loginItemStatus: LoginItemStatus | null;
  loginItemBusy: boolean;
  enableLoginItem: () => void;
  disableLoginItem: () => void;
  goRequests: () => void;
}) {
  return (
    <section className="view-grid">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Claude Desktop (MCP)</p>
            <h3>ローカルMCPで接続</h3>
          </div>
          <Plug size={18} />
        </div>
        <p className="muted">
          Claude Desktop設定に Life Context Vault のMCPサーバーを追加します。追加後、Claude Desktopから承認済みの文脈(Context Pack)を要求できます。
        </p>
        <div className="service-actions">
          <button
            className="primary-button"
            disabled={claudeInstallBusy || !nativePath}
            onClick={installClaudeConfig}
            type="button"
          >
            <Plug size={16} />
            Claude設定へ追加
          </button>
          {loginItemStatus && loginItemStatus.supported ? (
            <button
              className="secondary-button"
              disabled={loginItemBusy}
              onClick={loginItemStatus.enabled ? disableLoginItem : enableLoginItem}
              type="button"
            >
              {loginItemStatus.enabled ? "ログイン時起動を解除" : "ログイン時に起動"}
            </button>
          ) : null}
        </div>
        {claudeInstallResult ? <p className="muted">設定パス: {claudeInstallResult.configPath}</p> : null}
        <details className="advanced-panel">
          <summary>MCP設定（手動コピー用）</summary>
          <pre className="code-box">{claudeConfig}</pre>
        </details>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Copy fallback</p>
            <h3>コピーでAIに渡す</h3>
          </div>
          <MessageSquare size={18} />
        </div>
        <p className="muted">
          MCPを使わず、Requests で Context Pack を作成してコピーし、任意のAI（ChatGPT / Claude 等）に貼り付けられます。設定不要です。
        </p>
        <div className="service-actions">
          <button className="secondary-button" onClick={goRequests} type="button">
            <MessageSquare size={16} />
            Requestsへ
          </button>
        </div>
      </div>
    </section>
  );
}
