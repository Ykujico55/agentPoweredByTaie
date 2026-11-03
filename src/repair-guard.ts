import type { AgentSession } from "@earendil-works/pi-coding-agent";

type BeforeToolCall = NonNullable<AgentSession["agent"]["beforeToolCall"]>;

const modifyingTools = new Set(["write", "edit", "bash", "powershell"]);

/** Compose a live repair lock with Pi's existing tool policy. */
export function guardRepairTools(
  isLocked: () => boolean,
  previousHook?: BeforeToolCall,
): BeforeToolCall {
  return async (context, signal) => {
    // Read the closure for every call: a preceding analysis in the same
    // sequential tool batch may have locked repairs after this hook was made.
    if (isLocked() && modifyingTools.has(context.toolCall.name)) {
      return {
        block: true,
        reason: "Repair tools are locked after analysis. User authorization is required before modifying files or running shell commands.",
      };
    }
    return previousHook?.(context, signal);
  };
}
