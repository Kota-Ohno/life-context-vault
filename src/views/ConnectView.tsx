import { Plug, MessageSquare } from "lucide-react";
import type { ClaudeDesktopConfigInstallResult, LoginItemStatus } from "../nativeStorage";
import { PageHeader } from "../components/PageHeader";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { SectionDivider } from "../components/SectionDivider";

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
  goRequests,
  hasActiveConnection,
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
  hasActiveConnection: boolean;
}) {
  return (
    <div className="qv-connect">
      <PageHeader
        eyebrow="設定 · 接続"
        title="接続とAIアクセス"
        lede="AIクライアントを接続すると、あなたが審査・承認した記憶だけをAIに渡す内容（記憶）として渡します。金庫の中身がそのまま渡されることはありません。"
      />

      <div className="qv-connect__cards">
        {/* Claude Desktop — MCP card */}
        <Card>
          <div className="qv-connect-card__head">
            <div>
              <p className="qv-connect-card__sub">ローカル MCP</p>
              <h2 className="qv-connect-card__title">Claude Desktop</h2>
            </div>
            <div className="qv-connect-card__head-right">
              <span className={`qv-connection-status ${hasActiveConnection ? "qv-connection-status--connected" : "qv-connection-status--disconnected"}`}>
                {hasActiveConnection ? "接続済み" : "未接続"}
              </span>
              <Plug size={16} className="qv-connect-card__icon" />
            </div>
          </div>

          <p className="qv-connect-card__desc">
            Claude Desktopの設定ファイルにMCPサーバーを追加します。接続後、Claude DesktopからAIに渡す内容（記憶）を要求できます。毎回の要求はあなたの確認を経てから返されます。
          </p>

          {/* One-click install — recommended primary path */}
          <div className="qv-connect-card__actions">
            <Button
              variant="primary"
              size="md"
              disabled={claudeInstallBusy || !nativePath}
              onClick={installClaudeConfig}
            >
              <Plug size={14} />
              Claude設定へ追加（推奨）
            </Button>

            {loginItemStatus && loginItemStatus.supported ? (
              <Button
                variant="ghost"
                size="md"
                disabled={loginItemBusy}
                onClick={loginItemStatus.enabled ? disableLoginItem : enableLoginItem}
              >
                {loginItemStatus.enabled ? "ログイン時起動を解除" : "ログイン時に起動"}
              </Button>
            ) : null}
          </div>

          {!nativePath && (
            <p className="qv-connect-card__note">
              自動インストールにはデスクトップアプリが必要です（ブラウザプレビューでは使用できません）。
            </p>
          )}

          {claudeInstallResult ? (
            <p className="qv-connect-card__result">
              設定パス: {claudeInstallResult.configPath}
            </p>
          ) : null}

          {/* Manual config — last resort fallback */}
          <details className="qv-connect-card__disclosure">
            <summary>MCP設定を手動でコピーする（上の自動追加が使えない場合のみ）</summary>
            <p className="qv-connect-card__note">※ これはテンプレートです。「Claude設定へ追加（推奨）」を使うと正確なパスが自動設定されます。自動追加が動作しない場合の最終手段としてご利用ください。</p>
            <pre className="qv-connect-card__code">{claudeConfig}</pre>
          </details>
        </Card>

        {/* Copy fallback card */}
        <Card>
          <div className="qv-connect-card__head">
            <div>
              <p className="qv-connect-card__sub">コピー経由</p>
              <h2 className="qv-connect-card__title">ChatGPT · その他のAI</h2>
            </div>
            <MessageSquare size={16} className="qv-connect-card__icon" />
          </div>

          <p className="qv-connect-card__desc">
            MCPを使わず、RequestsでAIに渡す内容（記憶）を作成してコピーし、ChatGPTやClaudeなど任意のAIに貼り付けられます。設定は不要です。
          </p>

          <div className="qv-connect-card__actions">
            <Button variant="ghost" size="md" onClick={goRequests}>
              <MessageSquare size={14} />
              Requestsへ
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
