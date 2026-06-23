// First-run onboarding step copy (記憶を追加 → 確認して承認 → AIと接続).
export const ONBOARDING_STEPS = [
  { key: "add", title: "生活背景を少し書く", body: "ガイド入力またはデモデータで、AIに覚えておいてほしい背景を追加します。保存前にMemory Inboxで確認します。" },
  { key: "approve", title: "Memory Inbox で承認", body: "生成された候補を確認します。承認したものだけがAIの確定文脈になります。" },
  { key: "connect", title: "暗号化バックアップを作る", body: "機種変・故障に備え、Settings から暗号化バックアップを書き出します（パスフレーズは紛失しないよう管理してください）。" },
] as const;
