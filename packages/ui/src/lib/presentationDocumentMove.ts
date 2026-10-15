/** 修复原因：DOM 跨文档迁移不会自动迁移编辑器的文档级监听；显式解绑/重绑且保留状态。 */
interface PresentationMoveParticipant {
  root(): HTMLElement | null;
  isComposing(): boolean;
  detach(): () => void;
}
const participants = new Set<PresentationMoveParticipant>();

export function registerPresentationMoveParticipant(participant: PresentationMoveParticipant): () => void {
  participants.add(participant);
  return () => { participants.delete(participant); };
}

export function movePresentationHost(host: HTMLElement, parent: HTMLElement, returning = false): boolean {
  const moving = Array.from(participants).filter((participant) => {
    const root = participant.root();
    return root !== null && host.contains(root);
  });
  if (!returning && moving.some((participant) => participant.isComposing())) return false;
  const restore = moving.map((participant) => participant.detach());
  try { parent.appendChild(host); }
  finally { for (const attach of restore) attach(); }
  return true;
}
