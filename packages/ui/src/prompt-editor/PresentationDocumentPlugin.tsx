import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { registerPresentationMoveParticipant } from "@/lib/presentationDocumentMove.js";

/** Move the same editor; never create another composer or copy accepted input. */
export function PresentationDocumentPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerPresentationMoveParticipant({
    root: () => editor.getRootElement(),
    isComposing: () => editor.isComposing(),
    detach: () => {
      const root = editor.getRootElement();
      const focused = root?.ownerDocument.activeElement === root;
      // 修复原因：Lexical 缓存 Window 并在 ownerDocument 监听选区。
      // 必须在迁移前解绑旧文档，再在新文档重绑同一 editor；否则输入/光标失效。
      editor.setRootElement(null);
      return () => {
        editor.setRootElement(root);
        if (focused) editor.focus();
      };
    },
  }), [editor]);
  return null;
}
