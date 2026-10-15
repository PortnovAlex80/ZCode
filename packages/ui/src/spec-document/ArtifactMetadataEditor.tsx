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
    let input: ProjectMetadataInput;
    try {
      input = metadataInputFromDraft(
        draft,
        entries?.[scope]?.kind ?? (scope === path && path !== "." ? kind : "folder"),
      );
    } catch {
      setError(t("invalidSteps"));
      return;
    }
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
  const fields = [
    "purpose",
    "instructions",
    "sources",
    "links",
    "methods",
    "skills",
    "checklist",
  ] as const;
  const stepsExample = JSON.stringify(
    [
      {
        title: t("stepExampleTitle"),
        instruction: t("stepExampleInstruction"),
        tool: { transport: "file", operation: "read" },
        input: "requisites.txt",
        expected: t("stepExampleExpected"),
        onFailure: t("stepExampleFailure"),
      },
    ],
    null,
    2,
  );

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
        <label className="grid gap-1 text-ui-base">
          {t("field.type")}
          <Select
            value={draft.type}
            disabled={busy || !entries}
            onValueChange={(value) => setField("type", value)}
          >
            <SelectTrigger className="w-full" aria-label={t("field.type")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["source", "calculation", "note", "drawing", "other"] as const).map((type) => (
                <SelectItem key={type} value={type}>
                  {t(`type.${type}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((field) => (
            <label
              key={field}
              className={`grid gap-1 text-ui-base ${field === "instructions" || field === "purpose" ? "sm:col-span-2" : ""}`}
            >
              {t(`field.${field}`)}
              <Textarea
                value={draft[field]}
                disabled={busy || !entries}
                aria-label={t(`field.${field}`)}
                className="max-h-48 overflow-y-auto"
                rows={field === "instructions" ? 4 : 2}
                onChange={(event) => setField(field, event.target.value)}
              />
            </label>
          ))}
        </div>
        <p className="text-ui-sm text-foreground-subtle">{t("referencesHelp")}</p>
        <label className="grid gap-1 text-ui-base">
          {t("field.steps")}
          <Textarea
            value={draft.steps}
            aria-label={t("field.steps")}
            disabled={busy || !entries}
            className="max-h-64 overflow-y-auto font-mono"
            rows={6}
            onChange={(event) => setField("steps", event.target.value)}
          />
        </label>
        <p className="text-ui-sm text-foreground-subtle">{t("stepsHelp")}</p>
        <details className="text-ui-sm text-foreground-subtle">
          <summary className="cursor-pointer">{t("stepExample")}</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono">{stepsExample}</pre>
        </details>
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
