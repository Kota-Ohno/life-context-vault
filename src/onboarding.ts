// First-run onboarding step copy (記憶を追加 → 確認して承認 → AIと接続).
export const ONBOARDING_STEPS = [
  { key: "add", title: "生活背景を少し書く", body: "ガイド入力またはデモデータで、AIに覚えておいてほしい背景を追加します。保存前に取り込みで確認します。" },
  { key: "approve", title: "取り込みで確認して承認", body: "生成された候補を確認します。承認したものだけがAIの確定文脈になります。" },
  { key: "connect", title: "AIと接続する", body: "Claude Desktopを接続し、質問して最初のAI要求を受け取ります。確認して記憶を返します。" },
] as const;
