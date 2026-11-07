import { createServiceDescriptor } from "../descriptors.js";

/** Local document IO follows the native workspace-per-request boundary. */
export interface SpecDocumentSnapshot {
  path: string;
  content: string;
  sha256: string;
}

export interface ISpecDocumentService {
  getWorkspace(params: { workspacePath: string }): Promise<{ root: string; writable: boolean }>;
  list(params: { workspacePath: string }): Promise<string[]>;
  /**
   * U-20 (path half, 2026-11-07)：全量文档枚举 + Host 侧模糊搜索。
   *
   * 动机：list() 沿用移植期的 200 文件/8 层硬上限，大工作区（本仓实测 5998 个
   * 文档）在 picker 里被静默截断——用户自己的 docs/ 都不可见。search 与 list
   * 共用同一次枚举规则（跳过点目录/node_modules/符号链接、文本扩展名白名单），
   * 但枚举不设 200 截断（安全上限 DOCUMENT_ENUMERATION_CAP），打分复用共享的
   * workspaceFileSearch fuzzy top-K（与 @-提及/文件树同一算法），Host 侧分批
   * yield，不冻结共享 Host。
   *
   * 语义：query 为空 → 默认排序（相对路径字典序）前 limit 条；非空 → fuzzy
   * top-K。total = 枚举到的文档总数（受安全上限约束），供 UI 如实显示
   * «N shown · M total»。content-search 半边（按正文搜索）仍是 U-20 未完成项。
   */
  search(params: {
    workspacePath: string;
    query: string;
    limit?: number;
  }): Promise<{ paths: string[]; total: number }>;
  read(params: { workspacePath: string; path: string }): Promise<SpecDocumentSnapshot>;
  save(params: {
    workspacePath: string;
    path: string;
    content: string;
    expectedSha256: string;
  }): Promise<SpecDocumentSnapshot>;
  /**
   * U-14：删除工作区文档（真实 unlink）。与 save 共用同一写许可（writer lease）
   * 和写队列；拒绝时抛错（UI 负责可见呈现），绝不静默成功。
   */
  remove(params: { workspacePath: string; path: string }): Promise<{ path: string }>;
}

export const ISpecDocumentService = createServiceDescriptor<ISpecDocumentService>("specDocument");
