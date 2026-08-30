export function generateFileFingerprint(file: File): string {
  const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `fp_${cleanName}_${file.size}_${file.type || "unknown"}_${file.lastModified}`;
}
