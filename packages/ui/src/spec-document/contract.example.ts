/**
 * ui-spec-document 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { NativeFileEditingApi } from "./contract.js";

export function exampleMountNativeFileEditing(overlay: NativeFileEditingApi): void {
  // Typical mount: spread the overlay into PreviewPane inside FileManagerPane;
  // requestMarkdownViewMode switches markdown to Source while editing.
  void overlay.documentActions;
  void overlay.sourceEditor;
  void overlay.editing;
  void overlay.requestMarkdownViewMode;
}
