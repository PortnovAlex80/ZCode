import { useEffect, useRef, useState } from "react";
import type { ProjectMetadataEntries, ProjectMetadataInput } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useArtifactMetadata } from "@/hooks/useArtifactMetadata.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  artifactMetadataDraft,
  artifactMetadataScopes,
  metadataInputFromDraft,
  type ArtifactMetadataDraft,
} from "./artifactMetadataDraft.js";

export function ArtifactMetadataEditor({
  workspacePath,
  path,
  kind = "document",
  onClose,
}: {
  workspacePath: string;
  path: string;
  kind?: ProjectMetadataInput["kind"];
  onClose(): void;
}) {
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `artifactMetadata.${key}` });
  const metadata = useArtifactMetadata(workspacePath);
  const [entries, setEntries] = useState<ProjectMetadataEntries | null>(null);
  const [scope, setScope] = useState(path);
  const [draft, setDraft] = useState(() => artifactMetadataDraft());
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    let disposed = false;
    mounted.current = true;
    void metadata
      .read()
      .then((result) => {
        if (disposed || !result) return;
        setEntries(result);
        setDraft(artifactMetadataDraft(result[path]));
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : t("failed"));
      })
      .finally(() => {
        if (!disposed) setBusy(false);
      });
    return () => {
      disposed = true;
      mounted.current = false;
    };
  }, [metadata.read, path]);

  const setField = (key: keyof ArtifactMetadataDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  async function save() {
    const input = metadataInputFromDraft(
      draft,
      entries?.[scope]?.kind ?? (scope === path && path !== "." ? kind : "folder"),
    );
    setBusy(true);
    setError("");
    try {
      const result = await metadata.save(scope, input);
      if (result && mounted.current) onClose();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t("failed"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      const result = await metadata.remove(scope);
      if (result && mounted.current) onClose();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t("failed"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const fields = ["role", "template", "data", "assembly", "acceptance"] as const;

  return (
    <DialogContent className="max-h-[90dvh] sm:max-w-2xl flex flex-col overflow-hidden">
      <DialogHeader className="pr-8">
        <DialogTitle>{t("edit")}</DialogTitle>
        <DialogDescription>{t("editorHelp")}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto space-y-3 pr-1">
        <label className="grid gap-1 text-ui-base">
          {t("scope")}
          <Select
            value={scope}
            disabled={busy || !entries}
            onValueChange={(value) => {
              setScope(value);
              setDraft(artifactMetadataDraft(entries?.[value]));
              setError("");
            }}
          >
            <SelectTrigger className="w-full font-mono" aria-label={t("scope")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {artifactMetadataScopes(path).map((item) => (
                <SelectItem key={item} value={item}>
                  {item === "." ? t("projectScope") : item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <p className="text-ui-sm text-foreground-subtle">{t("blocksHelp")}</p>
        <div className="grid gap-3">
          {fields.map((field) => (
            <label key={field} className="grid gap-1 text-ui-base">
              {t(`field.${field}`)}
              <Textarea
                value={draft[field]}
                disabled={busy || !entries}
                aria-label={t(`field.${field}`)}
                placeholder={t(`hint.${field}`)}
                className="max-h-64 overflow-y-auto"
                rows={field === "assembly" || field === "template" ? 4 : 3}
                onChange={(event) => setField(field, event.target.value)}
              />
            </label>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-ui-base text-destructive whitespace-pre-wrap">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        {entries?.[scope] && (
          <Button variant="ghost" disabled={busy} onClick={() => void remove()}>
            {t("remove")}
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        <Button disabled={busy || !entries} onClick={() => void save()}>
          {intl.formatMessage({ id: "common.save" })}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
