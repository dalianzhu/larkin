export function parsePublicCliJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { ok: false, error: "empty_stdout" };
  try { return { ok: true, value: JSON.parse(text) }; }
  catch { return { ok: false, error: "invalid_json" }; }
}
