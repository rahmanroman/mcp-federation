import notifier from "node-notifier";
import open from "open";

let enabled = false;

export function enableNotifications(on: boolean): void {
  enabled = on;
}

/** OS notification; clicking it opens `url`. Failures are non-fatal — console output is the primary channel. */
export function notifyAuthRequired(service: string, url: string): void {
  if (!enabled) return;
  try {
    notifier.notify(
      {
        title: "mcp-federation",
        message: `[${service}] Authorization required — click to open`,
        wait: true, // keep the notification alive to receive the click
        open: url, // macOS: terminal-notifier opens it natively
      },
      (err, response) => {
        if (err) console.debug(`[gateway] notification failed: ${err.message}`);
        // SnoreToast (Windows) reports "activate" on click
        if (process.platform !== "darwin" && String(response).toLowerCase().includes("activate")) {
          open(url).catch(() => {});
        }
      },
    );
  } catch (e: any) {
    console.debug(`[gateway] notification failed: ${e.message}`);
  }
}
