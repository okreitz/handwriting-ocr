function requireOpenRouterProvider(settings) {
  const provider = settings.providers?.openrouter;

  if (!provider?.enabled) {
    throw new Error('Provider "openrouter" is not enabled in settings.');
  }

  if (!provider.apiKey) {
    throw new Error("OpenRouter API key is missing. Add it in Settings first.");
  }

  return provider;
}

function formatModelEntry(model) {
  const inputModalities = model?.architecture?.input_modalities || [];
  const supportsImage = inputModalities.includes("image");
  const supportsFile = inputModalities.includes("file");

  return {
    id: model.id,
    name: model.name || model.id,
    description: model.description || "",
    contextLength: model.context_length || 0,
    inputModalities,
    supportedParameters: model.supported_parameters || [],
    supportsVision: supportsImage || supportsFile,
  };
}

export async function listModels({ providerName }, settings) {
  if (providerName !== "openrouter") {
    throw new Error(
      `Model listing for provider "${providerName}" is not implemented yet.`
    );
  }

  const provider = requireOpenRouterProvider(settings);
  const response = await fetch(`${provider.baseUrl}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
      ...(provider.referer ? { "HTTP-Referer": provider.referer } : {}),
      ...(provider.appName ? { "X-Title": provider.appName } : {}),
    },
  });

  const data = await response.json();

  if (!response.ok) {
    const details = data?.error?.message || JSON.stringify(data);
    throw new Error(`OpenRouter models request failed: ${details}`);
  }

  const models = Array.isArray(data?.data) ? data.data.map(formatModelEntry) : [];
  models.sort((left, right) => left.name.localeCompare(right.name));

  return {
    provider: providerName,
    fetchedAt: new Date().toISOString(),
    models,
  };
}

export function mergeSettings(baseSettings, overrideSettings) {
  if (
    baseSettings &&
    typeof baseSettings === "object" &&
    overrideSettings &&
    typeof overrideSettings === "object"
  ) {
    const merged = { ...baseSettings };
    for (const [key, value] of Object.entries(overrideSettings)) {
      merged[key] = mergeSettings(baseSettings[key], value);
    }
    return merged;
  }

  return overrideSettings ?? baseSettings;
}
