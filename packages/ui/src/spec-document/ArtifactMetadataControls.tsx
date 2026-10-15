import { useEffect, useRef, useState } from "react";
import { ChevronDown, FileCog } from "lucide-react";
import type { ProjectMetadataContext } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useArtifactMetadata } from "@/hooks/useArtifactMetadata.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ArtifactMetadataEditor } from "./ArtifactMetadataEditor.js";

export interface ArtifactMetadataControlsProps {
  workspacePath: string;
  path: string;
  enabled?: boolean;
  onEnabledChange?(enabled: boolean): void;
  disabled?: boolean;
}

/** Each document/discussion owns its activation; opening a menu never sends a prompt. */
export function ArtifactMetadataControls(props: ArtifactMetadataControlsProps) {
  return <ArtifactMetadataControlsInner key={`${props.workspacePath}\0${props.path}`} {...props} />;
}

function ArtifactMetadataControlsInner({
  workspacePath,
  path,
  enabled = false,
  onEnabledChange,
  disabled,
}: ArtifactMetadataControlsProps) {
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `artifactMetadata.${key}` });
  const metadata = useArtifactMetadata(workspacePath);
  const [dialog, setDialog] = useState<"edit" | "preview" | null>(null);
  const [snapshot, setSnapshot] = useState<ProjectMetadataContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  async function refreshPreview() {
    const version = ++generation.current;
    setBusy(true);
    setError("");
    setSnapshot(null);
    try {
      const result = await metadata.resolve(path);
      if (version === generation.current && result) setSnapshot(result);
    } catch (cause) {
      if (version === generation.current)
        setError(cause instanceof Error ? cause.message : t("failed"));
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  function close() {
    generation.current += 1;
    setDialog(null);
    setBusy(false);
  }
  function preview() {
    setDialog("preview");
    void refreshPreview();
  }
  const unavailable = !metadata.available;
  return (
    <>
      {onEnabledChange ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid="artifact-context-trigger"
              className="max-w-full gap-1 text-ui-sm"
            >
              <span className="truncate">{t(enabled ? "contextOn" : "contextOff")}</span>
              <ChevronDown className="size-3 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={enabled ? "on" : "off"}
              onValueChange={(value) => onEnabledChange(value === "on")}
            >
              <DropdownMenuRadioItem value="off">{t("without")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="on" disabled={unavailable}>
                {t("use")}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={unavailable} onSelect={preview}>
              {t("inspect")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={unavailable} onSelect={() => setDialog("edit")}>
              {t("edit")}
            </DropdownMenuItem>
            {unavailable && (
              <p className="max-w-64 px-2 py-1 text-ui-sm text-foreground-subtle">
                {t("unavailable")}
              </p>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || unavailable}
          title={unavailable ? t("unavailable") : t("edit")}
          aria-label={t("edit")}
          onClick={() => setDialog("edit")}
          className="gap-1 text-ui-sm"
        >
          <FileCog className="size-3.5" />
          {t("metadata")}
        </Button>
      )}
      <Dialog
        open={dialog === "edit"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        {dialog === "edit" && (
          <ArtifactMetadataEditor workspacePath={workspacePath} path={path} onClose={close} />
        )}
      </Dialog>
      <Dialog
        open={dialog === "preview"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        {dialog === "preview" && (
          <DialogContent className="max-h-[90dvh] sm:max-w-2xl flex flex-col overflow-hidden">
            <DialogHeader className="pr-8">
              <DialogTitle>{t("inspect")}</DialogTitle>
              <DialogDescription>{t("previewHelp")}</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-y-auto space-y-3">
              <p className="text-ui-sm text-foreground-subtle">{t("historyHelp")}</p>
              {busy && (
                <p role="status" className="text-ui-base">
                  {t("loading")}
                </p>
              )}
              {error && (
                <p role="alert" className="text-ui-base text-destructive whitespace-pre-wrap">
                  {error}
                </p>
              )}
              {snapshot && (
                <>
                  <p className="text-ui-sm text-foreground-subtle">
                    {t("revision")}: <span className="font-mono">{snapshot.revision}</span>
                  </p>
                  <p className="text-ui-sm text-foreground-subtle">
                    {t("inheritedFrom")}:{" "}
                    {snapshot.entries.map((entry) => entry.path).join(" → ") || t("empty")}
                  </p>
                  <pre
                    className="whitespace-pre-wrap break-words rounded-lg bg-surface p-3 font-mono text-ui-sm"
                    data-testid="artifact-context-preview"
                  >
                    {snapshot.text || t("empty")}
                  </pre>
                </>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => void refreshPreview()}>
                {t("refresh")}
              </Button>
              <Button onClick={close}>{t("close")}</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
