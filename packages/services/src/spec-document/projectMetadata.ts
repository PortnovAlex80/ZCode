import { createServiceDescriptor } from "../descriptors.js";

/**
 * U-02 文档/目录护照（проектный харнесс）的 workspace-local 存储。
 *
 * 文件布局：`.harness/project.json`（UTF-8 JSON）：
 *  - `entries` 的键是规范化后的相对路径（分隔符 `/`，无 `..`）；
 *  - 每条记录有稳定 `id`，编辑护照不改 id，未来重命名文件/目录时可以按 id 重新挂链；
 *  - 记录只存引用（источники/связи/методики 是短文本行），不复制文档内容；
 *  - 写入保留未知的 top-level 键，`.harness/` 下也留出 `rules/`、`workflows/` 的位置，
 *    后续扩展不需要迁移本文件。
 *
 * 损坏的存储必须显式失败：读取抛 `ProjectMetadataCorruptError`，由 UI 降级为可见错误；
 * 保存前会重新读取并校验，损坏文件绝不被静默重写。
 */

/** 护照类型：исходные данные / расчёт / записка / чертёж / прочее。 */
export const PROJECT_METADATA_TYPES = [
  "source",
  "calculation",
  "note",
  "drawing",
  "other",
] as const;
export type ProjectMetadataType = (typeof PROJECT_METADATA_TYPES)[number];

/** 描述性步骤；连接、权限及真实执行由现有工具运行时负责。 */
export interface ProjectMetadataStep {
  title: string;
  instruction: string;
  tool?: {
    transport: "file" | "mcp" | "rest";
    connection?: string;
    operation: string;
  };
  input?: string;
  expected?: string;
  onFailure?: string;
}

export interface ProjectMetadataEntry {
  /** 稳定记录 id；仅在首次创建时生成，编辑不变。 */
  id: string;
  /** 行级别：文档或目录（左侧项目树的 file row / folder row）。 */
  kind: "document" | "folder";
  /** Назначение（自由文本）。 */
  purpose: string;
  type: ProjectMetadataType;
  /** Источники——短文本引用行，不是文档副本。 */
  sources: string[];
  /** Связанные материалы——短文本引用行。 */
  links: string[];
  /** Методики/правила——名称或链接引用。 */
  methods: string[];
  instructions?: string;
  skills?: string[];
  checklist?: string[];
  steps?: ProjectMetadataStep[];
  /** 最近一次保存的 ISO-8601 时间。 */
  updatedAt: string;
}

/** 保存入参：`id` 与 `updatedAt` 归服务所有，不由调用方指定。 */
export type ProjectMetadataInput = Omit<ProjectMetadataEntry, "id" | "updatedAt">;

/** 护照表：键为规范化相对路径（如 `docs/расчёт.md`）。 */
export type ProjectMetadataEntries = Record<string, ProjectMetadataEntry>;

export interface ProjectMetadataContext {
  path: string;
  revision: string;
  entries: { path: string; entry: ProjectMetadataEntry }[];
  text: string;
}

/** 存储损坏：UI 显示明确读错误，而不是崩溃或静默重写。 */
export class ProjectMetadataCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectMetadataCorruptError";
  }
}

export interface IProjectMetadataService {
  /**
   * 读取护照表。文件不存在返回空表（不创建 `.harness`）；文件损坏抛
   * `ProjectMetadataCorruptError`。
   */
  read(params: { workspacePath: string }): Promise<ProjectMetadataEntries>;
  /** 每次读取当前护照，仅继承根与祖先目录；不读取引用文件或执行工具。 */
  resolve(params: { workspacePath: string; path: string }): Promise<ProjectMetadataContext>;
  /**
   * 按规范化路径 upsert 一条护照：已有键保留其稳定 `id`。返回写入后的整表。
   * 保存前重读文件，外部手工编辑与未知 top-level 键不被覆盖。
   */
  save(params: {
    workspacePath: string;
    path: string;
    entry: ProjectMetadataInput;
  }): Promise<ProjectMetadataEntries>;
  /** 按路径删除记录（键不存在时为 no-op，不产生写入）。 */
  remove(params: { workspacePath: string; path: string }): Promise<ProjectMetadataEntries>;
}

export const IProjectMetadataService =
  createServiceDescriptor<IProjectMetadataService>("projectMetadata");
