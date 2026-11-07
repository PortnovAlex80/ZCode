/**
 * ui-spec-document contract: what callers must know to use this module.
 * One intent per member; details live in implementation files and tests.
 */
import type { ReactNode } from "react";

export type UiSpecDocumentId = string & { readonly __brand: "UiSpecDocumentId" };

/**
 * Editing overlay for native file tabs: mount via PreviewPane props
 * (documentActions/sourceEditor/requestMarkdownViewMode). Edit reads the disk
 * snapshot, autosaves with a 500 ms debounce and CAS `expectedSha256`;
 * conflicts surface as a visible error and pause autosave until resolved.
 */
export interface NativeFileEditingApi {
  documentActions: ReactNode;
  sourceEditor: ReactNode;
  editing: boolean;
  requestMarkdownViewMode: "code" | null;
}

/** Editable predicate: any path except the binary denylist; dotfiles count as text. */
export function isTextCompatibleDocumentPath(path: string): boolean;

/** Context-menu entry points: Discuss / open in a separate OS window / side conversation. */
export type WorkspaceFileEntryAction =
  | "discuss-document"
  | "open-document-window"
  | "side-conversation";
