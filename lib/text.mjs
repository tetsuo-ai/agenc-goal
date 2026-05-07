// Helpers for safely reflecting untrusted text (planner output, user
// objective) into prompts. Wraps in <untrusted>...</untrusted> tags with
// XML-escaped content so injected instructions can't escape the wrapper
// and override the surrounding prompt.

export function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function untrusted(s) {
  return `<untrusted>${escapeXml(s)}</untrusted>`;
}

// Strip ANSI escape sequences and other control characters from text
// before reflecting it into terminal output. Keeps newlines and tabs.
export function stripControl(s) {
  return String(s ?? "")
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")  // ANSI CSI sequences
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""); // other controls except \t \n
}
