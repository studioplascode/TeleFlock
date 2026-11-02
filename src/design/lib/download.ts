/** Saves `blob` as `name` through a download (browsers; desktop webviews save it to the Downloads folder). */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking at once can cancel a download that has not started reading yet.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
