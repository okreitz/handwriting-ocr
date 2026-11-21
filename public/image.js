// Vision models scale images down to a fixed budget anyway, so anything larger
// than this only makes the upload slower.
const MAX_LONG_EDGE = 2400;
const JPEG_QUALITY = 0.9;
const PASS_THROUGH_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

// Returns what should be uploaded for a file: PDFs and reasonably sized images
// go as they are, while oversized or unusual images are re-encoded as JPEG.
export async function prepareUpload(file) {
  if (isPdf(file)) {
    return { body: file, mimeType: "application/pdf" };
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      "This image format cannot be read here. Save it as JPG, PNG or PDF and try again."
    );
  }

  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (PASS_THROUGH_TYPES.has(file.type) && longEdge <= MAX_LONG_EDGE) {
      return { body: file, mimeType: file.type };
    }

    const scale = Math.min(1, MAX_LONG_EDGE / longEdge);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    const context = canvas.getContext("2d");
    // Transparent areas would turn black in a JPEG.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY)
    );
    if (!blob) {
      throw new Error("Could not prepare this image for upload.");
    }

    return { body: blob, mimeType: "image/jpeg" };
  } finally {
    bitmap.close();
  }
}
