const RUNTIME_PREFERENCES_KEY = "life-context-vault-runtime-preferences";

export interface RuntimePreferences {
  autoStartAiAccess: boolean;
  ocrCommand: string;
  ocrArgs: string;
  ocrTimeoutSeconds: number;
}

const defaultRuntimePreferences: RuntimePreferences = {
  autoStartAiAccess: false,
  ocrCommand: "",
  ocrArgs: "{input}",
  ocrTimeoutSeconds: 30
};

export function loadRuntimePreferences(): RuntimePreferences {
  if (typeof localStorage === "undefined") return defaultRuntimePreferences;
  const raw = localStorage.getItem(RUNTIME_PREFERENCES_KEY);
  if (!raw) return defaultRuntimePreferences;
  try {
    return {
      ...defaultRuntimePreferences,
      ...(JSON.parse(raw) as Partial<RuntimePreferences>)
    };
  } catch {
    return defaultRuntimePreferences;
  }
}

export function saveRuntimePreferences(preferences: RuntimePreferences): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(RUNTIME_PREFERENCES_KEY, JSON.stringify(preferences));
}
