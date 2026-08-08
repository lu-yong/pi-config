import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Track file modifications in the current turn
  let modifiedFiles = new Set<string>();
  let readmeModified = false;

  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "replace" || event.toolName === "undo_last_replace") {
      const path = (event.input as { path?: string }).path || "";
      if (/^readme(\.md)?$/i.test(path.split("/").pop() || "")) {
        readmeModified = true;
      } else if (path) {
        modifiedFiles.add(path);
      }
    }
  });

  pi.on("agent_settled", async (_event, _ctx) => {
    if (modifiedFiles.size === 0 || readmeModified) {
      // Nothing to check, or README was already modified
      modifiedFiles = new Set();
      readmeModified = false;
      return;
    }

    const files = [...modifiedFiles].slice(0, 5).join(", ");
    const tail = modifiedFiles.size > 5 ? ` and ${modifiedFiles.size - 5} more` : "";

    pi.sendUserMessage(
      `I just modified: ${files}${tail}. ` +
      `Please load skill /skill:readme-check and check whether README.md needs updating ` +
      `to reflect these changes. If README is already accurate, just say so.`
    );

    modifiedFiles = new Set();
    readmeModified = false;
  });
}
