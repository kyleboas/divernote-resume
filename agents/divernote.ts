// /divernote [project] [title]: move this Pi conversation into a new Divernote
// issue, then close this session so the conversation goes on only there.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("divernote", {
    description: "Move this conversation into a new Divernote issue",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const file = ctx.sessionManager.getSessionFile();
      if (!file) {
        ctx.ui.notify("This session is not saved, so it cannot be moved.", "error");
        return;
      }
      const words = args.trim() ? args.trim().split(/\s+/) : [];
      ctx.ui.setStatus("divernote", "Moving to Divernote…");
      try {
        const moved = await pi.exec("divernote", ["pi-move", "--from", "pi", "--source", file, ...words], { cwd: ctx.cwd, timeout: 120_000 });
        if (moved.code !== 0) {
          ctx.ui.notify((moved.stderr || moved.stdout || "The conversation could not be moved.").trim(), "error");
          return;
        }
        ctx.ui.notify(moved.stdout.trim(), "info");
      } finally {
        ctx.ui.setStatus("divernote", undefined);
      }
      ctx.shutdown();
    },
  });
}
