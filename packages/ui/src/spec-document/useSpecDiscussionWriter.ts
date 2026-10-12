import { useEffect, useState } from "react";
import {
  retainDiscussionWriter,
  discussionWriterAllowed,
  type DiscussionWriterPhase,
} from "./specDiscussionWriter.js";

export function useSpecDiscussionWriter(workspaceKey: string) {
  const [phase, setPhase] = useState<DiscussionWriterPhase>("checking");
  useEffect(() => {
    return retainDiscussionWriter(
      workspaceKey,
      typeof navigator === "undefined" ? undefined : navigator.locks,
      setPhase,
    );
  }, [workspaceKey]);
  return {
    phase,
    writable: phase === "owned",
    canWrite: () => discussionWriterAllowed(workspaceKey),
  };
}
