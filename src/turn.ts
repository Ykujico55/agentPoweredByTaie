/** Options are supplied for each user message and never become project configuration. */
export interface AgentTurnOptions {
  skipTaie?: boolean;
  repairMode?: RepairMode;
}

/** A leading chat flag applies only to this message; an empty task arms the next message. */
export function parseChatTurn(text: string, skipNextTurn = false, repairMode?: RepairMode): { task: string; skipTaie: boolean; repairMode?: RepairMode } {
  let task = text;
  let skipTaie = skipNextTurn;
  for (;;) {
    const flag = /^\s*(--skip-taie|--no-repair)(?:\s+|$)/.exec(task);
    if (!flag) break;
    if (flag[1] === "--skip-taie") skipTaie = true;
    else repairMode = "off";
    task = task.slice(flag[0].length);
  }
  return { task, skipTaie, ...(repairMode === undefined ? {} : { repairMode }) };
}
import type { RepairMode } from "./verification.ts";

