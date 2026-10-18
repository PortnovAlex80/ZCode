import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ConversationRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConversationGeometry extends ConversationRectangle {
  maximized: boolean;
  displayId: string;
}

export interface ConversationDisplay {
  id: string | number;
  workArea: ConversationRectangle;
}

const FRAME_NAME = /^zcode-conversation-[a-zA-Z0-9_-]{1,8192}$/;
const MAX_SAVED_WINDOWS = 256;

export function isConversationFrameName(value: unknown): value is string {
  return typeof value === "string" && FRAME_NAME.test(value);
}

export function parseConversationGeometry(
  value: unknown,
): ConversationGeometry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  for (const field of ["x", "y", "width", "height"] as const) {
    if (
      !Number.isSafeInteger(candidate[field]) ||
      Math.abs(candidate[field] as number) > 100_000
    ) {
      return undefined;
    }
  }
  if (
    (candidate.width as number) <= 0 ||
    (candidate.height as number) <= 0 ||
    typeof candidate.maximized !== "boolean" ||
    typeof candidate.displayId !== "string" ||
    candidate.displayId.length > 128
  )
    return undefined;
  return {
    x: candidate.x as number,
    y: candidate.y as number,
    width: candidate.width as number,
    height: candidate.height as number,
    maximized: candidate.maximized,
    displayId: candidate.displayId,
  };
}

function intersectionArea(
  a: ConversationRectangle,
  b: ConversationRectangle,
): number {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  );
}

/** All coordinates are native DIP, including negative coordinates on left-hand monitors. */
export function resolveConversationGeometry(
  saved: ConversationGeometry,
  displays: readonly ConversationDisplay[],
): ConversationGeometry | undefined {
  const available = displays.filter(
    ({ workArea: area }) =>
      [area.x, area.y, area.width, area.height].every(Number.isFinite) &&
      area.width > 0 &&
      area.height > 0,
  );
  if (!available.length) return undefined;
  const matching = available.find(
    (display) => String(display.id) === saved.displayId,
  );
  const display =
    matching ??
    available.reduce((best, current) =>
      intersectionArea(saved, current.workArea) >
      intersectionArea(saved, best.workArea)
        ? current
        : best,
    );
  const area = display.workArea;
  const width = Math.min(area.width, Math.max(320, saved.width));
  const height = Math.min(area.height, Math.max(240, saved.height));
  return {
    x: Math.round(
      Math.min(Math.max(saved.x, area.x), area.x + area.width - width),
    ),
    y: Math.round(
      Math.min(Math.max(saved.y, area.y), area.y + area.height - height),
    ),
    width: Math.floor(width),
    height: Math.floor(height),
    maximized: saved.maximized,
    displayId: String(display.id),
  };
}

/** One Main-owned store; readers hydrate before writes and all replacements serialize. */
export class NativeConversationGeometryStore {
  private readonly entries = new Map<string, ConversationGeometry>();
  private pending: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(
    private readonly path: string,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const payload: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (typeof payload !== "object" || payload === null) return;
      const { version, windows } = payload as Record<string, unknown>;
      if (
        version !== 1 ||
        typeof windows !== "object" ||
        windows === null ||
        Array.isArray(windows)
      )
        return;
      for (const [key, value] of Object.entries(windows).slice(
        -MAX_SAVED_WINDOWS,
      )) {
        const geometry = parseConversationGeometry(value);
        if (isConversationFrameName(key) && geometry)
          this.entries.set(key, geometry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.onError(error);
    }
  }

  get(frameName: string): ConversationGeometry | undefined {
    const entry = this.entries.get(frameName);
    return entry ? { ...entry } : undefined;
  }

  save(frameName: string, value: ConversationGeometry): Promise<void> {
    const geometry = parseConversationGeometry(value);
    if (!isConversationFrameName(frameName) || !geometry)
      return Promise.resolve();
    this.pending = this.pending
      .then(async () => {
        await this.ready;
        this.entries.delete(frameName);
        this.entries.set(frameName, geometry);
        if (this.entries.size > MAX_SAVED_WINDOWS)
          this.entries.delete(this.entries.keys().next().value!);
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(
            temporary,
            JSON.stringify({
              version: 1,
              windows: Object.fromEntries(this.entries),
            }),
            "utf8",
          );
          await rename(temporary, this.path);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      })
      .catch(this.onError);
    return this.pending;
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.pending;
  }
}

export interface ConversationGeometryWindow {
  isDestroyed(): boolean;
  getNormalBounds(): ConversationRectangle;
  isMaximized(): boolean;
  setBounds(bounds: ConversationRectangle): void;
  maximize(): void;
  on(event: string, listener: () => void): unknown;
}

/** 修复根因：宽高不足以还原跨显示器窗口；Main 持有 normal bounds 与独立最大化状态。 */
export function attachConversationGeometry(
  win: ConversationGeometryWindow,
  frameName: string,
  store: NativeConversationGeometryStore,
  getDisplays: () => readonly ConversationDisplay[],
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const capture = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (disposed || win.isDestroyed()) return;
    const bounds = win.getNormalBounds();
    const displays = getDisplays();
    const display = displays.reduce<ConversationDisplay | undefined>(
      (best, current) =>
        !best ||
        intersectionArea(bounds, current.workArea) >
          intersectionArea(bounds, best.workArea)
          ? current
          : best,
      undefined,
    );
    void store.save(frameName, {
      ...bounds,
      maximized: win.isMaximized(),
      displayId: String(display?.id ?? ""),
    });
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(capture, 250);
  };
  const saved = store.get(frameName);
  const restored = saved && resolveConversationGeometry(saved, getDisplays());
  if (restored && !win.isDestroyed()) {
    const { x, y, width, height } = restored;
    win.setBounds({ x, y, width, height });
    if (restored.maximized) win.maximize();
  }
  win.on("move", schedule);
  win.on("resize", schedule);
  win.on("maximize", capture);
  win.on("unmaximize", capture);
  win.on("close", capture);
  win.on("closed", () => {
    disposed = true;
    if (timer) clearTimeout(timer);
  });
  return capture;
}
