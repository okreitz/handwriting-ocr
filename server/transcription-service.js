const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const SUPPORTED_DOCUMENT_TYPES = new Set([
  "application/pdf",
  ...SUPPORTED_IMAGE_TYPES,
]);

function requireProvider(settings, providerName) {
  const provider = settings.providers?.[providerName];
  if (!provider?.enabled) {
    throw new Error(`Provider "${providerName}" is not enabled in settings.`);
  }
  return provider;
}

function requireModelConfig(modelConfig, label) {
  if (!modelConfig?.provider || !modelConfig?.model) {
    throw new Error(`${label} provider and model must be configured in settings.`);
  }
  return modelConfig;
}

async function callOpenRouter({ provider, model, messages }) {
  if (!provider.apiKey) {
    throw new Error("OpenRouter API key is missing. Add it in Settings.");
  }

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
      ...(provider.referer ? { "HTTP-Referer": provider.referer } : {}),
      ...(provider.appName ? { "X-Title": provider.appName } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    const details = data?.error?.message || JSON.stringify(data);
    throw new Error(`OpenRouter request failed: ${details}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => item?.text || "")
      .join("\n")
      .trim();
  }

  throw new Error("OpenRouter returned an unexpected response shape.");
}

async function runOcrStep(filePayload, settings) {
  const ocrModel = requireModelConfig(settings.ocrModel, "OCR model");

  if (!SUPPORTED_DOCUMENT_TYPES.has(filePayload.mimeType)) {
    throw new Error("Unsupported file type. Use PDF, PNG, JPG, or WEBP.");
  }

  if (ocrModel.provider !== "openrouter") {
    throw new Error(
      `OCR provider "${ocrModel.provider}" is not implemented yet. Start with OpenRouter in this version.`
    );
  }

  const provider = requireProvider(settings, "openrouter");
  const dataUrl = `data:${filePayload.mimeType};base64,${filePayload.base64}`;
  const attachmentType =
    filePayload.mimeType === "application/pdf" ? "file" : "image_url";
  const attachmentPayload =
    attachmentType === "file"
      ? {
          type: "file",
          file: {
            filename: filePayload.fileName || "document.pdf",
            file_data: dataUrl,
          },
        }
      : {
          type: "image_url",
          image_url: {
            url: dataUrl,
          },
        };

  return callOpenRouter({
    provider,
    model: ocrModel.model,
    messages: [
      {
        role: "system",
        content: settings.prompts.ocr,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Transcribe this uploaded handwritten document exactly.",
          },
          attachmentPayload,
        ],
      },
    ],
  });
}

async function runCorrectionStep(ocrText, settings) {
  const correctionModel = requireModelConfig(
    settings.correctionModel,
    "Correction model"
  );

  if (correctionModel.provider !== "openrouter") {
    throw new Error(
      `Correction provider "${correctionModel.provider}" is not implemented yet. Start with OpenRouter in this version.`
    );
  }

  const provider = requireProvider(settings, "openrouter");

  return callOpenRouter({
    provider,
    model: correctionModel.model,
    messages: [
      {
        role: "system",
        content: settings.prompts.correction,
      },
      {
        role: "user",
        content: `Correct this OCR transcription:\n\n${ocrText}`,
      },
    ],
  });
}

export async function transcribeDocument(filePayload, settings) {
  if (!filePayload?.base64 || !filePayload?.mimeType) {
    throw new Error("Missing uploaded document payload.");
  }

  const startedAt = new Date().toISOString();
  const rawTranscription = await runOcrStep(filePayload, settings);
  const correctedTranscription = await runCorrectionStep(rawTranscription, settings);

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    fileName: filePayload.fileName || "document",
    rawTranscription,
    correctedTranscription,
  };
}
