import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DriverChaoXingAddition, ChaoXingFile } from "./types"
import { ClientChaoXing, parseChaoXingTimestamp } from "./util"

function fileToItem(f: ChaoXingFile): FileItem {
  const c = f.content
  if (c.folderName) {
    return {
      name: c.folderName,
      size: 0,
      is_dir: true,
      modified: parseChaoXingTimestamp(f.inserttime),
      sign: String(f.id),
      type: 1,
    }
  }
  const fileId = c.fileId || c.objectId || ""
  return {
    name: c.name || "",
    size: Number(c.size) || 0,
    is_dir: false,
    modified: parseChaoXingTimestamp(c.uploadDate),
    sign: `${f.id}$${fileId}`,
    type: calcFileType(c.name || "", false),
    ...(c.thumbnail ? { thumb: c.thumbnail } : {}),
    raw_url: "",
  }
}

export class DriverChaoXing implements StorageDriver {
  private addition: DriverChaoXingAddition
  private client: ClientChaoXing
  private pathCache = new Map<string, string>()

  constructor(
    addition: DriverChaoXingAddition,
    persistCookie?: (cookie: string) => void | Promise<void>,
  ) {
    this.addition = addition
    this.client = new ClientChaoXing(addition, persistCookie)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private getRootId(): string {
    const raw = String(this.addition.root_folder_id ?? "").trim()
    return raw && raw !== "/" ? raw : "-1"
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parentId = await this.pathToId(physicalPath)
    const files = await this.client.getFiles(parentId)
    return files.map((f) => fileToItem(f))
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const rawName = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, -1).join("/")

    try {
      const parentId = await this.pathToId(parentPath)
      const files = await this.client.getFiles(parentId)
      const target = files.find(
        (f) => (f.content.folderName || f.content.name) === rawName,
      )
      if (target) {
        const item = fileToItem(target)
        if (!item.is_dir) {
          const fileId = item.sign.split("$")[1] || ""
          if (fileId) {
            try {
              const resp = await this.client.link(fileId)
              item.raw_url = resp.download
              item.raw_url_headers = this.client.downloadHeaders()
            } catch {
              item.raw_url_error = "[ChaoXing] failed to resolve download url"
            }
          }
        }
        return item
      }
    } catch {
      // fall through to directory fallback
    }

    try {
      const dirId = await this.pathToId(physicalPath)
      return {
        name: rawName,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: dirId,
        type: 1,
        raw_url: "",
      }
    } catch {
      return {
        name: rawName,
        size: 0,
        is_dir: false,
        modified: new Date().toISOString(),
        sign: "",
        type: 0,
        raw_url: "",
      }
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "new_folder"
    const parentPath = "/" + parts.join("/")
    await this.client.mkdir(await this.pathToId(parentPath), name)
    this.pathCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const entry = await this.resolveEntry(physicalPath)
    if (!entry.isDir) {
      throw new Error("[ChaoXing] 此网盘不支持修改文件名")
    }
    await this.client.renameFolder(entry.id, newName)
    this.pathCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const entry = await this.resolveEntry(physicalPath)
    await this.client.remove(entry.id, entry.isDir)
    this.pathCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const entry = await this.resolveEntry(srcPhysical)
    const dstParts = dstPhysical.split("/").filter(Boolean)
    const dstParentPath = "/" + dstParts.slice(0, -1).join("/")
    await this.client.move(
      entry.id,
      await this.pathToId(dstParentPath),
      entry.isDir,
    )
    this.pathCache.clear()
  }

  async copy(): Promise<void> {
    throw new Error("[ChaoXing] copy not supported")
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Uint8Array,
  ): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "file"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.pathToId(parentPath)
    await this.client.upload(parentId, name, new Uint8Array(content))
    this.pathCache.clear()
  }

  private async resolveEntry(
    physicalPath: string,
  ): Promise<{ id: string; isDir: boolean }> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.pathToId(parentPath)
    const files = await this.client.getFiles(parentId)
    const target = files.find(
      (f) => (f.content.folderName || f.content.name) === name,
    )
    if (!target) throw new Error(`[ChaoXing] '${name}' not found`)
    return { id: String(target.id), isDir: !!target.content.folderName }
  }

  /** 物理路径 → 目录 ID（根目录返回 root_folder_id 或 "-1"） */
  private async pathToId(physicalPath: string): Promise<string> {
    const parts = physicalPath.split("/").filter(Boolean)
    if (parts.length === 0) return this.getRootId()
    const normalized = "/" + parts.join("/")
    const cached = this.pathCache.get(normalized)
    if (cached) return cached

    let currentId = this.getRootId()
    for (let i = 0; i < parts.length; i++) {
      const subPath = "/" + parts.slice(0, i + 1).join("/")
      const subCached = this.pathCache.get(subPath)
      if (subCached) {
        currentId = subCached
        continue
      }
      const files = await this.client.getFiles(currentId)
      const target = files.find((f) => f.content.folderName === parts[i])
      if (!target) {
        throw new Error(`[ChaoXing] Directory '${parts[i]}' not found`)
      }
      currentId = String(target.id)
      this.pathCache.set(subPath, currentId)
    }
    return currentId
  }
}
